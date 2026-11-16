const { randomInt } = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const db = require("../../database");
const msg = require("../../services/messenger");
const leaderboard = require("../../services/leaderboard");
const ui = require("../../services/interaction");
const { isReplyToBotPrompt } = require("../../services/replyPrompts");
const CFG = require("./config");
const { ROLES, DUAL_ROLE_KEYS, createRoleSet, shuffle } = require("./roles");

const COMMANDS = new Map([
  ["feignhelp", "help"],
  ["قواعدفيجن", "help"],
  ["feignplayers", "players"],
  ["لاعبينفيجن", "players"],
  ["feignleave", "leave"],
  ["خروجفيجن", "leave"],
  ["feigncancel", "cancel"],
  ["إلغاءفيجن", "cancel"],
  ["feignrole", "role"],
  ["دورفيجن", "role"],
  ["feignaction", "action"],
  ["fa", "action"],
  ["feignvote", "vote"],
  ["fvote", "vote"],
  ["feignstatus", "status"],
  ["حالةفيجن", "status"],
]);
const TEAM_MARKERS = { town: "🟦", impostor: "🟥", neutral: "🟨" };
const ACTION_MARKER = "🌙 بطاقة القدرة الليلية في فيجن";
const VOTE_MARKER = "🗳️ بطاقة التصويت في فيجن";
const SOLO_ROLES = new Set(["serial_killer", "bomber", "sorcerer"]);
const NEUTRAL_THREATS = new Set([
  "serial_killer",
  "bomber",
  "thief",
  "haunter",
  "sorcerer",
]);
const NIGHT_ACTIONS = {
  protect: "اختر لاعباً لحمايته (يمكنك حماية نفسك).",
  mafia_kill: "اختروا ضحية الأشرار.",
  clean: "اختر لاعباً لإخفاء دوره إن مات الليلة.",
  blame: "اختر لاعباً ليظهر من الأشرار إن مات الليلة.",
  block: "اختر لاعباً لتعطيل قدرته.",
  lookout: "اختر منزلاً لمعرفة عدد زواره.",
  investigate: "اختر لاعباً لترى احتمالين لدوره.",
  track: "اختر لاعباً لمعرفة إلى من ذهب.",
  trap: "اختر منزلاً لتعطيل أول قدرة تزوره.",
  snitch: "اختر لاعباً؛ صباحاً سترى دوره وحدك (مرة واحدة).",
  provoke: "اختر لاعباً ليبدأ التصويت بصوتين ضده (مرة واحدة).",
  haunt: "اختر لاعباً لوسمه؛ إن طُردت نهاراً يقتله شبحك.",
  armor: "رد على بطاقة القدرة بكلمة «درع» لتستهلك درعاً وتحمي نفسك إن هوجمت.",
  serial_kill: "اختر لاعباً لقتله.",
  bomb: "رد على بطاقة القدرة برقم منزل لزرع قنبلة، أو بكلمة «تفجير».",
  steal_kill: "اختر لاعباً لقتله وسرقة دوره إذا نجحت.",
  sorcerer: "رد على بطاقة القدرة برقم اللاعب واسم دوره. إن أخطأت تموت.",
};

const getRoom = (id) =>
  db.one("SELECT * FROM game_rooms WHERE id=? AND game_id='feign'", [id]);
const getRoomByThread = (threadId) =>
  db.one(
    "SELECT * FROM game_rooms WHERE thread_id=? AND game_id='feign' AND status IN ('lobby','playing') ORDER BY id DESC LIMIT 1",
    [threadId],
  );
const getPlayers = (roomId) =>
  db.query("SELECT * FROM feign_players WHERE room_id=? ORDER BY id", [roomId]);
const getPlayer = (roomId, psid) =>
  db.one("SELECT * FROM feign_players WHERE room_id=? AND psid=?", [
    roomId,
    psid,
  ]);
const getSession = (psid) =>
  db.one(
    `SELECT fp.*, gr.thread_id, gr.host_psid, gr.status, gr.phase,
            gr.current_round, gr.phase_ends_at
     FROM feign_players fp JOIN game_rooms gr ON gr.id=fp.room_id
     WHERE fp.psid=? AND gr.game_id='feign' AND gr.status IN ('lobby','playing')
     ORDER BY fp.id DESC LIMIT 1`,
    [psid],
  );

async function assertSchema() {
  const schema = await fs.readFile(path.join(__dirname, "schema.sql"), "utf8");
  const statements = schema
    .split(";")
    .map((statement) => statement.trim())
    .filter(Boolean);
  for (const statement of statements) await db.query(statement);
  const columns = await db.query(
    "SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='feign_actions'",
  );
  if (!columns.some((column) => column.COLUMN_NAME === "guessed_role_key"))
    await db.query(
      "ALTER TABLE feign_actions ADD COLUMN guessed_role_key VARCHAR(32) NULL AFTER target_player_id",
    );
}

