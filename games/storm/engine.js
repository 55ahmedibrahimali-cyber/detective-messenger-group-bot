const { randomInt } = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const db = require("../../database");
const ui = require("../../services/interaction");
const msg = require("../../services/messenger");
const leaderboard = require("../../services/leaderboard");
const { isReplyToBotPrompt } = require("../../services/replyPrompts");
const CFG = require("./config");
const {
  ROLE_DEFINITIONS,
  rolesForPlayerCount,
  winnerForPlayers,
} = require("./roles");

const START_ALIASES = ["ستورم"];
const REPLY_ACTION_MARKERS = {
  shadow_kill: "🌙 اختيار ضحية الظلال",
  assassin_kill: "🗡️ الاغتيال الإضافي",
  doctor_protect: "🛡️ اختيار اللاعب للحماية",
  guard_protect: "🛡️ اختيار اللاعب للحراسة",
  investigate: "🕵️ اختيار لاعب للتحقيق",
  oracle_check: "🔮 اختيار لاعب للكشف",
  sniper_shot: "🎯 اختيار هدف الرصاصة",
  vote: "🗳️ بطاقة التصويت السري في STORM",
  buy_shield: "🛡️ بطاقة شراء الدرع في STORM",
};
const COMMANDS = new Map([
  ["help", "help"],
  ["stormhelp", "help"],
  ["قواعدستورم", "help"],
  ["players", "players"],
  ["stormplayers", "players"],
  ["لاعبينستورم", "players"],
  ["cancel", "cancel"],
  ["stormcancel", "cancel"],
  ["إلغاءستورم", "cancel"],
  ["leave", "leave"],
  ["stormleave", "leave"],
  ["خروجستورم", "leave"],
  ["role", "role"],
  ["دوري", "role"],
  ["vote", "vote"],
  ["تصويت", "vote"],
  ["صوت", "vote"],
  ["kill", "shadow_kill"],
  ["قتل", "shadow_kill"],
  ["assassinate", "assassin_kill"],
  ["اغتيال", "assassin_kill"],
  ["protect", "doctor_protect"],
  ["حماية", "doctor_protect"],
  ["guard", "guard_protect"],
  ["حراسة", "guard_protect"],
  ["investigate", "investigate"],
  ["فحص", "investigate"],
  ["oracle", "oracle_check"],
  ["كشف", "oracle_check"],
  ["shoot", "sniper_shot"],
  ["إطلاق", "sniper_shot"],
  ["اطلاق", "sniper_shot"],
  ["shield", "buy_shield"],
  ["درع", "buy_shield"],
]);

const shuffle = (items) => {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
};

const getRoom = (roomId) =>
  db.one("SELECT * FROM game_rooms WHERE id=? AND game_id='storm'", [roomId]);
const getPlayers = (roomId) =>
  db.query("SELECT * FROM storm_players WHERE room_id=? ORDER BY id", [roomId]);
const getPlayer = (roomId, psid) =>
  db.one("SELECT * FROM storm_players WHERE room_id=? AND psid=?", [
    roomId,
    psid,
  ]);
const getActiveRoom = (threadId) =>
  db.one(
    "SELECT * FROM game_rooms WHERE thread_id=? AND game_id='storm' AND status IN ('lobby','playing') ORDER BY id DESC LIMIT 1",
    [threadId],
  );
const getSession = (psid) =>
  db.one(
    `SELECT sp.*, gr.thread_id, gr.host_psid, gr.status, gr.phase, gr.current_round
     FROM storm_players sp JOIN game_rooms gr ON gr.id=sp.room_id
     WHERE sp.psid=? AND gr.game_id='storm' AND gr.status IN ('lobby','playing')
     ORDER BY sp.id DESC LIMIT 1`,
    [psid],
  );

async function assertSchema() {
  const schemaPath = path.join(__dirname, "schema.sql");
  const schema = await fs.readFile(schemaPath, "utf8");
  const statements = schema
    .split(";")
    .map((statement) => statement.trim())
    .filter(Boolean);

  for (const statement of statements) await db.query(statement);
}

async function canHandleMessage({ userId, isGroup }) {
  return !isGroup && Boolean(await getSession(userId));
}

function commandParts(text) {
  const parts = text.trim().replace(/^[/!]\s*/, "").split(/\s+/);
  return { name: (parts.shift() || "").toLowerCase(), arg: parts.join(" ") };
}

function parseTarget(text) {
  const { name, arg } = commandParts(text);
  const action = COMMANDS.get(name);
  if (!action) return null;
  return { action, arg };
}

function numberedPlayers(players) {
  const living = players.filter((player) => player.is_alive);
  return new Map(living.map((player, index) => [index + 1, player]));
}

function playerList(players) {
  return [...numberedPlayers(players)]
    .map(([number, player]) => `${number}. ${player.display_name}`)
    .join("\n");
}

function repliedAction(messageReply) {
  return (
    Object.entries(REPLY_ACTION_MARKERS).find(([, marker]) =>
      isReplyToBotPrompt(messageReply, marker, msg.selfId?.()),
    )?.[0] || null
  );
}

