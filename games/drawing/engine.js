const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const db = require("../../database");
const msg = require("../../services/messenger");
const leaderboard = require("../../services/leaderboard");
const adminAuth = require("../../services/adminAuth");
const drawingWebServer = require("../../services/spyImageServer");
const drawingTunnel = require("../../services/drawingTunnel");
const CFG = require("./config");
const { chooseWord, matchesAnswer } = require("./words");

const START_ALIASES = new Set(["رسم", "ارسم", "draw"]);
const COMMANDS = new Map([
  ["drawhelp", "help"],
  ["قواعدرسم", "help"],
  ["drawstatus", "status"],
  ["حالةرسم", "status"],
  ["drawscores", "scores"],
  ["نتائجالرسم", "scores"],
  ["drawcancel", "cancel"],
  ["إلغاءرسم", "cancel"],
]);
const TICK_MS = 3000;
const RECOVER_PUBLISHING_SECONDS = 120;
let ticking = false;
let lastStorageCleanup = 0;

const getRoom = (roomId) =>
  db.one(
    "SELECT * FROM game_rooms WHERE id=? AND game_id='drawing'",
    [roomId],
  );
const getActiveRoom = (threadId) =>
  db.one(
    "SELECT * FROM game_rooms WHERE game_id='drawing' AND thread_id=? AND status IN ('lobby','playing') ORDER BY id DESC LIMIT 1",
    [threadId],
  );
const getPlayer = (roomId, userId) =>
  db.one(
    "SELECT * FROM drawing_players WHERE room_id=? AND psid=?",
    [roomId, userId],
  );

function commandParts(text) {
  const parts = String(text || "")
    .trim()
    .replace(/^[/!]\s*/, "")
    .split(/\s+/);
  return { name: (parts.shift() || "").toLowerCase(), arg: parts.join(" ") };
}

function artistIdForCommand(context) {
  const repliedUserId = String(context.messageReply?.senderID || "").trim();
  return repliedUserId || String(context.userId);
}

function tokenHash(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

async function assertSchema() {
  const schema = await fs.readFile(path.join(__dirname, "schema.sql"), "utf8");
  for (const statement of schema
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean))
    await db.query(statement);
  const stateColumns = await db.query(
    "SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='drawing_state'",
  );
  if (!stateColumns.some((column) => column.COLUMN_NAME === "artist_psid")) {
    await db.query(
      "ALTER TABLE drawing_state ADD COLUMN artist_psid VARCHAR(64) NULL AFTER room_id",
    );
  }
  if (!stateColumns.some((column) => column.COLUMN_NAME === "round_started_at")) {
    await db.query(
      "ALTER TABLE drawing_state ADD COLUMN round_started_at DATETIME NULL AFTER artist_psid",
    );
  }
  await db.query(
    `UPDATE drawing_state ds
     JOIN game_rooms gr ON gr.id=ds.room_id
     SET ds.artist_psid=gr.host_psid
     WHERE ds.artist_psid IS NULL
       AND gr.game_id='drawing' AND gr.status IN ('lobby','playing')`,
  );
  const columns = await db.query(
    "SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='drawing_submissions'",
  );
  if (!columns.some((column) => column.COLUMN_NAME === "image_content_type"))
    await db.query(
      "ALTER TABLE drawing_submissions ADD COLUMN image_content_type VARCHAR(32) NULL AFTER image_data",
    );
  const tokenIndexes = await db.query(
    "SELECT INDEX_NAME, NON_UNIQUE FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='drawing_submissions' AND COLUMN_NAME='token_hash'",
  );
  if (tokenIndexes.some((index) => index.INDEX_NAME === "uq_drawing_token"))
    await db.query(
      "ALTER TABLE drawing_submissions DROP INDEX uq_drawing_token",
    );
  if (!tokenIndexes.some((index) => index.INDEX_NAME === "idx_drawing_token"))
    await db.query(
      "ALTER TABLE drawing_submissions ADD INDEX idx_drawing_token (token_hash)",
    );
}

