const fs = require("node:fs/promises");
const path = require("node:path");
const db = require("../../database");
const msg = require("../../services/messenger");
const leaderboard = require("../../services/leaderboard");
const ui = require("../../services/interaction");
const { isReplyToBotPrompt } = require("../../services/replyPrompts");
const CFG = require("./config");
const { ROLES, createRoleSet, shuffle } = require("./roles");

const REPLY_ACTION_MARKERS = {
  action: "🌙 بطاقة القدرة الليلية في المستذئب",
  vote: "🗳️ بطاقة التصويت في لعبة المستذئب",
  hunter: "🎯 بطاقة طلقة الصياد في المستذئب",
  appoint: "⭐ بطاقة اختيار خليفة العمدة في المستذئب",
};
const COMMANDS = new Map([
  ["werewolfhelp", "help"],
  ["قواعدذئب", "help"],
  ["werewolfplayers", "players"],
  ["لاعبينذئب", "players"],
  ["werewolfstatus", "status"],
  ["حالةذئب", "status"],
  ["werewolfleave", "leave"],
  ["خروجذئب", "leave"],
  ["انضمذئب", "join"],
  ["werewolfcancel", "cancel"],
  ["إلغاءذئب", "cancel"],
  ["werewolfrole", "role"],
  ["دورذئب", "role"],
  ["werewolfaction", "action"],
  ["wa", "action"],
  ["werewolfvote", "vote"],
  ["wvote", "vote"],
  ["werewolfhunt", "hunt"],
  ["whunt", "hunt"],
  ["werewolfappoint", "appoint"],
  ["whandoff", "appoint"],
]);

const getRoom = (roomId) =>
  db.one("SELECT * FROM game_rooms WHERE id=? AND game_id='werewolf'", [
    roomId,
  ]);
const getRoomByThread = (threadId) =>
  db.one(
    "SELECT * FROM game_rooms WHERE thread_id=? AND game_id='werewolf' AND status IN ('lobby','playing') ORDER BY id DESC LIMIT 1",
    [threadId],
  );
const getPlayers = (roomId) =>
  db.query("SELECT * FROM werewolf_players WHERE room_id=? ORDER BY id", [
    roomId,
  ]);
const getPlayer = (roomId, psid) =>
  db.one("SELECT * FROM werewolf_players WHERE room_id=? AND psid=?", [
    roomId,
    psid,
  ]);
const getSession = (psid) =>
  db.one(
    `SELECT wp.*, gr.thread_id, gr.host_psid, gr.status, gr.phase,
            gr.current_round, gr.phase_ends_at
     FROM werewolf_players wp JOIN game_rooms gr ON gr.id=wp.room_id
     WHERE wp.psid=? AND gr.game_id='werewolf'
       AND gr.status IN ('lobby','playing')
     ORDER BY wp.id DESC LIMIT 1`,
    [psid],
  );
const alivePlayers = (players) =>
  players.filter((player) => Number(player.is_alive) === 1);

function commandParts(text) {
  const parts = String(text || "")
    .trim()
    .replace(/^[/!]\s*/, "")
    .split(/\s+/);
  const name = (parts.shift() || "").toLowerCase();
  return { name, arg: parts.join(" "), command: COMMANDS.get(name) || null };
}

function numberedPlayers(players) {
  return new Map(players.map((player, index) => [index + 1, player]));
}

function playerList(players) {
  return [...numberedPlayers(players)]
    .map(([number, player]) => `${number}. ${player.display_name}`)
    .join("\n");
}

function tallyWeightedVotes(votes, sheriffPlayerId) {
  const counts = new Map();
  for (const vote of votes) {
    const targetId = Number(vote.target_player_id);
    const weight =
      Number(vote.voter_player_id) === Number(sheriffPlayerId) ? 2 : 1;
    counts.set(targetId, (counts.get(targetId) || 0) + weight);
  }
  return [...counts.entries()]
    .map(([targetId, count]) => ({ targetId, count }))
    .sort((a, b) => b.count - a.count);
}

function mixedLoversWin(living, loverPlayerIds) {
  const lovers = new Set(loverPlayerIds.map(Number).filter(Boolean));
  return (
    living.length === 2 &&
    living.every((player) => lovers.has(Number(player.id))) &&
    living[0].team !== living[1].team
  );
}

function mixedLoversAreAlive(players, loverPlayerIds) {
  const lovers = new Set(loverPlayerIds.map(Number).filter(Boolean));
  if (lovers.size !== 2) return false;
  const pair = players.filter((player) => lovers.has(Number(player.id)));
  return (
    pair.length === 2 &&
    pair.every((player) => Number(player.is_alive) === 1) &&
    pair[0].team !== pair[1].team
  );
}

function findTarget(players, input) {
  const value = String(input || "").trim();
  if (/^\d+$/.test(value))
    return numberedPlayers(players).get(Number(value)) || null;
  const wanted = value.normalize("NFKC").toLowerCase().trim();
  const exact = players.filter(
    (player) =>
      player.display_name.normalize("NFKC").toLowerCase().trim() === wanted,
  );
  if (exact.length === 1) return exact[0];
  const partial = players.filter((player) =>
    player.display_name.normalize("NFKC").toLowerCase().includes(wanted),
  );
  return partial.length === 1 ? partial[0] : null;
}

function roleCard(player, players) {
  const role = ROLES[player.role_key];
  const pack =
    player.team === "wolves"
      ? players
          .filter(
            (other) =>
              Number(other.id) !== Number(player.id) &&
              Number(other.is_alive) === 1 &&
              other.team === "wolves",
          )
          .map((other) => other.display_name)
      : [];
  const lines = [
    `🐺 دورك في لعبة المستذئب: ${role?.name || "غير معروف"}`,
    role?.description || "",
    pack.length ? `🤝 حلفاؤك: ${pack.join("، ")}` : "",
    "",
    player.role_key === "werewolf"
      ? "🌙 رد على بطاقة القدرة برقم لاعب من القرويين."
      : player.role_key === "seer"
        ? "🔮 رد على بطاقة القدرة برقم اللاعب لفحصه."
        : player.role_key === "witch"
          ? "🧪 رد على بطاقة القدرة بكلمة save للإنقاذ أو poison <رقم اللاعب> للسم."
          : player.role_key === "cupid"
            ? "💘 في الليلة الأولى فقط، رد على بطاقة القدرة بـ love <رقم اللاعب الأول> <رقم اللاعب الثاني>."
            : player.role_key === "hunter"
              ? "🎯 عند خروجك ستصلك فرصة لإطلاق طلقتك الأخيرة."
              : "🌙 لا تملك قدرة ليلية.",
    player.role_key === "cupid"
      ? "💘 إذا مات أحد العاشقين، يموت الآخر أيضاً. سيعرفان هويتيهما سراً."
      : "",
    `${REPLY_ACTION_MARKERS.appoint}\nيختار العمدة خليفته بالرد على بطاقة التعيين برقم اللاعب.`,
    "رد على بطاقة التصويت برقم اللاعب.",
    "📩 لإعادة إرسال دورك: /werewolfrole",
  ];
  return lines.filter(Boolean).join("\n");
}

async function assertSchema() {
  const schema = await fs.readFile(path.join(__dirname, "schema.sql"), "utf8");
  for (const statement of schema
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean))
    await db.query(statement);
  const stateColumns = await db.query(
    `SELECT COLUMN_NAME FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='werewolf_state'`,
  );
  if (!stateColumns.some((column) => column.COLUMN_NAME === "witch_prompt_round"))
    await db.query(
      "ALTER TABLE werewolf_state ADD COLUMN witch_prompt_round TINYINT UNSIGNED NOT NULL DEFAULT 0 AFTER after_hunter",
    );
  const actionColumns = await db.query(
    `SELECT COLUMN_NAME FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='werewolf_actions'`,
  );
  if (!actionColumns.some((column) => column.COLUMN_NAME === "target_player_id_2"))
    await db.query(
      "ALTER TABLE werewolf_actions ADD COLUMN target_player_id_2 INT UNSIGNED NULL AFTER target_player_id",
    );
  const migrations = [
    ["lover_player_id_one", "INT UNSIGNED NULL"],
    ["lover_player_id_two", "INT UNSIGNED NULL"],
    ["sheriff_player_id", "INT UNSIGNED NULL"],
    ["sheriff_successor_player_id", "INT UNSIGNED NULL"],
    ["sheriff_election_done", "TINYINT(1) NOT NULL DEFAULT 0"],
    ["pending_hunter_queue", "TEXT NULL"],
  ];
  for (const [column, definition] of migrations) {
    if (!stateColumns.some((entry) => entry.COLUMN_NAME === column))
      await db.query(
        `ALTER TABLE werewolf_state ADD COLUMN ${column} ${definition}`,
      );
  }
}