function commandParts(text) {
  const parts = String(text || "")
    .trim()
    .replace(/^[/!]\s*/, "")
    .split(/\s+/);
  const name = (parts.shift() || "").toLowerCase();
  return { name, arg: parts.join(" "), command: COMMANDS.get(name) || null };
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

function aliveList(players) {
  return players.filter((player) => player.is_alive);
}

function playerList(players) {
  return players
    .map((player, index) => `${index + 1}. ${player.display_name}`)
    .join("\n");
}

function findTarget(players, text, actorId, allowSelf = false) {
  const eligible = aliveList(players).filter(
    (player) => allowSelf || Number(player.id) !== Number(actorId),
  );
  const value = String(text || "").trim();
  if (/^\d+$/.test(value)) return eligible[Number(value) - 1] || null;
  const wanted = normalizeText(value);
  const exact = eligible.filter(
    (player) => normalizeText(player.display_name) === wanted,
  );
  if (exact.length === 1) return exact[0];
  const partial = eligible.filter((player) =>
    normalizeText(player.display_name).includes(wanted),
  );
  return partial.length === 1 ? partial[0] : null;
}

function targetOptions(players, actorId, allowSelf = false) {
  return aliveList(players).filter(
    (player) => allowSelf || Number(player.id) !== Number(actorId),
  );
}

function findRoleKey(text) {
  const wanted = normalizeText(text);
  return (
    Object.entries(ROLES).find(
      ([key, role]) =>
        normalizeText(key) === wanted || normalizeText(role.name) === wanted,
    )?.[0] || null
  );
}

function actionFor(player) {
  if (player.role_key === "insane")
    return ROLES[player.apparent_role_key]?.action || "investigate";
  return ROLES[player.role_key]?.action || "copied";
}

function shownRole(player) {
  return player.role_key === "insane"
    ? player.apparent_role_key
    : player.role_key;
}

function roleCard(player, players) {
  const displayedRole = shownRole(player);
  const role = ROLES[displayedRole];
  const teammates =
    player.team === "impostor"
      ? players
          .filter(
            (other) =>
              Number(other.id) !== Number(player.id) &&
              other.is_alive &&
              other.team === "impostor",
          )
          .map((other) => other.display_name)
      : [];
  const description = role?.description || "لا تملك قدرة معروفة.";
  return [
    `🎭 دورك في فيجن: ${role?.name || "غير معروف"}`,
    `رمز فصيلتك السري: ${TEAM_MARKERS[player.team] || "⬜"}`,
    description,
    teammates.length ? `🤝 حلفاؤك: ${teammates.join("، ")}` : "",
    "",
    displayedRole === "sorcerer"
      ? "رد على بطاقة القدرة برقم اللاعب واسم الدور."
      : "رد على بطاقة القدرة الليلية باختيارك.",
    "رد على بطاقة التصويت برقم اللاعب.",
    "📩 لإعادة إرسال دورك: /feignrole",
  ]
    .filter(Boolean)
    .join("\n");
}

async function canHandleMessage({ userId, isGroup }) {
  return !isGroup && Boolean(await getSession(userId));
}

async function handleMessage(context) {
  const { name, arg, command } = commandParts(context.text);
  if (context.isGroup) {
    if (name === "فيجن" || name === "feign")
      return createRoom(context.userId, context.threadId);
    return handleGroup(context, command);
  }
  return handlePrivate(context, command, arg);
}

async function handleReaction({ userId, threadId, messageId }) {
  const room = await db.one(
    `SELECT * FROM game_rooms
     WHERE game_id='feign' AND thread_id=? AND lobby_message_id=?
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
  const active = await db.one(
    "SELECT id FROM game_rooms WHERE thread_id=? AND status IN ('lobby','playing') LIMIT 1",
    [threadId],
  );
  if (active)
    return msg.sendGroup(
      threadId,
      "⚠️ توجد لعبة نشطة في المجموعة. أنهِها قبل بدء فيجن.",
    );

  let roomId;
  try {
    const result = await db.query(
      "INSERT INTO game_rooms (game_id, thread_id, host_psid, status, phase) VALUES ('feign',?,?, 'lobby','lobby')",
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
      title: "فيجن",
      tagline: "اكتشفوا الأشرار.",
      min: CFG.MIN_PLAYERS,
      max: CFG.MAX_PLAYERS,
      seconds: CFG.LOBBY_SECONDS,
      leaveCommand: "خروج فيجن",
    }),
  );
  if (!messageId) {
    await db.query(
      "UPDATE game_rooms SET status='cancelled', phase='finished', phase_ends_at=NULL WHERE id=? AND game_id='feign'",
      [roomId],
    );
    return;
  }
  await db.query(
    "UPDATE game_rooms SET lobby_message_id=?, phase_ends_at=DATE_ADD(NOW(), INTERVAL ? SECOND) WHERE id=? AND game_id='feign' AND status='lobby'",
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
    return msg.sendGroup(room.thread_id, "⛔ اكتمل عدد لاعبي فيجن.");
  let name = await msg.getUserName(userId);
  if (players.some((player) => player.display_name === name))
    name = `${name} (${players.length + 1})`;
  try {
    await db.query(
      "INSERT INTO feign_players (room_id, psid, display_name) VALUES (?,?,?)",
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
    console.error(`[feign] reaction recovery failed for room ${roomId}:`, error);
  }
  const players = await getPlayers(roomId);
  if (players.length < CFG.MIN_PLAYERS) {
    const cancelled = await db.query(
      "UPDATE game_rooms SET status='cancelled', phase='finished', phase_ends_at=NULL WHERE id=? AND game_id='feign' AND status='lobby'",
      [roomId],
    );
    if (cancelled.affectedRows)
      await msg.sendGroup(
        room.thread_id,
        `لم يكتمل العدد (${CFG.MIN_PLAYERS})؛ أُلغيت فيجن.`,
      );
    return;
  }

  const locked = await db.query(
    "UPDATE game_rooms SET status='playing', phase='assigning', phase_ends_at=NULL WHERE id=? AND game_id='feign' AND status='lobby'",
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
        const apparentRole =
          role.key === "insane"
            ? shuffle(["doctor", ...DUAL_ROLE_KEYS])[randomInt(1 + DUAL_ROLE_KEYS.length)]
            : null;
        await query(
          `UPDATE feign_players
           SET role_key=?, team=?, apparent_role_key=?, ability_variant=?,
               ability_used=0, armor_count=?, is_alive=1
           WHERE id=? AND room_id=?`,
          [
            role.key,
            role.team,
            apparentRole,
            apparentRole,
            role.key === "survivor" ? 3 : 0,
            randomizedPlayers[index].id,
            roomId,
          ],
        );
        assigned.push({
          ...randomizedPlayers[index],
          ...role,
          apparent_role_key: apparentRole,
          ability_variant: apparentRole,
          is_alive: 1,
        });
      }
    });
  } catch (error) {
    await db.query(
      "UPDATE game_rooms SET status='cancelled', phase='finished', phase_ends_at=NULL WHERE id=? AND game_id='feign' AND status='playing'",
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
        `[feign] role delivery failed for player ${player.id}:`,
        sent.reason,
      );
    }
  }
  if (failed) {
    await db.query(
      "UPDATE game_rooms SET status='cancelled', phase='finished', phase_ends_at=NULL WHERE id=? AND game_id='feign' AND status='playing' AND phase='assigning'",
      [roomId],
    );
    return msg.sendGroup(
      room.thread_id,
      "لم تصل الأدوار للجميع؛ أُلغيت اللعبة. راجعوا طلبات الرسائل وأعيدوا المحاولة.",
    );
  }
  await startNight(roomId, false);
}

async function startNight(roomId, nextRound) {
  const room = await getRoom(roomId);
  if (!room || room.status !== "playing") return;
  const round = Number(room.current_round || 0) + (nextRound ? 1 : 0);
  const started = await db.query(
    `UPDATE game_rooms
     SET phase='night', current_round=?, phase_ends_at=DATE_ADD(NOW(), INTERVAL ? SECOND)
     WHERE id=? AND game_id='feign' AND status='playing' AND phase IN ('assigning','tallying')`,
    [round || 1, CFG.NIGHT_SECONDS, roomId],
  );
  if (!started.affectedRows) return;
  const players = aliveList(await getPlayers(roomId));
  await msg.sendGroup(
    room.thread_id,
    `بدأ الليل (${CFG.NIGHT_SECONDS}ث). استخدموا قدراتكم في الخاص.`,
  );
  for (const player of players) {
    const action = actionFor(player);
    if (!NIGHT_ACTIONS[action]) continue;
    const displayedRole = ROLES[shownRole(player)];
    const instruction =
      displayedRole?.oneUse && player.ability_used
        ? "استخدمت قدرتك المحدودة. لا تملك إجراءً آخر الليلة."
        : action === "armor"
          ? NIGHT_ACTIONS[action]
          : action === "bomb"
            ? NIGHT_ACTIONS[action]
            : action === "sorcerer"
              ? `${NIGHT_ACTIONS[action]}\nالأدوار: ${Object.values(ROLES).map((role) => role.name).join("، ")}.`
              : NIGHT_ACTIONS[action];
    const prompt = `${ACTION_MARKER}\n${instruction}\nرد على هذه الرسالة باختيارك.`;
    const sent = await msg.sendPrivateWithResult(player.psid, prompt);
    if (!sent.ok)
      console.error(
        `[feign] night prompt failed for player ${player.id}:`,
        sent.reason,
      );
  }
}

async function submitNightAction(userId, session, argument) {
  if (session.status !== "playing" || session.phase !== "night")
    return msg.sendPrivate(userId, "⌛ لا توجد ليلة مفتوحة الآن.");
  if (!session.is_alive)
    return msg.sendPrivate(userId, "⛔ لا يمكنك تنفيذ قدرة بعد خروجك من اللعبة.");
  const action = actionFor(session);
  if (!NIGHT_ACTIONS[action])
    return msg.sendPrivate(userId, "ℹ️ لا تملك قدرة ليلية قابلة للاستخدام.");
  const displayedRole = ROLES[shownRole(session)];
  if (displayedRole?.oneUse && session.ability_used)
    return msg.sendPrivate(userId, "⛔ استخدمت هذه القدرة المحدودة بالفعل.");

  const players = aliveList(await getPlayers(session.room_id));
  let actionType = action;
  let guessedRoleKey = null;
  let target = null;
  const [targetInput, ...roleGuessParts] = String(argument || "")
    .trim()
    .split(/\s+/);
  const normalized = normalizeText(argument);
  if (action === "armor") {
    if (!["درع", "حمايه", "armor"].includes(normalized))
      return msg.sendPrivate(userId, "أرسل /fa درع لاستهلاك درعك.");
    if (!Number(session.armor_count))
      return msg.sendPrivate(userId, "⛔ نفدت دروعك.");
    target = session;
  } else if (
    action === "bomb" &&
    ["تفجير", "فجر", "detonate"].includes(normalized)
  ) {
    const bombs = await db.one(
      "SELECT COUNT(*) AS count FROM feign_marks WHERE room_id=? AND source_player_id=? AND mark_type='bomb'",
      [session.room_id, session.id],
    );
    if (!Number(bombs?.count))
      return msg.sendPrivate(userId, "لا توجد قنابل مزروعة لتفجيرها.");
    actionType = "detonate";
  } else if (action === "sorcerer") {
    target = findTarget(
      players,
      targetInput,
      session.id,
    );
    guessedRoleKey = findRoleKey(roleGuessParts.join(" "));
    if (!target || !guessedRoleKey)
      return msg.sendPrivate(
        userId,
        `رد على بطاقة القدرة برقم اللاعب واسم الدور.\nاللاعبون:\n${playerList(targetOptions(players, session.id))}\nالأدوار: ${Object.values(ROLES).map((role) => role.name).join("، ")}`,
      );
    actionType = session.role_key === "insane" ? "mad" : "sorcerer_attack";
  } else {
    target = findTarget(
      players,
      argument,
      session.id,
      action === "protect",
    );
    if (!target)
      return msg.sendPrivate(
        userId,
        `اختر لاعباً حياً من القائمة:\n${playerList(targetOptions(players, session.id, action === "protect"))}`,
      );
    if (action === "mafia_kill" && target.team === "impostor")
      return msg.sendPrivate(userId, "لا يمكن استهداف لاعب من فصيلتك.");
    if (action === "bomb" && Number(target.id) === Number(session.id))
      return msg.sendPrivate(userId, "لا تزرع قنبلة في منزلك.");
    if (session.role_key === "insane") actionType = "mad";
  }

  await db.query(
    `INSERT INTO feign_actions
      (room_id, round_number, actor_player_id, action_type, target_player_id, guessed_role_key)
     VALUES (?,?,?,?,?,?)
     ON DUPLICATE KEY UPDATE action_type=VALUES(action_type),
                             target_player_id=VALUES(target_player_id),
                             guessed_role_key=VALUES(guessed_role_key)`,
    [
      session.room_id,
      session.current_round,
      session.id,
      actionType,
      target?.id || null,
      guessedRoleKey,
    ],
  );
  return msg.sendPrivate(
    userId,
    `✅ سُجل اختيارك السري${target ? `: ${target.display_name}` : ""}. يمكنك تغييره قبل انتهاء الليل.`,
  );
}

async function submitVote(userId, session, input) {
  if (session.status !== "playing" || session.phase !== "voting")
    return msg.sendPrivate(userId, "⌛ لا يوجد تصويت مفتوح الآن.");
  if (!session.is_alive)
    return msg.sendPrivate(userId, "⛔ لا يمكنك التصويت بعد خروجك.");
  const players = aliveList(await getPlayers(session.room_id));
  const target = findTarget(players, input, session.id);
  if (!target)
    return msg.sendPrivate(
      userId,
      `اختر لاعباً حياً غيرك:\n${playerList(players)}`,
    );
  await db.query(
    `INSERT INTO feign_votes (room_id, round_number, voter_player_id, target_player_id)
     VALUES (?,?,?,?)
     ON DUPLICATE KEY UPDATE target_player_id=VALUES(target_player_id)`,
    [session.room_id, session.current_round, session.id, target.id],
  );
  const count = await db.one(
    "SELECT COUNT(*) AS count FROM feign_votes WHERE room_id=? AND round_number=?",
    [session.room_id, session.current_round],
  );
  await msg.sendPrivate(
    userId,
    `✅ سُجل صوتك سراً لـ ${target.display_name}.`,
  );
  if (Number(count.count) >= players.length)
    return resolveVoting(session.room_id);
}

async function loadActions(roomId, round) {
  return db.query(
    `SELECT fa.*, actor.role_key, actor.team, actor.is_alive,
            actor.apparent_role_key, actor.ability_used
     FROM feign_actions fa
     JOIN feign_players actor ON actor.id=fa.actor_player_id
     WHERE fa.room_id=? AND fa.round_number=?
     ORDER BY fa.actor_player_id`,
    [roomId, round],
  );
}

function revealMode(player, actions, cause) {
  const aimed = actions.filter(
    (action) =>
      Number(action.target_player_id) === Number(player.id) && action.is_alive,
  );
  if (
    cause !== "vote" &&
    aimed.some((action) => action.action_type === "clean")
  )
    return "hidden";
  if (aimed.some((action) => action.action_type === "blame")) return "impostor";
  return "role";
}

async function applyDeaths(roomId, round, incoming, actions, options = {}) {
  const players = await getPlayers(roomId);
  const byId = new Map(players.map((player) => [Number(player.id), player]));
  const deaths = [];
  const deadIds = new Set();
  const queue = [...incoming];
  while (queue.length) {
    const event = queue.shift();
    const id = Number(event.playerId);
    const player = byId.get(id);
    if (!player?.is_alive || deadIds.has(id)) continue;

    if (options.night && !event.unblockable) {
      if (options.protected?.has(id)) {
        if (event.sourceId)
          options.results.set(
            Number(event.sourceId),
            `🛡️ نجا هدفك ${player.display_name} من الهجوم.`,
          );
        continue;
      }
      if (options.armored?.has(id)) {
        options.armored.delete(id);
        options.absorbed?.add(id);
        options.results.set(id, "🛡️ صدّ درعك الهجوم.");
        if (event.sourceId)
          options.results.set(
            Number(event.sourceId),
            `🛡️ صدّ درع ${player.display_name} هجومك.`,
          );
        continue;
      }
    }

    const mode = revealMode(player, actions, event.cause);
    const revealRole =
      mode === "role"
        ? player.role_key
        : mode === "impostor"
          ? shuffle([
              "imposter_killer",
              "cleaner",
              "blamer",
              ...DUAL_ROLE_KEYS,
            ])[randomInt(3 + DUAL_ROLE_KEYS.length)]
          : null;
    const killed = await db.query(
      "UPDATE feign_players SET is_alive=0 WHERE id=? AND room_id=? AND is_alive=1",
      [id, roomId],
    );
    if (!killed.affectedRows) continue;
    deadIds.add(id);
    byId.set(id, { ...player, is_alive: 0 });
    await db.query(
      `INSERT INTO feign_deaths
        (room_id, round_number, player_id, cause, reveal_mode, reveal_role_key)
       VALUES (?,?,?,?,?,?)`,
      [roomId, round, id, event.cause, mode, revealRole],
    );
    deaths.push({
      ...player,
      cause: event.cause,
      revealMode: mode,
      revealRole,
    });

    if (player.role_key === "haunter" && event.cause !== "vote")
      await db.query(
        "DELETE FROM feign_marks WHERE room_id=? AND source_player_id=? AND mark_type='haunt'",
        [roomId, id],
      );
  }
  return deaths;
}

async function addMark(roomId, sourceId, targetId, type, round) {
  await db.query(
    `INSERT INTO feign_marks
      (room_id, source_player_id, target_player_id, mark_type, planted_round)
     VALUES (?,?,?,?,?)
     ON DUPLICATE KEY UPDATE planted_round=VALUES(planted_round)`,
    [roomId, sourceId, targetId, type, round],
  );
}

async function resolveNight(roomId) {
  const locked = await db.query(
    "UPDATE game_rooms SET phase='tallying', phase_ends_at=NULL WHERE id=? AND game_id='feign' AND status='playing' AND phase='night'",
    [roomId],
  );
  if (!locked.affectedRows) return;
  const room = await getRoom(roomId);
  const round = Number(room.current_round);
  const players = await getPlayers(roomId);
  const living = aliveList(players);
  const aliveIds = new Set(living.map((player) => Number(player.id)));
  const actions = (await loadActions(roomId, round)).filter(
    (action) =>
      action.is_alive && aliveIds.has(Number(action.actor_player_id)),
  );
  const results = new Map();
  const policeBlocked = new Set(
    actions
      .filter((action) => {
        if (action.action_type !== "block") return false;
        const target = living.find(
          (player) => Number(player.id) === Number(action.target_player_id),
        );
        return target && !["serial_killer", "sorcerer"].includes(target.role_key);
      })
      .map((action) => Number(action.target_player_id)),
  );
  const traps = actions.filter(
    (action) =>
      action.action_type === "trap" &&
      !policeBlocked.has(Number(action.actor_player_id)),
  );
  const trapBlocked = new Set();
  for (const trap of traps) {
    const visitors = actions.filter(
      (action) =>
        ![
          "trap",
          "detonate",
          "armor",
          "block",
          "mad",
          "sorcerer_attack",
        ].includes(action.action_type) &&
        Number(action.target_player_id) === Number(trap.target_player_id) &&
        Number(action.actor_player_id) !== Number(trap.actor_player_id) &&
        action.role_key !== "serial_killer" &&
        !policeBlocked.has(Number(action.actor_player_id)) &&
        !trapBlocked.has(Number(action.actor_player_id)),
    );
    const visitor = visitors.length
      ? visitors[randomInt(visitors.length)]
      : null;
    if (visitor) {
      trapBlocked.add(Number(visitor.actor_player_id));
      results.set(Number(visitor.actor_player_id), "🪤 عطّل فخّ قدرتك.");
      results.set(Number(trap.actor_player_id), "🪤 اصطاد فخك أول زائر.");
    } else {
      results.set(Number(trap.actor_player_id), "🪤 لم يزر منزلك أحد.");
    }
  }
  for (const action of actions) {
    if (policeBlocked.has(Number(action.actor_player_id)))
      results.set(Number(action.actor_player_id), "🚓 عطّل الشرطي قدرتك.");
  }
  const active = actions.filter(
    (action) =>
      !policeBlocked.has(Number(action.actor_player_id)) &&
      !trapBlocked.has(Number(action.actor_player_id)),
  );
  const disabledActors = new Set([...policeBlocked, ...trapBlocked]);
  for (const actorId of disabledActors)
    await db.query(
      "UPDATE feign_actions SET action_type='blocked' WHERE room_id=? AND round_number=? AND actor_player_id=?",
      [roomId, round, actorId],
    );

  for (const action of active) {
    const actorId = Number(action.actor_player_id);
    const targetId = Number(action.target_player_id);
    if (["bomb", "haunt"].includes(action.action_type) && aliveIds.has(targetId)) {
      const type = action.action_type;
      await addMark(roomId, actorId, targetId, type, round);
      results.set(
        actorId,
        type === "bomb"
          ? "💣 زُرعت القنبلة."
          : "🕯️ وُسم المنزل؛ إذا طُردت بالتصويت ستنتقم من هدفك.",
      );
    }
  }

  const protectedPlayers = new Set(
    active
      .filter((action) => action.action_type === "protect")
      .map((action) => Number(action.target_player_id)),
  );
  const armoredPlayers = new Set();
  for (const action of active.filter((entry) => entry.action_type === "armor")) {
    const used = await db.query(
      "UPDATE feign_players SET armor_count=armor_count-1 WHERE id=? AND room_id=? AND armor_count>0 AND is_alive=1",
      [action.actor_player_id, roomId],
    );
    if (used.affectedRows) armoredPlayers.add(Number(action.actor_player_id));
  }
  const absorbed = new Set();
  const attackTypes = new Set(["mafia_kill", "serial_kill", "steal_kill"]);
  const attacks = active
    .filter(
      (action) =>
        attackTypes.has(action.action_type) &&
        aliveIds.has(Number(action.target_player_id)),
    )
    .map((action) => ({
      playerId: Number(action.target_player_id),
      sourceId: Number(action.actor_player_id),
      cause: action.action_type,
    }));
  for (const action of active.filter(
    (entry) => entry.action_type === "sorcerer_attack",
  )) {
    const target = living.find(
      (player) => Number(player.id) === Number(action.target_player_id),
    );
    if (!target) continue;
    const targetRole =
      target.role_key === "insane"
        ? target.apparent_role_key
        : target.role_key;
    const guessedCorrectly = action.guessed_role_key === targetRole;
    const victimId = guessedCorrectly
      ? Number(target.id)
      : Number(action.actor_player_id);
    attacks.push({
      playerId: victimId,
      sourceId: Number(action.actor_player_id),
      cause: guessedCorrectly ? "sorcerer" : "sorcerer_backfire",
      unblockable: true,
    });
    results.set(
      Number(action.actor_player_id),
      guessedCorrectly
        ? `⚡ أصابت صاعقتك ${target.display_name}.`
        : `⚡ أخطأت تخمين دور ${target.display_name}؛ ارتدت الصاعقة عليك.`,
    );
  }

  for (const action of active.filter((entry) => entry.action_type === "detonate")) {
    const bombs = await db.query(
      "SELECT target_player_id FROM feign_marks WHERE room_id=? AND source_player_id=? AND mark_type='bomb'",
      [roomId, action.actor_player_id],
    );
    for (const bomb of bombs)
      attacks.push({
        playerId: Number(bomb.target_player_id),
        sourceId: Number(action.actor_player_id),
        cause: "bomb",
        unblockable: true,
      });
    await db.query(
      "DELETE FROM feign_marks WHERE room_id=? AND source_player_id=? AND mark_type='bomb'",
      [roomId, action.actor_player_id],
    );
    results.set(Number(action.actor_player_id), `💥 فُجّرت ${bombs.length} قنبلة.`);
  }

  const hauntMarks = await db.query(
    `SELECT mark.id, mark.target_player_id, mark.source_player_id
     FROM feign_marks mark
     JOIN feign_players source ON source.id=mark.source_player_id
     JOIN feign_deaths death ON death.player_id=source.id AND death.room_id=mark.room_id
     WHERE mark.room_id=? AND mark.mark_type='haunt' AND source.is_alive=0
       AND death.cause='vote'`,
    [roomId],
  );
  for (const mark of hauntMarks) {
    attacks.push({
      playerId: Number(mark.target_player_id),
      sourceId: Number(mark.source_player_id),
      cause: "haunt",
      unblockable: true,
    });
    await db.query("DELETE FROM feign_marks WHERE id=?", [mark.id]);
  }

  const visits = active.filter(
    (action) =>
      action.target_player_id &&
      ![
        "armor",
        "block",
        "detonate",
        "mad",
        "sorcerer_attack",
      ].includes(action.action_type),
  );
  for (const action of active) {
    const actorId = Number(action.actor_player_id);
    const target = living.find(
      (player) => Number(player.id) === Number(action.target_player_id),
    );
    if (!target) continue;
    if (action.action_type === "lookout") {
      const count = visits.filter(
        (visit) =>
          Number(visit.target_player_id) === Number(target.id) &&
          Number(visit.actor_player_id) !== actorId,
      ).length;
      results.set(actorId, `👁️ زار ${target.display_name} ${count} لاعباً.`);
    } else if (action.action_type === "mad") {
      const actor = living.find(
        (player) => Number(player.id) === actorId,
      );
      const apparentAction = ROLES[actor?.apparent_role_key]?.action;
      if (apparentAction === "investigate" || apparentAction === "snitch") {
        const guesses = Object.keys(ROLES).filter(
          (key) => key !== target.role_key && key !== "insane",
        );
        const guess = guesses[randomInt(guesses.length)];
        results.set(
          actorId,
          `🔎 نتيجة فحصك: يبدو أن ${target.display_name} هو ${ROLES[guess]?.name || "غير معروف"}.`,
        );
      } else if (apparentAction === "lookout") {
        results.set(
          actorId,
          `👁️ تظن أن ${randomInt(4)} لاعباً زار ${target.display_name}.`,
        );
      } else if (apparentAction === "track") {
        const choices = living.filter(
          (player) => Number(player.id) !== Number(target.id),
        );
        const destination = choices.length
          ? choices[randomInt(choices.length)].display_name
          : "لم يذهب إلى أحد";
        results.set(
          actorId,
          `👣 تظن أن ${target.display_name} ذهب إلى ${destination}.`,
        );
      } else {
        results.set(actorId, "🌫️ لم تستطع التأكد مما أحدثته قدرتك.");
      }
    } else if (action.action_type === "track") {
      const visit = visits.find((entry) => Number(entry.actor_player_id) === Number(target.id));
      const destination = visit
        ? living.find((player) => Number(player.id) === Number(visit.target_player_id))?.display_name || "منزلاً مجهولاً"
        : "لم يزر أحداً";
      results.set(actorId, `👣 ${target.display_name}: ${destination === "لم يزر أحداً" ? destination : `ذهب إلى ${destination}`}.`);
    } else if (action.action_type === "provoke") {
      results.set(actorId, `🗳️ سيُضاف صوتان ضد ${target.display_name}.`);
    } else if (action.action_type === "protect") {
      results.set(actorId, `🛡️ أعددت الحماية لـ ${target.display_name}.`);
    } else if (action.action_type === "block") {
      results.set(actorId, `🚓 عطّلت قدرة ${target.display_name}.`);
    } else if (action.action_type === "clean") {
      results.set(actorId, "🧹 ستُخفى هوية الهدف إذا مات.");
    } else if (action.action_type === "blame") {
      results.set(actorId, "🎭 سيظهر الهدف من الأشرار إذا مات.");
    }
  }

  const deaths = await applyDeaths(roomId, round, attacks, active, {
    night: true,
    protected: protectedPlayers,
    armored: armoredPlayers,
    absorbed,
    results,
  });
  for (const action of active) {
    if (!["investigate", "snitch"].includes(action.action_type)) continue;
    const target = living.find(
      (player) => Number(player.id) === Number(action.target_player_id),
    );
    if (!target) continue;
    const targetDeath = deaths.find(
      (death) => Number(death.id) === Number(target.id),
    );
    if (action.action_type === "snitch" && targetDeath) continue;
    if (targetDeath?.revealMode === "hidden") {
      results.set(
        Number(action.actor_player_id),
        `🔎 لم تستطع معرفة دور ${target.display_name}.`,
      );
    } else if (action.action_type === "snitch") {
      const key =
        target.role_key === "insane"
          ? target.apparent_role_key
          : target.role_key;
      results.set(
        Number(action.actor_player_id),
        `🔎 الدور الذي رأيته لـ ${target.display_name}: ${ROLES[key]?.name || "غير معروف"}.`,
      );
      await db.query(
        "UPDATE feign_players SET ability_used=1 WHERE id=? AND room_id=?",
        [action.actor_player_id, roomId],
      );
    } else {
      const actual =
        target.role_key === "insane"
          ? target.apparent_role_key
          : target.role_key;
      const candidates =
        target.role_key === "insane"
          ? Object.keys(ROLES).filter((key) => key !== actual)
          : target.team === "impostor"
            ? [
                "cleaner",
                "blamer",
                "imposter_killer",
                ...DUAL_ROLE_KEYS,
              ].filter((key) => key !== actual)
            : target.team === "neutral"
              ? Object.keys(ROLES).filter(
                  (key) =>
                    ROLES[key].faction === "neutral" && key !== actual,
                )
              : ["doctor", "insane", ...DUAL_ROLE_KEYS].filter(
                  (key) => key !== actual,
                );
      const alternative =
        candidates[randomInt(Math.max(1, candidates.length))] || actual;
      const options =
        target.role_key === "insane"
          ? [actual, alternative]
          : [actual, alternative];
      results.set(
        Number(action.actor_player_id),
        `🔎 احتمالَا دور ${target.display_name}: ${options.map((key) => ROLES[key]?.name || "غير معروف").join(" أو ")}. أحدهما صحيح.`,
      );
    }
  }
  for (const action of active.filter(
    (entry) => entry.action_type === "provoke",
  )) {
    const targetDied = deaths.some(
      (death) => Number(death.id) === Number(action.target_player_id),
    );
    if (!targetDied)
      await db.query(
        "UPDATE feign_players SET ability_used=1 WHERE id=? AND room_id=?",
        [action.actor_player_id, roomId],
      );
  }
  for (const action of active.filter(
    (entry) => entry.action_type === "mad",
  )) {
    const actor = living.find(
      (player) => Number(player.id) === Number(action.actor_player_id),
    );
    if (!ROLES[actor?.apparent_role_key]?.oneUse) continue;
    await db.query(
      "UPDATE feign_players SET ability_used=1 WHERE id=? AND room_id=?",
      [action.actor_player_id, roomId],
    );
  }
  for (const action of active) {
    const actorId = Number(action.actor_player_id);
    const targetId = Number(action.target_player_id);
    const victim = living.find((player) => Number(player.id) === targetId);
    const death = deaths.find((entry) => Number(entry.id) === targetId);
    if (action.action_type === "protect" && victim) {
      const attacked = attacks.some((entry) => entry.playerId === targetId && !entry.unblockable);
      results.set(
        actorId,
        attacked && !death
          ? `🛡️ صدّت حمايتك الهجوم عن ${victim.display_name}.`
          : attacked
            ? `⚠️ مات ${victim.display_name} بانفجار لا توقفه الحماية.`
            : `🛡️ لم يتعرض ${victim.display_name} لهجوم.`,
      );
    }
    if (["mafia_kill", "serial_kill", "steal_kill"].includes(action.action_type) && victim) {
      if (action.action_type === "steal_kill" && death?.cause === "steal_kill") {
        await db.query(
          `UPDATE feign_players
           SET role_key=?, team=?, apparent_role_key=?, ability_variant=?,
               ability_used=0, armor_count=?
           WHERE id=? AND is_alive=1`,
          [
            victim.role_key,
            victim.team,
            victim.role_key === "insane" ? victim.apparent_role_key : null,
            victim.role_key === "insane" ? victim.ability_variant : null,
            victim.role_key === "survivor" ? victim.armor_count : 0,
            actorId,
          ],
        );
        results.set(actorId, `🗝️ قتلت ${victim.display_name} وسرقت دوره وفصيلته.`);
        const thiefPlayer = players.find((player) => Number(player.id) === actorId);
        if (thiefPlayer) {
          const thief = await getPlayer(roomId, thiefPlayer.psid);
          if (thief?.is_alive) {
            const updatedPlayers = await getPlayers(roomId);
            const sent = await msg.sendPrivateWithResult(
              thief.psid,
              roleCard(thief, updatedPlayers),
            );
            if (!sent.ok)
              console.error(
                `[feign] stolen role delivery failed for player ${thief.id}:`,
                sent.reason,
              );
          }
        }
      } else if (death && action.action_type === "steal_kill") {
        results.set(actorId, `⚠️ مات ${victim.display_name} بفعل آخر قبل سرقة دوره.`);
      } else if (death) {
        results.set(actorId, `☠️ مات هدفك ${victim.display_name}.`);
      } else if (!protectedPlayers.has(targetId) && !absorbed.has(targetId)) {
        results.set(actorId, "⚠️ لم تنجح هجمـتك؛ ربما عطّلها فخ.");
      }
    }
    if (action.action_type === "steal_kill" && death?.cause !== "steal_kill")
      await db.query(
        "UPDATE feign_players SET ability_used=1 WHERE id=? AND room_id=? AND role_key='thief'",
        [actorId, roomId],
      );
  }

  for (const [playerId, text] of results) {
    const player = players.find((entry) => Number(entry.id) === Number(playerId));
    if (!player) continue;
    const sent = await msg.sendPrivateWithResult(player.psid, text);
    if (!sent.ok)
      console.error(`[feign] private result failed for player ${player.id}:`, sent.reason);
  }

  if (await checkVictory(roomId)) return;
  await beginDiscussion(roomId, deaths);
}

function deathLine(death) {
  const reveal =
    death.revealMode === "hidden"
      ? " — الدور مخفي"
      : ` — الدور: ${ROLES[death.revealRole]?.name || "غير معروف"}`;
  return `• ${death.display_name}${reveal}`;
}

async function beginDiscussion(roomId, deaths) {
  const room = await getRoom(roomId);
  if (!room || room.status !== "playing" || room.phase !== "tallying") return;
  const updated = await db.query(
    "UPDATE game_rooms SET phase='discussion', phase_ends_at=DATE_ADD(NOW(), INTERVAL ? SECOND) WHERE id=? AND game_id='feign' AND status='playing' AND phase='tallying'",
    [CFG.DISCUSSION_SECONDS, roomId],
  );
  if (!updated.affectedRows) return;
  const report = deaths.length
    ? `🌅 تقرير الصباح — الموتى فقط:\n${deaths.map(deathLine).join("\n")}`
    : "🌅 حلّ الصباح. لم يُعلن عن أي ضحايا.";
  await msg.sendGroup(
    room.thread_id,
    `${report}\n\n💬 أمامكم ${CFG.DISCUSSION_SECONDS} ثانية للنقاش. لا تُكشف التحركات أو نتائج الأدوار.`,
  );
}

async function startVoting(roomId) {
  const moved = await db.query(
    "UPDATE game_rooms SET phase='voting', phase_ends_at=DATE_ADD(NOW(), INTERVAL ? SECOND) WHERE id=? AND game_id='feign' AND status='playing' AND phase='discussion'",
    [CFG.VOTING_SECONDS, roomId],
  );
  if (!moved.affectedRows) return;
  const room = await getRoom(roomId);
  const players = aliveList(await getPlayers(roomId));
  if (players.length < 2) return checkVictory(roomId);
  await msg.sendGroup(
    room.thread_id,
    `التصويت (${CFG.VOTING_SECONDS}ث):\n${playerList(players)}`,
  );
  for (const player of players) {
    const sent = await msg.sendPrivateWithResult(
      player.psid,
      `${VOTE_MARKER}\nرد على هذه البطاقة برقم اللاعب للتصويت.\n${playerList(players.filter((other) => Number(other.id) !== Number(player.id)))}`,
    );
    if (!sent.ok)
      console.error(`[feign] vote card failed for ${player.id}:`, sent.reason);
  }
}

async function resolveVoting(roomId) {
  const locked = await db.query(
    "UPDATE game_rooms SET phase='tallying', phase_ends_at=NULL WHERE id=? AND game_id='feign' AND status='playing' AND phase='voting'",
    [roomId],
  );
  if (!locked.affectedRows) return;
  const room = await getRoom(roomId);
  const players = aliveList(await getPlayers(roomId));
  const votes = await db.query(
    `SELECT fv.target_player_id, COUNT(*) AS count
     FROM feign_votes fv
     JOIN feign_players voter ON voter.id=fv.voter_player_id
     WHERE fv.room_id=? AND fv.round_number=? AND voter.is_alive=1
     GROUP BY fv.target_player_id`,
    [roomId, room.current_round],
  );
  const totals = new Map(
    votes.map((vote) => [Number(vote.target_player_id), Number(vote.count)]),
  );
  const livingIds = new Set(players.map((player) => Number(player.id)));
  const actions = await loadActions(roomId, room.current_round);
  for (const action of actions) {
    if (
      action.action_type === "provoke" &&
      action.target_player_id &&
      livingIds.has(Number(action.target_player_id))
    ) {
      const id = Number(action.target_player_id);
      totals.set(id, (totals.get(id) || 0) + 2);
    }
  }
  const order = [...totals.entries()].sort((a, b) => b[1] - a[1]);
  const top = order[0];
  if (!top || (order[1] && order[1][1] === top[1])) {
    await msg.sendGroup(room.thread_id, "🗳️ تعادل التصويت؛ لم يُطرد أحد.");
  } else {
    const target = players.find((player) => Number(player.id) === top[0]);
    const deaths = target
      ? await applyDeaths(
          roomId,
          Number(room.current_round),
          [{ playerId: target.id, cause: "vote" }],
          actions,
        )
      : [];
    await msg.sendGroup(
      room.thread_id,
      deaths.length
        ? `⚖️ طُرد ${deaths.map(deathLine).join("\n• ")}.`
        : "⚖️ انتهى التصويت دون طرد.",
    );
    if (target?.role_key === "haunter" && deaths.length) {
      const marks = await db.query(
        "SELECT id, target_player_id FROM feign_marks WHERE room_id=? AND source_player_id=? AND mark_type='haunt'",
        [roomId, target.id],
      );
      const hauntDeaths = await applyDeaths(
        roomId,
        Number(room.current_round),
        marks.map((mark) => ({
          playerId: mark.target_player_id,
          cause: "haunt",
          unblockable: true,
        })),
        [],
      );
      for (const mark of marks)
        await db.query("DELETE FROM feign_marks WHERE id=?", [mark.id]);
      return finishGame(
        roomId,
        "haunter",
        hauntDeaths.length
          ? `${target.display_name} طُرد وفاز كمطارد، وأخذ معه ${hauntDeaths.map((death) => death.display_name).join("، ")}.`
          : `${target.display_name} طُرد وفاز كمطارد.`,
        target.id,
      );
    }
  }
  if (!(await checkVictory(roomId))) await startNight(roomId, true);
}

async function checkVictory(roomId) {
  const players = await getPlayers(roomId);
  const living = aliveList(players);
  if (!living.length) return finishGame(roomId, "draw", "لم ينجُ أحد.");
  if (living.length === 1) {
    const last = living[0];
    if (SOLO_ROLES.has(last.role_key))
      return finishGame(roomId, "solo", `${last.display_name} بقي الأخير.`, last.id);
    if (last.role_key === "survivor")
      return finishGame(roomId, "survivor", `${last.display_name} حقق هدف البقاء.`);
    if (last.team === "neutral")
      return finishGame(roomId, "solo", `${last.display_name} بقي الأخير.`, last.id);
    return finishGame(
      roomId,
      last.team === "impostor" ? "impostor" : "town",
      `${last.display_name} هو آخر لاعب حي.`,
    );
  }
  const impostors = living.filter((player) => player.team === "impostor");
  const soloThreats = living.filter((player) =>
    NEUTRAL_THREATS.has(player.role_key),
  );
  if (!impostors.length && !soloThreats.length)
    return finishGame(roomId, "town", "قضى الأخيار على الأشرار والقتلة المنفردين.");
  if (impostors.length >= living.length - impostors.length)
    return finishGame(roomId, "impostor", "بلغ الأشرار نصف اللاعبين الأحياء أو أكثر.");
  return false;
}

async function finishGame(roomId, winner, reason, winningPlayerId = null) {
  const updated = await db.query(
    "UPDATE game_rooms SET status='finished', phase='finished', phase_ends_at=NULL WHERE id=? AND game_id='feign' AND status='playing'",
    [roomId],
  );
  if (!updated.affectedRows) return winner;
  const room = await getRoom(roomId);
  const players = await getPlayers(roomId);
  const winners = players.filter((player) => {
    if (winner === "town") return player.team === "town" || player.role_key === "survivor";
    if (winner === "impostor") return player.team === "impostor" || player.role_key === "survivor";
    if (winner === "solo" || winner === "haunter")
      return Number(player.id) === Number(winningPlayerId);
    if (winner === "survivor") return player.role_key === "survivor";
    return false;
  });
  await leaderboard.recordPoints("feign", roomId, winners);
  const winnerName =
    winner === "town" ? "الأخيار" :
      winner === "impostor" ? "الأشرار" :
        winner === "solo" ? "الفائز الفردي" :
          winner === "haunter" ? "المطارد" :
        winner === "survivor" ? "الناجي" : "لا أحد";
  const roster = players.map(
    (player) =>
      `• ${player.display_name}: ${ROLES[player.role_key]?.name || "غير معروف"} — ${player.team === "town" ? "الأخيار" : player.team === "impostor" ? "الأشرار" : "محايد"}${player.is_alive ? "" : " (خرج)"}`,
  );
  await msg.sendGroup(
    room.thread_id,
    `${reason}\nالفائز: ${winnerName}${winners.length ? ` — ${winners.map((player) => player.display_name).join("، ")}` : ""}\nالأدوار:\n${roster.join("\n")}\nجولة جديدة: فيجن`,
  );
  return winner;
}

async function handleGroup(context, command) {
  const name = commandParts(context.text).name;
  if (name === "فيجن" || name === "feign")
    return msg.sendGroup(
      context.threadId,
      "⚠️ توجد لعبة فيجن نشطة بالفعل في هذه المجموعة.",
    );
  if (command === "help") return msg.sendGroup(context.threadId, helpText());
  if (command === "action")
    return msg.sendGroup(context.threadId, "🔒 استخدم القدرة بالرد على بطاقة القدرة التي تصلك من البوت في الخاص.");
  if (command === "vote")
    return msg.sendGroup(context.threadId, "🔒 صوّت بالرد على بطاقة التصويت التي تصلك من البوت في الخاص.");
  if (command === "players") return listPlayers(context.threadId);
  if (command === "status") return showStatus(context.threadId);
  if (command === "leave") return leaveGame(context.userId, context.threadId);
  if (command === "cancel") return cancelGame(context.userId, context.threadId);
}

async function handlePrivate(context, command, argument) {
  if (command === "help") return msg.sendPrivate(context.userId, helpText());
  const session = await getSession(context.userId);
  if (command === "role") {
    if (!session)
      return msg.sendPrivate(context.userId, "لا تشارك في لعبة فيجن حالياً.");
    return msg.sendPrivate(
      context.userId,
      roleCard(session, await getPlayers(session.room_id)),
    );
  }
  if (!session)
    return command
      ? msg.sendPrivate(context.userId, "لا تشارك في لعبة فيجن نشطة حالياً.")
      : undefined;
  const isActionReply = isReplyToBotPrompt(
    context.messageReply,
    ACTION_MARKER,
    msg.selfId?.(),
  );
  const isVoteReply = isReplyToBotPrompt(
    context.messageReply,
    VOTE_MARKER,
    msg.selfId?.(),
  );
  if (command === "action") {
    if (!isActionReply)
      return msg.sendPrivate(
        context.userId,
        "🔒 لا تُقبل القدرة بأمر مباشر؛ رد على بطاقة القدرة الليلية التي أرسلها البوت.",
      );
    return submitNightAction(context.userId, session, argument);
  }
  if (command === "vote") {
    if (!isVoteReply)
      return msg.sendPrivate(
        context.userId,
        "🔒 لا يُقبل التصويت بأمر مباشر؛ رد على بطاقة التصويت التي أرسلها البوت.",
      );
    return submitVote(context.userId, session, argument);
  }
  if (!command && session.phase === "night" && isActionReply)
    return submitNightAction(context.userId, session, context.text);
  if (
    !command &&
    session.phase === "voting" &&
    /^\d+$/.test(context.text.trim())
  ) {
    if (!isVoteReply)
      return msg.sendPrivate(
        context.userId,
        "🔒 رد على بطاقة التصويت المرسلة من البوت برقم اللاعب.",
      );
    return submitVote(context.userId, session, context.text.trim());
  }
}

async function listPlayers(threadId) {
  const room = await getRoomByThread(threadId);
  if (!room) return msg.sendGroup(threadId, "ℹ️ لا توجد لعبة فيجن نشطة.");
  const players = await getPlayers(room.id);
  return msg.sendGroup(
    threadId,
    `🎭 لاعبو فيجن (${players.length}):\n${players.map((player) => `• ${player.display_name}${player.is_alive === 0 ? " — خرج" : ""}`).join("\n") || "لا يوجد لاعبون بعد."}`,
  );
}

async function showStatus(threadId) {
  const room = await getRoomByThread(threadId);
  if (!room)
    return msg.sendGroup(threadId, "ℹ️ لا توجد لعبة فيجن نشطة. اكتبوا «فيجن» لبدء واحدة.");
  const [players, timer] = await Promise.all([
    getPlayers(room.id),
    db.one(
      "SELECT TIMESTAMPDIFF(SECOND, NOW(), phase_ends_at) AS remaining FROM game_rooms WHERE id=?",
      [room.id],
    ),
  ]);
  const remaining =
    timer?.remaining !== null && Number(timer?.remaining) > 0
      ? `\n⏳ المتبقي: ${timer.remaining} ثانية`
      : "";
  return msg.sendGroup(
    threadId,
    `🎭 حالة فيجن: ${room.phase}${remaining}\n👥 الأحياء: ${aliveList(players).map((player) => player.display_name).join("، ") || "لا أحد"}`,
  );
}

async function leaveGame(userId, threadId) {
  const room = await getRoomByThread(threadId);
  if (!room || room.status !== "lobby") return;
  const player = await getPlayer(room.id, userId);
  if (!player) return;
  if (room.host_psid === userId) return cancelGame(userId, threadId);
  await db.query("DELETE FROM feign_players WHERE id=?", [player.id]);
  return msg.sendGroup(threadId, `👋 غادر ${player.display_name} التسجيل.`);
}

async function cancelGame(userId, threadId, isAdmin = false) {
  const room = await getRoomByThread(threadId);
  if (!room) return;
  if (room.host_psid !== userId && !isAdmin)
    return msg.sendGroup(threadId, "⛔ مضيف اللعبة فقط يستطيع إلغاء فيجن.");
  const cancelled = await db.query(
    "UPDATE game_rooms SET status='cancelled', phase='finished', phase_ends_at=NULL WHERE id=? AND game_id='feign' AND status IN ('lobby','playing')",
    [room.id],
  );
  if (cancelled.affectedRows)
    return msg.sendGroup(threadId, "🚫 أُلغيت لعبة فيجن.");
}

async function handleDueRoom(room) {
  if (room.phase === "lobby") return startGame(room.id);
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
      `SELECT id, phase FROM game_rooms
       WHERE game_id='feign' AND status IN ('lobby','playing')
         AND phase_ends_at IS NOT NULL AND phase_ends_at<=NOW()
         AND phase IN ('lobby','night','discussion','voting')`,
    );
    for (const room of rooms) {
      try {
        await handleDueRoom(room);
      } catch (error) {
        console.error(`[feign] ticker failed for room ${room.id}:`, error);
      }
    }
  } finally {
    ticking = false;
  }
}

function startTicker() {
  setInterval(() => {
    tick().catch((error) => console.error("[feign] ticker failed:", error));
  }, 3000);
}

function helpText() {
  return `فيجن (${CFG.MIN_PLAYERS}-${CFG.MAX_PLAYERS} لاعباً): اكتب فيجن وتفاعل للانضمام. الأدوار عشوائية وسرية.
الدورة: ليلة (${CFG.NIGHT_SECONDS}ث) للقدرات الخاصة، ثم نقاش (${CFG.DISCUSSION_SECONDS}ث) وتصويت سري (${CFG.VOTING_SECONDS}ث). التعادل لا يُقصي أحداً.
لا تُقبل القدرة أو الأصوات بأوامر مباشرة؛ أرسل الاختيار بالرد على بطاقة البوت المناسبة. أعد إرسال دورك بكتابة /دور فيجن.
يفوز الأخيار بإقصاء الأشرار والقتلة؛ يفوز الأشرار عند بلوغ نصف اللاعبين. الأدوار المنفردة لها شروط فوز خاصة.
الأوامر: /قواعد فيجن، /لاعبين فيجن، /حالة فيجن، /خروج فيجن، /إلغاء فيجن.`;
}

module.exports = {
  assertSchema,
  handleMessage,
  handleReaction,
  cancelActiveGame: cancelGame,
  canHandleMessage,
  startTicker,
};