async function findOtherActiveGame(userId, exceptRoomId = 0) {
  return db.one(
    `SELECT gr.game_id FROM game_rooms gr
     LEFT JOIN room_players rp ON rp.room_id=gr.id AND rp.psid=?
     LEFT JOIN storm_players stp ON stp.room_id=gr.id AND stp.psid=?
     LEFT JOIN spy_players spp ON spp.room_id=gr.id AND spp.psid=?
     LEFT JOIN feign_players fgp ON fgp.room_id=gr.id AND fgp.psid=?
     LEFT JOIN werewolf_players wwp ON wwp.room_id=gr.id AND wwp.psid=?
     LEFT JOIN drawing_players dp ON dp.room_id=gr.id AND dp.psid=?
     WHERE gr.status IN ('lobby','playing') AND gr.id<>?
       AND (rp.id IS NOT NULL OR stp.id IS NOT NULL OR spp.id IS NOT NULL
            OR fgp.id IS NOT NULL OR wwp.id IS NOT NULL OR dp.id IS NOT NULL)
     LIMIT 1`,
    [
      userId,
      userId,
      userId,
      userId,
      userId,
      userId,
      exceptRoomId,
    ],
  );
}

async function ensurePlayer(roomId, userId) {
  const existing = await getPlayer(roomId, userId);
  if (existing) return existing;
  const displayName = await msg.getUserName(userId);
  await db.query(
    "INSERT IGNORE INTO drawing_players (room_id, psid, display_name) VALUES (?,?,?)",
    [roomId, userId, displayName],
  );
  return getPlayer(roomId, userId);
}

async function issueChallenge(room, userId) {
  const state = await db.one(
    "SELECT artist_psid FROM drawing_state WHERE room_id=?",
    [room.id],
  );
  if (state?.artist_psid && String(state.artist_psid) !== String(userId))
    return {
      ok: false,
      reason: "ℹ️ الرسام الوحيد في هذه اللعبة هو اللاعب الذي اختير عند بدء الجولة.",
    };
  if (await db.isUserBanned(userId))
    return { ok: false, reason: "⛔ لا يمكنك بدء الألعاب حالياً." };
  if (await findOtherActiveGame(userId, room.id))
    return {
      ok: false,
      reason: "أنت مشارك في لعبة أخرى.",
    };

  const player = await ensurePlayer(room.id, userId);
  const pending = await db.one(
    `SELECT id, status FROM drawing_submissions
     WHERE room_id=? AND player_id=?
       AND status IN ('issued','queued','publishing','published')
     ORDER BY id DESC LIMIT 1`,
    [room.id, player.id],
  );
  if (pending && pending.status !== "issued")
    return {
      ok: false,
      reason:
        "لديك رسمة قائمة بالفعل. انتظر عرضها وتخمينها قبل طلب كلمة جديدة.",
    };
  if (pending)
    await db.query(
      "UPDATE drawing_submissions SET status='expired' WHERE id=? AND status='issued'",
      [pending.id],
    );

  const word = chooseWord();
  const token = crypto.randomBytes(32).toString("base64url");
  const insert = await db.query(
    `INSERT INTO drawing_submissions
      (room_id, player_id, word, aliases_json, token_hash, token_expires_at)
     VALUES (?,?,?,?,?,DATE_ADD(NOW(), INTERVAL ? MINUTE))`,
    [
      room.id,
      player.id,
      word.word,
      JSON.stringify(word.aliases),
      tokenHash(token),
      CFG.TOKEN_TTL_MINUTES,
    ],
  );

  let publicBase;
  try {
    publicBase = await drawingWebServer.enableDrawing();
    await drawingTunnel.waitForReachableUrl(
      publicBase,
      12000,
      `/draw/${token}`,
    );
  } catch (error) {
    console.error("[drawing] could not enable the public drawing page:", error.message);
    return {
      ok: false,
      reason:
        "⚠️ تعذر تشغيل رابط صفحة الرسم العامة. تحقق من اتصال الإنترنت وإعداد Tailscale Funnel أو أداة النفق المحددة، ثم أعد المحاولة.",
    };
  }

  const link = `${publicBase}/draw/${token}`;
  const sent = await msg.sendPrivateWithResult(
    userId,
    `صفحتك: ${link}\nارسم فيها؛ تُنشر اللوحة كل ${CFG.PUBLISH_INTERVAL_SECONDS}ث. لا تشارك الرابط.`,
  );
  if (!sent.ok) {
    await db.query(
      "UPDATE drawing_submissions SET status='cancelled' WHERE id=? AND status='issued'",
      [insert.insertId],
    );
    return {
      ok: false,
      reason:
        sent.userMessage ||
        "تعذّر إرسال رابط الرسم. افتح محادثة خاصة مع البوت أولاً ثم أعد المحاولة.",
    };
  }
  return { ok: true, player };
}

