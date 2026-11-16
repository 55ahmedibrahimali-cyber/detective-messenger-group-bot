// games/crime/engine.js - محرك لعبة التحقيق
// الغرفة = المجموعة نفسها. الأوامر والنقاش في المجموعة، والأدوار السرية والتصويت في الخاص.
// الانتقالات بين المراحل عبر ticker يعتمد على phase_ends_at في MySQL (يصمد أمام إعادة التشغيل)
// وكل انتقال محميّ بـ UPDATE شرطي (affectedRows) لمنع التنفيذ المزدوج.
const { randomInt } = require("node:crypto");
const db = require("../../database");
const msg = require("../../services/messenger");
const leaderboard = require("../../services/leaderboard");
const crime = require("./caseService");
const crimeAI = require("./aiProvider");
const ui = require("../../services/interaction");
const { findActiveGameForPlayer } = require("../../services/activeGameLookup");
const { isReplyToBotPrompt } = require("../../services/replyPrompts");
const CFG = require("./config");
const VOTE_MARKER = "🗳️ بطاقة التصويت في مين قتل كريم";

const shuffle = (arr) => {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

const setPhase = (roomId, from, to, seconds, extra = "") =>
  db.query(
    `UPDATE game_rooms SET phase=?, phase_ends_at=${seconds ? "DATE_ADD(NOW(), INTERVAL ? SECOND)" : "NULL"} ${extra}
     WHERE id=? AND phase IN (${from.map(() => "?").join(",")})`,
    [to, ...(seconds ? [seconds] : []), roomId, ...from],
  );

// ============================== الأوامر ==============================
const ALIASES = {
  new: ["جريمة"],
  leave: ["leave", "خروج", "مغادرة"],
  cancel: ["cancel", "الغاء", "إلغاء"],
  players: ["players", "لاعبين", "اللاعبين"],
  help: ["help", "مساعدة", "قواعدقتل", "قواعدقتل كريم", "قواعدجريمة", "طريقة", "شرح"],
  role: ["role", "دوري"],
  test: ["test", "تجربة", "اختبار"],
  vote: ["vote", "تصويت", "صوت"],
  bio: ["bio", "تعريف", "شخصيتي"],
  case: ["case", "قضية"],
  stock: ["stock", "تجهيزقضايا", "قضايااحتياط"],
};
const CMD_LOOKUP = new Map(
  Object.entries(ALIASES).flatMap(([k, v]) => v.map((a) => [a, k])),
);

/** "/vote 2" is a vote payload only when it replies to the vote card. */
function parseCommand(text) {
  const bareCommand = text.trim().toLowerCase();
  if (["test", "تجربة", "اختبار"].includes(bareCommand))
    return { name: "test", arg: "" };
  if (bareCommand === "قضية")
    return { name: "case", arg: "" };
  const bareStock = bareCommand.match(/^(تجهيزقضايا|قضايااحتياط)(?:\s+(\d+))?$/);
  if (bareStock)
    return { name: "stock", arg: bareStock[2] || "" };
  if (/^[\/!]\s*قواعدقتل(?:\s+كريم)?$/i.test(text.trim()))
    return { name: "help", arg: "" };
  if (CMD_LOOKUP.get(bareCommand) === "new")
    return { name: "new", arg: "" };
  const m = text.match(/^[\/!]\s*(\S+)\s*(.*)$/s);
  if (!m) return null;
  const name = CMD_LOOKUP.get(m[1].toLowerCase());
  return name ? { name, arg: m[2].trim() } : null;
}

// ============================== مساعدات ==============================
const getRoomByThread = (threadId) =>
  db.one(
    "SELECT * FROM game_rooms WHERE thread_id=? AND game_id='crime' AND status IN ('lobby','playing') ORDER BY id DESC LIMIT 1",
    [threadId],
  );
const getPlayers = (roomId) =>
  db.query("SELECT * FROM room_players WHERE room_id=? ORDER BY id", [roomId]);
const getRoom = (roomId) =>
  db.one("SELECT * FROM game_rooms WHERE id=? AND game_id='crime'", [roomId]);
const getPlayer = (roomId, userId) =>
  db.one("SELECT * FROM room_players WHERE room_id=? AND psid=?", [
    roomId,
    userId,
  ]);

/** جلسة لاعب (للرسائل الخاصة): آخر غرفة نشطة له */
const getSessionByUser = (userId) =>
  db.one(
    `SELECT rp.id AS player_id, rp.room_id, rp.display_name, rp.role, rp.character_name, rp.is_alive,
            rp.character_bio, rp.alibi, rp.secret_note,
            gr.thread_id, gr.status, gr.phase, gr.current_round, gr.host_psid
     FROM room_players rp JOIN game_rooms gr ON gr.id = rp.room_id
     WHERE rp.psid=? AND gr.game_id='crime' AND gr.status IN ('lobby','playing')
     ORDER BY rp.id DESC LIMIT 1`,
    [userId],
  );
const canHandleMessage = async ({ userId, isGroup }) =>
  !isGroup && Boolean(await getSessionByUser(userId));

async function say(roomId, text) {
  const r = await db.one(
    "SELECT thread_id FROM game_rooms WHERE id=? AND game_id='crime'",
    [roomId],
  );
  if (r) await msg.sendGroup(r.thread_id, text);
}
const aliveNames = (players) =>
  players
    .filter((p) => p.is_alive)
    .map((p) => `• ${p.display_name}`)
    .join("\n");

function replaceCharacterNames(text, players) {
  const names = new Map();
  for (const player of players) {
    if (!player.character_name || !player.display_name) continue;
    for (const name of [
      player.character_name,
      player.character_name.split(/[،,]/, 1)[0].trim(),
    ]) {
      if (name) names.set(name, player.display_name);
    }
  }
  const alternatives = [...names.keys()].sort((a, b) => b.length - a.length);
  if (!alternatives.length) return String(text || "");
  const escaped = alternatives.map((name) =>
    name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
  );
  const pattern = new RegExp(
    `(?<![\\p{L}\\p{N}])(?:${escaped.join("|")})(?![\\p{L}\\p{N}])`,
    "giu",
  );
  return String(text || "").replace(pattern, (name) => names.get(name) || name);
}

// ============================== نقطة الدخول ==============================
async function handleMessage({ userId, threadId, isGroup, text, messageReply }) {
  const cmd = parseCommand(text);
  return isGroup
    ? handleGroup(userId, threadId, text, cmd)
    : handleDM(userId, text, cmd, messageReply);
}

async function handleReaction({ userId, threadId, messageId }) {
  const room = await db.one(
    "SELECT * FROM game_rooms WHERE thread_id=? AND lobby_message_id=? AND game_id='crime' AND status='lobby' AND phase='lobby'",
    [threadId, messageId],
  );
  if (!room) return;
  return registerPlayerByReaction(room, userId);
}

async function registerPlayerByReaction(room, userId) {
  if (await getPlayer(room.id, userId)) return;
  if (await db.isUserBanned(userId)) {
    await msg.sendGroup(
      room.thread_id,
      "أنت محظور من التسجيل.",
    );
    return;
  }
  const activeGame = await findActiveGameForPlayer(userId);
  if (activeGame) {
    await msg.sendGroup(
      room.thread_id,
      "⚠️ لا يمكنك التسجيل لأنك مشارك في لعبة أخرى.",
    );
    return;
  }

  const players = await getPlayers(room.id);
  if (players.length >= CFG.MAX) {
    await msg.sendGroup(room.thread_id, "⛔ اكتمل عدد اللاعبين في هذه الغرفة.");
    return;
  }

  let name = await msg.getUserName(userId);
  try {
    await db.query(
      "INSERT INTO room_players (room_id, psid, display_name) VALUES (?,?,?)",
      [room.id, userId, name],
    );
  } catch (e) {
    if (e.code === "ER_DUP_ENTRY") return;
    throw e;
  }

  const playerCount = players.length + 1;
  const announcement = ui.joinAnnouncement({
    name,
    count: playerCount,
    min: CFG.MIN,
    max: CFG.MAX,
  });
  if (announcement) await msg.sendGroup(room.thread_id, announcement);
}

async function handleGroup(userId, threadId, _text, cmd) {
  if (!cmd) return; // نقاش اللاعبين العادي: البوت لا يتدخل
  switch (cmd.name) {
    case "help":
      return howTo(threadId);
    case "test":
      return msg.sendGroup(
        threadId,
        "إرسال المجموعة يعمل. لاختبار الخاص أرسل «تجربة» للبوت.",
      );
    case "new":
      return createRoom(userId, threadId);
    case "players":
      return listPlayers(threadId);
    case "leave":
      return leaveRoom(userId, threadId);
    case "cancel":
      return cancelRoom(userId, threadId);
    case "bio":
      return publishCharacter(userId, threadId);
    case "vote":
      return msg.sendGroup(
        threadId,
        "🔒 التصويت سرّي: رد على بطاقة التصويت التي تصلك في الخاص برقم المشتبه به.",
      );
    default:
      return;
  }
}

async function publishCharacter(userId, threadId) {
  const room = await getRoomByThread(threadId);
  if (!room || room.status !== "playing") {
    return msg.sendGroup(
      threadId,
      "ℹ️ تظهر الشخصيات والنبذات تلقائياً في رسالة بداية اللعبة.",
    );
  }
  const player = await getPlayer(room.id, userId);
  if (!player || !player.character_name)
    return msg.sendGroup(
      threadId,
      "ℹ️ سجّل بالتفاعل مع رسالة بدء التسجيل لتشارك في اللعبة.",
    );
  return msg.sendGroup(
    threadId,
    "ℹ️ نُشرت أسماء المشتبه بهم والشخصيات والنبذات تلقائياً عند بدء اللعبة. تبدأ الجولة الأولى بعد دقيقة.",
  );
}

async function handleDM(userId, text, cmd, messageReply = null) {
  const isVoteNumber = /^\d+$/.test(text);
  if (!cmd && !isVoteNumber) return;

  if (cmd?.name === "help") return msg.sendPrivate(userId, helpText());
  if (cmd?.name === "test") return testPrivateConnection(userId);
  if (cmd?.name === "case") return sendGeneratedCasePreview(userId);
  if (cmd?.name === "stock") return sendFictionalCaseStock(userId, cmd.arg);
  const s = await getSessionByUser(userId);

  if (cmd?.name === "role") return resendRole(userId, s);

  // A vote must be a reply to this game's bot-issued ballot.
  const numMatch =
    cmd?.name === "vote" ? cmd.arg.match(/^\d+$/) : text.match(/^\d+$/);
  const isVoteReply = isReplyToBotPrompt(
    messageReply,
    VOTE_MARKER,
    msg.selfId?.(),
  );
  if (numMatch && isVoteReply)
    return castVote(userId, s, Number(numMatch[0]));
  if (numMatch || cmd?.name === "vote") {
    if (s?.status === "playing" && ["voting", "final_voting"].includes(s.phase))
      return msg.sendPrivate(
        userId,
        "🔒 للتصويت، رد على بطاقة التصويت المرسلة من البوت برقم اللاعب فقط.",
      );
    return msg.sendPrivate(
      userId,
      "⌛ لا يوجد تصويت مفتوح الآن.",
    );
  }
}

async function sendGeneratedCasePreview(userId) {
  const started = await msg.sendPrivate(
    userId,
    "⏳ أجهّز قضية خيالية تجريبية جديدة عبر Gemini. قد يستغرق ذلك بعض الوقت.",
  );
  if (!started) return;

  try {
    const kase = await crime.generateFictionalCaseForTesting();
    const suspects = [kase.killer, ...kase.innocents]
      .map((person) => `• ${person.name}: ${person.bio}\nالدافع: ${person.motive}`)
      .join("\n\n");
    const clues = kase.clues
      .map((clue, index) => `${index + 1}. ${clue.clue_text}`)
      .join("\n");
    const sent = await msg.sendPrivateWithResult(
      userId,
      `🧪 قضية تجريبية مولّدة بالذكاء الاصطناعي\n\n🕵️ ${kase.title}\n\n${kase.summary}\n\n📍 ${kase.setting}\n⚰️ ${kase.victim_name}: ${kase.victim_desc}\n\n👥 الشخصيات:\n${suspects}\n\n🔎 الأدلة:\n${clues}\n\n✅ الحل: ${kase.solution}\n🔪 القاتل في بيانات اللعبة: ${kase.killer.name}`,
    );
    if (!sent.ok)
      console.error("[case preview] private send failed:", sent.reason);
  } catch (error) {
    console.error("[case preview] generation failed:", error);
    const reason =
      error instanceof Error ? error.message.slice(0, 300) : "خطأ غير معروف";
    await msg.sendPrivate(
      userId,
      `❌ تعذّر توليد القضية التجريبية: ${reason}`,
    );
  }
}

async function sendFictionalCaseStock(userId, arg) {
  const count = arg ? Number(arg) : 5;
  if (!Number.isInteger(count) || count < 1 || count > 10)
    return msg.sendPrivate(userId, "استخدم /تجهيز قضايا مع عدد من 1 إلى 10 (الافتراضي 5).");

  const started = await msg.sendPrivate(
    userId,
    `⏳ سأولّد ${count} قضايا خيالية مختلفة وأحفظها في قاعدة البيانات كاحتياط. قد يستغرق ذلك بعض الوقت.`,
  );
  if (!started) return;

  try {
    const generated = await crime.generateFictionalCaseStock(count);
    await msg.sendPrivate(
      userId,
      `✅ تم حفظ ${generated} قضايا خيالية جديدة كاحتياط في قاعدة البيانات.`,
    );
  } catch (error) {
    console.error("[case stock] generation failed:", error);
    const generated =
      error instanceof Error ? Number(error.generatedCount) || 0 : 0;
    const reason =
      error instanceof Error ? error.message.slice(0, 250) : "خطأ غير معروف";
    await msg.sendPrivate(
      userId,
      `⚠️ تم حفظ ${generated} من القضايا المطلوبة. تعذّر إكمال الباقي: ${reason}`,
    );
  }
}

async function testPrivateConnection(userId) {
  console.log("[diagnostic] private test request received");
  const connection = msg.getConnectionStatus();
  let registration = "تعذر فحص سجل اللاعبين";
  try {
    const player = await db.one(
      "SELECT display_name FROM room_players WHERE psid=? ORDER BY id DESC LIMIT 1",
      [userId],
    );
    registration = player
      ? `مسجل باسم ${player.display_name}`
      : "غير مسجل حتى الآن";
  } catch (error) {
    console.error("[diagnostic] player lookup failed:", error.message);
  }
  const response = [
    `الاتصال: ${connection.loggedIn ? "متصل" : "غير متصل"}`,
    `استقبال الرسائل: ${connection.listenerHealthy ? "مستقر" : "غير مستقر"}`,
    `الخاص المشفر: ${connection.e2eeConnected ? "متصل" : "غير متصل"}`,
    `حساب اللاعب: ${registration}`,
  ].join("\n");
  const result = await msg.sendPrivateWithResult(userId, response);
  if (!result.ok)
    console.error("[diagnostic] private test reply failed:", result.reason);
}

function helpText() {
  return `مين قتل كريم
التسجيل: اكتب «جريمة» ثم تفاعل مع الرسالة (${CFG.MIN}-${CFG.MAX} لاعباً). تبدأ بعد دقيقة.
الأدوار والبطاقات والتصويت السري في الخاص. التصويت لا يُقبل إلا بالرد على بطاقة البوت برقم اللاعب.
ناقشوا وصوّتوا حتى النهائي؛ الأبرياء يفوزون بإقصاء القاتل.
الأوامر: لاعبين، شخصيتي، خروج، الغاء، دوري.
في الخاص: قضية، تجهيز قضايا <1-10>.`;
}
const howTo = (threadId) => msg.sendGroup(threadId, helpText());

// ============================== اللوبي ==============================
async function createRoom(userId, threadId) {
  if (await db.isUserBanned(userId))
    return msg.sendGroup(
      threadId,
      "أنت محظور من بدء الألعاب.",
    );
  if (await getRoomByThread(threadId))
    return msg.sendGroup(
      threadId,
      "⚠️ توجد لعبة نشطة في هذه المجموعة بالفعل. (/الغاء من المضيف لإنهائها)",
    );

  let roomId;
  try {
    const r = await db.query(
      "INSERT INTO game_rooms (game_id, thread_id, host_psid, status, phase) VALUES (?,?,?,?,?)",
      ["crime", threadId, userId, "lobby", "lobby"],
    );
    roomId = r.insertId;
  } catch (e) {
    if (e.code === "ER_DUP_ENTRY")
      return msg.sendGroup(
        threadId,
        "⚠️ توجد لعبة نشطة في هذه المجموعة بالفعل.",
      );
    throw e;
  }
  const messageID = await msg.sendGroupTracked(
    threadId,
    ui.lobbyMessage({
      title: "مين قتل كريم",
      tagline: "قُتل كريم في ظروف غامضة، والقاتل بينكم. هل تكشفونه قبل أن يفلت؟",
      min: CFG.MIN,
      max: CFG.MAX,
      seconds: CFG.LOBBY,
      leaveCommand: "خروج",
    }),
  );
  if (!messageID) {
    await db.query(
      "UPDATE game_rooms SET status='cancelled', phase='finished', phase_ends_at=NULL WHERE id=?",
      [roomId],
    );
    return;
  }
  await db.query(
    "UPDATE game_rooms SET lobby_message_id=?, phase_ends_at=DATE_ADD(NOW(), INTERVAL ? SECOND) WHERE id=? AND status='lobby'",
    [messageID, CFG.LOBBY, roomId],
  );
  if (crimeAI.getConfig().apiKey) {
    crime.prepareCase(roomId).catch((error) => {
      console.error(
        `[case preparation] background generation failed for room ${roomId}:`,
        error,
      );
    });
  }
}

async function listPlayers(threadId) {
  const room = await getRoomByThread(threadId);
  if (!room) return msg.sendGroup(threadId, "ℹ️ لا توجد لعبة نشطة.");
  const players = await getPlayers(room.id);
  const lines = players.map((p) => {
    if (room.status === "lobby")
      return `• ${p.display_name}${p.psid === room.host_psid ? " 👑" : ""}`;
    return `• ${p.display_name} ${p.is_alive ? "✅" : "💀"}`;
  });
  return msg.sendGroup(
    threadId,
    `👥 اللاعبون (${players.length}):\n${lines.join("\n")}`,
  );
}

async function leaveRoom(userId, threadId) {
  const room = await getRoomByThread(threadId);
  if (!room) return;
  const p = await getPlayer(room.id, userId);
  if (!p) return;
  if (room.status === "playing")
    return msg.sendGroup(threadId, "⛔ لا يمكن المغادرة أثناء اللعبة الجارية.");
  if (room.host_psid === userId) return cancelRoom(userId, threadId);
  await db.query("DELETE FROM room_players WHERE id=?", [p.id]);
  await msg.sendGroup(threadId, `👋 غادر ${p.display_name} الغرفة.`);
}

async function cancelRoom(userId, threadId, isAdmin = false) {
  const room = await getRoomByThread(threadId);
  if (!room) return;
  if (room.host_psid !== userId && !isAdmin)
    return msg.sendGroup(threadId, "⛔ فقط مضيف الغرفة يستطيع إلغاء اللعبة.");
  crime.releasePreparedCase(room.id);
  await db.query(
    "UPDATE game_rooms SET status='cancelled', phase='finished', phase_ends_at=NULL WHERE id=?",
    [room.id],
  );
  await msg.sendGroup(
    threadId,
    "🚫 أُلغيت اللعبة. اكتبوا «جريمة» للبدء من جديد.",
  );
}

// ============================== بدء اللعبة وتوزيع الأدوار ==============================
function secretCard(p) {
  if (p.role === "killer") {
    return `أنت القاتل: ${p.display_name}\n${p.character_bio}\nالحقيقة: ${p.secret_note}\nعذرك: ${p.alibi}\nهدفك: انجُ دون أن تُكشف.`;
  }
  return `أنت بريء: ${p.display_name}\n${p.character_bio}\nعذرك: ${p.alibi}\nسرك: ${p.secret_note || "لا شيء"}\nاكتشف القاتل وصوّت له.`;
}

async function resendRole(userId, s) {
  if (!s || s.status !== "playing" || !s.role)
    return msg.sendPrivate(userId, "ℹ️ لم يتم توزيع الأدوار بعد.");
  return msg.sendPrivate(userId, secretCard(s));
}

async function startGame(roomId) {
  const room = await getRoom(roomId);
  if (!room || room.status !== "lobby" || room.phase !== "lobby") return;
  try {
    const reactors = await msg.getReactors(
      room.thread_id,
      room.lobby_message_id,
    );
    for (const userId of reactors) await registerPlayerByReaction(room, userId);
  } catch (e) {
    console.error(
      `[startGame] could not recover reactions for room ${room.id}:`,
      e && e.stack ? e.stack : e,
    );
  }

  const players = await getPlayers(room.id);
  if (players.length < CFG.MIN) {
    const cancelled = await db.query(
      "UPDATE game_rooms SET status='cancelled', phase='finished', phase_ends_at=NULL WHERE id=? AND game_id='crime' AND status='lobby' AND phase='lobby'",
      [room.id],
    );
    if (!cancelled.affectedRows) return;
    crime.releasePreparedCase(room.id);
    return msg.sendGroup(
      room.thread_id,
      `⌛ انتهى وقت التسجيل. نحتاج ${CFG.MIN} لاعبين على الأقل (الحالي ${players.length})، لذلك أُلغيت اللعبة.`,
    );
  }
  // حارس: يمنع بدء اللعبة مرتين
  const lock = await db.query(
    "UPDATE game_rooms SET status='playing', phase='assigning' WHERE id=? AND status='lobby'",
    [room.id],
  );
  if (!lock.affectedRows) return;

  try {
    const kase = await crime.getOrCreateCase(room.id);
    if (kase.innocents.length < players.length - 1)
      throw new Error("not enough characters in case");

    const killerPlayer = players[randomInt(players.length)];
    const order = shuffle(players);
    const innocentChars = shuffle(kase.innocents);
    let innocentIndex = 0;
    const rounds = players.length - 2;

    await db.withTransaction(async (q) => {
      for (const p of order) {
        const isKiller = p.id === killerPlayer.id;
        const c = isKiller ? kase.killer : innocentChars[innocentIndex++];
        await q(
          `UPDATE room_players SET role=?, character_key=?, character_name=?, character_bio=?, alibi=?, secret_note=?, bio_revealed_at=NULL WHERE id=?`,
          [
            isKiller ? "killer" : "innocent",
            c.key,
            c.name,
            `${c.bio || "لا توجد معلومات إضافية عن هذه الشخصية."}\n\n🕵️ سبب الاشتباه أو الدافع المحتمل: ${c.motive || "له صلة بالقضية وقد تثير تحركاته الشكوك."}`,
            c.alibi,
            c.secret || "",
            p.id,
          ],
        );
      }
      await q(
        "UPDATE game_rooms SET case_id=?, killer_player_id=?, total_rounds=?, current_round=0 WHERE id=?",
        [kase.id, killerPlayer.id, rounds, room.id],
      );
    });

    // الأدوار السرية في الخاص بعد تجهيز القضية.
    const fresh = await getPlayers(room.id);
    const failedRoles = [];
    for (const p of fresh) {
      const result = await msg.sendPrivateWithResult(p.psid, secretCard(p));
      if (!result.ok) failedRoles.push(`• ${p.display_name}: ${result.reason}`);
    }
    if (failedRoles.length) {
      await db.query(
        "UPDATE game_rooms SET status='cancelled', phase='finished', phase_ends_at=NULL WHERE id=? AND status='playing' AND phase='assigning'",
        [room.id],
      );
      await msg.sendGroup(
        room.thread_id,
        `تعذّر إرسال الدور إلى:\n${failedRoles.join("\n")}\nأُلغيت اللعبة؛ اكتبوا «جريمة» للمحاولة مجدداً.`,
      );
      return;
    }

    const caseSent = await msg.sendGroup(
      room.thread_id,
      `القضية: ${replaceCharacterNames(kase.title, fresh)}\n${replaceCharacterNames(kase.summary, fresh)}\nالمكان: ${replaceCharacterNames(kase.setting, fresh)}\nالضحية: ${kase.victim_name || "مجهول"} — ${replaceCharacterNames(kase.victim_desc, fresh)}\nالمشتبه بهم بعد ${CFG.SUSPECTS_DELAY}ث.`,
    );
    if (!caseSent) throw new Error("failed to send the case introduction");
    await setPhase(room.id, ["assigning"], "intro", CFG.SUSPECTS_DELAY);
  } catch (err) {
    console.error("[startGame]", err);
    const setupHint =
      err instanceof Error && err.code === "MISSING_CRIME_AI_KEY"
        ? ` ${err.message}`
        : " راجع سجل التشغيل أو أضف قضايا احتياطية بأمر تجهيز قضايا.";
    await db.query(
      "UPDATE game_rooms SET status='cancelled', phase='finished', phase_ends_at=NULL WHERE id=?",
      [room.id],
    );
    await msg.sendGroup(
      room.thread_id,
      `❌ تعذّر إعداد قضية جديدة، ولا تتوفر قضية احتياطية غير مستخدمة. أُلغيت اللعبة.${setupHint}`,
    );
  }
}

// ============================== الجولات ==============================
async function startRound(roomId, n) {
  const upd = await db.query(
    `UPDATE game_rooms SET current_round=?, phase='discussion', phase_ends_at=DATE_ADD(NOW(), INTERVAL ? SECOND)
     WHERE id=? AND phase='between'`,
    [n, CFG.DISCUSSION, roomId],
  );
  if (!upd.affectedRows) return;

  const room = await getRoom(roomId);
  const clue = await db.one(
    "SELECT * FROM case_clues WHERE case_id=? AND round_number<=? ORDER BY round_number DESC LIMIT 1",
    [room.case_id, n],
  );
  const players = await getPlayers(roomId);

  await msg.sendGroup(
    room.thread_id,
    `الجولة ${n}/${room.total_rounds} | الدليل:\n${clue ? replaceCharacterNames(clue.clue_text, players) : "—"}\nالأحياء: ${aliveNames(players)}\nالنقاش ${CFG.DISCUSSION}ث، ثم التصويت في الخاص.`,
  );
}

async function revealSuspects(roomId) {
  const room = await getRoom(roomId);
  if (!room || room.status !== "playing" || room.phase !== "intro") return;

  const players = await getPlayers(roomId);
  const suspects = players
    .map(
      (player) =>
        `• ${player.display_name}\n${replaceCharacterNames(player.character_bio || "لا توجد معلومات إضافية عن هذه الشخصية.", players)}`,
    )
    .join("\n\n");
  const sent = await msg.sendGroup(
    room.thread_id,
    `👥 المشتبه بهم:\n${suspects}\n\nيبدأ الدليل الأول بعد ${CFG.ROUND_START_DELAY} ثانية.`,
  );
  if (!sent) {
    await db.query(
      "UPDATE game_rooms SET status='cancelled', phase='finished', phase_ends_at=NULL WHERE id=? AND status='playing' AND phase='intro'",
      [roomId],
    );
    console.error(
      `[revealSuspects] failed to send suspects for room ${roomId}`,
    );
    return;
  }
  await setPhase(roomId, ["intro"], "between", CFG.ROUND_START_DELAY);
}

/** المرشّحون للتصويت من منظور لاعب: كل الأحياء عدا نفسه، بترتيب ثابت (id) => الرقم n يشير لنفس الشخص دائماً */
const voteTargets = (players, voterId) =>
  players
    .filter((p) => p.is_alive && p.id !== voterId)
    .sort((a, b) => a.id - b.id);

async function startVoting(roomId) {
  const upd = await db.query(
    `UPDATE game_rooms SET phase='voting', phase_ends_at=DATE_ADD(NOW(), INTERVAL ? SECOND)
     WHERE id=? AND phase='discussion'`,
    [CFG.VOTING, roomId],
  );
  if (!upd.affectedRows) return;

  const room = await getRoom(roomId);
  const players = await getPlayers(roomId);
  await msg.sendGroup(
    room.thread_id,
    `🗳️ بدأت مرحلة التصويت! تفقّدوا بطاقات التصويت في الخاص وردوا عليها برقم المشتبه به خلال ${CFG.VOTING} ثانية.`,
  );

  for (const voter of players.filter((p) => p.is_alive)) {
    const list = voteTargets(players, voter.id)
      .map((t, i) => `${i + 1}) ${t.display_name}`)
      .join("\n");
    await msg.sendPrivate(
      voter.psid,
      `${VOTE_MARKER}\nمن تريد طرده؟ رد على هذه الرسالة برقم اللاعب فقط:\n\n${list}\n\n(يمكنك تغيير صوتك قبل انتهاء الوقت)`,
    );
  }
}

async function castVote(userId, s, n) {
  if (
    !s ||
    s.status !== "playing" ||
    !["voting", "final_voting"].includes(s.phase)
  ) {
    return msg.sendPrivate(userId, "⌛ لا يوجد تصويت مفتوح الآن.");
  }

  const players = await getPlayers(s.room_id);
  if (s.phase === "final_voting") {
    if (s.is_alive)
      return msg.sendPrivate(
        userId,
        "ℹ️ التصويت النهائي مخصص للاعبين المستبعدين فقط.",
      );
    const finalists = players
      .filter((player) => player.is_alive)
      .sort((a, b) => a.id - b.id);
    const target = finalists[n - 1];
    if (!target)
      return msg.sendPrivate(
        userId,
        "❌ رقم غير صحيح. اختر أحد اللاعبين النهائيين.",
      );

    const room = await getRoom(s.room_id);
    const finalRound = room.current_round + 1;
    await db.query(
      `INSERT INTO votes (room_id, round_number, voter_player_id, target_player_id) VALUES (?,?,?,?)
       ON DUPLICATE KEY UPDATE target_player_id=VALUES(target_player_id)`,
      [s.room_id, finalRound, s.player_id, target.id],
    );
    await msg.sendPrivate(
      userId,
      `✅ تم تسجيل اختيارك: ${target.display_name}`,
    );

    const counts = await db.one(
      `SELECT
         (SELECT COUNT(*) FROM votes v JOIN room_players p ON p.id=v.voter_player_id
          WHERE v.room_id=? AND v.round_number=? AND p.is_alive=0) AS voted,
         (SELECT COUNT(*) FROM room_players WHERE room_id=? AND is_alive=0) AS eliminated`,
      [s.room_id, finalRound, s.room_id],
    );
    if (counts.voted >= counts.eliminated) await tallyFinalVotes(s.room_id);
    return;
  }

  if (!s.is_alive)
    return msg.sendPrivate(userId, "👻 لا يمكنك التصويت وأنت خارج اللعبة.");
  const target = voteTargets(players, s.player_id)[n - 1];
  if (!target)
    return msg.sendPrivate(userId, "❌ رقم غير صحيح. اختر رقماً من القائمة.");

  await db.query(
    `INSERT INTO votes (room_id, round_number, voter_player_id, target_player_id) VALUES (?,?,?,?)
     ON DUPLICATE KEY UPDATE target_player_id=VALUES(target_player_id)`,
    [s.room_id, s.current_round, s.player_id, target.id],
  );
  await msg.sendPrivate(
    userId,
    `✅ تم تسجيل صوتك ضد: ${target.display_name}`,
  );

  // إنهاء مبكر إذا صوّت كل الأحياء
  const row = await db.one(
    `SELECT (SELECT COUNT(*) FROM votes v JOIN room_players p ON p.id=v.voter_player_id
              WHERE v.room_id=? AND v.round_number=? AND p.is_alive=1) AS voted,
            (SELECT COUNT(*) FROM room_players WHERE room_id=? AND is_alive=1) AS alive`,
    [s.room_id, s.current_round, s.room_id],
  );
  if (row.voted >= row.alive) await tallyVotes(s.room_id);
}

async function tallyVotes(roomId) {
  const lock = await db.query(
    "UPDATE game_rooms SET phase='tallying', phase_ends_at=NULL WHERE id=? AND phase='voting'",
    [roomId],
  );
  if (!lock.affectedRows) return;

  const room = await getRoom(roomId);
  const players = await getPlayers(roomId);
  const byId = Object.fromEntries(players.map((p) => [p.id, p]));
  const tally = await db.query(
    "SELECT target_player_id, COUNT(*) AS c FROM votes WHERE room_id=? AND round_number=? GROUP BY target_player_id ORDER BY c DESC",
    [roomId, room.current_round],
  );

  let report =
    "📊 نتيجة التصويت:\n" +
    (tally.length
      ? tally
          .map(
            (t) => `• ${byId[t.target_player_id].display_name}: ${t.c} صوت`,
          )
          .join("\n")
      : "• لم يصوّت أحد");
  let eliminated = null;

  if (tally.length && (tally.length === 1 || tally[0].c > tally[1].c)) {
    eliminated = byId[tally[0].target_player_id];
    await db.query(
      "UPDATE room_players SET is_alive=0, eliminated_round=? WHERE id=?",
      [room.current_round, eliminated.id],
    );
    report +=
      `\n\n⚖️ تم طرد ${eliminated.display_name}!\n` +
      (eliminated.role === "killer"
        ? "🔪 كان هو القاتل!"
        : "😢 لقد كان بريئاً...\n(المطرودون يكتفون بالمشاهدة ولا يكشفون شيئاً)");
  } else {
    report += "\n\n⚖️ تعادل أو لا أصوات — لم يُطرد أحد هذه الجولة.";
  }
  await msg.sendGroup(room.thread_id, report);

  const alive = players.filter(
    (p) => p.is_alive && (!eliminated || p.id !== eliminated.id),
  );
  const killerAlive = alive.some((p) => p.id === room.killer_player_id);

  if (!killerAlive) return endGame(roomId, "innocents");
  if (alive.length === 2) return startFinalVote(roomId);

  if (!eliminated) {
    await db.query("DELETE FROM votes WHERE room_id=? AND round_number=?", [
      roomId,
      room.current_round,
    ]);
    await db.query(
      "UPDATE game_rooms SET phase='discussion', phase_ends_at=DATE_ADD(NOW(), INTERVAL ? SECOND) WHERE id=? AND status='playing' AND phase='tallying'",
      [CFG.DISCUSSION, roomId],
    );
    return msg.sendGroup(
      room.thread_id,
      `🔁 تعادل التصويت. نعيد النقاش في الجولة ${room.current_round} ثم يُعاد التصويت، من دون احتساب جولة جديدة.`,
    );
  }

  await msg.sendGroup(
    room.thread_id,
    `⏭️ الجولة التالية بعد ${CFG.BETWEEN} ثوانٍ...`,
  );
  await setPhase(roomId, ["tallying"], "between", CFG.BETWEEN);
}

async function startFinalVote(roomId) {
  const upd = await db.query(
    "UPDATE game_rooms SET phase='final_voting', phase_ends_at=DATE_ADD(NOW(), INTERVAL ? SECOND) WHERE id=? AND status='playing' AND phase='tallying'",
    [CFG.VOTING, roomId],
  );
  if (!upd.affectedRows) return;

  const room = await getRoom(roomId);
  const players = await getPlayers(roomId);
  const finalists = players
    .filter((player) => player.is_alive)
    .sort((a, b) => a.id - b.id);
  const eliminated = players.filter((player) => !player.is_alive);
  const options = finalists
    .map((player, index) => `${index + 1}) ${player.display_name}`)
    .join("\n");

  await msg.sendGroup(
    room.thread_id,
    `⚖️ بدأت مرحلة التصويت النهائي! بقي لاعبان فقط. اللاعبون المستبعدون أمامهم ${CFG.VOTING} ثانية للتصويت سراً في الخاص: من بين النهائيين هو القاتل؟`,
  );
  for (const player of eliminated) {
    await msg.sendPrivate(
      player.psid,
      `${VOTE_MARKER} — التصويت النهائي\nمن تعتقد أنه القاتل؟ رد على هذه الرسالة برقم اللاعب:\n\n${options}`,
    );
  }
}

async function tallyFinalVotes(roomId) {
  const lock = await db.query(
    "UPDATE game_rooms SET phase='final_tallying', phase_ends_at=NULL WHERE id=? AND status='playing' AND phase='final_voting'",
    [roomId],
  );
  if (!lock.affectedRows) return;

  const room = await getRoom(roomId);
  const players = await getPlayers(roomId);
  const byId = Object.fromEntries(players.map((player) => [player.id, player]));
  const finalRound = room.current_round + 1;
  const tally = await db.query(
    "SELECT target_player_id, COUNT(*) AS c FROM votes WHERE room_id=? AND round_number=? GROUP BY target_player_id ORDER BY c DESC",
    [roomId, finalRound],
  );
  const killerVotes = Number(
    tally.find((vote) => vote.target_player_id === room.killer_player_id)?.c ||
      0,
  );
  const innocentVotes = tally.reduce(
    (sum, vote) =>
      sum +
      (Number(vote.target_player_id) === Number(room.killer_player_id)
        ? 0
        : Number(vote.c)),
    0,
  );
  const result = killerVotes > innocentVotes ? "innocents" : "killer";
  const report = tally.length
    ? tally
        .map(
          (vote) =>
            `• ${byId[vote.target_player_id].display_name}: ${vote.c} صوت`,
        )
        .join("\n")
    : "لم يصوّت أحد.";

  await msg.sendGroup(
    room.thread_id,
    `🗳️ نتيجة التصويت النهائي:\n${report}\n\n${
      killerVotes > innocentVotes
        ? "✅ الأغلبية اكتشفت القاتل!"
        : "😈 لم تحصل هوية القاتل على أغلبية الأصوات."
    }`,
  );
  await endGame(roomId, result);
}

async function endGame(roomId, winner) {
  const lock = await db.query(
    "UPDATE game_rooms SET status='finished', phase='finished', phase_ends_at=NULL, winner=? WHERE id=? AND status='playing'",
    [winner, roomId],
  );
  if (!lock.affectedRows) return;

  const room = await getRoom(roomId);
  const kase = await db.one("SELECT * FROM cases_pool WHERE id=?", [
    room.case_id,
  ]);
  const players = await getPlayers(roomId);
  const killer = players.find((p) => p.id === room.killer_player_id);
  const winners = players.filter((player) =>
    winner === "innocents"
      ? player.role === "innocent"
      : Number(player.id) === Number(room.killer_player_id),
  );
  await leaderboard.recordPoints("crime", roomId, winners);

  const title =
    winner === "innocents"
      ? "🎉 فاز الأبرياء! تم كشف القاتل."
      : "😈 فاز القاتل! أفلت من العدالة.";
  const reveal = players
    .map(
      (p) =>
        `• ${p.display_name}${p.role === "killer" ? " 🔪 القاتل" : ""}`,
    )
    .join("\n");

  await msg.sendGroup(
    room.thread_id,
    `${title}\nالقاتل: ${killer.display_name}\nالحقيقة: ${replaceCharacterNames(kase.solution, players)}\nاللاعبون:\n${reveal}\nجولة جديدة: جريمة`,
  );
}

// ============================== المؤقّت (Ticker) ==============================
let ticking = false;
let lastCleanup = 0;

async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    const due = await db.query(
      `SELECT id, status, phase, current_round FROM game_rooms
       WHERE game_id='crime' AND ((status='playing' AND phase IN ('intro','discussion','voting','between','final_voting'))
          OR (status='lobby' AND phase='lobby'))
         AND phase_ends_at IS NOT NULL AND phase_ends_at <= NOW()`,
    );
    for (const r of due) {
      try {
        if (r.status === "lobby") await startGame(r.id);
        else if (r.phase === "intro") await revealSuspects(r.id);
        else if (r.phase === "discussion") await startVoting(r.id);
        else if (r.phase === "voting") await tallyVotes(r.id);
        else if (r.phase === "final_voting") await tallyFinalVotes(r.id);
        else if (r.phase === "between")
          await startRound(r.id, r.current_round + 1);
      } catch (e) {
        console.error("[tick room " + r.id + "]", e);
      }
    }
    // تنظيف: غرف انتظار مهجورة (ساعة) وألعاب عالقة (3 ساعات)
    if (Date.now() - lastCleanup > 600000) {
      lastCleanup = Date.now();
      await db.query(
        "UPDATE game_rooms SET status='cancelled', phase='finished', phase_ends_at=NULL WHERE game_id='crime' AND status='lobby' AND created_at < NOW() - INTERVAL 1 HOUR",
      );
      await db.query(
        "UPDATE game_rooms SET status='cancelled', phase='finished', phase_ends_at=NULL WHERE game_id='crime' AND status='playing' AND updated_at < NOW() - INTERVAL 3 HOUR",
      );
    }
  } catch (e) {
    console.error("[tick]", e);
  } finally {
    ticking = false;
  }
}

function startTicker() {
  setInterval(tick, 3000);
}

module.exports = {
  handleMessage,
  handleReaction,
  cancelActiveGame: cancelRoom,
  startTicker,
  parseCommand,
  canHandleMessage,
  replaceCharacterNames,
};