async function canHandleMessage({ userId, isGroup }) {
  return !isGroup && Boolean(await getSession(userId));
}

async function handleMessage(context) {
  const { name, command } = commandParts(context.text);
  if (context.isGroup) {
    if (["ذئب", "مستذئب", "werewolf"].includes(name))
      return createRoom(context.userId, context.threadId);
    return handleGroup(context, command);
  }
  return handlePrivate(context, command, commandParts(context.text).arg);
}

async function handleReaction({ userId, threadId, messageId }) {
  const room = await db.one(
    `SELECT * FROM game_rooms
     WHERE game_id='werewolf' AND thread_id=? AND lobby_message_id=?
       AND status='lobby' AND phase='lobby'`,
    [threadId, messageId],
  );
  if (room) return registerPlayer(room, userId);
}

async function joinLobby(userId, threadId) {
  const room = await getRoomByThread(threadId);
  if (!room || room.status !== "lobby" || room.phase !== "lobby")
    return msg.sendGroup(
      threadId,
      "ℹ️ لا يوجد تسجيل مفتوح للمستذئب حالياً. اكتبوا «ذئب» لبدء التسجيل.",
    );
  return registerPlayer(room, userId);
}

async function createRoom(userId, threadId) {
  if (await db.isUserBanned(userId))
    return msg.sendGroup(
      threadId,
      "أنت محظور من بدء الألعاب.",
    );
  const active = await db.one(
    "SELECT id FROM game_rooms WHERE thread_id=? AND status IN ('lobby','playing') LIMIT 1",
    [threadId],
  );
  if (active)
    return msg.sendGroup(
      threadId,
      "⚠️ توجد لعبة نشطة في المجموعة. أنهِها قبل بدء لعبة المستذئب.",
    );

  let roomId;
  try {
    const result = await db.query(
      "INSERT INTO game_rooms (game_id, thread_id, host_psid, status, phase) VALUES ('werewolf',?,?, 'lobby','lobby')",
      [threadId, userId],
    );
    roomId = result.insertId;
  } catch (error) {
    if (error.code === "ER_DUP_ENTRY")
      return msg.sendGroup(threadId, "⚠️ توجد لعبة نشطة في هذه المجموعة.");
    throw error;
  }

  const messageId = await msg.sendGroupTracked(
    threadId,
    ui.lobbyMessage({
      title: "لعبة المستذئب",
      tagline: "اكتشفوا الذئاب قبل سيطرتها.",
      min: CFG.MIN_PLAYERS,
      max: CFG.MAX_PLAYERS,
      seconds: CFG.LOBBY_SECONDS,
      leaveCommand: "خروج ذئب",
    }),
  );
  if (!messageId) {
    await db.query(
      "UPDATE game_rooms SET status='cancelled', phase='finished', phase_ends_at=NULL WHERE id=? AND game_id='werewolf'",
      [roomId],
    );
    return;
  }
  await db.query(
    "UPDATE game_rooms SET lobby_message_id=?, phase_ends_at=DATE_ADD(NOW(), INTERVAL ? SECOND) WHERE id=? AND game_id='werewolf' AND status='lobby'",
    [messageId, CFG.LOBBY_SECONDS, roomId],
  );
  await registerPlayer(
    { id: roomId, thread_id: threadId, status: "lobby", phase: "lobby" },
    userId,
  );
}