async function createRoom(userId, artistId, threadId) {
  if (await db.isUserBanned(userId))
    return msg.sendGroup(
      threadId,
      "أنت محظور من بدء الألعاب.",
    );
  if (await findOtherActiveGame(userId))
    return msg.sendGroup(
      threadId,
      "أنت مشارك في لعبة أخرى.",
    );
  if (
    String(artistId) !== String(userId) &&
    (await findOtherActiveGame(artistId))
  )
    return msg.sendGroup(
      threadId,
      "اللاعب المختار يشارك في لعبة أخرى.",
    );

  const active = await db.one(
    "SELECT game_id FROM game_rooms WHERE thread_id=? AND status IN ('lobby','playing') LIMIT 1",
    [threadId],
  );
  if (active)
    return msg.sendGroup(
      threadId,
      `⚠️ توجد لعبة نشطة بالفعل (${active.game_id}). أنهِها أولاً قبل بدء لعبة الرسم.`,
    );

  let roomId;
  try {
    roomId = await db.withTransaction(async (query) => {
      const result = await query(
        "INSERT INTO game_rooms (game_id, thread_id, host_psid, status, phase) VALUES ('drawing',?,?, 'playing','discussion')",
        [threadId, userId],
      );
      await query(
        "INSERT INTO drawing_state (room_id, artist_psid) VALUES (?,?)",
        [result.insertId, artistId],
      );
      return result.insertId;
    });
  } catch (error) {
    if (error.code === "ER_DUP_ENTRY")
      return msg.sendGroup(threadId, "⚠️ توجد لعبة نشطة في هذه المجموعة.");
    throw error;
  }
  const room = await getRoom(roomId);
  let result;
  try {
    result = await issueChallenge(room, artistId);
  } catch (error) {
    console.error("[drawing] failed to issue the first drawing challenge:", error);
    await db.query(
      "UPDATE game_rooms SET status='cancelled', phase='finished' WHERE id=? AND game_id='drawing' AND status='playing'",
      [roomId],
    );
    return msg.sendGroup(
      threadId,
      "⚠️ تعذر تجهيز لعبة الرسم بسبب خطأ داخلي. أُلغيت الجلسة؛ حاول مرة أخرى.",
    );
  }
  if (!result.ok) {
    await db.query(
      "UPDATE game_rooms SET status='cancelled', phase='finished' WHERE id=? AND game_id='drawing' AND status='playing'",
      [roomId],
    );
    await db.query(
      "UPDATE drawing_submissions SET status='cancelled', image_data=NULL WHERE room_id=? AND status IN ('issued','queued','publishing','published')",
      [roomId],
    );
    await drawingWebServer.disableDrawingIfIdle();
    const response = await msg.sendGroup(threadId, result.reason);
    return response;
  }
  const announced = await msg.sendGroup(
    threadId,
    `بدأت جولة الرسم. الرسام: ${result.player.display_name}.\nخمّنوا هنا؛ تُنشر اللوحة كل ${CFG.PUBLISH_INTERVAL_SECONDS}ث. مدة الجولة ${CFG.ROUND_DURATION_SECONDS / 60} دقائق، ويمكن للرسام إلغاؤها من صفحة الرسم.\nالرسام: لا تشارك الرابط أو الكلمة.`,
  );
  if (!announced) {
    await db.query(
      "UPDATE game_rooms SET status='cancelled', phase='finished' WHERE id=? AND game_id='drawing' AND status='playing'",
      [roomId],
    );
    await db.query(
      "UPDATE drawing_submissions SET status='cancelled' WHERE room_id=? AND status='issued'",
      [roomId],
    );
    await drawingWebServer.disableDrawingIfIdle();
    const notice = await msg.sendPrivateWithResult(
      userId,
      "تعذّر إعلان الجولة؛ أُلغيت. حاول مجدداً.",
    );
    if (!notice.ok)
      console.error(
        `[drawing] failed to notify host ${userId} after announcement failure:`,
        notice.reason,
      );
  }
  return announced;
}

