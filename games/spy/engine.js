const { randomInt } = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const db = require("../../database");
const msg = require("../../services/messenger");
const leaderboard = require("../../services/leaderboard");
const { isReplyToBotPrompt } = require("../../services/replyPrompts");
const CFG = require("./config");
const spyImages = require("./imageService");
const ui = require("../../services/interaction");
const imageHost = require("../../services/imageHost");
let imageLinks = null;
try {
  imageLinks = require("../../services/spyImageLinks");
} catch {
  imageLinks = null;
}

const START_ALIASES = new Set(["جاسوس"]);
const COMMANDS = new Map([
  ["spyhelp", "help"],
  ["قواعدجاسوس", "help"],
  ["spyplayers", "players"],
  ["لاعبينجاسوس", "players"],
  ["spyleave", "leave"],
  ["خروججاسوس", "leave"],
  ["spycancel", "cancel"],
  ["إلغاءجاسوس", "cancel"],
  ["spyvote", "vote"],
  ["تصويتللجاسوس", "vote"],
  ["spyguess", "guess"],
  ["خمنجاسوس", "guess"],
  ["spyrole", "role"],
  ["دوريجاسوس", "role"],
  ["spytest", "test"],
  ["اختبارجاسوس", "test"],
  ["spystatus", "status"],
  ["حالةجاسوس", "status"],
]);
const VOTE_MARKER = "🗳️ بطاقة التصويت في لعبة الجاسوس";
const GUESS_MARKER = "🎯 بطاقة تخمين الجاسوس";
const PIXABAY_CREDIT = "📷 الصور من Pixabay: https://pixabay.com/";
const creditFor = (imageKey) =>
  spyImages.isPixabayKey(imageKey) ? `\n${PIXABAY_CREDIT}` : "";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// SPY_IMAGE_DELIVERY: attachment | link | host | both (hosted link + encrypted attachment)
function deliveryMode() {
  const mode = (process.env.SPY_IMAGE_DELIVERY || "attachment")
    .trim()
    .toLowerCase();
  if (!["attachment", "link", "host", "both"].includes(mode))
    throw new Error(
      "SPY_IMAGE_DELIVERY must be attachment, link, host, or both.",
    );
  if (["host", "both"].includes(mode)) return mode;
  if (mode === "link" && !imageLinks?.isConfigured()) {
    console.warn("[spy] SPY_IMAGE_DELIVERY=link but SPY_IMAGE_PUBLIC_BASE_URL is not configured; using attachment.");
    return "attachment";
  }
  return mode;
}

async function sendImageLink(psid, imageKey, title, image, caption) {
  const link =
    ["host", "both"].includes(deliveryMode())
      ? await imageHost.getUrl(imageKey, image || (await spyImages.getSceneImageByKey(imageKey)))
      : await imageLinks.createUrl("spy", imageKey);
  return msg.sendPrivateWithResult(
    psid,
    caption
      ? `${caption}\n${link}`
      : `الصورة السرية (لا تشاركها): ${link}\nصِفها دون ذكر اسمها أو كلماتها المفتاحية.`,
  );
}

async function deliverRoundImage({
  userId,
  imageKey,
  title,
  image,
  caption,
  fallbackText,
  label,
  requireImage = false,
}) {
  const mode = deliveryMode();
  let linkedResult = null;
  if (mode !== "attachment") {
    try {
      const linked = await sendImageLink(
        userId,
        imageKey,
        title,
        image,
        caption,
      );
      if (linked.ok && mode !== "both")
        return { ...linked, delivery: "link" };
      if (linked.ok) linkedResult = linked;
    } catch (error) {
      console.error(`[spy] ${label} link delivery failed:`, error.message);
    }
  }

  const sent = await msg.sendPrivateImageBufferWithResult(
    userId,
    image.buffer,
    image.contentType,
    caption,
  );
  if (sent.ok)
    return {
      ...sent,
      delivery: linkedResult ? "both" : "attachment",
    };

  console.error(`[spy] ${label} image delivery failed: ${sent.reason}`);
  if (linkedResult) return { ...linkedResult, delivery: "link" };
  if (requireImage) return sent;
  let text = fallbackText;
  try {
    if (imageLinks?.isConfigured()) {
      const link = await imageLinks.createUrl("spy", imageKey);
      text = `${fallbackText}\n\n🖼️ رابط خاص مؤقت للصورة (لا تشاركه):\n${link}`;
    }
  } catch (error) {
    console.error(`[spy] ${label} signed link fallback failed:`, error.message);
  }
  const fallback = await msg.sendPrivateWithResult(userId, text);
  return fallback.ok ? { ...fallback, degraded: true } : sent;
}

const getRoom = (roomId) =>
  db.one("SELECT * FROM game_rooms WHERE id=? AND game_id='spy'", [roomId]);
const getPlayers = (roomId) =>
  db.query("SELECT * FROM spy_players WHERE room_id=? ORDER BY id", [roomId]);
const getPlayer = (roomId, userId) =>
  db.one("SELECT * FROM spy_players WHERE room_id=? AND psid=?", [
    roomId,
    userId,
  ]);
const getActiveRoom = (threadId) =>
  db.one(
    "SELECT * FROM game_rooms WHERE thread_id=? AND game_id='spy' AND status IN ('lobby','playing') ORDER BY id DESC LIMIT 1",
    [threadId],
  );
const getSession = (userId) =>
  db.one(
    `SELECT sp.*, gr.thread_id, gr.host_psid, gr.status, gr.phase
     FROM spy_players sp JOIN game_rooms gr ON gr.id=sp.room_id
     WHERE sp.psid=? AND gr.game_id='spy' AND gr.status IN ('lobby','playing')
     ORDER BY sp.id DESC LIMIT 1`,
    [userId],
  );