function roleName(roleKey) {
  return ROLE_DEFINITIONS[roleKey]?.name || "دور غير معروف";
}

function roleCard(player) {
  const roleNames = {
    shadow_leader: "زعيم الظلال",
    shadow_assassin: "السفاح",
    investigator: "المحقق الملكي",
    doctor: "الطبيب الملكي",
    sniper: "القناص",
    oracle: "العرّاف",
    bodyguard: "الحارس الشخصي",
    trickster: "المخادع",
    citizen: "المواطن النبيل",
  };
  const descriptions = {
    shadow_leader:
      "أنت تقود الظلال. عند بدء الليل، رد على رسالة اختيار الضحية برقم اللاعب.",
    shadow_assassin:
      "أنت من الظلال. رد على رسالة اختيار الضحية برقم اللاعب؛ ويمكنك الرد على رسالة الاغتيال الإضافي مرة واحدة طوال اللعبة.",
    investigator: "رد على رسالة التحقيق برقم لاعب لتعرف إن كان من الظلال.",
    doctor: "رد على رسالة الحماية برقم اللاعب الذي تريد حمايته. يمكنك حماية نفسك.",
    sniper:
      "احتفظ برصاصتك أو رد على رسالة اختيار الهدف برقم لاعب لاستخدامها مرة واحدة.",
    oracle:
      "رد على رسالة الكشف برقم لاعب لمعرفة إن كانت لديه قدرة خاصة.",
    bodyguard:
      "رد على رسالة الحراسة برقم اللاعب؛ إذا تعرض المحمي لاغتيال يموت الحارس بدلاً منه.",
    trickster:
      `ابقَ حياً حتى نهاية اللعبة لتفوز مستقلاً. صوتك الحاسم يمنحك نقطة.\n${REPLY_ACTION_MARKERS.buy_shield}\nلشراء درع أثناء النهار، رد على هذه البطاقة بكلمة «درع».`,
    citizen:
      "ليس لديك قدرة ليلية. حلّل الأدلة وناقش وصوّت لإقصاء الظلال.",
  };
  return `دورك: ${roleNames[player.role_key]}\n${descriptions[player.role_key]}\nللتصويت، رد برقم اللاعب.`;
}

async function handleMessage(context) {
  const { name } = commandParts(context.text);
  if (START_ALIASES.includes(name)) {
    if (!context.isGroup)
      return msg.sendPrivate(context.userId, "ابدأ STORM داخل مجموعة.");
    return createRoom(context.userId, context.threadId);
  }
  const command = COMMANDS.get(name);
  if (context.isGroup) return handleGroup(context, command);
  return handlePrivate(context, command);
}

async function handleReaction({ userId, threadId, messageId }) {
  const room = await db.one(
    `SELECT * FROM game_rooms
     WHERE game_id='storm' AND thread_id=? AND lobby_message_id=?
       AND status='lobby' AND phase='lobby'`,
    [threadId, messageId],
  );
  if (!room) return;
  return registerPlayer(room, userId);
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
      "⚠️ توجد لعبة نشطة في المجموعة. أنهِها قبل بدء STORM.",
    );

  const result = await db.query(
    "INSERT INTO game_rooms (game_id, thread_id, host_psid, status, phase) VALUES ('storm',?,?, 'lobby','lobby')",
    [threadId, userId],
  );
  const roomId = result.insertId;
  const messageId = await msg.sendGroupTracked(
    threadId,
    ui.lobbyMessage({
      title: "إمبراطورية STORM",
      tagline: "اكشفوا الخونة قبل سقوط المملكة.",
      min: CFG.MIN_PLAYERS,
      max: CFG.MAX_PLAYERS,
      seconds: CFG.LOBBY_SECONDS,
      leaveCommand: "خروج ستورم",
    }),
  );
  if (!messageId) {
    await db.query(
      "UPDATE game_rooms SET status='cancelled', phase='finished', phase_ends_at=NULL WHERE id=? AND game_id='storm'",
      [roomId],
    );
    return;
  }
  await db.query(
    "UPDATE game_rooms SET lobby_message_id=?, phase_ends_at=DATE_ADD(NOW(), INTERVAL ? SECOND) WHERE id=? AND game_id='storm' AND status='lobby'",
    [messageId, CFG.LOBBY_SECONDS, roomId],
  );
}