async function startOrJoin(context) {
  const artistId = artistIdForCommand(context);
  if (artistId === String(msg.selfId?.() || ""))
    return msg.sendGroup(
      context.threadId,
      "رد على لاعب بأمر رسم لاختياره رساماً.",
    );
  const room = await getActiveRoom(context.threadId);
    if (room)
      return msg.sendGroup(
        context.threadId,
        "جولة الرسم نشطة بالفعل. انتظروا نهايتها.",
      );
  return createRoom(context.userId, artistId, context.threadId);
}

async function submitGuess(context) {
  const room = await getActiveRoom(context.threadId);
  if (!room || room.status !== "playing") return;
  const current = await db.one(
    `SELECT ds.id, ds.player_id, ds.word, ds.aliases_json,
            dp.psid AS artist_psid, dp.display_name AS artist_name
     FROM drawing_submissions ds
     JOIN drawing_players dp ON dp.id=ds.player_id
     WHERE ds.room_id=? AND ds.status='published'
     ORDER BY ds.id LIMIT 1`,
    [room.id],
  );
  if (!current || String(current.artist_psid) === String(context.userId))
    return;

  let aliases = current.aliases_json;
  if (typeof aliases === "string") aliases = JSON.parse(aliases);
  if (!matchesAnswer(context.text, { word: current.word, aliases })) return;

  if (await findOtherActiveGame(context.userId, room.id)) return;
  if (await db.isUserBanned(context.userId)) return;
  const guesser = await ensurePlayer(room.id, context.userId);
  const scored = await db.withTransaction(async (query) => {
    const activeRoom = await query(
      "SELECT id FROM game_rooms WHERE id=? AND status='playing' FOR UPDATE",
      [room.id],
    );
    if (!activeRoom.length) return false;
    const solved = await query(
      "UPDATE drawing_submissions SET status='solved', guessed_by_player_id=? WHERE id=? AND status='published'",
      [guesser.id, current.id],
    );
    if (!solved.affectedRows) return false;
    await query("UPDATE drawing_players SET score=score+1 WHERE id=?", [
      current.player_id,
    ]);
    await query("UPDATE drawing_players SET score=score+1 WHERE id=?", [
      guesser.id,
    ]);
    const finished = await finishRound(query, room.id);
    if (!finished) return false;
    await leaderboard.recordPoints(
      "drawing",
      room.id,
      [
        { psid: current.artist_psid, display_name: current.artist_name },
        { psid: guesser.psid, display_name: guesser.display_name },
      ],
      query,
    );
    return true;
  });
  if (!scored) return;
  await drawingWebServer.disableDrawingIfIdle();
  await msg.sendGroup(
    context.threadId,
    `✅ ${guesser.display_name} خمّن «${current.word}»! نقطة له وللرسام ${current.artist_name}.`,
  );
}

async function finishRound(query, roomId) {
  const finished = await query(
    "UPDATE game_rooms SET status='finished', phase='finished', phase_ends_at=NULL WHERE id=? AND game_id='drawing' AND status='playing'",
    [roomId],
  );
  if (!finished.affectedRows) return false;
  await query("UPDATE drawing_state SET next_publish_at=NULL WHERE room_id=?", [
    roomId,
  ]);
  await query(
    `UPDATE drawing_submissions SET status='cancelled', image_data=NULL
     WHERE room_id=? AND status IN ('issued','queued','publishing','published')`,
    [roomId],
  );
  return true;
}