async function ensureColumn(table, column, definition) {
  const found = await db.one(
    `SELECT COLUMN_NAME FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA=? AND TABLE_NAME=? AND COLUMN_NAME=?`,
    [process.env.DB_NAME || "detective_bot", table, column],
  );
  if (!found)
    await db.query(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${definition}`);
}

async function assertSchema() {
  const schemaPath = path.join(__dirname, "schema.sql");
  const schema = await fs.readFile(schemaPath, "utf8");
  const statements = schema
    .split(";")
    .map((statement) => statement.trim())
    .filter(Boolean);
  for (const statement of statements) await db.query(statement);

  await ensureColumn("spy_players", "is_out", "TINYINT(1) NOT NULL DEFAULT 0");
  await ensureColumn(
    "spy_rounds",
    "image_asset_key",
    "VARCHAR(120) NOT NULL DEFAULT ''",
  );
  await ensureColumn("spy_rounds", "image_title", "VARCHAR(160) NOT NULL DEFAULT ''");
  await ensureColumn("spy_rounds", "spy_hint", "VARCHAR(255) NOT NULL DEFAULT ''");
  await ensureColumn("spy_rounds", "forbidden_words", "JSON NULL");
  const spyIdColumn = await db.one(
    `SELECT IS_NULLABLE FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA=? AND TABLE_NAME='spy_rounds' AND COLUMN_NAME='spy_player_id'`,
    [process.env.DB_NAME || "detective_bot"],
  );
  if (spyIdColumn && spyIdColumn.IS_NULLABLE === "NO")
    await db.query(
      "ALTER TABLE spy_rounds MODIFY spy_player_id INT UNSIGNED NULL",
    );
}

async function reservePendingScene(roomId) {
  return db.withTransaction(async (query) => {
    await query(
      `UPDATE spy_pending_scenes ps
       LEFT JOIN game_rooms gr ON gr.id=ps.reserved_room_id
       SET ps.reserved_room_id=NULL
       WHERE ps.reserved_room_id IS NOT NULL
         AND (gr.id IS NULL OR gr.status!='playing' OR gr.phase!='assigning')`,
    );
    const rows = await query(
      `SELECT id, location_name, category, image_asset_key, image_title,
              spy_hint, forbidden_words
       FROM spy_pending_scenes
       WHERE reserved_room_id IS NULL
       ORDER BY id
       LIMIT 1
       FOR UPDATE`,
    );
    const scene = rows[0];
    if (!scene) return null;
    const reserved = await query(
      "UPDATE spy_pending_scenes SET reserved_room_id=? WHERE id=? AND reserved_room_id IS NULL",
      [roomId, scene.id],
    );
    if (!reserved.affectedRows)
      throw new Error(`Could not reserve pending spy scene ${scene.id}`);
    return scene;
  });
}

async function savePendingScene(roomId, scene) {
  const result = await db.query(
    `INSERT INTO spy_pending_scenes
      (reserved_room_id, location_name, category, image_asset_key, image_title,
       spy_hint, forbidden_words)
     VALUES (?,?,?,?,?,?,?)`,
    [
      roomId,
      scene.location_name,
      scene.category,
      scene.image_asset_key,
      scene.image_title,
      scene.spy_hint,
      serializeForbiddenWords(scene.forbidden_words),
    ],
  );
  return { ...scene, id: result.insertId };
}

async function releasePendingScene(roomId) {
  await db.query(
    "UPDATE spy_pending_scenes SET reserved_room_id=NULL WHERE reserved_room_id=?",
    [roomId],
  );
}

async function prepareRound(roomId) {
  let round = await db.one("SELECT * FROM spy_rounds WHERE room_id=?", [
    roomId,
  ]);
  let pending = await db.one(
    "SELECT * FROM spy_pending_scenes WHERE reserved_room_id=? ORDER BY id LIMIT 1",
    [roomId],
  );

  if (!pending && round) {
    pending = await savePendingScene(roomId, {
      location_name: round.location_name,
      category: round.category,
      image_asset_key: round.image_asset_key,
      image_title: round.image_title,
      spy_hint: round.spy_hint,
      forbidden_words: round.forbidden_words,
    });
  }
  if (!pending) pending = await reservePendingScene(roomId);

  if (!pending) {
    const { scene } = await spyImages.getRandomSceneImage();
    pending = await savePendingScene(roomId, {
      location_name: scene.title,
      category: "صورة",
      image_asset_key: scene.imageKey,
      image_title: scene.title,
      spy_hint: scene.spyHint,
      forbidden_words: JSON.stringify(scene.forbiddenWords),
    });
  }

  if (!round) {
    await db.query(
      `INSERT INTO spy_rounds
        (room_id, location_name, category, image_asset_key, image_title, spy_hint, forbidden_words, spy_player_id)
       VALUES (?,?,?,?,?,?,?,NULL)`,
      [
        roomId,
        pending.location_name,
        pending.category,
        pending.image_asset_key,
        pending.image_title,
        pending.spy_hint,
        serializeForbiddenWords(pending.forbidden_words),
      ],
    );
    round = {
      ...pending,
      room_id: roomId,
      spy_player_id: null,
    };
  }

  const image = await spyImages.getSceneImageByKey(round.image_asset_key);
  if (!image)
    throw new Error(
      `Image asset ${round.image_asset_key} is missing from the database cache.`,
    );
  return { round, image };
}

async function canHandleMessage({ userId, isGroup }) {
  return !isGroup && Boolean(await getSession(userId));
}

function commandParts(text) {
  const parts = String(text || "")
    .trim()
    .replace(/^[/!]\s*/, "")
    .split(/\s+/);
  return { name: (parts.shift() || "").toLowerCase(), arg: parts.join(" ") };
}

function numberedPlayers(players) {
  return new Map(players.map((player, index) => [index + 1, player]));
}

function playerList(players) {
  return [...numberedPlayers(players)]
    .map(([number, player]) => `${number}. ${player.display_name}`)
    .join("\n");
}

function normalizeText(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\u064B-\u065F\u0670\u0640]/g, "")
    .replace(/[أإآ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function parseForbiddenWords(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string") return [];
  const parsed = JSON.parse(value);
  if (!Array.isArray(parsed) || parsed.some((word) => typeof word !== "string"))
    throw new Error("Spy round forbidden_words must be a JSON string array.");
  return parsed;
}

function serializeForbiddenWords(value) {
  return JSON.stringify(parseForbiddenWords(value));
}

// المطابقة تتجاوز بادئات العربية («المنارة» و«بمنارة» و«والمنارة» = «منارة») وجموع بسيطة («منارات»، lighthouses)،
// وإلا كان يكفي أن يضيف اللاعب «ال» ليتحايل على الكلمة الممنوعة.
const AR_PREFIXES = ["وبال", "وال", "بال", "كال", "فال", "لل", "ال", "و", "ب", "ل", "ك", "ف"];
const SUFFIXES = ["ات", "ان", "ين", "ون", "ه", "es", "s"];

function coreForms(token) {
  const bases = new Set([token]);
  for (const prefix of AR_PREFIXES)
    if (token.startsWith(prefix) && token.length - prefix.length >= 2)
      bases.add(token.slice(prefix.length));
  const forms = new Set();
  for (const base of bases) {
    forms.add(base);
    for (const suffix of SUFFIXES)
      if (base.endsWith(suffix) && base.length - suffix.length >= 3)
        forms.add(base.slice(0, -suffix.length));
  }
  return forms;
}

function forbiddenWordInMessage(text, words) {
  const normalizedMessage = normalizeText(text);
  if (!normalizedMessage) return undefined;
  const padded = ` ${normalizedMessage} `;
  const tokenForms = normalizedMessage.split(" ").map(coreForms);
  return words.find((word) => {
    const normalizedWord = normalizeText(word);
    if (!normalizedWord) return false;
    if (normalizedWord.includes(" "))
      return padded.includes(` ${normalizedWord} `);
    const wordForms = coreForms(normalizedWord);
    return tokenForms.some((forms) => [...forms].some((form) => wordForms.has(form)));
  });
}

function correctGuess(guess, round) {
  const normalizedGuess = normalizeText(guess);
  if (!normalizedGuess) return false;
  if (normalizedGuess === normalizeText(round.image_title)) return true;
  // تخمين قصير فقط (حتى 6 كلمات) يحتوي كلمة مفتاحية؛ يمنع كتابة قائمة كلمات لاصطياد الإجابة
  if (normalizedGuess.split(" ").length > 6) return false;
  return Boolean(forbiddenWordInMessage(guess, parseForbiddenWords(round.forbidden_words)));
}

async function handleMessage(context) {
  const { name, arg } = commandParts(context.text);
  if (context.isGroup) {
    if (START_ALIASES.has(name))
      return createRoom(context.userId, context.threadId);
    return handleGroup(context, COMMANDS.get(name));
  }
  return handlePrivate(context, COMMANDS.get(name), arg);
}

async function handleReaction({ userId, threadId, messageId }) {
  const room = await db.one(
    `SELECT * FROM game_rooms
     WHERE game_id='spy' AND thread_id=? AND lobby_message_id=?
       AND status='lobby' AND phase='lobby'`,
    [threadId, messageId],
  );
  if (room) return registerPlayer(room, userId);
}

async function createRoom(userId, threadId) {
  if (await db.isUserBanned(userId))
    return msg.sendGroup(
      threadId,
      "أنت محظور من بدء الألعاب.",
    );
  const existing = await db.one(
    "SELECT game_id FROM game_rooms WHERE thread_id=? AND status IN ('lobby','playing') LIMIT 1",
    [threadId],
  );
  if (existing)
    return msg.sendGroup(
      threadId,
      "⚠️ توجد لعبة نشطة في المجموعة. أنهِها قبل بدء لعبة الجاسوس.",
    );

  const result = await db.query(
    "INSERT INTO game_rooms (game_id, thread_id, host_psid, status, phase) VALUES ('spy',?,?, 'lobby','lobby')",
    [threadId, userId],
  );
  const roomId = result.insertId;
  const messageId = await msg.sendGroupTracked(
    threadId,
    ui.lobbyMessage({
      title: "لعبة الجاسوس",
      tagline: "اكتشفوا الجاسوس قبل أن يخمّن الصورة.",
      min: CFG.MIN_PLAYERS,
      max: CFG.MAX_PLAYERS,
      seconds: CFG.LOBBY_SECONDS,
      leaveCommand: "خروج جاسوس",
    }),
  );
  if (!messageId) {
    await db.query(
      "UPDATE game_rooms SET status='cancelled', phase='finished', phase_ends_at=NULL WHERE id=? AND game_id='spy'",
      [roomId],
    );
    return;
  }
  await db.query(
    "UPDATE game_rooms SET lobby_message_id=?, phase_ends_at=DATE_ADD(NOW(), INTERVAL ? SECOND) WHERE id=? AND game_id='spy' AND status='lobby'",
    [messageId, CFG.LOBBY_SECONDS, roomId],
  );
}

async function registerPlayer(room, userId) {
  if (await getPlayer(room.id, userId)) return;
  if (await db.isUserBanned(userId))
    return msg.sendGroup(
      room.thread_id,
      "أنت محظور من التسجيل.",
    );

  const active = await db.one(
    `SELECT gr.game_id FROM game_rooms gr
     LEFT JOIN room_players rp ON rp.room_id=gr.id AND rp.psid=?
     LEFT JOIN storm_players stp ON stp.room_id=gr.id AND stp.psid=?
     LEFT JOIN spy_players spp ON spp.room_id=gr.id AND spp.psid=?
     LEFT JOIN feign_players fgp ON fgp.room_id=gr.id AND fgp.psid=?
     LEFT JOIN werewolf_players wwp ON wwp.room_id=gr.id AND wwp.psid=?
     LEFT JOIN drawing_players drp ON drp.room_id=gr.id AND drp.psid=?
     WHERE gr.status IN ('lobby','playing')
       AND (rp.id IS NOT NULL OR stp.id IS NOT NULL OR spp.id IS NOT NULL
            OR fgp.id IS NOT NULL OR wwp.id IS NOT NULL OR drp.id IS NOT NULL)
     LIMIT 1`,
    [userId, userId, userId, userId, userId, userId],
  );
  if (active)
    return msg.sendGroup(
      room.thread_id,
      "أنت مشارك في لعبة أخرى.",
    );

  const players = await getPlayers(room.id);
  if (players.length >= CFG.MAX_PLAYERS)
    return msg.sendGroup(room.thread_id, "⛔ اكتمل عدد لاعبي لعبة الجاسوس.");

  let name = await msg.getUserName(userId);
  if (players.some((player) => player.display_name === name))
    name = `${name} (${players.length + 1})`;
  try {
    await db.query(
      "INSERT INTO spy_players (room_id, psid, display_name) VALUES (?,?,?)",
      [room.id, userId, name],
    );
  } catch (error) {
    if (error.code === "ER_DUP_ENTRY") return;
    throw error;
  }
  const playerCount = players.length + 1;
  const announcement = ui.joinAnnouncement({
    name,
    count: playerCount,
    min: CFG.MIN_PLAYERS,
    max: CFG.MAX_PLAYERS,
  });
  if (announcement) await msg.sendGroup(room.thread_id, announcement);
}

async function startGame(roomId) {
  const room = await getRoom(roomId);
  if (!room || room.status !== "lobby" || room.phase !== "lobby") return;
  try {
    const reactors = await msg.getReactors(
      room.thread_id,
      room.lobby_message_id,
    );
    for (const userId of reactors) await registerPlayer(room, String(userId));
  } catch (error) {
    console.error(`[spy] reaction recovery failed for room ${roomId}:`, error);
  }

  const players = await getPlayers(roomId);
  if (players.length < CFG.MIN_PLAYERS) {
    const cancelled = await db.query(
      "UPDATE game_rooms SET status='cancelled', phase='finished', phase_ends_at=NULL WHERE id=? AND game_id='spy' AND status='lobby' AND phase='lobby'",
      [roomId],
    );
    if (!cancelled.affectedRows) return;
    return msg.sendGroup(
      room.thread_id,
      `لم يكتمل العدد (${CFG.MIN_PLAYERS})؛ أُلغيت اللعبة.`,
    );
  }

  const locked = await db.query(
    "UPDATE game_rooms SET status='playing', phase='assigning', phase_ends_at=NULL WHERE id=? AND game_id='spy' AND status='lobby'",
    [roomId],
  );
  if (!locked.affectedRows) return;

  const spy = players[randomInt(players.length)];
  let round;
  let image;
  try {
    ({ round, image } = await prepareRound(roomId));
    if (!round.image_asset_key)
      throw new Error(`Missing prepared spy image for room ${roomId}`);

    await db.withTransaction(async (query) => {
      await query(
        "UPDATE spy_players SET is_spy=0, is_out=0, guess_used=0 WHERE room_id=?",
        [roomId],
      );
      await query("UPDATE spy_players SET is_spy=1 WHERE id=? AND room_id=?", [
        spy.id,
        roomId,
      ]);
      const updatedRound = await query(
        "UPDATE spy_rounds SET spy_player_id=? WHERE room_id=? AND spy_player_id IS NULL",
        [spy.id, roomId],
      );
      if (!updatedRound.affectedRows)
        throw new Error(`Could not assign spy for room ${roomId}`);
    });
  } catch (error) {
    await db.query(
      "UPDATE game_rooms SET status='cancelled', phase='finished', phase_ends_at=NULL WHERE id=? AND game_id='spy' AND status='playing' AND phase='assigning'",
      [roomId],
    );
    await releasePendingScene(roomId);
    await msg.sendGroup(
      room.thread_id,
      "⚠️ تعذّر تجهيز الصورة أو الجولة، لذلك أُلغيت اللعبة. إن كانت الصورة قد جُهّزت فسيُعاد استخدامها في اللعبة التالية.",
    );
    throw error;
  }

  const RETRY_WAIT_SECONDS = Math.max(
    5,
    Number(process.env.SPY_DELIVERY_RETRY_SECONDS) || 25,
  );
  const degraded = [];

  // يوصل دور اللاعب. فشل الصورة لا يُلغي اللعبة فوراً: نجرّب رابطاً ثم وصفاً نصياً.
  async function deliverRole(player) {
    if (player.id === spy.id)
      return msg.sendPrivateWithResult(
        player.psid,
        `أنت الجاسوس. التلميح: ${round.spy_hint}\nإذا أُقصيت، لديك ${CFG.SPY_GUESS_SECONDS}ث ومحاولة واحدة للتخمين.`,
      );
    return deliverRoundImage({
      userId: player.psid,
      imageKey: round.image_asset_key,
      title: round.image_title,
      image,
      caption:
        "صورة سرية؛ لا تشاركها. صِفها دون ذكر اسمها أو كلماتها المفتاحية. لإعادتها: spyrole",
      fallbackText: "تعذّر إيصال صورة الجولة السرية.",
      label: `image delivery for player ${player.id}`,
      requireImage: true,
    });
  }

  async function deliverAll(list) {
    const failed = [];
    for (const player of list) {
      let result;
      try {
        result = await deliverRole(player);
      } catch (error) {
        console.error(
          `[spy] role delivery threw for player ${player.id}:`,
          error,
        );
        result = {
          ok: false,
          reason: error instanceof Error ? error.message : String(error),
        };
      }
      if (!result.ok) {
        failed.push(player);
        console.error(
          `[spy] private role delivery failed for player ${player.id}:`,
          result.reason,
        );
      } else if (result.degraded) degraded.push(player);
    }
    return failed;
  }

  let undelivered = await deliverAll(players);
  if (undelivered.length) {
    await msg.sendGroup(
      room.thread_id,
      `لم يصل الدور إلى ${undelivered.map((player) => player.display_name).join("، ")}. راجعوا طلبات الرسائل؛ سأعيد المحاولة بعد ${RETRY_WAIT_SECONDS}ث.`,
    );
    await sleep(RETRY_WAIT_SECONDS * 1000);
    const stillActive = await db.one(
      "SELECT id FROM game_rooms WHERE id=? AND game_id='spy' AND status='playing' AND phase='assigning'",
      [roomId],
    );
    if (!stillActive) {
      await releasePendingScene(roomId);
      return;
    }
    undelivered = await deliverAll(undelivered);
  }
  if (undelivered.length) {
    const cancelled = await db.query(
      "UPDATE game_rooms SET status='cancelled', phase='finished', phase_ends_at=NULL WHERE id=? AND game_id='spy' AND status='playing' AND phase='assigning'",
      [roomId],
    );
    if (cancelled.affectedRows) {
      await releasePendingScene(roomId);
      await msg.sendGroup(
        room.thread_id,
        `تعذّر إيصال الدور إلى ${undelivered.map((player) => player.display_name).join("، ")}؛ أُلغيت الجولة. راجعوا طلبات الرسائل وأعيدوا المحاولة.`,
      );
    }
    return;
  }

  const started = await db.withTransaction(async (query) => {
    const updated = await query(
      "UPDATE game_rooms SET phase='discussion', current_round=1, phase_ends_at=DATE_ADD(NOW(), INTERVAL ? SECOND) WHERE id=? AND game_id='spy' AND status='playing' AND phase='assigning'",
      [CFG.DISCUSSION_SECONDS, roomId],
    );
    if (updated.affectedRows)
      await query(
        "DELETE FROM spy_pending_scenes WHERE reserved_room_id=?",
        [roomId],
      );
    return updated;
  });
  if (!started.affectedRows) {
    await releasePendingScene(roomId);
    return;
  }

  // ترتيب وصف عشوائي مقترح لإشعال النقاش
  const order = players
    .map((player) => player.display_name)
    .sort(() => Math.random() - 0.5);
  const lines = [
    "🕵️ بدأت الجولة! وصلت الصورة السرية لكل اللاعبين… ما عدا واحد 😏",
    `⏱️ أمامكم ${CFG.DISCUSSION_SECONDS} ثانية للنقاش.`,
    "",
    "🎙️ ترتيب الوصف المقترح (جملة واحدة لكل لاعب):",
    ...order.map((name, index) => `${ui.numberEmoji(index + 1)} ${name}`),
    "",
    "🚫 ممنوع ذكر اسم الصورة أو كلماتها المفتاحية؛ من يذكر إحداها يخرج وحده.",
    "🗳️ بعد النقاش يبدأ التصويت السري في الخاص.",
  ];
  if (degraded.length)
    lines.push(
      "",
      `ℹ️ وصلت نسخة بديلة بدل الصورة إلى: ${degraded.map((player) => player.display_name).join("، ")}.`,
    );
  lines.push("", `🎤 ابدأ يا ${order[0]}!`);
  await msg.sendGroup(room.thread_id, lines.join("\n"));
}

async function handleGroup(context, command) {
  if (command === "test")
    return msg.sendGroup(
      context.threadId,
      "🔒 أمر اختبار صورة الجاسوس متاح في الخاص فقط. أرسل /spytest للبوت في محادثة خاصة.",
    );
  if (command === "help") return msg.sendGroup(context.threadId, helpText());
  if (command === "players") return listPlayers(context.threadId);
  if (command === "status") return showStatus(context.threadId);
  if (command === "leave") return leaveGame(context.userId, context.threadId);
  if (command === "cancel")
    return cancelGame(context.userId, context.threadId);
  if (command === "vote")
    return msg.sendGroup(
      context.threadId,
      "🗳️ التصويت سري: رد في الخاص على بطاقة التصويت المرسلة من البوت برقم اللاعب أو اسمه.",
    );
  if (command === "guess")
    return msg.sendGroup(
      context.threadId,
      "🔒 التخمين متاح للجاسوس في الخاص فقط، وبعد إقصائه بالتصويت.",
    );

  const session = await getPlayerInRoom(context.threadId, context.userId);
  if (!session || session.is_out || session.status !== "playing")
    return;
  if (session.phase !== "discussion") return;
  const round = await db.one(
    "SELECT forbidden_words, spy_player_id FROM spy_rounds WHERE room_id=?",
    [session.room_id],
  );
  if (!round) throw new Error(`Missing spy round for room ${session.room_id}`);
  const matched = forbiddenWordInMessage(
    context.text,
    parseForbiddenWords(round.forbidden_words),
  );
  if (!matched) return;

  const removed = await db.query(
    "UPDATE spy_players SET is_out=1 WHERE id=? AND room_id=? AND is_out=0",
    [session.id, session.room_id],
  );
  if (!removed.affectedRows) return;
  await msg.sendGroup(
    context.threadId,
    `🚫 خسر ${session.display_name} وحده بسبب ذكر كلمة ممنوعة، واستُبعد من الجولة.`,
  );
  if (session.is_spy)
    return startSpyGuess(session.room_id, "استُبعد الجاسوس بعد مخالفة الكلمات الممنوعة.");
  return checkRemainingPlayers(session.room_id);
}

async function getPlayerInRoom(threadId, userId) {
  return db.one(
    `SELECT sp.*, gr.status, gr.phase
     FROM spy_players sp JOIN game_rooms gr ON gr.id=sp.room_id
     WHERE gr.thread_id=? AND gr.game_id='spy' AND gr.status IN ('lobby','playing')
       AND sp.psid=? ORDER BY sp.id DESC LIMIT 1`,
    [threadId, userId],
  );
}

async function testSpyImage(userId) {
  let prepared;
  try {
    spyImages.assertConfigured();
    prepared = await spyImages.getRandomSceneImage();
  } catch (error) {
    console.error("[spy test] image preparation failed:", error.message);
    return msg.sendPrivate(
      userId,
      `❌ تعذّر تجهيز صورة الاختبار: ${error.message}`,
    );
  }

  const { scene, image } = prepared;
  let sent;
  try {
    sent = await deliverRoundImage({
      userId,
      imageKey: scene.imageKey,
      title: scene.title,
      image,
      caption: "🧪 اختبار صورة لعبة الجاسوس — هذه صورة الجولة السرية التجريبية.",
      fallbackText: `🧪 تعذّر إرسال الصورة كمرفق. المشهد الذي جرى تجهيزه هو: «${scene.title}».`,
      label: "private test",
    });
  } catch (error) {
    console.error("[spy test] image delivery failed:", error.message);
    return msg.sendPrivate(
      userId,
      `❌ جُهّزت الصورة لكن تعذّر إرسالها: ${error.message}`,
    );
  }

  if (!sent.ok)
    return msg.sendPrivate(
      userId,
      `❌ فشل إرسال صورة الاختبار: ${sent.reason || "خطأ غير معروف"}`,
    );
  if (sent.degraded)
    return msg.sendPrivate(
      userId,
      "⚠️ أُرسلت رسالة بديلة، لكن لم تصل الصورة كمرفق. راجع طريقة إرسال الصور وإعدادات الخاص.",
    );
  if (sent.delivery === "link" && deliveryMode() === "both")
    return msg.sendPrivate(
      userId,
      "⚠️ وصل رابط الصورة المؤقت، لكن تعذّر إرسال المرفق المباشر. افتح الرابط لمشاهدة الصورة، ويمكن مراجعة سجل البوت لمعرفة سبب فشل E2EE.",
    );
  if (sent.delivery === "link")
    return msg.sendPrivate(
      userId,
      "✅ نجح اختبار صورة الجاسوس عبر الرابط المؤقت. افتح الرابط المرسل بالأعلى لمشاهدة الصورة.",
    );
  if (sent.delivery === "both")
    return msg.sendPrivate(
      userId,
      "✅ نجح اختبار صورة الجاسوس: وصل رابط الصورة والمرفق المباشر.",
    );
  return msg.sendPrivate(
    userId,
    "✅ نجح اختبار تجهيز الصورة وإرسالها عبر مسار لعبة الجاسوس. لم تُنشأ مباراة ولم تُرسل صورة إلى أي مجموعة.",
  );
}

async function handlePrivate(context, command, argument) {
  if (command === "help") return msg.sendPrivate(context.userId, helpText());
  if (command === "test") return testSpyImage(context.userId);
  const session = await getSession(context.userId);
  if (!session) return;
  if (command === "role") return resendRole(context.userId, session);

  const isVoteReply = isReplyToBotPrompt(
    context.messageReply,
    VOTE_MARKER,
    msg.selfId?.(),
  );
  const isGuessReply = isReplyToBotPrompt(
    context.messageReply,
    GUESS_MARKER,
    msg.selfId?.(),
  );
  if (command === "guess") {
    if (!isGuessReply)
      return msg.sendPrivate(
        context.userId,
        "🔒 أرسل التخمين رداً على بطاقة تخمين الجاسوس التي أرسلها البوت.",
      );
    return guessImage(context.userId, session, argument);
  }
  if (session.phase === "spy_guess" && !command) {
    if (!isGuessReply)
      return msg.sendPrivate(
        context.userId,
        "🔒 أرسل التخمين رداً على بطاقة تخمين الجاسوس التي أرسلها البوت.",
      );
    return guessImage(context.userId, session, context.text);
  }
  if (
    command === "vote" ||
    (!command && (isVoteReply || /^\d+$/.test(context.text.trim())))
  ) {
    const choice =
      command === "vote" ? argument.trim() : String(context.text || "").trim();
    if (!isVoteReply)
      return msg.sendPrivate(
        context.userId,
        "🔒 للتصويت، رد على بطاقة التصويت المرسلة من البوت برقم اللاعب أو اسمه.",
      );
    const target = choice.match(/^\d+$/);
    if (target) return castVote(context.userId, session, Number(target[0]));
    if (choice) return castVote(context.userId, session, choice);
    return msg.sendPrivate(
      context.userId,
      "رد على بطاقة التصويت برقم اللاعب أو اسمه.",
    );
  }
}

async function resendRole(userId, session) {
  if (session.status === "lobby")
    return msg.sendPrivate(userId, "ستصلك الصورة أو تلميحك عند بدء اللعبة.");
  const round = await db.one(
    "SELECT image_asset_key, image_title, spy_hint FROM spy_rounds WHERE room_id=?",
    [session.room_id],
  );
  if (!round) return;
  if (session.is_spy)
    return msg.sendPrivate(userId, `🕵️ تلميح الصورة: ${round.spy_hint}`);
  try {
    const image = await spyImages.getSceneImageByKey(round.image_asset_key);
    if (!image)
      throw new Error(
        `Image asset ${round.image_asset_key} is missing from the database cache.`,
      );
    const sent = await deliverRoundImage({
      userId,
      imageKey: round.image_asset_key,
      title: round.image_title,
      image,
      caption: `🖼️ صورة الجولة السرية (لا تشاركها 🤫):\n\nصف الصورة دون ذكر كلمتها المفتاحية.${creditFor(round.image_asset_key)}`,
      fallbackText: "تعذّر إيصال صورة الجولة السرية.",
      label: `role resend for player ${userId}`,
      requireImage: true,
    });
    if (!sent.ok)
      return msg.sendPrivate(
        userId,
        `⚠️ تعذر إرسال الصورة: ${sent.reason || "خطأ غير معروف"}`,
      );
    if (sent.delivery === "link" && deliveryMode() === "both")
      return msg.sendPrivate(
        userId,
        "⚠️ وصل رابط الصورة المؤقت لكن لم يصل المرفق المباشر. افتح الرابط لمشاهدة الصورة.",
      );
  } catch (error) {
    console.error("[spy] role resend failed:", error.message);
    return msg.sendPrivate(userId, "⚠️ تعذر تجهيز صورة الجولة المحفوظة.");
  }
}

async function startVoting(roomId) {
  const updated = await db.query(
    "UPDATE game_rooms SET phase='voting', phase_ends_at=DATE_ADD(NOW(), INTERVAL ? SECOND) WHERE id=? AND game_id='spy' AND status='playing' AND phase='discussion'",
    [CFG.VOTING_SECONDS, roomId],
  );
  if (!updated.affectedRows) return;
  const room = await getRoom(roomId);
  const players = (await getPlayers(roomId)).filter((player) => !player.is_out);
  if (players.length < 2)
    return checkRemainingPlayers(roomId);

  await msg.sendGroup(
    room.thread_id,
    `التصويت (${CFG.VOTING_SECONDS}ث): ${players.map((player) => player.display_name).join("، ")}\nصوّتوا سراً في الخاص؛ يمكن تغيير الصوت.`,
  );
  const failed = [];
  for (const player of players) {
    const choices = playerList(
      players.filter((candidate) => candidate.id !== player.id),
    );
    const sent = await msg.sendPrivateWithResult(
      player.psid,
      `${VOTE_MARKER}\nمن الجاسوس؟ رد على هذه البطاقة برقم اللاعب أو اسمه.\n${choices}\nلا تصوّت لنفسك؛ يمكنك تغيير صوتك.`,
    );
    if (!sent.ok) {
      failed.push(player);
      console.error(
        `[spy] vote card delivery failed for player ${player.id}:`,
        sent.reason,
      );
    }
  }
  // لا نُلغي اللعبة بسبب تعذّر تسليم بطاقة واحدة.
  if (failed.length)
    await msg.sendGroup(
      room.thread_id,
      `تعذّر تسليم بطاقة التصويت إلى ${failed.map((player) => player.display_name).join("، ")}؛ لا يُقبل التصويت دون الرد على بطاقة البوت.`,
    );
}

function findTargetByName(targets, text) {
  const wanted = normalizeText(text);
  if (!wanted) return null;
  const exact = targets.filter((player) => normalizeText(player.display_name) === wanted);
  if (exact.length === 1) return exact[0];
  const partial = targets.filter((player) => normalizeText(player.display_name).includes(wanted));
  return partial.length === 1 ? partial[0] : null;
}

async function castVote(userId, session, choice) {
  if (session.status !== "playing" || session.phase !== "voting")
    return msg.sendPrivate(userId, "⌛ لا يوجد تصويت مفتوح الآن.");
  if (session.is_out)
    return msg.sendPrivate(userId, "⛔ تم استبعادك ولا يمكنك التصويت.");
  const activePlayers = (await getPlayers(session.room_id)).filter(
    (player) => !player.is_out,
  );
  const eligibleTargets = activePlayers.filter(
    (player) => player.id !== session.id,
  );
  const target =
    typeof choice === "number"
      ? numberedPlayers(eligibleTargets).get(choice)
      : findTargetByName(eligibleTargets, choice);
  if (!target)
    return msg.sendPrivate(
      userId,
      "اختر رقماً أو اسماً صحيحاً من بطاقة التصويت التي رددت عليها.",
    );
  await db.query(
    `INSERT INTO spy_votes (room_id, voter_player_id, target_player_id)
     VALUES (?,?,?) ON DUPLICATE KEY UPDATE target_player_id=VALUES(target_player_id)`,
    [session.room_id, session.id, target.id],
  );
  const voteCount = await db.one(
    `SELECT COUNT(*) AS count FROM spy_votes sv
     JOIN spy_players sp ON sp.id=sv.voter_player_id
     WHERE sv.room_id=? AND sp.is_out=0`,
    [session.room_id],
  );
  const count = Number(voteCount.count);
  await msg.sendPrivate(
    userId,
    `✅ سُجل تصويتك لـ ${target.display_name}.${count === activePlayers.length ? " اكتمل تصويت الجميع!" : " يمكنك تغييره قبل انتهاء الوقت."}`,
  );
  if (count >= activePlayers.length)
    return resolveVoting(session.room_id);
}

async function resolveVoting(roomId) {
  const lock = await db.query(
    "UPDATE game_rooms SET phase='tallying', phase_ends_at=NULL WHERE id=? AND game_id='spy' AND status='playing' AND phase='voting'",
    [roomId],
  );
  if (!lock.affectedRows) return;
  const [round, players, tally] = await Promise.all([
    db.one("SELECT spy_player_id FROM spy_rounds WHERE room_id=?", [roomId]),
    getPlayers(roomId).then((all) => all.filter((player) => !player.is_out)),
    db.query(
      `SELECT sv.target_player_id, COUNT(*) AS votes
       FROM spy_votes sv JOIN spy_players sp ON sp.id=sv.voter_player_id
       WHERE sv.room_id=? AND sp.is_out=0
       GROUP BY sv.target_player_id
       ORDER BY votes DESC, sv.target_player_id`,
      [roomId],
    ),
  ]);
  if (!round) throw new Error(`Missing spy round for room ${roomId}`);
  if (tally.length) {
    const names = new Map(players.map((player) => [Number(player.id), player.display_name]));
    const lines = tally.map(
      (row) =>
        `• ${names.get(Number(row.target_player_id)) || "؟"}: ${row.votes} ${Number(row.votes) === 1 ? "صوت" : "أصوات"}`,
    );
    const room = await getRoom(roomId);
    await msg.sendGroup(room.thread_id, `📊 نتيجة التصويت:\n${lines.join("\n")}`);
  }
  const top = tally[0];
  const tied = tally[1] && Number(tally[1].votes) === Number(top?.votes);
  const majority = top && Number(top.votes) > Math.floor(players.length / 2);
  if (!top || tied || !majority)
    return finishGame(roomId, "spy", "🕵️ لم يحصل أي مشتبه به على أغلبية الأصوات.");
  if (Number(top.target_player_id) === Number(round.spy_player_id))
    return startSpyGuess(roomId, "صوّت اللاعبون لإقصاء الجاسوس.");

  const suspected = players.find(
    (player) => Number(player.id) === Number(top.target_player_id),
  );
  return finishGame(
    roomId,
    "spy",
    `❌ صوّتتم لـ ${suspected?.display_name || "مشتبه به آخر"}، لكنه ليس الجاسوس.`,
  );
}

async function startSpyGuess(roomId, reason) {
  const updated = await db.query(
    "UPDATE game_rooms SET phase='spy_guess', phase_ends_at=DATE_ADD(NOW(), INTERVAL ? SECOND) WHERE id=? AND game_id='spy' AND status='playing' AND phase IN ('discussion','voting','tallying')",
    [CFG.SPY_GUESS_SECONDS, roomId],
  );
  if (!updated.affectedRows) return;
  const [room, round] = await Promise.all([
    getRoom(roomId),
    db.one(
      "SELECT spy_player_id, spy_hint FROM spy_rounds WHERE room_id=?",
      [roomId],
    ),
  ]);
  if (!round) throw new Error(`Missing spy round for room ${roomId}`);
  await db.query(
    "UPDATE spy_players SET is_out=1 WHERE id=? AND room_id=?",
    [round.spy_player_id, roomId],
  );
  const spy = await db.one(
    "SELECT psid FROM spy_players WHERE id=? AND room_id=?",
    [round.spy_player_id, roomId],
  );
  await msg.sendGroup(
    room.thread_id,
    `${reason} الجاسوس لديه ${CFG.SPY_GUESS_SECONDS}ث ومحاولة واحدة. التخمين الصحيح يفوز.`,
  );
  const sent = await msg.sendPrivateWithResult(
    spy.psid,
    `${GUESS_MARKER}\nلديك ${CFG.SPY_GUESS_SECONDS}ث ومحاولة واحدة.\nالتلميح: ${round.spy_hint}\nرد على هذه الرسالة باسم الصورة.`,
  );
  if (!sent.ok)
    return finishGame(
      roomId,
      "citizens",
      "تعذّر إيصال فرصة التخمين للجاسوس؛ فاز بقية اللاعبين.",
    );
}

async function guessImage(userId, session, guess) {
  if (session.status !== "playing" || session.phase !== "spy_guess")
    return msg.sendPrivate(
      userId,
      "⌛ لا تتاح محاولة التخمين إلا للجاسوس بعد إقصائه.",
    );
  if (!session.is_spy || !session.is_out)
    return msg.sendPrivate(userId, "🔒 التخمين متاح للجاسوس المستبعد فقط.");
  if (session.guess_used)
    return msg.sendPrivate(userId, "⛔ استخدمت محاولة التخمين بالفعل.");
  if (!guess.trim())
    return msg.sendPrivate(userId, "رد على بطاقة تخمين الجاسوس باسم الصورة.");
  const used = await db.query(
    "UPDATE spy_players SET guess_used=1 WHERE id=? AND room_id=? AND is_spy=1 AND is_out=1 AND guess_used=0",
    [session.id, session.room_id],
  );
  if (!used.affectedRows)
    return msg.sendPrivate(userId, "⛔ استخدمت محاولة التخمين بالفعل.");

  const round = await db.one(
    "SELECT image_title, forbidden_words FROM spy_rounds WHERE room_id=?",
    [session.room_id],
  );
  if (!round) throw new Error(`Missing spy round for room ${session.room_id}`);
  if (correctGuess(guess, round))
    return finishGame(
      session.room_id,
      "spy",
      "✅ تخمين صحيح! نجح الجاسوس في معرفة الصورة.",
    );
  return finishGame(
    session.room_id,
    "citizens",
    "❌ أخطأ الجاسوس في تخمين الصورة.",
  );
}

async function checkRemainingPlayers(roomId) {
  const players = await getPlayers(roomId);
  const active = players.filter((player) => !player.is_out);
  const round = await db.one(
    "SELECT spy_player_id FROM spy_rounds WHERE room_id=?",
    [roomId],
  );
  if (!round) throw new Error(`Missing spy round for room ${roomId}`);
  const spyOut = players.find(
    (player) =>
      Number(player.id) === Number(round.spy_player_id) && player.is_out,
  );
  if (spyOut)
    return startSpyGuess(roomId, "خسر الجاسوس بسبب ذكر كلمة ممنوعة.");
  if (active.length < 2)
    return finishGame(
      roomId,
      "spy",
      "لم يتبقَّ عدد كافٍ من اللاعبين لمواصلة الجولة.",
    );
}

async function finishGame(roomId, winner, message) {
  const result = await db.query(
    "UPDATE game_rooms SET status='finished', phase='finished', phase_ends_at=NULL, winner=NULL WHERE id=? AND game_id='spy' AND status='playing' AND phase IN ('discussion','voting','tallying','spy_guess')",
    [roomId],
  );
  if (!result.affectedRows) return;
  await db.query("UPDATE spy_rounds SET result=? WHERE room_id=?", [
    winner,
    roomId,
  ]);
  const [room, round, players] = await Promise.all([
    getRoom(roomId),
    db.one(
      "SELECT image_title, image_asset_key, spy_player_id FROM spy_rounds WHERE room_id=?",
      [roomId],
    ),
    getPlayers(roomId),
  ]);
  if (!round) throw new Error(`Missing spy round for room ${roomId}`);
  const spy = players.find(
    (player) => Number(player.id) === Number(round.spy_player_id),
  );
  const winners =
    winner === "spy"
      ? players.filter(
          (player) => Number(player.id) === Number(round.spy_player_id),
        )
      : players.filter(
          (player) => Number(player.id) !== Number(round.spy_player_id),
        );
  await leaderboard.recordPoints("spy", roomId, winners);
  const outcome =
    winner === "spy"
      ? "🏆 فاز الجاسوس! خدعكم جميعاً 😎"
      : "🏆 فاز بقية اللاعبين! انكشف الجاسوس 🎉";
  const text = `${message}\n${outcome}\nالجاسوس: ${spy?.display_name || "غير معروف"} | الصورة: ${round.image_title}${creditFor(round.image_asset_key)}\nلجولة جديدة: جاسوس`;

  // نكشف الصورة نفسها في المجموعة بعد انتهاء اللعبة (آمن الآن)؛ وإن فشلت نرسل النص فقط
  let revealed = false;
  try {
    const image = await spyImages.getSceneImageByKey(round.image_asset_key);
    if (image)
      revealed = Boolean(
        await msg.sendGroupImageBufferTracked(
          room.thread_id,
          image.buffer,
          image.contentType,
          text,
        ),
      );
  } catch (error) {
    console.error("[spy] reveal image failed:", error.message);
  }
  if (!revealed) await msg.sendGroup(room.thread_id, text);
}

const PHASE_LABELS = {
  lobby: "التسجيل 📝",
  assigning: "توزيع الصور 📩",
  discussion: "النقاش 🗣️",
  voting: "التصويت 🗳️",
  tallying: "فرز الأصوات 📊",
  spy_guess: "تخمين الجاسوس 🕵️",
};

async function showStatus(threadId) {
  const room = await getActiveRoom(threadId);
  if (!room) return msg.sendGroup(threadId, "ℹ️ لا توجد لعبة جاسوس نشطة. اكتبوا «جاسوس» لبدء واحدة!");
  const [players, timing] = await Promise.all([
    getPlayers(room.id),
    db.one(
      "SELECT TIMESTAMPDIFF(SECOND, NOW(), phase_ends_at) AS remaining FROM game_rooms WHERE id=?",
      [room.id],
    ),
  ]);
  const lines = [
    `🕵️ حالة لعبة الجاسوس: ${PHASE_LABELS[room.phase] || room.phase}`,
  ];
  if (timing && timing.remaining !== null && Number(timing.remaining) > 0)
    lines.push(`⏳ الوقت المتبقي: ${timing.remaining} ثانية`);
  lines.push(
    `👥 اللاعبون: ${players.map((player) => `${player.display_name}${player.is_out ? " ❌" : ""}`).join("، ") || "—"}`,
  );
  if (room.phase === "voting") {
    const missing = await db.query(
      `SELECT sp.display_name FROM spy_players sp
       WHERE sp.room_id=? AND sp.is_out=0 AND NOT EXISTS (
         SELECT 1 FROM spy_votes sv WHERE sv.room_id=sp.room_id AND sv.voter_player_id=sp.id)`,
      [room.id],
    );
    if (missing.length)
      lines.push(`⏰ لم يصوّت بعد: ${missing.map((row) => row.display_name).join("، ")}`);
  }
  return msg.sendGroup(threadId, lines.join("\n"));
}

async function listPlayers(threadId) {
  const room = await getActiveRoom(threadId);
  if (!room)
    return msg.sendGroup(threadId, "ℹ️ لا توجد لعبة جاسوس نشطة.");
  const players = await getPlayers(room.id);
  return msg.sendGroup(
    threadId,
    `🕵️ لاعبو الجاسوس (${players.length}):\n${players.map((player) => `• ${player.display_name}${player.is_out ? " — مستبعد" : ""}`).join("\n") || "لا يوجد لاعبون بعد."}`,
  );
}

async function leaveGame(userId, threadId) {
  const room = await getActiveRoom(threadId);
  if (!room || room.status !== "lobby") return;
  const player = await getPlayer(room.id, userId);
  if (!player) return;
  if (room.host_psid === userId)
    return cancelGame(userId, threadId);
  await db.query("DELETE FROM spy_players WHERE id=?", [player.id]);
  await msg.sendGroup(threadId, `👋 غادر ${player.display_name} التسجيل.`);
}

async function cancelGame(userId, threadId, isAdmin = false) {
  const room = await getActiveRoom(threadId);
  if (!room) return;
  if (room.host_psid !== userId && !isAdmin)
    return msg.sendGroup(
      threadId,
      "⛔ مضيف اللعبة فقط يستطيع إلغاء لعبة الجاسوس.",
    );
  const cancelled = await db.query(
    "UPDATE game_rooms SET status='cancelled', phase='finished', phase_ends_at=NULL WHERE id=? AND game_id='spy' AND status IN ('lobby','playing')",
    [room.id],
  );
  if (!cancelled.affectedRows) return;
  return msg.sendGroup(threadId, "🚫 أُلغيت لعبة الجاسوس.");
}

async function handleDueRoom(room) {
  if (room.status === "lobby") return startGame(room.id);
  if (room.phase === "discussion") return startVoting(room.id);
  if (room.phase === "voting") return resolveVoting(room.id);
  if (room.phase === "spy_guess")
    return finishGame(
      room.id,
      "citizens",
      "انتهت مهلة التخمين ولم يرسل الجاسوس إجابته.",
    );
}

let ticking = false;
async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    const rooms = await db.query(
      `SELECT id, status, phase FROM game_rooms
       WHERE game_id='spy' AND status IN ('lobby','playing')
         AND phase_ends_at IS NOT NULL AND phase_ends_at<=NOW()
         AND phase IN ('lobby','discussion','voting','spy_guess')`,
    );
    for (const room of rooms) {
      try {
        await handleDueRoom(room);
      } catch (error) {
        console.error(`[spy] ticker failed for room ${room.id}:`, error);
      }
    }
  } finally {
    ticking = false;
  }
}

function startTicker() {
  setInterval(() => {
    tick().catch((error) => console.error("[spy] ticker failed:", error));
  }, 3000);
}

function helpText() {
  return `الجاسوس (${CFG.MIN_PLAYERS}-${CFG.MAX_PLAYERS} لاعباً): اكتب جاسوس وتفاعل للانضمام. الصورة للاعبين في الخاص؛ الجاسوس يتلقى تلميحاً.
صفوا الصورة دون كلماتها المفتاحية؛ الكلمة الممنوعة تُقصي قائلها. التصويت سري في الخاص، ويمكن تغيير الصوت.
إذا أُقصي الجاسوس، لديه ${CFG.SPY_GUESS_SECONDS}ث ومحاولة واحدة لتخمين الصورة.
صوّت أو أرسل التخمين بالرد على بطاقة البوت المناسبة فقط؛ لا تُقبل أوامر مباشرة.
الأوامر: /قواعد جاسوس، /لاعبين جاسوس، /حالة جاسوس، /خروج جاسوس، /إلغاء جاسوس؛ في الخاص: /دوري جاسوس.`;
}

module.exports = {
  assertSchema,
  handleMessage,
  handleReaction,
  cancelActiveGame: cancelGame,
  canHandleMessage,
  startTicker,
  normalizeText,
  forbiddenWordInMessage,
  correctGuess,
  deliveryMode,
  deliverRoundImage,
  _internal: { castVote },
};