async function registerPlayer(room, userId) {
  if (!room || room.status !== "lobby" || room.phase !== "lobby") return;
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
    return msg.sendGroup(room.thread_id, "⛔ اكتمل عدد لاعبي لعبة المستذئب.");
  let name = await msg.getUserName(userId);
  if (players.some((player) => player.display_name === name))
    name = `${name} (${players.length + 1})`;
  try {
    await db.query(
      "INSERT INTO werewolf_players (room_id, psid, display_name) VALUES (?,?,?)",
      [room.id, userId, name],
    );
  } catch (error) {
    if (error.code === "ER_DUP_ENTRY") return;
    throw error;
  }
  const announcement = ui.joinAnnouncement({
    name,
    count: players.length + 1,
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
    console.error(
      `[werewolf] reaction recovery failed for room ${roomId}:`,
      error,
    );
  }
  const players = await getPlayers(roomId);
  if (players.length < CFG.MIN_PLAYERS) {
    const cancelled = await db.query(
      "UPDATE game_rooms SET status='cancelled', phase='finished', phase_ends_at=NULL WHERE id=? AND game_id='werewolf' AND status='lobby'",
      [roomId],
    );
    if (cancelled.affectedRows)
      await msg.sendGroup(
        room.thread_id,
        `لم يكتمل العدد (${CFG.MIN_PLAYERS})؛ أُلغيت اللعبة.`,
      );
    return;
  }
  const locked = await db.query(
    "UPDATE game_rooms SET status='playing', phase='assigning', phase_ends_at=NULL WHERE id=? AND game_id='werewolf' AND status='lobby'",
    [roomId],
  );
  if (!locked.affectedRows) return;

  const randomizedPlayers = shuffle(players);
  const roles = createRoleSet(players.length);
  const assigned = [];
  try {
    await db.withTransaction(async (query) => {
      for (let index = 0; index < randomizedPlayers.length; index++) {
        const role = roles[index];
        const player = randomizedPlayers[index];
        await query(
          "UPDATE werewolf_players SET role_key=?, team=?, is_alive=1, witch_heal_used=0, witch_poison_used=0 WHERE id=? AND room_id=?",
          [role.key, role.team, player.id, roomId],
        );
        assigned.push({
          ...player,
          ...role,
          role_key: role.key,
          is_alive: 1,
        });
      }
      await query(
        `INSERT INTO werewolf_state
           (room_id, pending_hunter_player_id, after_hunter, witch_prompt_round,
            lover_player_id_one, lover_player_id_two, sheriff_player_id,
            sheriff_successor_player_id, sheriff_election_done, pending_hunter_queue)
         VALUES (?, NULL, NULL, 0, NULL, NULL, NULL, NULL, 0, NULL)
         ON DUPLICATE KEY UPDATE pending_hunter_player_id=NULL, after_hunter=NULL,
           witch_prompt_round=0, lover_player_id_one=NULL, lover_player_id_two=NULL,
           sheriff_player_id=NULL, sheriff_successor_player_id=NULL,
           sheriff_election_done=0, pending_hunter_queue=NULL`,
        [roomId],
      );
    });
  } catch (error) {
    await db.query(
      "UPDATE game_rooms SET status='cancelled', phase='finished', phase_ends_at=NULL WHERE id=? AND game_id='werewolf' AND status='playing'",
      [roomId],
    );
    throw error;
  }

  let failed = false;
  for (const player of assigned) {
    const sent = await msg.sendPrivateWithResult(
      player.psid,
      roleCard(player, assigned),
    );
    if (!sent.ok) {
      failed = true;
      console.error(
        `[werewolf] role delivery failed for player ${player.id}:`,
        sent.reason,
      );
    }
  }
  if (failed) {
    await db.query(
      "UPDATE game_rooms SET status='cancelled', phase='finished', phase_ends_at=NULL WHERE id=? AND game_id='werewolf' AND status='playing' AND phase='assigning'",
      [roomId],
    );
    return msg.sendGroup(
      room.thread_id,
      "لم تصل الأدوار للجميع؛ أُلغيت اللعبة. راجعوا طلبات الرسائل وأعيدوا المحاولة.",
    );
  }
  await startSheriffElection(roomId);
}

async function startNight(roomId, advanceRound) {
  const room = await getRoom(roomId);
  if (!room || room.status !== "playing") return;
  const round = Number(room.current_round || 0) + (advanceRound ? 1 : 0);
  const currentRound = round || 1;
  const moved = await db.query(
    `UPDATE game_rooms SET phase='night', current_round=?,
       phase_ends_at=DATE_ADD(NOW(), INTERVAL ? SECOND)
     WHERE id=? AND game_id='werewolf' AND status='playing'
       AND phase IN ('assigning','tallying','hunter','voting')`,
    [currentRound, CFG.NIGHT_SECONDS, roomId],
  );
  if (!moved.affectedRows) return;
  const players = alivePlayers(await getPlayers(roomId));
  await msg.sendGroup(
    room.thread_id,
    `الليلة ${currentRound} (${CFG.NIGHT_SECONDS}ث). الاختيارات في الخاص.`,
  );
  for (const player of players) {
    let prompt;
    if (player.role_key === "werewolf")
      prompt = `${REPLY_ACTION_MARKERS.action}\nاختروا ضحية:\n${playerList(players.filter((other) => other.team !== "wolves"))}\nرد على هذه البطاقة برقم اللاعب.`;
    else if (player.role_key === "cupid" && currentRound === 1)
      prompt = `${REPLY_ACTION_MARKERS.action}\nاختر عاشقين:\n${playerList(players)}\nرد على هذه البطاقة بـ love <رقم1> <رقم2>.`;
    else if (player.role_key === "seer")
      prompt = `${REPLY_ACTION_MARKERS.action}\nافحص لاعباً:\n${playerList(players.filter((other) => Number(other.id) !== Number(player.id)))}\nرد على هذه البطاقة برقم اللاعب.`;
    else if (player.role_key === "witch") {
      prompt = `${REPLY_ACTION_MARKERS.action}\nالساحرة: رد على هذه البطاقة بـ save للإنقاذ أو poison <رقم> للسم (مرة لكل جرعة).\n${playerList(players)}`;
    } else {
      continue;
    }
    const sent = await msg.sendPrivateWithResult(player.psid, prompt);
    if (!sent.ok)
      console.error(
        `[werewolf] night prompt failed for player ${player.id}:`,
        sent.reason,
      );
  }
}

async function saveNightAction(
  roomId,
  round,
  actorId,
  actionType,
  targetId,
  targetIdTwo = null,
) {
  await db.query(
    `INSERT INTO werewolf_actions
      (room_id, round_number, actor_player_id, action_type, target_player_id, target_player_id_2)
     VALUES (?,?,?,?,?,?)
     ON DUPLICATE KEY UPDATE target_player_id=VALUES(target_player_id),
       target_player_id_2=VALUES(target_player_id_2)`,
    [roomId, round, actorId, actionType, targetId, targetIdTwo],
  );
}

async function submitNightAction(userId, session, argument) {
  if (session.status !== "playing" || session.phase !== "night")
    return msg.sendPrivate(userId, "⌛ لا توجد ليلة مفتوحة الآن.");
  if (Number(session.is_alive) !== 1)
    return msg.sendPrivate(userId, "⛔ لا يمكنك تنفيذ قدرة بعد خروجك.");
  const players = alivePlayers(await getPlayers(session.room_id));
  const input = String(argument || "").trim();
  let actionType;
  let target = null;
  let targetTwo = null;
  if (session.role_key === "werewolf") {
    target = findTarget(
      players.filter((player) => player.team !== "wolves"),
      input,
    );
    if (!target)
      return msg.sendPrivate(
        userId,
        `اختر لاعباً من القرويين:\n${playerList(players.filter((player) => player.team !== "wolves"))}`,
      );
    const wolfVotes = await db.one(
      `SELECT COUNT(DISTINCT wa.actor_player_id) AS count
       FROM werewolf_actions wa
       JOIN werewolf_players wp ON wp.id=wa.actor_player_id
       WHERE wa.room_id=? AND wa.round_number=? AND wa.action_type='wolf_vote'
         AND wp.is_alive=1 AND wp.team='wolves'`,
      [session.room_id, session.current_round],
    );
    if (
      Number(wolfVotes?.count || 0) >=
      players.filter((player) => player.team === "wolves").length
    )
      return msg.sendPrivate(
        userId,
        "🔒 اكتملت اختيارات الذئاب؛ أُغلق التصويت الليلي.",
      );
    actionType = "wolf_vote";
  } else if (session.role_key === "cupid") {
    if (Number(session.current_round) !== 1)
      return msg.sendPrivate(userId, "💘 يستطيع كيوبيد اختيار العاشقين في الليلة الأولى فقط.");
    const match = input.match(/^love\s+(\d+)\s+(\d+)$/i);
    if (!match)
      return msg.sendPrivate(
        userId,
        "رد على بطاقة القدرة بصيغة love <رقم اللاعب الأول> <رقم اللاعب الثاني>.",
      );
    target = players.find((player) => Number(player.id) === Number(match[1]));
    targetTwo = players.find((player) => Number(player.id) === Number(match[2]));
    if (!target || !targetTwo || Number(target.id) === Number(targetTwo.id))
      return msg.sendPrivate(userId, `اختر لاعبين مختلفين من القائمة:\n${playerList(players)}`);
    actionType = "cupid_pair";
  } else if (session.role_key === "seer") {
    target = findTarget(
      players.filter((player) => Number(player.id) !== Number(session.id)),
      input,
    );
    if (!target)
      return msg.sendPrivate(
        userId,
        `اختر لاعباً حياً غيرك:\n${playerList(players.filter((player) => Number(player.id) !== Number(session.id)))}`,
      );
    actionType = "seer_check";
  } else if (session.role_key === "witch") {
    const [verb, ...rest] = input.split(/\s+/);
    const normalized = verb.toLowerCase();
    if (["save", "انقاذ", "إنقاذ"].includes(normalized)) {
      if (Number(session.witch_heal_used))
        return msg.sendPrivate(userId, "⛔ استُخدمت جرعة الإنقاذ بالفعل.");
      const wolfVotes = await db.one(
        `SELECT COUNT(DISTINCT wa.actor_player_id) AS count
         FROM werewolf_actions wa
         JOIN werewolf_players wp ON wp.id=wa.actor_player_id
         WHERE wa.room_id=? AND wa.round_number=? AND wa.action_type='wolf_vote'
           AND wp.is_alive=1 AND wp.team='wolves'`,
        [session.room_id, session.current_round],
      );
      if (
        Number(wolfVotes?.count || 0) <
        players.filter((player) => player.team === "wolves").length
      )
        return msg.sendPrivate(
          userId,
          "انتظري حتى تختار الذئاب ضحيتها؛ سأرسل لك إشعاراً فور اتفاقهم.",
        );
      actionType = "witch_save";
    } else if (["poison", "سم"].includes(normalized)) {
      if (Number(session.witch_poison_used))
        return msg.sendPrivate(userId, "⛔ استُخدمت جرعة السم بالفعل.");
      target = findTarget(players, rest.join(" "));
      if (!target)
        return msg.sendPrivate(
          userId,
          `اختر لاعباً حياً لتسميمه:\n${playerList(players)}`,
        );
      actionType = "witch_poison";
    } else {
      return msg.sendPrivate(
        userId,
        "رد على بطاقة القدرة بـ save للإنقاذ أو poison <رقم اللاعب> للسم.",
      );
    }
  } else {
    return msg.sendPrivate(userId, "ℹ️ لا تملك قدرة ليلية.");
  }

  await saveNightAction(
    session.room_id,
    session.current_round,
    session.id,
    actionType,
    target?.id || null,
    targetTwo?.id || null,
  );
  if (actionType === "wolf_vote")
    await maybePromptWitch(session.room_id, Number(session.current_round));
  return msg.sendPrivate(
    userId,
    actionType === "wolf_vote"
      ? `✅ سُجل اختيارك السري${target ? `: ${target.display_name}` : ""}. يمكن تغييره حتى اكتمال اختيارات الذئاب.`
      : actionType === "cupid_pair"
        ? `💘 سُجل اختيار العاشقين سراً: ${target.display_name} و${targetTwo.display_name}.`
        : `✅ سُجل اختيارك السري${target ? `: ${target.display_name}` : ""}. يمكنك تغييره قبل انتهاء الليل.`,
  );
}

async function maybePromptWitch(roomId, round) {
  const [players, state, votes] = await Promise.all([
    getPlayers(roomId),
    db.one(
      "SELECT witch_prompt_round FROM werewolf_state WHERE room_id=?",
      [roomId],
    ),
    db.one(
      `SELECT COUNT(DISTINCT wa.actor_player_id) AS count
       FROM werewolf_actions wa
       JOIN werewolf_players wp ON wp.id=wa.actor_player_id
       WHERE wa.room_id=? AND wa.round_number=? AND wa.action_type='wolf_vote'
         AND wp.is_alive=1 AND wp.team='wolves'`,
      [roomId, round],
    ),
  ]);
  const livingWolves = players.filter(
    (player) => Number(player.is_alive) === 1 && player.team === "wolves",
  );
  const witch = players.find(
    (player) => Number(player.is_alive) === 1 && player.role_key === "witch",
  );
  if (
    !witch ||
    Number(votes?.count || 0) < livingWolves.length ||
    Number(state?.witch_prompt_round || 0) >= round
  )
    return;
  const claimed = await db.query(
    "UPDATE werewolf_state SET witch_prompt_round=? WHERE room_id=? AND witch_prompt_round<?",
    [round, roomId, round],
  );
  if (!claimed.affectedRows) return;
  const actions = await loadActions(roomId, round);
  const counts = new Map();
  for (const action of actions.filter((entry) => entry.action_type === "wolf_vote")) {
    const targetId = Number(action.target_player_id);
    counts.set(targetId, (counts.get(targetId) || 0) + 1);
  }
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const tied = sorted.length > 1 && sorted[0][1] === sorted[1][1];
  const target = tied
    ? null
    : players.find((player) => Number(player.id) === sorted[0]?.[0]);
  const text = target
    ? `${REPLY_ACTION_MARKERS.action}\n🐺 اختارت الذئاب ${target.display_name} ضحيةً الليلة. هل تنقذينها؟ ردي على هذه الرسالة بـ save.\nيمكنك أيضاً الرد بـ poison <رقم اللاعب>.`
    : `${REPLY_ACTION_MARKERS.action}\n🐺 لم تتفق الذئاب على ضحية؛ لا توجد ضحية لإنقاذها. يمكنك الرد بـ poison <رقم اللاعب>.`;
  const sent = await msg.sendPrivateWithResult(witch.psid, text);
  if (!sent.ok)
    console.error(
      `[werewolf] witch prompt failed for player ${witch.id}:`,
      sent.reason,
    );
}

async function submitVote(userId, session, input) {
  const state = await db.one(
    `SELECT lover_player_id_one, lover_player_id_two, sheriff_election_done
     FROM werewolf_state WHERE room_id=?`,
    [session.room_id],
  );
  const sheriffElection =
    session.phase === "voting" &&
    Number(session.current_round) === 0 &&
    !Number(state?.sheriff_election_done);
  if (
    session.status !== "playing" ||
    (session.phase !== "voting" && !sheriffElection)
  )
    return msg.sendPrivate(userId, "⌛ لا يوجد تصويت مفتوح الآن.");
  if (Number(session.is_alive) !== 1)
    return msg.sendPrivate(userId, "⛔ لا يمكنك التصويت بعد خروجك.");
  const players = alivePlayers(await getPlayers(session.room_id));
  const partnerId =
    Number(state?.lover_player_id_one) === Number(session.id)
      ? Number(state?.lover_player_id_two)
      : Number(state?.lover_player_id_two) === Number(session.id)
        ? Number(state?.lover_player_id_one)
        : 0;
  const eligible = players.filter(
    (player) =>
      (sheriffElection || Number(player.id) !== Number(session.id)) &&
      Number(player.id) !== partnerId,
  );
  const target = findTarget(eligible, input);
  if (!target)
    return msg.sendPrivate(
      userId,
      sheriffElection
        ? `اختر لاعباً حياً غير شريكك:\n${playerList(eligible)}`
        : `اختر لاعباً حياً غيرك أو شريكك:\n${playerList(eligible)}`,
    );
  const voteRound = sheriffElection ? 0 : Number(session.current_round);
  await db.query(
    `INSERT INTO werewolf_votes
      (room_id, round_number, voter_player_id, target_player_id)
     VALUES (?,?,?,?)
     ON DUPLICATE KEY UPDATE target_player_id=VALUES(target_player_id)`,
    [session.room_id, voteRound, session.id, target.id],
  );
  const count = await db.one(
    `SELECT COUNT(*) AS count FROM werewolf_votes wv
     JOIN werewolf_players voter ON voter.id=wv.voter_player_id
     WHERE wv.room_id=? AND wv.round_number=? AND voter.is_alive=1`,
    [session.room_id, voteRound],
  );
  await msg.sendPrivate(
    userId,
    sheriffElection
      ? `✅ سُجل تصويتك السري للعمدة: ${target.display_name}.`
      : `✅ سُجل تصويتك سراً لـ ${target.display_name}.`,
  );
  if (Number(count.count) >= players.length)
    return sheriffElection
      ? resolveSheriffElection(session.room_id)
      : resolveVoting(session.room_id);
}

async function loadActions(roomId, round) {
  return db.query(
    `SELECT wa.*, actor.role_key, actor.team, actor.is_alive,
            actor.witch_heal_used, actor.witch_poison_used
     FROM werewolf_actions wa
     JOIN werewolf_players actor ON actor.id=wa.actor_player_id
     WHERE wa.room_id=? AND wa.round_number=? AND actor.is_alive=1
     ORDER BY wa.actor_player_id`,
    [roomId, round],
  );
}

async function recordDeaths(roomId, round, targets, cause) {
  const deaths = [];
  for (const target of targets) {
    if (!target) continue;
    const result = await db.query(
      "UPDATE werewolf_players SET is_alive=0 WHERE id=? AND room_id=? AND is_alive=1",
      [target.id, roomId],
    );
    if (!result.affectedRows) continue;
    await db.query(
      "INSERT INTO werewolf_deaths (room_id, round_number, player_id, cause) VALUES (?,?,?,?)",
      [roomId, round, target.id, cause],
    );
    deaths.push(target);
  }
  return deaths;
}

async function applyLoverConsequences(roomId, round, deaths) {
  if (!deaths.length) return deaths;
  const state = await db.one(
    "SELECT lover_player_id_one, lover_player_id_two FROM werewolf_state WHERE room_id=?",
    [roomId],
  );
  const loverIds = [
    Number(state?.lover_player_id_one),
    Number(state?.lover_player_id_two),
  ].filter(Boolean);
  if (loverIds.length !== 2) return deaths;
  const deathIds = new Set(deaths.map((player) => Number(player.id)));
  const lostLover = loverIds.find((playerId) => deathIds.has(playerId));
  if (!lostLover) return deaths;
  const survivingId = loverIds.find((playerId) => playerId !== lostLover);
  const survivor = (await getPlayers(roomId)).find(
    (player) => Number(player.id) === survivingId && Number(player.is_alive) === 1,
  );
  if (!survivor) return deaths;
  const [loverDeath] = await recordDeaths(
    roomId,
    round,
    [survivor],
    "lover",
  );
  if (loverDeath) deaths.push(loverDeath);
  return deaths;
}

async function updateSheriffAfterDeaths(roomId, deaths) {
  if (!deaths.length) return null;
  const state = await db.one(
    "SELECT sheriff_player_id, sheriff_successor_player_id FROM werewolf_state WHERE room_id=?",
    [roomId],
  );
  const sheriffId = Number(state?.sheriff_player_id);
  if (!sheriffId || !deaths.some((player) => Number(player.id) === sheriffId))
    return null;
  const successorId = Number(state.sheriff_successor_player_id);
  const survivor = successorId
    ? (await getPlayers(roomId)).find(
        (player) =>
          Number(player.id) === successorId && Number(player.is_alive) === 1,
      )
    : null;
  await db.query(
    "UPDATE werewolf_state SET sheriff_player_id=?, sheriff_successor_player_id=NULL WHERE room_id=?",
    [survivor?.id || null, roomId],
  );
  return { successor: survivor || null };
}

async function announceSheriffTransfer(roomId, transfer) {
  if (!transfer) return;
  const room = await getRoom(roomId);
  if (!room) return;
  return msg.sendGroup(
    room.thread_id,
    transfer.successor
      ? `⭐ انتقلت شارة العمدة إلى ${transfer.successor.display_name}.`
      : "⭐ خرج العمدة دون خليفة حي؛ لم تعد هناك شارة عمدة.",
  );
}

async function resolveNight(roomId) {
  const locked = await db.query(
    "UPDATE game_rooms SET phase='tallying', phase_ends_at=NULL WHERE id=? AND game_id='werewolf' AND status='playing' AND phase='night'",
    [roomId],
  );
  if (!locked.affectedRows) return;
  const room = await getRoom(roomId);
  const round = Number(room.current_round);
  const players = alivePlayers(await getPlayers(roomId));
  const actions = await loadActions(roomId, round);
  const results = new Map();
  const cupidPair = actions.find(
    (action) => action.action_type === "cupid_pair",
  );
  if (cupidPair && round === 1 && cupidPair.target_player_id_2) {
    const first = players.find(
      (player) => Number(player.id) === Number(cupidPair.target_player_id),
    );
    const second = players.find(
      (player) => Number(player.id) === Number(cupidPair.target_player_id_2),
    );
    if (first && second && Number(first.id) !== Number(second.id)) {
      await db.query(
        `UPDATE werewolf_state
         SET lover_player_id_one=?, lover_player_id_two=? WHERE room_id=?`,
        [first.id, second.id, roomId],
      );
      for (const [lover, partner] of [[first, second], [second, first]]) {
        const sent = await msg.sendPrivateWithResult(
          lover.psid,
          `💘 أصبحتما عاشقين سراً مع ${partner.display_name}. إذا خرج أحدكما، يخرج الآخر معه. لا تصوّت على شريكك.`,
        );
        if (!sent.ok)
          console.error(
            `[werewolf] lover notification failed for player ${lover.id}:`,
            sent.reason,
          );
      }
    }
  }
  const wolves = actions.filter((action) => action.action_type === "wolf_vote");
  const wolfCounts = new Map();
  for (const action of wolves) {
    const targetId = Number(action.target_player_id);
    wolfCounts.set(targetId, (wolfCounts.get(targetId) || 0) + 1);
  }
  const sortedWolfVotes = [...wolfCounts.entries()].sort((a, b) => b[1] - a[1]);
  const wolfTie =
    sortedWolfVotes.length > 1 &&
    sortedWolfVotes[0][1] === sortedWolfVotes[1][1];
  const wolfTargetId = wolfTie ? null : sortedWolfVotes[0]?.[0] || null;
  const wolfTarget = players.find(
    (player) => Number(player.id) === Number(wolfTargetId),
  );
  for (const action of actions.filter(
    (entry) => entry.action_type === "seer_check",
  )) {
    const target = players.find(
      (player) => Number(player.id) === Number(action.target_player_id),
    );
    if (target)
      results.set(
        Number(action.actor_player_id),
        `🔮 نتيجة فحصك: ${target.display_name} ${target.team === "wolves" ? "مستذئب" : "ليس مستذئباً"}.`,
      );
  }

  const witchSave = actions.find(
    (action) => action.action_type === "witch_save",
  );
  const witchPoison = actions.find(
    (action) => action.action_type === "witch_poison",
  );
  let wolfVictim = wolfTarget;
  if (wolfVictim && witchSave) {
    wolfVictim = null;
    await db.query(
      "UPDATE werewolf_players SET witch_heal_used=1 WHERE id=? AND room_id=?",
      [witchSave.actor_player_id, roomId],
    );
    results.set(Number(witchSave.actor_player_id), "🧪 أنقذت ضحية الذئاب.");
  } else if (witchSave) {
    results.set(
      Number(witchSave.actor_player_id),
      "🧪 لم تكن هناك ضحية للإنقاذ؛ احتفظت بجرعتك.",
    );
  }
  const victims = [];
  if (wolfVictim) victims.push({ player: wolfVictim, cause: "werewolf" });
  const poisonVictim = players.find(
    (player) => Number(player.id) === Number(witchPoison?.target_player_id),
  );
  if (poisonVictim) {
    victims.push({ player: poisonVictim, cause: "witch" });
    await db.query(
      "UPDATE werewolf_players SET witch_poison_used=1 WHERE id=? AND room_id=?",
      [witchPoison.actor_player_id, roomId],
    );
    results.set(
      Number(witchPoison.actor_player_id),
      `☠️ استُخدمت جرعة السم ضد ${poisonVictim.display_name}.`,
    );
  }
  if (wolfTarget) {
    for (const action of wolves)
      results.set(
        Number(action.actor_player_id),
        wolfVictim
          ? `🐺 اختيرت ضحية الذئاب: ${wolfTarget.display_name}.`
          : "🧪 أنقذت الساحرة ضحية الذئاب.",
      );
  } else {
    for (const action of wolves)
      results.set(Number(action.actor_player_id), "🌙 لم تتفق الذئاب على ضحية.");
  }

  const deaths = await recordDeaths(
    roomId,
    round,
    victims.map((victim) => victim.player),
    "night",
  );
  await applyLoverConsequences(roomId, round, deaths);
  await announceSheriffTransfer(
    roomId,
    await updateSheriffAfterDeaths(roomId, deaths),
  );
  for (const [playerId, text] of results) {
    if (!text) continue;
    const player = (await getPlayers(roomId)).find(
      (entry) => Number(entry.id) === Number(playerId),
    );
    if (player) {
      const sent = await msg.sendPrivateWithResult(player.psid, text);
      if (!sent.ok)
        console.error(
          `[werewolf] private result failed for player ${player.id}:`,
          sent.reason,
        );
    }
  }

  const hunters = deaths.filter((player) => player.role_key === "hunter");
  if (hunters.length)
    return requestHunterShot(roomId, hunters[0], "discussion", hunters.slice(1));
  return completeNight(roomId, deaths);
}

async function completeNight(roomId, deaths) {
  const room = await getRoom(roomId);
  if (!room || room.status !== "playing") return;
  const report = deaths.length
    ? `🌅 تقرير الصباح:\n${deaths.map((player) => `• ${player.display_name} — ${ROLES[player.role_key]?.name || "غير معروف"}`).join("\n")}`
    : "🌅 حلّ الصباح ولم تقع ضحايا.";
  await msg.sendGroup(room.thread_id, report);
  if (await checkVictory(roomId)) return;
  return startDiscussion(roomId);
}

async function startSheriffElection(roomId) {
  const updated = await db.query(
    `UPDATE game_rooms SET phase='voting',
       phase_ends_at=DATE_ADD(NOW(), INTERVAL ? SECOND)
     WHERE id=? AND game_id='werewolf' AND status='playing'
       AND phase='assigning'`,
    [CFG.VOTING_SECONDS, roomId],
  );
  if (!updated.affectedRows) return;
  const room = await getRoom(roomId);
  const living = alivePlayers(await getPlayers(roomId));
  await msg.sendGroup(room.thread_id, "⭐ حان وقت انتخاب العمدة الأول. صوّتوا سراً لأحد الأحياء.");
  const state = await db.one(
    "SELECT lover_player_id_one, lover_player_id_two FROM werewolf_state WHERE room_id=?",
    [roomId],
  );
  for (const player of living) {
    const partnerId =
      Number(state?.lover_player_id_one) === Number(player.id)
        ? Number(state?.lover_player_id_two)
        : Number(state?.lover_player_id_two) === Number(player.id)
          ? Number(state?.lover_player_id_one)
          : 0;
    const candidates = living.filter(
      (candidate) => Number(candidate.id) !== partnerId,
    );
    const sent = await msg.sendPrivateWithResult(
      player.psid,
      `${REPLY_ACTION_MARKERS.vote}\n⭐ انتخاب العمدة:\n${playerList(candidates)}\n\nرد على هذه البطاقة برقم اللاعب. يمكنك التصويت لنفسك.`,
    );
    if (!sent.ok)
      console.error(
        `[werewolf] sheriff election prompt failed for player ${player.id}:`,
        sent.reason,
      );
  }
}

async function resolveSheriffElection(roomId) {
  const locked = await db.query(
    "UPDATE game_rooms SET phase='tallying', phase_ends_at=NULL WHERE id=? AND game_id='werewolf' AND status='playing' AND phase='voting'",
    [roomId],
  );
  if (!locked.affectedRows) return;
  const room = await getRoom(roomId);
  const votes = await db.query(
    `SELECT target_player_id, COUNT(*) AS count
     FROM werewolf_votes
     WHERE room_id=? AND round_number=0
     GROUP BY target_player_id`,
    [roomId],
  );
  const order = votes
    .map((vote) => ({
      targetId: Number(vote.target_player_id),
      count: Number(vote.count),
    }))
    .sort((a, b) => b.count - a.count);
  const tie = order.length > 1 && order[0].count === order[1].count;
  const candidates = alivePlayers(await getPlayers(roomId));
  const sheriff = tie
    ? null
    : candidates.find((player) => Number(player.id) === order[0]?.targetId);
  await db.query(
    "UPDATE werewolf_state SET sheriff_player_id=?, sheriff_successor_player_id=NULL, sheriff_election_done=1 WHERE room_id=?",
    [sheriff?.id || null, roomId],
  );
  await msg.sendGroup(
    room.thread_id,
    sheriff
      ? `⭐ انتُخب ${sheriff.display_name} عمدةً للقرية؛ صوته النهاري يُحتسب بصوتين.`
      : "⭐ انتهى انتخاب العمدة بالتعادل أو دون أصوات؛ لا يوجد عمدة هذه الجولة.",
  );
  return startNight(roomId, false);
}

async function startDiscussion(roomId) {
  const updated = await db.query(
    "UPDATE game_rooms SET phase='discussion', phase_ends_at=DATE_ADD(NOW(), INTERVAL ? SECOND) WHERE id=? AND game_id='werewolf' AND status='playing' AND phase IN ('tallying','hunter')",
    [CFG.DISCUSSION_SECONDS, roomId],
  );
  if (!updated.affectedRows) return;
  const room = await getRoom(roomId);
  const living = alivePlayers(await getPlayers(roomId));
  await msg.sendGroup(
    room.thread_id,
    `💬 أمامكم ${CFG.DISCUSSION_SECONDS} ثانية للنقاش.\nالأحياء: ${living.map((player) => player.display_name).join("، ")}`,
  );
}

async function startVoting(roomId) {
  const moved = await db.query(
    "UPDATE game_rooms SET phase='voting', phase_ends_at=DATE_ADD(NOW(), INTERVAL ? SECOND) WHERE id=? AND game_id='werewolf' AND status='playing' AND phase='discussion'",
    [CFG.VOTING_SECONDS, roomId],
  );
  if (!moved.affectedRows) return;
  const room = await getRoom(roomId);
  const players = alivePlayers(await getPlayers(roomId));
  if (players.length < 2) return checkVictory(roomId);
  const state = await db.one(
    "SELECT sheriff_player_id, lover_player_id_one, lover_player_id_two FROM werewolf_state WHERE room_id=?",
    [roomId],
  );
  await msg.sendGroup(
    room.thread_id,
    `🗳️ انتهى النقاش. أمامكم ${CFG.VOTING_SECONDS} ثانية للتصويت السري.`,
  );
  for (const player of players) {
    const partnerId =
      Number(state?.lover_player_id_one) === Number(player.id)
        ? Number(state?.lover_player_id_two)
        : Number(state?.lover_player_id_two) === Number(player.id)
          ? Number(state?.lover_player_id_one)
          : 0;
    const targets = players.filter(
      (other) =>
        Number(other.id) !== Number(player.id) &&
        Number(other.id) !== partnerId,
    );
    const sheriffReminder =
      Number(state?.sheriff_player_id) === Number(player.id)
        ? " صوتك يُحتسب بصوتين."
        : "";
    const sent = await msg.sendPrivateWithResult(
      player.psid,
      `${REPLY_ACTION_MARKERS.vote}\nرد على هذه البطاقة برقم اللاعب للتصويت.${sheriffReminder}\n${playerList(targets)}`,
    );
    if (!sent.ok)
      console.error(
        `[werewolf] vote prompt failed for player ${player.id}:`,
        sent.reason,
      );
  }
}

async function resolveVoting(roomId) {
  const locked = await db.query(
    "UPDATE game_rooms SET phase='tallying', phase_ends_at=NULL WHERE id=? AND game_id='werewolf' AND status='playing' AND phase='voting'",
    [roomId],
  );
  if (!locked.affectedRows) return;
  const room = await getRoom(roomId);
  const players = alivePlayers(await getPlayers(roomId));
  const state = await db.one(
    "SELECT sheriff_player_id FROM werewolf_state WHERE room_id=?",
    [roomId],
  );
  const votes = await db.query(
    `SELECT wv.voter_player_id, wv.target_player_id
     FROM werewolf_votes wv
     JOIN werewolf_players voter ON voter.id=wv.voter_player_id
     WHERE wv.room_id=? AND wv.round_number=? AND voter.is_alive=1
     ORDER BY wv.id`,
    [roomId, room.current_round],
  );
  const order = tallyWeightedVotes(votes, state?.sheriff_player_id);
  if (!order.length || (order[1] && order[1].count === order[0].count)) {
    await msg.sendGroup(room.thread_id, "🗳️ تعادل أو غياب الأصوات؛ لم يُخرج أحد.");
    if (!(await checkVictory(roomId))) await startNight(roomId, true);
    return;
  }
  const target = players.find((player) => Number(player.id) === order[0].targetId);
  if (!target) {
    await msg.sendGroup(room.thread_id, "⚠️ تعذّر تحديد نتيجة التصويت.");
    if (!(await checkVictory(roomId))) await startNight(roomId, true);
    return;
  }
  const deaths = await recordDeaths(
    roomId,
    Number(room.current_round),
    [target],
    "vote",
  );
  await applyLoverConsequences(roomId, Number(room.current_round), deaths);
  await announceSheriffTransfer(
    roomId,
    await updateSheriffAfterDeaths(roomId, deaths),
  );
  const death = deaths[0];
  if (!death) {
    await msg.sendGroup(room.thread_id, "🗳️ لم يُخرج أحد.");
    if (!(await checkVictory(roomId))) await startNight(roomId, true);
    return;
  }
  await msg.sendGroup(
    room.thread_id,
    `⚖️ أُخرج:\n${deaths.map((player) => `• ${player.display_name} — ${ROLES[player.role_key]?.name || "غير معروف"}${player.role_key === "hunter" ? " (صياد)" : ""}`).join("\n")}`,
  );
  const hunters = deaths.filter((player) => player.role_key === "hunter");
  if (hunters.length)
    return requestHunterShot(roomId, hunters[0], "night", hunters.slice(1));
  if (!(await checkVictory(roomId))) await startNight(roomId, true);
}

async function requestHunterShot(roomId, hunter, afterPhase, queuedHunters = []) {
  const room = await getRoom(roomId);
  if (!room || room.status !== "playing") return;
  await db.query(
    `UPDATE werewolf_state
     SET pending_hunter_player_id=?, after_hunter=?, pending_hunter_queue=?
     WHERE room_id=?`,
    [hunter.id, afterPhase, JSON.stringify(queuedHunters.map((player) => player.id)), roomId],
  );
  const moved = await db.query(
    "UPDATE game_rooms SET phase='hunter', phase_ends_at=DATE_ADD(NOW(), INTERVAL ? SECOND) WHERE id=? AND game_id='werewolf' AND status='playing' AND phase='tallying'",
    [CFG.HUNTER_SECONDS, roomId],
  );
  if (!moved.affectedRows) return;
  const players = alivePlayers(await getPlayers(roomId));
  await msg.sendGroup(
    room.thread_id,
    `🎯 خرج الصياد ${hunter.display_name}، ولديه ${CFG.HUNTER_SECONDS} ثانية لاختيار لاعب حي ليصيبه بآخر طلقة.`,
  );
  const sent = await msg.sendPrivateWithResult(
    hunter.psid,
    `${REPLY_ACTION_MARKERS.hunter}\nطلقتك الأخيرة! اختر لاعباً حياً خلال ${CFG.HUNTER_SECONDS} ثانية:\n${playerList(players)}\n\nرد على هذه البطاقة برقم اللاعب.`,
  );
  if (!sent.ok) {
    console.error(
      `[werewolf] hunter prompt failed for player ${hunter.id}:`,
      sent.reason,
    );
    await clearHunterAndContinue(roomId);
  }
}

async function submitHunterShot(userId, session, input) {
  if (session.status !== "playing" || session.phase !== "hunter")
    return msg.sendPrivate(userId, "⌛ لا توجد طلقة صياد متاحة الآن.");
  const state = await db.one(
    "SELECT pending_hunter_player_id FROM werewolf_state WHERE room_id=?",
    [session.room_id],
  );
  if (Number(state?.pending_hunter_player_id) !== Number(session.id))
    return msg.sendPrivate(userId, "🔒 هذه الطلقة تخص صياداً آخر.");
  const players = alivePlayers(await getPlayers(session.room_id));
  const target = findTarget(players, input);
  if (!target)
    return msg.sendPrivate(userId, `اختر لاعباً حياً:\n${playerList(players)}`);
  const deaths = await recordDeaths(
    session.room_id,
    Number(session.current_round),
    [target],
    "hunter",
  );
  await applyLoverConsequences(
    session.room_id,
    Number(session.current_round),
    deaths,
  );
  await announceSheriffTransfer(
    session.room_id,
    await updateSheriffAfterDeaths(session.room_id, deaths),
  );
  if (deaths.length)
    await msg.sendGroup(
      session.thread_id,
      `🎯 أصابت طلقة الصياد:\n${deaths.map((player) => `• ${player.display_name} — ${ROLES[player.role_key]?.name || "غير معروف"}`).join("\n")}`,
    );
  return continueHunterChain(
    session.room_id,
    deaths.filter((player) => player.role_key === "hunter").map((player) => player.id),
  );
}

async function clearHunterAndContinue(roomId) {
  return continueHunterChain(roomId);
}

async function continueHunterChain(roomId, additionalHunterIds = []) {
  const state = await db.one(
    "SELECT pending_hunter_player_id, pending_hunter_queue, after_hunter FROM werewolf_state WHERE room_id=?",
    [roomId],
  );
  const room = await getRoom(roomId);
  if (!room || room.status !== "playing") return;
  const queued = JSON.parse(state?.pending_hunter_queue || "[]");
  const candidates = [
    ...queued.map(Number),
    ...additionalHunterIds.map(Number),
  ].filter(
    (id, index, list) =>
      id !== Number(state?.pending_hunter_player_id) && list.indexOf(id) === index,
  );
  const players = await getPlayers(roomId);
  while (candidates.length) {
    const nextId = candidates.shift();
    const hunter = players.find(
      (player) => Number(player.id) === nextId && player.role_key === "hunter",
    );
    if (!hunter) continue;
    await db.query(
      `UPDATE werewolf_state SET pending_hunter_player_id=?,
       pending_hunter_queue=? WHERE room_id=?`,
      [hunter.id, JSON.stringify(candidates), roomId],
    );
    const living = alivePlayers(players);
    await msg.sendGroup(
      room.thread_id,
      `🎯 خرج الصياد ${hunter.display_name}، ولديه ${CFG.HUNTER_SECONDS} ثانية لاختيار لاعب حي ليصيبه بآخر طلقة.`,
    );
    const sent = await msg.sendPrivateWithResult(
      hunter.psid,
      `${REPLY_ACTION_MARKERS.hunter}\nطلقتك الأخيرة! اختر لاعباً حياً خلال ${CFG.HUNTER_SECONDS} ثانية:\n${playerList(living)}\n\nرد على هذه البطاقة برقم اللاعب.`,
    );
    if (sent.ok) {
      await db.query(
        "UPDATE game_rooms SET phase_ends_at=DATE_ADD(NOW(), INTERVAL ? SECOND) WHERE id=? AND game_id='werewolf' AND phase='hunter'",
        [CFG.HUNTER_SECONDS, roomId],
      );
      return;
    }
    console.error(
      `[werewolf] hunter prompt failed for player ${hunter.id}:`,
      sent.reason,
    );
  }
  await db.query(
    "UPDATE werewolf_state SET pending_hunter_player_id=NULL, pending_hunter_queue=NULL, after_hunter=NULL WHERE room_id=?",
    [roomId],
  );
  if (state?.after_hunter === "discussion") {
    const deaths = await db.query(
      `SELECT wp.* FROM werewolf_deaths wd
       JOIN werewolf_players wp ON wp.id=wd.player_id
       WHERE wd.room_id=? AND wd.round_number=? AND wd.cause IN ('night','hunter','lover')
       ORDER BY wd.id`,
      [roomId, room.current_round],
    );
    return completeNight(roomId, deaths);
  }
  if (!(await checkVictory(roomId))) return startNight(roomId, true);
}

async function checkVictory(roomId) {
  const living = alivePlayers(await getPlayers(roomId));
  const wolves = living.filter((player) => player.team === "wolves").length;
  if (!living.length)
    return finishGame(roomId, "draw", "لم ينجُ أحد بعد هجمات متزامنة.");
  const state = await db.one(
    "SELECT lover_player_id_one, lover_player_id_two FROM werewolf_state WHERE room_id=?",
    [roomId],
  );
  const lovers = [
    state?.lover_player_id_one,
    state?.lover_player_id_two,
  ];
  if (mixedLoversAreAlive(living, lovers)) {
    if (mixedLoversWin(living, lovers))
      return finishGame(
        roomId,
        "lovers",
        "نجا العاشقان المختلفا الفريق وحدهما؛ فازا معاً.",
      );
    return false;
  }
  if (!wolves)
    return finishGame(roomId, "village", "قضى القرويون على جميع المستذئبين.");
  if (wolves >= living.length - wolves)
    return finishGame(roomId, "wolves", "بلغ المستذئبون عدد بقية الأحياء أو تجاوزوه.");
  return false;
}

async function finishGame(roomId, winner, reason) {
  const updated = await db.query(
    "UPDATE game_rooms SET status='finished', phase='finished', phase_ends_at=NULL WHERE id=? AND game_id='werewolf' AND status='playing'",
    [roomId],
  );
  if (!updated.affectedRows) return winner;
  const room = await getRoom(roomId);
  const players = await getPlayers(roomId);
  const state = await db.one(
    "SELECT lover_player_id_one, lover_player_id_two FROM werewolf_state WHERE room_id=?",
    [roomId],
  );
  const loverIds = new Set(
    [
      Number(state?.lover_player_id_one),
      Number(state?.lover_player_id_two),
    ].filter(Boolean),
  );
  const winningPlayers =
    winner === "lovers"
      ? players.filter((player) => loverIds.has(Number(player.id)))
      : players.filter((player) => player.team === winner);
  await leaderboard.recordPoints("werewolf", roomId, winningPlayers);
  const winnerName =
    winner === "wolves"
      ? "المستذئبون"
      : winner === "village"
        ? "القرويون"
        : winner === "lovers"
          ? "العاشقان"
          : "تعادل";
  const roster = players.map(
    (player) =>
      `• ${player.display_name}: ${ROLES[player.role_key]?.name || "غير معروف"}${Number(player.is_alive) ? "" : " (خرج)"}`,
  );
  await msg.sendGroup(
    room.thread_id,
    `${reason}\nالفائز: ${winnerName}${winningPlayers.length ? ` — ${winningPlayers.map((player) => player.display_name).join("، ")}` : ""}\nالأدوار:\n${roster.join("\n")}\nجولة جديدة: ذئب`,
  );
  return winner;
}

async function handleGroup(context, command) {
  if (command === "help") return msg.sendGroup(context.threadId, helpText());
  if (command === "join")
    return joinLobby(context.userId, context.threadId);
  if (command === "players") return listPlayers(context.threadId);
  if (command === "status") return showStatus(context.threadId);
  if (command === "leave") return leaveGame(context.userId, context.threadId);
  if (command === "cancel")
    return cancelGame(context.userId, context.threadId);
  if (command === "action")
    return msg.sendGroup(
      context.threadId,
      "🔒 استخدم القدرة بالرد على بطاقة القدرة التي تصلك من البوت في الخاص.",
    );
  if (command === "vote")
    return msg.sendGroup(
      context.threadId,
      "🔒 صوّت بالرد على بطاقة التصويت التي تصلك من البوت في الخاص.",
    );
  if (command === "hunt")
    return msg.sendGroup(
      context.threadId,
      "🔒 يختار الصياد هدفه بالرد على بطاقة طلقة الصياد في الخاص.",
    );
  if (command === "appoint")
    return msg.sendGroup(
      context.threadId,
      "🔒 يختار العمدة خليفته بالرد على بطاقة التعيين في الخاص.",
    );
}

async function appointSheriffSuccessor(userId, session, input) {
  if (session.status !== "playing" || Number(session.is_alive) !== 1)
    return msg.sendPrivate(userId, "⛔ يجب أن تكون حياً لاختيار خليفة.");
  const state = await db.one(
    "SELECT sheriff_player_id FROM werewolf_state WHERE room_id=?",
    [session.room_id],
  );
  if (Number(state?.sheriff_player_id) !== Number(session.id))
    return msg.sendPrivate(userId, "🔒 هذه الصلاحية متاحة للعمدة الحالي فقط.");
  const players = alivePlayers(await getPlayers(session.room_id));
  const candidates = players.filter(
    (player) => Number(player.id) !== Number(session.id),
  );
  const target = findTarget(candidates, input);
  if (!target)
    return msg.sendPrivate(
      userId,
      `اختر لاعباً حياً غيرك ليكون خليفتك:\n${playerList(candidates)}`,
    );
  await db.query(
    "UPDATE werewolf_state SET sheriff_successor_player_id=? WHERE room_id=? AND sheriff_player_id=?",
    [target.id, session.room_id, session.id],
  );
  return msg.sendPrivate(
    userId,
    `⭐ عُيّن ${target.display_name} خليفةً لك إذا خرجت من اللعبة.`,
  );
}

async function handlePrivate(context, command, argument) {
  if (command === "help") return msg.sendPrivate(context.userId, helpText());
  const session = await getSession(context.userId);
  if (!session)
    return command
      ? msg.sendPrivate(context.userId, "لا تشارك في لعبة مستذئب نشطة حالياً.")
      : undefined;
  if (command === "role")
    return msg.sendPrivate(
      context.userId,
      roleCard(session, await getPlayers(session.room_id)),
    );
  const actionReply = isReplyToBotPrompt(
    context.messageReply,
    REPLY_ACTION_MARKERS.action,
    msg.selfId?.(),
  );
  const voteReply = isReplyToBotPrompt(
    context.messageReply,
    REPLY_ACTION_MARKERS.vote,
    msg.selfId?.(),
  );
  const hunterReply = isReplyToBotPrompt(
    context.messageReply,
    REPLY_ACTION_MARKERS.hunter,
    msg.selfId?.(),
  );
  const appointReply = isReplyToBotPrompt(
    context.messageReply,
    REPLY_ACTION_MARKERS.appoint,
    msg.selfId?.(),
  );
  if (command === "action") {
    if (!actionReply)
      return msg.sendPrivate(
        context.userId,
        "🔒 لا تُقبل القدرة بأمر مباشر؛ رد على بطاقة القدرة الليلية التي أرسلها البوت.",
      );
    return submitNightAction(context.userId, session, argument);
  }
  if (command === "vote") {
    if (!voteReply)
      return msg.sendPrivate(
        context.userId,
        "🔒 لا يُقبل التصويت بأمر مباشر؛ رد على بطاقة التصويت التي أرسلها البوت.",
      );
    return submitVote(context.userId, session, argument);
  }
  if (command === "hunt") {
    if (!hunterReply)
      return msg.sendPrivate(
        context.userId,
        "🔒 لا تُقبل الطلقة بأمر مباشر؛ رد على بطاقة طلقة الصياد التي أرسلها البوت.",
      );
    return submitHunterShot(context.userId, session, argument);
  }
  if (command === "appoint") {
    if (!appointReply)
      return msg.sendPrivate(
        context.userId,
        "🔒 لا يُقبل التعيين بأمر مباشر؛ رد على بطاقة تعيين الخليفة التي أرسلها البوت.",
      );
    return appointSheriffSuccessor(context.userId, session, argument);
  }
  if (!command && actionReply)
    return submitNightAction(context.userId, session, context.text);
  if (!command && /^\d+$/.test(String(context.text || "").trim())) {
    if (voteReply)
      return submitVote(context.userId, session, context.text.trim());
    if (hunterReply)
      return submitHunterShot(context.userId, session, context.text.trim());
    if (appointReply)
      return appointSheriffSuccessor(
        context.userId,
        session,
        context.text.trim(),
      );
    return msg.sendPrivate(
      context.userId,
      "🔒 لا تُقبل الأرقام وحدها؛ رد على بطاقة التصويت أو القدرة المناسبة من البوت.",
    );
  }
}

async function listPlayers(threadId) {
  const room = await getRoomByThread(threadId);
  if (!room) return msg.sendGroup(threadId, "ℹ️ لا توجد لعبة مستذئب نشطة.");
  const players = await getPlayers(room.id);
  return msg.sendGroup(
    threadId,
    `🐺 لاعبو المستذئب (${players.length}):\n${players.map((player) => `• ${player.display_name}${Number(player.is_alive) ? "" : " — خرج"}`).join("\n") || "لا يوجد لاعبون بعد."}`,
  );
}

async function showStatus(threadId) {
  const room = await getRoomByThread(threadId);
  if (!room)
    return msg.sendGroup(
      threadId,
      "ℹ️ لا توجد لعبة مستذئب نشطة. اكتبوا «ذئب» لبدء واحدة.",
    );
  const [players, timer, state] = await Promise.all([
    getPlayers(room.id),
    db.one(
      "SELECT TIMESTAMPDIFF(SECOND, NOW(), phase_ends_at) AS remaining FROM game_rooms WHERE id=?",
      [room.id],
    ),
    db.one(
      "SELECT sheriff_election_done FROM werewolf_state WHERE room_id=?",
      [room.id],
    ),
  ]);
  const remaining =
    timer?.remaining !== null && Number(timer?.remaining) > 0
      ? `\n⏳ المتبقي: ${timer.remaining} ثانية`
      : "";
  const phase =
    room.phase === "voting" &&
    Number(room.current_round) === 0 &&
    !Number(state?.sheriff_election_done)
      ? "انتخاب العمدة"
      : room.phase;
  return msg.sendGroup(
    threadId,
    `🐺 حالة المستذئب: ${phase}${remaining}\n👥 الأحياء: ${alivePlayers(players).map((player) => player.display_name).join("، ") || "لا أحد"}`,
  );
}

async function leaveGame(userId, threadId) {
  const room = await getRoomByThread(threadId);
  if (!room || room.status !== "lobby") return;
  const player = await getPlayer(room.id, userId);
  if (!player) return;
  if (room.host_psid === userId) return cancelGame(userId, threadId);
  await db.query("DELETE FROM werewolf_players WHERE id=?", [player.id]);
  return msg.sendGroup(threadId, `👋 غادر ${player.display_name} التسجيل.`);
}

async function cancelGame(userId, threadId, isAdmin = false) {
  const room = await getRoomByThread(threadId);
  if (!room) return;
  if (room.host_psid !== userId && !isAdmin)
    return msg.sendGroup(
      threadId,
      "⛔ مضيف اللعبة فقط يستطيع إلغاء لعبة المستذئب.",
    );
  const cancelled = await db.query(
    "UPDATE game_rooms SET status='cancelled', phase='finished', phase_ends_at=NULL WHERE id=? AND game_id='werewolf' AND status IN ('lobby','playing')",
    [room.id],
  );
  if (cancelled.affectedRows)
    return msg.sendGroup(threadId, "🚫 أُلغيت لعبة المستذئب.");
}

async function handleDueRoom(room) {
  if (room.phase === "lobby") return startGame(room.id);
  if (room.phase === "night") return resolveNight(room.id);
  if (room.phase === "discussion") return startVoting(room.id);
  if (room.phase === "voting") {
    const [current, state] = await Promise.all([
      getRoom(room.id),
      db.one(
        "SELECT sheriff_election_done FROM werewolf_state WHERE room_id=?",
        [room.id],
      ),
    ]);
    if (
      Number(current?.current_round) === 0 &&
      !Number(state?.sheriff_election_done)
    )
      return resolveSheriffElection(room.id);
    return resolveVoting(room.id);
  }
  if (room.phase === "hunter") return clearHunterAndContinue(room.id);
}

let ticking = false;
async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    const rooms = await db.query(
      `SELECT id, phase FROM game_rooms
       WHERE game_id='werewolf' AND status IN ('lobby','playing')
         AND phase_ends_at IS NOT NULL AND phase_ends_at<=NOW()
         AND phase IN ('lobby','night','discussion','voting','hunter')`,
    );
    for (const room of rooms) {
      try {
        await handleDueRoom(room);
      } catch (error) {
        console.error(`[werewolf] ticker failed for room ${room.id}:`, error);
      }
    }
  } finally {
    ticking = false;
  }
}