async function sendScores(threadId, room) {
  const players = await db.query(
    `SELECT display_name, score FROM drawing_players
     WHERE room_id=? ORDER BY score DESC, id LIMIT 20`,
    [room.id],
  );
  if (!players.length)
    return msg.sendGroup(threadId, "لم يشارك أحد في لعبة الرسم بعد.");
  return msg.sendGroup(
    threadId,
    `🏆 نتائج لعبة الرسم:\n${players.map((player, index) => `${index + 1}. ${player.display_name} — ${player.score} نقطة`).join("\n")}`,
  );
}

async function sendStatus(threadId, room) {
  const [counts, current] = await Promise.all([
    db.one(
      `SELECT
         SUM(ds.status='queued') AS queued,
         MAX(CASE WHEN dp.psid=drawing_meta.artist_psid THEN dp.display_name END) AS artist_name
       FROM drawing_state drawing_meta
       LEFT JOIN drawing_submissions ds ON ds.room_id=drawing_meta.room_id
       LEFT JOIN drawing_players dp ON dp.id=ds.player_id
       WHERE drawing_meta.room_id=?`,
      [room.id],
    ),
    db.one(
      `SELECT dp.display_name FROM drawing_submissions ds
       JOIN drawing_players dp ON dp.id=ds.player_id
       WHERE ds.room_id=? AND ds.status='published' LIMIT 1`,
      [room.id],
    ),
  ]);
  return msg.sendGroup(
    threadId,
    `الرسم | الرسام: ${counts.artist_name || "—"} | انتظار: ${Number(counts.queued || 0)} | المعروضة: ${current ? current.display_name : "—"}`,
  );
}

async function cancelGame(userId, threadId, isAdmin = false) {
  const room = await getActiveRoom(threadId);
  if (!room) return msg.sendGroup(threadId, "ℹ️ لا توجد لعبة رسم نشطة.");
  if (room.host_psid !== userId && !isAdmin)
    return msg.sendGroup(
      threadId,
      "⛔ مضيف لعبة الرسم فقط يستطيع إلغاءها.",
    );
  const cancelled = await db.query(
    "UPDATE game_rooms SET status='cancelled', phase='finished', phase_ends_at=NULL WHERE id=? AND game_id='drawing' AND status IN ('lobby','playing')",
    [room.id],
  );
  if (!cancelled.affectedRows) return;
  await db.query(
    "UPDATE drawing_submissions SET status='cancelled', image_data=NULL WHERE room_id=? AND status IN ('issued','queued','publishing','published')",
    [room.id],
  );
  await drawingWebServer.disableDrawingIfIdle();
  return msg.sendGroup(threadId, "🚫 أُلغيت لعبة الرسم.");
}

async function handleGroup(context, command) {
  if (START_ALIASES.has(command)) return startOrJoin(context);
  if (command === "help") return msg.sendGroup(context.threadId, helpText());
  const room = await getActiveRoom(context.threadId);
  if (command === "cancel")
    return cancelGame(
      context.userId,
      context.threadId,
      adminAuth.isAdmin(context.userId),
    );
  if (!room) {
    if (command === "status")
      return msg.sendGroup(context.threadId, "ℹ️ لا توجد لعبة رسم نشطة.");
    if (command === "scores")
      return msg.sendGroup(context.threadId, "ℹ️ لا توجد لعبة رسم نشطة.");
    return;
  }
  if (command === "status") return sendStatus(context.threadId, room);
  if (command === "scores") return sendScores(context.threadId, room);
  if (command) return;
  return submitGuess(context);
}