async function registerPlayer(room, userId) {
  if (await getPlayer(room.id, userId)) return;
  if (await db.isUserBanned(userId)) {
    await msg.sendGroup(
      room.thread_id,
      "أنت محظور من التسجيل.",
    );
    return;
  }
  const active = await db.one(
    `SELECT gr.game_id FROM game_rooms gr
     LEFT JOIN room_players rp ON rp.room_id=gr.id AND rp.psid=?
     LEFT JOIN storm_players sp ON sp.room_id=gr.id AND sp.psid=?
     LEFT JOIN spy_players spp ON spp.room_id=gr.id AND spp.psid=?
     LEFT JOIN feign_players fgp ON fgp.room_id=gr.id AND fgp.psid=?
     LEFT JOIN werewolf_players wwp ON wwp.room_id=gr.id AND wwp.psid=?
     LEFT JOIN drawing_players drp ON drp.room_id=gr.id AND drp.psid=?
     WHERE gr.status IN ('lobby','playing')
       AND (rp.id IS NOT NULL OR sp.id IS NOT NULL OR spp.id IS NOT NULL
            OR fgp.id IS NOT NULL OR wwp.id IS NOT NULL OR drp.id IS NOT NULL)
     LIMIT 1`,
    [userId, userId, userId, userId, userId, userId],
  );
  if (active) {
    await msg.sendGroup(
      room.thread_id,
      "أنت مشارك في لعبة أخرى.",
    );
    return;
  }
  const players = await getPlayers(room.id);
  if (players.length >= CFG.MAX_PLAYERS) {
    await msg.sendGroup(room.thread_id, "⛔ اكتمل عدد لاعبي STORM.");
    return;
  }
  let name = await msg.getUserName(userId);
  if (players.some((player) => player.display_name === name))
    name = `${name} (${players.length + 1})`;
  try {
    await db.query(
      "INSERT INTO storm_players (room_id, psid, display_name) VALUES (?,?,?)",
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
    console.error(`[STORM] reaction recovery failed for room ${roomId}:`, error);
  }
  const players = await getPlayers(roomId);
  if (players.length < CFG.MIN_PLAYERS) {
    const cancelled = await db.query(
      "UPDATE game_rooms SET status='cancelled', phase='finished', phase_ends_at=NULL WHERE id=? AND game_id='storm' AND status='lobby' AND phase='lobby'",
      [roomId],
    );
    if (!cancelled.affectedRows) return;
    return msg.sendGroup(
      room.thread_id,
      `لم يكتمل العدد (${CFG.MIN_PLAYERS})؛ أُلغيت STORM.`,
    );
  }
  const locked = await db.query(
    "UPDATE game_rooms SET status='playing', phase='assigning', phase_ends_at=NULL WHERE id=? AND game_id='storm' AND status='lobby'",
    [roomId],
  );
  if (!locked.affectedRows) return;

  const roles = shuffle(rolesForPlayerCount(players.length));
  const randomizedPlayers = shuffle(players);
  await db.withTransaction(async (query) => {
    for (let index = 0; index < randomizedPlayers.length; index++) {
      const role = roles[index];
      await query(
        "UPDATE storm_players SET role_key=?, team=?, is_alive=1, armor_count=0, trickster_points=0, assassin_used=0, sniper_used=0 WHERE id=? AND room_id=?",
        [role.key, role.team, randomizedPlayers[index].id, roomId],
      );
    }
  });
  const assigned = await getPlayers(roomId);
  let privateDeliveryFailed = false;
  for (const player of assigned) {
    const result = await msg.sendPrivateWithResult(
      player.psid,
      roleCard(player),
    );
    if (!result.ok) {
      privateDeliveryFailed = true;
      console.error(
        `[STORM] role delivery failed for player ${player.id}:`,
        result.reason,
      );
    }
  }
  if (privateDeliveryFailed) {
    await db.query(
      "UPDATE game_rooms SET status='cancelled', phase='finished', phase_ends_at=NULL WHERE id=? AND game_id='storm' AND status='playing'",
      [roomId],
    );
    return msg.sendGroup(
      room.thread_id,
      "لم تصل الأدوار للجميع؛ أُلغيت الجولة. راجعوا طلبات الرسائل وأعيدوا المحاولة.",
    );
  }
  await msg.sendGroup(
    room.thread_id,
    "بدأت STORM. وصلت الأدوار؛ يبدأ الليل الآن.",
  );
  await beginNight(roomId, ["assigning"]);
}

async function beginNight(roomId, allowedPhases) {
  const room = await getRoom(roomId);
  if (!room || room.status !== "playing") return;
  const update = await db.query(
    `UPDATE game_rooms SET phase='night', current_round=current_round+1,
       phase_ends_at=DATE_ADD(NOW(), INTERVAL ? SECOND)
     WHERE id=? AND game_id='storm' AND status='playing' AND phase IN (${allowedPhases.map(() => "?").join(",")})`,
    [CFG.NIGHT_SECONDS, roomId, ...allowedPhases],
  );
  if (!update.affectedRows) return;
  const players = await getPlayers(roomId);
  const targets = `\nاللاعبون الأحياء:\n${playerList(players)}\n\nرد على هذه الرسالة برقم اللاعب فقط.`;
  for (const player of players.filter((entry) => entry.is_alive)) {
    if (player.team === "shadow")
      await msg.sendPrivate(
        player.psid,
        `${REPLY_ACTION_MARKERS.shadow_kill}\n🌙 الليل بدأ. اختاروا ضحية خلال ${CFG.NIGHT_SECONDS} ثانية.${targets}`,
      );
    else if (player.role_key === "doctor")
      await msg.sendPrivate(
        player.psid,
        `${REPLY_ACTION_MARKERS.doctor_protect}\n🌙 اختر من تحميه.${targets}`,
      );
    else if (player.role_key === "bodyguard")
      await msg.sendPrivate(
        player.psid,
        `${REPLY_ACTION_MARKERS.guard_protect}\n🌙 اختر من تحرسه.${targets}`,
      );
    else if (player.role_key === "investigator")
      await msg.sendPrivate(
        player.psid,
        `${REPLY_ACTION_MARKERS.investigate}\n🌙 اختر لاعباً للتحقق من انتمائه.${targets}`,
      );
    else if (player.role_key === "oracle")
      await msg.sendPrivate(
        player.psid,
        `${REPLY_ACTION_MARKERS.oracle_check}\n🌙 اختر لاعباً لمعرفة إن كانت لديه قدرة خاصة.${targets}`,
      );
    else if (player.role_key === "sniper" && !player.sniper_used)
      await msg.sendPrivate(
        player.psid,
        `${REPLY_ACTION_MARKERS.sniper_shot}\n🌙 يمكنك حفظ رصاصتك أو اختيار هدف لاستخدامها.${targets}`,
      );

    if (player.role_key === "shadow_assassin" && !player.assassin_used)
      await msg.sendPrivate(
        player.psid,
        `${REPLY_ACTION_MARKERS.assassin_kill}\n🗡️ يمكنك تنفيذ اغتيال إضافي مرة واحدة طوال اللعبة.${targets}`,
      );
  }
}

async function handleGroup(context, command) {
  if (!command) return;
  if (command === "help") return msg.sendGroup(context.threadId, helpText());
  if (command === "players") return listPlayers(context.threadId);
  if (command === "cancel") return cancelGame(context.userId, context.threadId);
  if (command === "leave") return leaveGame(context.userId, context.threadId);
}

async function listPlayers(threadId) {
  const room = await getActiveRoom(threadId);
  if (!room) return msg.sendGroup(threadId, "ℹ️ لا توجد لعبة STORM نشطة.");
  const players = await getPlayers(room.id);
  const lines = players.map((player) => {
    const status = player.is_alive ? "✅" : "💀";
    return `• ${player.display_name} ${status}`;
  });
  return msg.sendGroup(
    threadId,
    `🌩️ لاعبو STORM (${players.length}):\n${lines.join("\n")}`,
  );
}

async function leaveGame(userId, threadId) {
  const room = await getActiveRoom(threadId);
  if (!room || room.status !== "lobby") return;
  const player = await getPlayer(room.id, userId);
  if (!player) return;
  if (room.host_psid === userId) return cancelGame(userId, threadId);
  await db.query("DELETE FROM storm_players WHERE id=?", [player.id]);
  await msg.sendGroup(threadId, `👋 غادر ${player.display_name} التسجيل.`);
}

async function cancelGame(userId, threadId, isAdmin = false) {
  const room = await getActiveRoom(threadId);
  if (!room) return;
  if (room.host_psid !== userId && !isAdmin)
    return msg.sendGroup(threadId, "⛔ مضيف اللعبة فقط يستطيع إلغاء STORM.");
  await db.query(
    "UPDATE game_rooms SET status='cancelled', phase='finished', phase_ends_at=NULL WHERE id=? AND game_id='storm' AND status IN ('lobby','playing')",
    [room.id],
  );
  await msg.sendGroup(threadId, "🚫 أُلغيت لعبة STORM.");
}

async function handlePrivate(context, command) {
  if (command === "help") return msg.sendPrivate(context.userId, helpText());
  const session = await getSession(context.userId);
  if (!session) return;
  if (command === "role")
    return msg.sendPrivate(context.userId, roleCard(session));

  const input = parseTarget(context.text);
  const numericReply = context.text.trim().match(/^\d+$/);
  const actionFromReply = repliedAction(context.messageReply);
  if (actionFromReply === "buy_shield") {
    if (input?.action === "buy_shield") return purchaseShield(session);
    return msg.sendPrivate(
      context.userId,
      "لشراء الدرع، رد على بطاقة الدرع بكلمة «درع».",
    );
  }
  if (actionFromReply && !numericReply)
    return msg.sendPrivate(
      context.userId,
      "رد على رسالة الاختيار برقم اللاعب فقط.",
    );
  if (numericReply && actionFromReply === "vote")
    return castVote(session, Number(numericReply[0]));
  if (numericReply && actionFromReply)
    return submitNightAction(session, actionFromReply, Number(numericReply[0]));

  if (input || numericReply)
    return msg.sendPrivate(
      context.userId,
      "🔒 لا تُقبل القدرات أو الأصوات بأمر مباشر؛ رد على بطاقة الاختيار المناسبة من البوت برقم اللاعب.",
    );
}

async function submitNightAction(session, action, targetNumber) {
  if (session.status !== "playing" || session.phase !== "night")
    return msg.sendPrivate(session.psid, "هذه القدرة متاحة أثناء الليل فقط.");
  if (!session.is_alive)
    return msg.sendPrivate(session.psid, "لا يمكنك تنفيذ الأوامر بعد الإقصاء.");
  const allowedRoles = {
    shadow_kill: ["shadow_leader", "shadow_assassin"],
    assassin_kill: ["shadow_assassin"],
    doctor_protect: ["doctor"],
    guard_protect: ["bodyguard"],
    investigate: ["investigator"],
    oracle_check: ["oracle"],
    sniper_shot: ["sniper"],
  };
  if (!allowedRoles[action]?.includes(session.role_key))
    return msg.sendPrivate(session.psid, "هذا الأمر ليس من قدرات دورك.");
  if (action === "assassin_kill" && session.assassin_used)
    return msg.sendPrivate(session.psid, "استخدمت اغتيالك الإضافي من قبل.");
  if (action === "sniper_shot" && session.sniper_used)
    return msg.sendPrivate(session.psid, "استخدمت رصاصتك الوحيدة من قبل.");

  const players = await getPlayers(session.room_id);
  const target = numberedPlayers(players).get(targetNumber);
  if (!target)
    return msg.sendPrivate(session.psid, "رقم الهدف غير صحيح أو أن اللاعب أُقصي.");
  if (
    ["shadow_kill", "assassin_kill"].includes(action) &&
    target.team === "shadow"
  )
    return msg.sendPrivate(session.psid, "لا يمكن استهداف أحد أفراد الظلال.");
  if (
    ["assassin_kill", "guard_protect", "sniper_shot"].includes(action) &&
    target.id === session.id
  )
    return msg.sendPrivate(session.psid, "اختر لاعباً آخر غير نفسك.");

  await db.query(
    `INSERT INTO storm_actions (room_id, round_number, actor_player_id, action_type, target_player_id)
     VALUES (?,?,?,?,?)
     ON DUPLICATE KEY UPDATE target_player_id=VALUES(target_player_id), created_at=CURRENT_TIMESTAMP`,
    [session.room_id, session.current_round, session.id, action, target.id],
  );
  if (action === "assassin_kill")
    await db.query("UPDATE storm_players SET assassin_used=1 WHERE id=?", [
      session.id,
    ]);
  if (action === "sniper_shot")
    await db.query("UPDATE storm_players SET sniper_used=1 WHERE id=?", [
      session.id,
    ]);
  await msg.sendPrivate(
    session.psid,
    `✅ تم تسجيل اختيارك: ${target.display_name}. يمكنك تغييره قبل انتهاء الليل.`,
  );
}

async function purchaseShield(session) {
  if (session.role_key !== "trickster")
    return msg.sendPrivate(session.psid, "الدروع متاحة للمخادع فقط.");
  if (!["discussion", "voting"].includes(session.phase))
    return msg.sendPrivate(
      session.psid,
      "اشترِ الدروع أثناء النهار وقبل بدء الليلة التالية.",
    );
  const cost = 3 + session.armor_count * 2;
  if (session.trickster_points < cost)
    return msg.sendPrivate(
      session.psid,
      `تحتاج ${cost} نقاط لشراء الدرع التالي؛ لديك ${session.trickster_points}.`,
    );
  const result = await db.query(
    `UPDATE storm_players SET armor_count=armor_count+1, trickster_points=trickster_points-?
     WHERE id=? AND role_key='trickster' AND trickster_points>=?`,
    [cost, session.id, cost],
  );
  if (!result.affectedRows)
    return msg.sendPrivate(session.psid, "تعذّر شراء الدرع؛ تحقق من رصيدك.");
  return msg.sendPrivate(
    session.psid,
    `🛡️ اشتريت درعاً مقابل ${cost} نقاط. يحميك من محاولة اغتيال ليلية واحدة، ولا يحميك من التصويت.`,
  );
}

async function castVote(session, targetNumber) {
  if (session.status !== "playing" || session.phase !== "voting")
    return msg.sendPrivate(session.psid, "لا يوجد تصويت مفتوح الآن.");
  if (!session.is_alive)
    return msg.sendPrivate(session.psid, "لا يمكنك التصويت بعد الإقصاء.");
  const players = await getPlayers(session.room_id);
  const target = numberedPlayers(players).get(targetNumber);
  if (!target || target.id === session.id)
    return msg.sendPrivate(session.psid, "اختر رقماً صحيحاً للاعب آخر.");
  await db.query(
    `INSERT INTO storm_actions (room_id, round_number, actor_player_id, action_type, target_player_id)
     VALUES (?,?,?,'vote',?)
     ON DUPLICATE KEY UPDATE target_player_id=VALUES(target_player_id), created_at=CURRENT_TIMESTAMP`,
    [session.room_id, session.current_round, session.id, target.id],
  );
  const progress = await db.one(
    `SELECT COUNT(DISTINCT sa.actor_player_id) AS voted,
            (SELECT COUNT(*) FROM storm_players WHERE room_id=? AND is_alive=1) AS alive
     FROM storm_actions sa
     JOIN storm_players sp ON sp.id=sa.actor_player_id AND sp.is_alive=1
     WHERE sa.room_id=? AND sa.round_number=? AND sa.action_type='vote'`,
    [session.room_id, session.room_id, session.current_round],
  );
  const voted = Number(progress?.voted || 0);
  const alive = Number(progress?.alive || 0);
  await msg.sendPrivate(
    session.psid,
    `✅ تم تسجيل صوتك ضد ${target.display_name}.${voted >= alive ? " اكتمل تصويت الجميع!" : " يمكنك تغييره قبل انتهاء التصويت."}`,
  );
  if (voted >= alive && alive > 0) {
    return resolveVoting(session.room_id);
  }
}

async function listNightActions(roomId, round, type) {
  return db.query(
    `SELECT a.*, p.psid AS actor_psid, p.role_key AS actor_role, p.is_alive AS actor_alive
     FROM storm_actions a JOIN storm_players p ON p.id=a.actor_player_id
     WHERE a.room_id=? AND a.round_number=? AND a.action_type=?`,
    [roomId, round, type],
  );
}

function plurality(actions, preferPlayerId) {
  if (!actions.length) return null;
  const counts = new Map();
  for (const action of actions)
    counts.set(
      action.target_player_id,
      (counts.get(action.target_player_id) || 0) + 1,
    );
  const max = Math.max(...counts.values());
  const winners = [...counts].filter(([, count]) => count === max);
  if (winners.length === 1) return winners[0][0];
  return (
    actions.find((action) => action.actor_player_id === preferPlayerId)
      ?.target_player_id || null
  );
}

async function resolveNight(roomId) {
  const room = await getRoom(roomId);
  if (!room || room.status !== "playing" || room.phase !== "night") return;
  const lock = await db.query(
    "UPDATE game_rooms SET phase='assigning', phase_ends_at=NULL WHERE id=? AND game_id='storm' AND status='playing' AND phase='night'",
    [roomId],
  );
  if (!lock.affectedRows) return;

  let players = await getPlayers(roomId);
  const alive = players.filter((player) => player.is_alive);
  const round = room.current_round;
  const shadows = alive.filter((player) => player.team === "shadow");
  const leader = shadows.find((player) => player.role_key === "shadow_leader") || shadows[0];
  const shadowActions = (await listNightActions(roomId, round, "shadow_kill"))
    .filter((action) => action.actor_alive);
  const shadowTarget = plurality(shadowActions, leader?.id);
  const attacks = [];
  if (shadowTarget) attacks.push({ targetId: shadowTarget });

  const assassin = alive.find((player) => player.role_key === "shadow_assassin");
  const extraKill = (
    await listNightActions(roomId, round, "assassin_kill")
  ).find((action) => action.actor_alive && action.actor_player_id === assassin?.id);
  if (extraKill && extraKill.target_player_id !== shadowTarget)
    attacks.push({ targetId: extraKill.target_player_id });

  const sniper = alive.find((player) => player.role_key === "sniper");
  const sniperShot = (await listNightActions(roomId, round, "sniper_shot")).find(
    (action) => action.actor_alive && action.actor_player_id === sniper?.id,
  );
  if (sniperShot) attacks.push({ targetId: sniperShot.target_player_id });

  const doctor = alive.find((player) => player.role_key === "doctor");
  const doctorAction = doctor
    ? (await listNightActions(roomId, round, "doctor_protect")).find(
        (action) => action.actor_alive && action.actor_player_id === doctor.id,
      )
    : null;
  const doctorTarget = doctorAction?.target_player_id || null;
  const guard = alive.find((player) => player.role_key === "bodyguard");
  const guardAction = guard
    ? (await listNightActions(roomId, round, "guard_protect")).find(
        (action) => action.actor_alive && action.actor_player_id === guard.id,
      )
    : null;
  const guardTarget = guardAction?.target_player_id || null;
  const deaths = new Map();

  for (const attack of attacks) {
    let target = players.find(
      (player) => player.id === attack.targetId && player.is_alive,
    );
    if (!target) continue;
    if (doctorTarget === target.id) continue;
    if (guardTarget === target.id && guard?.is_alive) {
      target = players.find(
        (player) => player.id === guard.id && player.is_alive,
      );
      if (!target) continue;
      if (doctorTarget === target.id) continue;
    }
    if (target.role_key === "trickster" && target.armor_count > 0) {
      target.armor_count--;
      await db.query(
        "UPDATE storm_players SET armor_count=armor_count-1 WHERE id=? AND armor_count>0",
        [target.id],
      );
      continue;
    }
    target.is_alive = 0;
    deaths.set(target.id, target);
  }

  for (const player of deaths.values())
    await db.query("UPDATE storm_players SET is_alive=0 WHERE id=?", [
      player.id,
    ]);

  const investigations = await listNightActions(roomId, round, "investigate");
  for (const action of investigations) {
    if (!action.actor_alive) continue;
    const target = players.find(
      (player) => player.id === action.target_player_id,
    );
    if (!target) continue;
    const result =
      target.team === "shadow" ? "ينتمي إلى الظلال 🔴" : "ليس من الظلال 🟢";
    await msg.sendPrivate(
      action.actor_psid,
      `🕵️ نتيجة التحقيق: ${target.display_name} ${result}.`,
    );
  }
  const oracleActions = await listNightActions(roomId, round, "oracle_check");
  for (const action of oracleActions) {
    if (!action.actor_alive) continue;
    const target = players.find(
      (player) => player.id === action.target_player_id,
    );
    if (!target) continue;
    const special = target.role_key !== "citizen";
    await msg.sendPrivate(
      action.actor_psid,
      `🔮 ${target.display_name} ${special ? "يمتلك قدرة خاصة" : "لا يمتلك قدرة خاصة"}.`,
    );
  }

  players = await getPlayers(roomId);
  const winner = winnerForPlayers(players);
  if (deaths.size) {
    const names = [...deaths.values()]
      .map(
        (player) =>
          `• ${player.display_name} — كان دوره: ${roleName(player.role_key)}`,
      )
      .join("\n");
    await msg.sendGroup(
      room.thread_id,
      `☀️ انتهت الليلة. خرج من اللعبة:\n${names}`,
    );
  } else {
    await msg.sendGroup(room.thread_id, "☀️ انتهت الليلة ولم يُقصَ أحد.");
  }
  if (winner) return finishGame(roomId, winner);
  const next = await db.query(
    `UPDATE game_rooms SET phase='discussion',
       phase_ends_at=DATE_ADD(NOW(), INTERVAL ? SECOND)
     WHERE id=? AND game_id='storm' AND status='playing' AND phase='assigning'`,
    [CFG.DISCUSSION_SECONDS, roomId],
  );
  if (!next.affectedRows) return;
  players = await getPlayers(roomId);
  await msg.sendGroup(
    room.thread_id,
    `🗣️ بدأت مرحلة النقاش (${CFG.DISCUSSION_SECONDS} ثانية).\nاللاعبون الأحياء:\n${playerList(players)}`,
  );
}

async function startVoting(roomId) {
  const room = await getRoom(roomId);
  if (!room || room.status !== "playing" || room.phase !== "discussion") return;
  const update = await db.query(
    `UPDATE game_rooms SET phase='voting',
       phase_ends_at=DATE_ADD(NOW(), INTERVAL ? SECOND)
     WHERE id=? AND game_id='storm' AND status='playing' AND phase='discussion'`,
    [CFG.VOTING_SECONDS, roomId],
  );
  if (!update.affectedRows) return;
  const players = await getPlayers(roomId);
  await msg.sendGroup(
    room.thread_id,
    `🗳️ بدأ التصويت! افتحوا رسالة التصويت الخاصة وردوا عليها برقم اللاعب خلال ${CFG.VOTING_SECONDS} ثانية.`,
  );
  for (const player of players.filter((entry) => entry.is_alive))
    await msg.sendPrivate(
      player.psid,
      `${REPLY_ACTION_MARKERS.vote}\n🗳️ صوّت لإقصاء لاعب بالرد على هذه الرسالة برقم اللاعب:\n${playerList(players)}`,
    );
}

async function resolveVoting(roomId) {
  const room = await getRoom(roomId);
  if (!room || room.status !== "playing" || room.phase !== "voting") return;
  const lock = await db.query(
    "UPDATE game_rooms SET phase='tallying', phase_ends_at=NULL WHERE id=? AND game_id='storm' AND status='playing' AND phase='voting'",
    [roomId],
  );
  if (!lock.affectedRows) return;
  const players = await getPlayers(roomId);
  const votes = (await listNightActions(roomId, room.current_round, "vote"))
    .filter((action) => action.actor_alive);
  const eliminatedId = plurality(votes, null);
  if (votes.length) {
    const counts = new Map();
    for (const vote of votes)
      counts.set(vote.target_player_id, (counts.get(vote.target_player_id) || 0) + 1);
    const lines = [...counts]
      .sort((a, b) => b[1] - a[1])
      .map(([id, count]) => {
        const target = players.find((player) => player.id === id);
        return `• ${target?.display_name || "؟"}: ${count} ${count === 1 ? "صوت" : "أصوات"}`;
      });
    await msg.sendGroup(room.thread_id, `📊 نتيجة التصويت:\n${lines.join("\n")}`);
  }
  const eliminated = players.find(
    (player) => player.id === eliminatedId && player.is_alive,
  );

  const trickster = players.find(
    (player) => player.role_key === "trickster" && player.is_alive,
  );
  const tricksterVote = trickster
    ? votes.find((vote) => vote.actor_player_id === trickster.id)
    : null;
  if (eliminated && tricksterVote?.target_player_id === eliminated.id) {
    const withoutTrickster = votes.filter(
      (vote) => vote.actor_player_id !== trickster.id,
    );
    if (plurality(withoutTrickster, null) !== eliminated.id) {
      await db.query(
        "UPDATE storm_players SET trickster_points=trickster_points+1 WHERE id=? AND role_key='trickster'",
        [trickster.id],
      );
      await msg.sendPrivate(
        trickster.psid,
        "🎭 صوتك غيّر نتيجة التصويت! حصلت على نقطة.",
      );
    }
  }

  if (eliminated) {
    await db.query("UPDATE storm_players SET is_alive=0 WHERE id=?", [
      eliminated.id,
    ]);
    await msg.sendGroup(
      room.thread_id,
      `⚖️ أُقصي ${eliminated.display_name} بتصويت المملكة — كان دوره: ${roleName(
        eliminated.role_key,
      )}.`,
    );
  } else {
    await msg.sendGroup(
      room.thread_id,
      "⚖️ تعادل التصويت أو لم تكتمل الأصوات؛ لم يُقصَ أحد.",
    );
  }
  const afterVote = await getPlayers(roomId);
  const winner = winnerForPlayers(afterVote);
  if (winner) return finishGame(roomId, winner);
  return beginNight(roomId, ["tallying"]);
}

async function finishGame(roomId, winner) {
  const room = await getRoom(roomId);
  if (!room) return;
  const update = await db.query(
    "UPDATE game_rooms SET status='finished', phase='finished', phase_ends_at=NULL, winner=? WHERE id=? AND game_id='storm' AND status='playing'",
    [
      winner === "shadow"
        ? "killer"
        : winner === "kingdom"
          ? "innocents"
          : null,
      roomId,
    ],
  );
  if (!update.affectedRows) return;
  const players = await getPlayers(roomId);
  const winningTeam =
    winner === "shadow"
      ? "shadow"
      : winner === "kingdom"
        ? "kingdom"
        : winner === "independent"
          ? "independent"
          : null;
  const winners = winningTeam
    ? players.filter(
        (player) =>
          player.team === winningTeam ||
          (winner !== "independent" &&
            player.role_key === "trickster" &&
            player.is_alive),
      )
    : [];
  await leaderboard.recordPoints("storm", roomId, winners);
  const result = players
    .map((player) => {
      const role = ROLE_DEFINITIONS[player.role_key];
      return `• ${player.display_name}: ${role?.name || player.role_key}`;
    })
    .join("\n");
  const trickster = players.find(
    (player) => player.role_key === "trickster" && player.is_alive,
  );
  const ending =
    winner === "shadow"
      ? "فاز فريق الظل الأسود."
      : winner === "kingdom"
        ? "فاز فريق المملكة."
        : winner === "independent"
          ? "فاز المخادع المستقل."
          : "انتهت اللعبة بتعادل.";
  await msg.sendGroup(
    room.thread_id,
    `${ending}${trickster && winner !== "independent" ? "\nالمخادع فاز أيضاً." : ""}\nالأدوار:\n${result}`,
  );
}

async function handleDueRoom(room) {
  if (room.status === "lobby") return startGame(room.id);
  if (room.phase === "night") return resolveNight(room.id);
  if (room.phase === "discussion") return startVoting(room.id);
  if (room.phase === "voting") return resolveVoting(room.id);
}

let ticking = false;

async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    const rooms = await db.query(
      `SELECT id, status, phase FROM game_rooms
       WHERE game_id='storm' AND status IN ('lobby','playing')
         AND phase_ends_at IS NOT NULL AND phase_ends_at<=NOW()
         AND phase IN ('lobby','night','discussion','voting')`,
    );
    for (const room of rooms) {
      try {
        await handleDueRoom(room);
      } catch (error) {
        console.error(`[STORM] ticker failed for room ${room.id}:`, error);
      }
    }
  } finally {
    ticking = false;
  }
}

function startTicker() {
  setInterval(() => {
    tick().catch((error) => console.error("[STORM] ticker failed:", error));
  }, 3000);
}

function helpText() {
  return `STORM: اكتب ستورم وتفاعل للانضمام (4-8 لاعبين). القدرات في الخاص؛ النهار للنقاش والتصويت.
تفوز المملكة بإقصاء الظلال، والظلال بمساواتها أو تجاوزها. المخادع يفوز منفرداً إن بقي للنهاية؛ دروعه تكلف 3 ثم 5 ثم 7 نقاط.
القدرات والتصويت وشراء الدرع لا تُقبل إلا بالرد على بطاقة البوت المناسبة. الأوامر: /قواعد ستورم، /لاعبين ستورم، /خروج ستورم، /إلغاء ستورم.`;
}

module.exports = {
  assertSchema,
  handleMessage,
  handleReaction,
  cancelActiveGame: cancelGame,
  canHandleMessage,
  startTicker,
  rolesForPlayerCount,
  winnerForPlayers,
  _internal: { castVote },
};