function startTicker() {
  setInterval(() => {
    tick().catch((error) =>
      console.error("[werewolf] ticker failed:", error),
    );
  }, 3000).unref?.();
}

function helpText() {
  return `المستذئب (${CFG.MIN_PLAYERS}-${CFG.MAX_PLAYERS} لاعبين): اكتب ذئب أو انضم بـ /انضم ذئب. الأدوار سرية في الخاص.
قبل الليل ينتخب اللاعبون عمدة (صوته بصوتين). ليلاً يختار الذئاب ضحية؛ العرّاف يفحص لاعباً، والساحرة تنقذ أو تسمّم مرة لكل جرعة. الصياد يطلق عند خروجه؛ وكيوبيد يربط عاشقين إن وُزّع.
بعد النقاش (${CFG.DISCUSSION_SECONDS}ث)، يصوّت الأحياء (${CFG.VOTING_SECONDS}ث)؛ التعادل لا يُقصي.
يفوز القرويون بإقصاء الذئاب، والذئاب بمساواة بقية الأحياء أو تجاوزهم. العاشقان المختلفا الفريق يفوزان إذا بقيا وحدهما.
لا تُقبل القدرات أو الأصوات بأوامر مباشرة؛ رد على بطاقة البوت المناسبة مع اختيارك. ويجب على الصياد الرد على بطاقة الطلقة.
أوامر المجموعة: /قواعد ذئب، /لاعبين ذئب، /حالة ذئب، /خروج ذئب، /إلغاء ذئب. الأفعال والتصويت في الخاص بالرد على بطاقة البوت.`;
}

module.exports = {
  assertSchema,
  handleMessage,
  handleReaction,
  cancelActiveGame: cancelGame,
  canHandleMessage,
  startTicker,
  tallyWeightedVotes,
  mixedLoversWin,
  mixedLoversAreAlive,
  commandParts,
};