async function handlePrivate(context, command) {
  if (command === "help") return msg.sendPrivate(context.userId, helpText());
  const active = await db.one(
    `SELECT gr.thread_id FROM drawing_players dp
     JOIN game_rooms gr ON gr.id=dp.room_id
     WHERE dp.psid=? AND gr.game_id='drawing'
       AND gr.status IN ('lobby','playing')
     ORDER BY gr.id DESC LIMIT 1`,
    [context.userId],
  );
  if (!active && command)
    return msg.sendPrivate(
      context.userId,
      "ابدأ لعبة الرسم داخل المجموعة بكتابة /رسم.",
    );
  if (command === "status")
    return msg.sendPrivate(
      context.userId,
      "افتح رابط صفحة الرسم الذي وصلك في الخاص للرسم مباشرةً.",
    );
}

async function handleMessage(context) {
  const { name } = commandParts(context.text);
  const command = COMMANDS.get(name);
  if (!context.isGroup) return handlePrivate(context, command);
  if (START_ALIASES.has(name)) return startOrJoin(context);
  if (command) return handleGroup(context, command);
  if (/^[/!]/.test(String(context.text || "").trim())) return;
  return submitGuess(context);
}

async function canHandleMessage({ userId, isGroup }) {
  if (isGroup) return false;
  return Boolean(
    await db.one(
      `SELECT dp.id FROM drawing_players dp
       JOIN game_rooms gr ON gr.id=dp.room_id
       WHERE dp.psid=? AND gr.game_id='drawing'
         AND gr.status IN ('lobby','playing') LIMIT 1`,
      [userId],
    ),
  );
}

async function processRoom(room) {
  const roundExpired = await db.one(
    `SELECT 1 AS expired FROM drawing_state
     WHERE room_id=? AND round_started_at IS NOT NULL
       AND DATE_ADD(round_started_at, INTERVAL ? SECOND) <= NOW()
     LIMIT 1`,
    [room.id, CFG.ROUND_DURATION_SECONDS],
  );
  if (roundExpired) {
    const finished = await db.withTransaction((query) =>
      finishRound(query, room.id),
    );
    if (finished) {
      await drawingWebServer.disableDrawingIfIdle();
      const sent = await msg.sendGroup(
        room.thread_id,
        `⌛ انتهت مدة الجولة (${CFG.ROUND_DURATION_SECONDS} ثانية). اكتبوا /رسم لبدء لعبة جديدة.`,
      );
      if (!sent)
        console.error(
          `[drawing] failed to announce the round timeout for room ${room.id}`,
        );
    }
    return;
  }
  const expiredChallenge = await db.query(
    `UPDATE drawing_submissions SET status='expired'
     WHERE room_id=? AND status='issued' AND token_expires_at<=NOW()`,
    [room.id],
  );
  if (expiredChallenge.affectedRows) {
    const finished = await db.withTransaction((query) =>
      finishRound(query, room.id),
    );
    if (finished) {
      await drawingWebServer.disableDrawingIfIdle();
      const sent = await msg.sendGroup(
        room.thread_id,
        "⌛ انتهت صلاحية جولة الرسم قبل إرسال الرسمة. اكتبوا /رسم لبدء لعبة جديدة.",
      );
      if (!sent)
        console.error(
          `[drawing] failed to announce the expired challenge for room ${room.id}`,
        );
    }
    return;
  }
  await db.query(
    `UPDATE drawing_submissions SET status='queued'
     WHERE room_id=? AND status='publishing'
       AND created_at<=DATE_SUB(NOW(), INTERVAL ? SECOND)`,
    [room.id, RECOVER_PUBLISHING_SECONDS],
  );
  if (!Number(room.publish_due)) return;

  const queued = await db.one(
    `SELECT ds.id, ds.word, ds.image_data, ds.image_content_type, dp.display_name
     FROM drawing_submissions ds
     JOIN drawing_players dp ON dp.id=ds.player_id
     WHERE ds.room_id=? AND ds.status='queued'
     ORDER BY ds.id LIMIT 1`,
    [room.id],
  );
  if (!queued) {
    await db.query(
      "UPDATE drawing_state SET next_publish_at=NULL WHERE room_id=?",
      [room.id],
    );
    return;
  }
  const claimed = await db.query(
    "UPDATE drawing_submissions SET status='publishing' WHERE id=? AND status='queued'",
    [queued.id],
  );
  if (!claimed.affectedRows) return;
  const messageId = await msg.sendGroupImageBufferTracked(
    room.thread_id,
    Buffer.from(queued.image_data),
    queued.image_content_type,
    `🎨 رسمة من ${queued.display_name}! اكتبوا تخمينكم في المجموعة.`,
  );
  if (!messageId) {
    await db.query(
      "UPDATE drawing_submissions SET status='queued' WHERE id=? AND status='publishing'",
      [queued.id],
    );
    await db.query(
      "UPDATE drawing_state SET next_publish_at=DATE_ADD(NOW(), INTERVAL ? SECOND) WHERE room_id=?",
      [CFG.PUBLISH_INTERVAL_SECONDS, room.id],
    );
    console.error(
      `[drawing] image delivery failed for submission ${queued.id}; it will be retried`,
    );
    return;
  }
  await db.query(
    `UPDATE drawing_submissions SET status='published', published_at=NOW(),
       image_data=NULL, image_content_type=NULL WHERE id=? AND status='publishing'`,
    [queued.id],
  );
  await db.query(
    "UPDATE drawing_state SET next_publish_at=DATE_ADD(NOW(), INTERVAL ? SECOND) WHERE room_id=?",
    [CFG.PUBLISH_INTERVAL_SECONDS, room.id],
  );
  await db.query(
    "UPDATE game_rooms SET updated_at=NOW() WHERE id=? AND status='playing'",
    [room.id],
  );
}

async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    if (Date.now() - lastStorageCleanup >= 60_000) {
      await db.query(
        `UPDATE drawing_submissions ds
         JOIN game_rooms gr ON gr.id=ds.room_id
         SET ds.status='cancelled', ds.image_data=NULL
         WHERE gr.game_id='drawing' AND gr.status IN ('cancelled','finished')
           AND ds.status IN ('issued','queued','publishing','published')`,
      );
      lastStorageCleanup = Date.now();
    }
    const rooms = await db.query(
      `SELECT gr.id, gr.thread_id, ds.next_publish_at,
              (ds.next_publish_at IS NOT NULL AND ds.next_publish_at<=NOW()) AS publish_due
       FROM drawing_state ds JOIN game_rooms gr ON gr.id=ds.room_id
       WHERE gr.game_id='drawing' AND gr.status='playing'`,
    );
    for (const room of rooms) {
      try {
        await processRoom(room);
      } catch (error) {
        console.error(`[drawing] ticker failed for room ${room.id}:`, error);
      }
    }
  } finally {
    ticking = false;
  }
}

function startTicker() {
  setInterval(() => {
    tick().catch((error) => console.error("[drawing] ticker failed:", error));
  }, TICK_MS).unref?.();
}

function helpText() {
  return `الرسم: اكتب رسم أو رد به على لاعب ليكون الرسام. يرسم في الرابط الخاص؛ تُنشر اللوحة كل ${CFG.PUBLISH_INTERVAL_SECONDS}ث.
مدة الجولة ${CFG.ROUND_DURATION_SECONDS / 60} دقائق؛ لا تنتهي عند توقف الرسام عن الرسم، ويمكنه إلغاؤها من صفحة الرسم. التخمين الصحيح يمنح الرسام والمخمّن نقطة.
الأوامر: /رسم، /حالة رسم، /نتائج الرسم، /إلغاء رسم. لا تشارك الرابط أو الكلمة.`;
}

drawingWebServer.setCancelHandler(async ({ threadId }) => {
  await drawingWebServer.disableDrawingIfIdle();
  const sent = await msg.sendGroup(threadId, "🚫 ألغى الرسام جولة الرسم من الصفحة.");
  if (!sent) {
    console.error(`[drawing] failed to announce cancellation in thread ${threadId}`);
  }
});

module.exports = {
  assertSchema,
  handleMessage,
  handleReaction: async () => {},
  cancelActiveGame: cancelGame,
  canHandleMessage,
  startTicker,
  tick,
  normalizeAnswer: require("./words").normalizeAnswer,
  matchesAnswer,
  artistIdForCommand,
  finishRound,
};
