const fs = require("node:fs/promises");
const path = require("node:path");
const { randomInt } = require("node:crypto");
const db = require("../../database");
const ui = require("../../services/interaction");
const msg = require("../../services/messenger");
const adminAuth = require("../../services/adminAuth");
const leaderboard = require("../../services/leaderboard");
const CFG = require("./config");
const TRAILS = require("./trails");

const GAME_ID = "treasure-hunt";
const STARTS = new Set([
  "كنز",
  "البحث عن الكنز",
  "البحثعنالكنز",
  "البحث_عن_الكنز",
  "صيدالكنز",
  "treasurehunt",
]);
const COMMANDS = new Map([
  ["قواعدالكنز", "help"],
  ["treasurehunthelp", "help"],
  ["حالةالكنز", "status"],
  ["treasurehuntstatus", "status"],
  ["خروجالكنز", "leave"],
  ["leavetreasurehunt", "leave"],
  ["إلغاءالكنز", "cancel"],
  ["الغاءالكنز", "cancel"],
  ["canceltreasurehunt", "cancel"],
  ["تلميحكنز", "hint"],
  ["treasurehunthint", "hint"],
]);
const roomLocks = new Map();
let ticker = null;
let ticking = false;

function commandParts(text) {
  const clean = String(text || "")
    .trim()
    .replace(/^[/!]\s*/, "");
  const parts = clean.split(/\s+/u);
  const name = (parts.shift() || "").toLowerCase();
  return { clean, name, arg: parts.join(" "), command: COMMANDS.get(name) || null };
}

function normalize(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\u064B-\u065F\u0670\u0640\u200c\u200d]/g, "")
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

function answerForms(value) {
  const normalized = normalize(value);
  const forms = new Set(normalized ? [normalized] : []);
  if (normalized.startsWith("ال") && normalized.length > 2)
    forms.add(normalized.slice(2));
  return forms;
}

function isCorrectAnswer(answer, acceptedAnswers) {
  const answerVariants = answerForms(answer);
  return (
    answerVariants.size > 0 &&
    acceptedAnswers.some((candidate) =>
      [...answerForms(candidate)].some((form) => answerVariants.has(form)),
    )
  );
}

function shuffle(items) {
  const result = [...items];
  for (let index = result.length - 1; index > 0; index--) {
    const swapIndex = randomInt(index + 1);
    [result[index], result[swapIndex]] = [result[swapIndex], result[index]];
  }
  return result;
}

function setDeadline(state, seconds) {
  state.deadlineAt = new Date(Date.now() + seconds * 1000).toISOString();
}

function clearDeadline(state) {
  state.deadlineAt = null;
}

function phaseForStage(stage) {
  if (stage === "lobby") return "lobby";
  if (stage === "clue" || stage === "final") return "assigning";
  return "finished";
}

function statusForStage(stage) {
  if (stage === "lobby") return "lobby";
  if (stage === "cancelled") return "cancelled";
  if (stage === "finished") return "finished";
  return "playing";
}

async function withRoomLock(roomId, operation) {
  const key = String(roomId);
  const previous = roomLocks.get(key) || Promise.resolve();
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const current = previous.then(() => gate);
  roomLocks.set(key, current);
  await previous.catch(() => {});
  try {
    return await operation();
  } finally {
    release();
    if (roomLocks.get(key) === current) roomLocks.delete(key);
  }
}

const getRoom = (roomId) =>
  db.one("SELECT * FROM game_rooms WHERE id=? AND game_id=?", [
    roomId,
    GAME_ID,
  ]);
const getActiveRoom = (threadId) =>
  db.one(
    "SELECT * FROM game_rooms WHERE thread_id=? AND game_id=? AND status IN ('lobby','playing') ORDER BY id DESC LIMIT 1",
    [threadId, GAME_ID],
  );
const getPlayers = (roomId) =>
  db.query(
    "SELECT id, psid, display_name FROM room_players WHERE room_id=? ORDER BY id",
    [roomId],
  );
const getPlayer = (roomId, userId) =>
  db.one("SELECT id, psid, display_name FROM room_players WHERE room_id=? AND psid=?", [
    roomId,
    String(userId),
  ]);

async function getState(roomId) {
  const row = await db.one(
    "SELECT state_json FROM treasure_hunt_state WHERE room_id=?",
    [roomId],
  );
  if (!row)
    throw new Error(`Missing treasure hunt state for room ${roomId}.`);
  return JSON.parse(row.state_json);
}

async function persistState(state) {
  const roomStatus = statusForStage(state.stage);
  const phase = phaseForStage(state.stage);
  const round = state.stage === "final" ? CFG.CLUE_COUNT + 1 : state.round || 0;
  const remainingSeconds = state.deadlineAt
    ? Math.max(
        0,
        Math.ceil((new Date(state.deadlineAt).getTime() - Date.now()) / 1000),
      )
    : null;

  await db.withTransaction(async (query) => {
    if (remainingSeconds === null) {
      await query(
        "UPDATE treasure_hunt_state SET state_json=?, deadline_at=NULL WHERE room_id=?",
        [JSON.stringify(state), state.roomId],
      );
      await query(
        "UPDATE game_rooms SET status=?, phase=?, current_round=?, total_rounds=?, phase_ends_at=NULL WHERE id=? AND game_id=?",
        [
          roomStatus,
          phase,
          round,
          CFG.CLUE_COUNT + 1,
          state.roomId,
          GAME_ID,
        ],
      );
      return;
    }

    await query(
      "UPDATE treasure_hunt_state SET state_json=?, deadline_at=DATE_ADD(NOW(), INTERVAL ? SECOND) WHERE room_id=?",
      [JSON.stringify(state), remainingSeconds, state.roomId],
    );
    await query(
      "UPDATE game_rooms SET status=?, phase=?, current_round=?, total_rounds=?, phase_ends_at=DATE_ADD(NOW(), INTERVAL ? SECOND) WHERE id=? AND game_id=?",
      [
        roomStatus,
        phase,
        round,
        CFG.CLUE_COUNT + 1,
        remainingSeconds,
        state.roomId,
        GAME_ID,
      ],
    );
  });
}

function currentClue(state) {
  return state.trail.clues[state.round - 1];
}

function clueMessage(state) {
  const clue = currentClue(state);
  return [
    `🗺️ ${state.trail.name} — الدليل ${state.round}/${CFG.CLUE_COUNT}`,
    clue.text,
    `أول لاعب يكتشف المكان يحصل على مفتاح. الوقت: ${CFG.CLUE_SECONDS} ثانية.`,
  ].join("\n");
}

function finalMessage(state) {
  const finalists = state.finalists.map((player) => player.display_name);
  const hasKeyHolder = state.finalists.some(
    (player) => (Number(state.keys[String(player.psid)]) || 0) > 0,
  );
  const accessText = hasKeyHolder
    ? `المسموح لهم بمحاولة القفل: ${finalists.join("، ")}.`
    : "لم يجمع أحد مفتاحاً؛ يحق للجميع محاولة فتح الصندوق.";
  return [
    `🔐 وصلتم إلى الصندوق بعد ${state.trail.name}!`,
    `لغز القفل: ${state.trail.final.text}`,
    accessText,
    `أول إجابة صحيحة تفتح الكنز. الوقت: ${CFG.FINAL_SECONDS} ثانية.`,
  ].join("\n");
}

function addKey(state, userId) {
  const id = String(userId);
  state.keys[id] = (Number(state.keys[id]) || 0) + 1;
}

function spendHint(state, userId) {
  const id = String(userId);
  if (
    state.stage !== "clue" ||
    state.hintUsed.includes(state.round) ||
    (Number(state.keys[id]) || 0) < 2
  )
    return false;

  state.keys[id] -= 1;
  state.hintUsed.push(state.round);
  return true;
}

function finalPlayers(players, state) {
  const holders = players.filter((player) => (state.keys[String(player.psid)] || 0) > 0);
  return holders.length ? holders : players;
}

function topKeyWinners(players, state) {
  const highest = Math.max(
    0,
    ...players.map((player) => Number(state.keys[String(player.psid)]) || 0),
  );
  if (!highest) return [];
  return players.filter(
    (player) => (Number(state.keys[String(player.psid)]) || 0) === highest,
  );
}

async function assertSchema() {
  const schema = await fs.readFile(path.join(__dirname, "schema.sql"), "utf8");
  for (const statement of schema
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)) {
    await db.query(statement);
  }
}

async function createRoom(userId, threadId) {
  if (await db.isUserBanned(userId))
    return msg.sendGroup(threadId, "أنت محظور من بدء الألعاب.");
  const existing = await db.one(
    "SELECT game_id FROM game_rooms WHERE thread_id=? AND status IN ('lobby','playing') LIMIT 1",
    [threadId],
  );
  if (existing)
    return msg.sendGroup(
      threadId,
      `⚠️ توجد لعبة نشطة بالفعل (${existing.game_id}). أنهِها قبل بدء البحث عن الكنز.`,
    );

  const initialState = {
    roomId: null,
    stage: "lobby",
    round: 0,
    trail: null,
    keys: {},
    hintUsed: [],
    finalists: [],
    deadlineAt: null,
  };
  let created;
  try {
    created = await db.withTransaction(async (query) => {
      const room = await query(
        "INSERT INTO game_rooms (game_id, thread_id, host_psid, status, phase, total_rounds) VALUES (?,?,?,'lobby','lobby',?)",
        [GAME_ID, threadId, String(userId), CFG.CLUE_COUNT + 1],
      );
      initialState.roomId = room.insertId;
      await query(
        "INSERT INTO treasure_hunt_state (room_id, state_json) VALUES (?,?)",
        [room.insertId, JSON.stringify(initialState)],
      );
      return room;
    });
  } catch (error) {
    if (error.code === "ER_DUP_ENTRY")
      return msg.sendGroup(threadId, "⚠️ توجد لعبة نشطة في هذه المجموعة.");
    throw error;
  }

  const messageId = await msg.sendGroupTracked(
    threadId,
    [
      `البحث عن الكنز | التسجيل مفتوح (${CFG.MIN_PLAYERS}–${CFG.MAX_PLAYERS} لاعبين، ينتهي بعد ${CFG.LOBBY_SECONDS} ثانية)`,
      "حلّوا الأدلة المتتابعة واجمعوا المفاتيح، ثم حاولوا فتح الصندوق النهائي.",
      "تفاعلوا مع هذه الرسالة للانضمام؛ المضيف لا يُسجل تلقائياً. راسلوا البوت في الخاص أولاً. للمغادرة: /خروج الكنز",
    ].join("\n"),
  );
  if (!messageId) {
    initialState.stage = "cancelled";
    await persistState(initialState);
    return;
  }
  await db.query(
    "UPDATE game_rooms SET lobby_message_id=?, phase_ends_at=DATE_ADD(NOW(), INTERVAL ? SECOND) WHERE id=? AND game_id=? AND status='lobby'",
    [messageId, CFG.LOBBY_SECONDS, created.insertId, GAME_ID],
  );
}

async function registerPlayer(room, userId) {
  if (!room || room.status !== "lobby") return;
  return withRoomLock(room.id, async () => {
    const currentRoom = await getRoom(room.id);
    if (!currentRoom || currentRoom.status !== "lobby") return;
    if (await getPlayer(room.id, userId)) return;
    if (await db.isUserBanned(userId))
      return msg.sendGroup(room.thread_id, "أنت محظور من التسجيل.");

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
      Array(6).fill(String(userId)),
    );
    if (active)
      return msg.sendGroup(room.thread_id, "أنت مشارك في لعبة أخرى.");

    const players = await getPlayers(room.id);
    if (players.length >= CFG.MAX_PLAYERS)
      return msg.sendGroup(room.thread_id, "⛔ اكتمل عدد لاعبي البحث عن الكنز.");

    let displayName = String((await msg.getUserName(userId)) || "لاعب").slice(0, 100);
    if (players.some((player) => player.display_name === displayName))
      displayName = `${displayName} (${players.length + 1})`;
    try {
      await db.query(
        "INSERT INTO room_players (room_id, psid, display_name) VALUES (?,?,?)",
        [room.id, String(userId), displayName],
      );
    } catch (error) {
      if (error.code === "ER_DUP_ENTRY") return;
      throw error;
    }

    const playerCount = players.length + 1;
    const announcement = ui.joinAnnouncement({
      name: displayName,
      count: playerCount,
      min: CFG.MIN_PLAYERS,
      max: CFG.MAX_PLAYERS,
    });
    if (announcement) await msg.sendGroup(room.thread_id, announcement);
    if (playerCount >= CFG.MAX_PLAYERS)
      await db.query(
        "UPDATE game_rooms SET phase_ends_at=NOW() WHERE id=? AND game_id=? AND status='lobby'",
        [room.id, GAME_ID],
      );
  });
}

async function handleReaction({ userId, threadId, messageId }) {
  const room = await db.one(
    `SELECT * FROM game_rooms
     WHERE game_id=? AND thread_id=? AND lobby_message_id=?
       AND status='lobby' AND phase='lobby'`,
    [GAME_ID, threadId, messageId],
  );
  if (room) return registerPlayer(room, userId);
}

async function startGame(roomId) {
  const initialRoom = await getRoom(roomId);
  if (!initialRoom || initialRoom.status !== "lobby" || initialRoom.phase !== "lobby")
    return;
  try {
    const reactors = await msg.getReactors(
      initialRoom.thread_id,
      initialRoom.lobby_message_id,
    );
    for (const userId of reactors)
      await registerPlayer(initialRoom, String(userId));
  } catch (error) {
    console.error(`[${GAME_ID}] reaction recovery failed for room ${roomId}:`, error);
  }

  return withRoomLock(roomId, async () => {
    const room = await getRoom(roomId);
    if (!room || room.status !== "lobby" || room.phase !== "lobby") return;
    const players = await getPlayers(room.id);
    if (players.length < CFG.MIN_PLAYERS) {
      const state = await getState(room.id);
      state.stage = "cancelled";
      clearDeadline(state);
      await persistState(state);
      return msg.sendGroup(
        room.thread_id,
        `انتهى التسجيل دون ${CFG.MIN_PLAYERS} لاعبين؛ أُلغي البحث عن الكنز.`,
      );
    }

    const state = await getState(room.id);
    state.stage = "clue";
    state.round = 1;
    state.trail = TRAILS[randomInt(TRAILS.length)];
    state.keys = {};
    state.hintUsed = [];
    setDeadline(state, CFG.CLUE_SECONDS);
    await persistState(state);
    return msg.sendGroup(
      room.thread_id,
      `🧭 بدأ البحث عن الكنز! اللاعبون: ${players.map((player) => player.display_name).join("، ")}.\n${clueMessage(state)}`,
    );
  });
}

async function beginFinal(room, state, players, opening) {
  state.stage = "final";
  state.finalists = finalPlayers(players, state).map((player) => ({
    psid: String(player.psid),
    display_name: player.display_name,
  }));
  setDeadline(state, CFG.FINAL_SECONDS);
  await persistState(state);
  return msg.sendGroup(
    room.thread_id,
    `${opening}\n\n${finalMessage(state)}`,
  );
}

async function advanceClue(room, state, players, finder = null) {
  if (finder) addKey(state, finder.psid);
  const clue = currentClue(state);
  const opening = finder
    ? `🗝️ ${finder.display_name} اكتشف ${clue.answers[0]} وحصل على مفتاح!`
    : `⌛ انتهى الوقت. الإجابة كانت ${clue.answers[0]}، ولم يُعثر على مفتاح في هذا الدليل.`;

  if (state.round < state.trail.clues.length) {
    state.round += 1;
    setDeadline(state, CFG.CLUE_SECONDS);
    await persistState(state);
    return msg.sendGroup(
      room.thread_id,
      `${opening}\n\n${clueMessage(state)}`,
    );
  }
  return beginFinal(room, state, players, opening);
}

async function finishGame(room, state, winners, message) {
  if (winners.length) {
    await leaderboard.recordPoints(
      GAME_ID,
      room.id,
      winners.map((player) => ({
        psid: String(player.psid),
        display_name: player.display_name,
      })),
    );
  }
  state.stage = "finished";
  clearDeadline(state);
  await persistState(state);
  return msg.sendGroup(room.thread_id, message);
}

async function handleHint(room, state, player) {
  if (state.stage !== "clue")
    return msg.sendGroup(room.thread_id, "التلميح متاح أثناء حل الأدلة فقط.");
  if (state.hintUsed.includes(state.round))
    return msg.sendGroup(room.thread_id, "استُخدم تلميح هذا الدليل بالفعل.");
  if ((Number(state.keys[String(player.psid)]) || 0) < 1)
    return msg.sendGroup(
      room.thread_id,
      `${player.display_name} يحتاج مفتاحين على الأقل لطلب التلميح.`,
    );
  if (!spendHint(state, player.psid))
    return msg.sendGroup(room.thread_id, "تعذّر استخدام التلميح في هذه المرحلة.");

  await persistState(state);
  return msg.sendGroup(
    room.thread_id,
    `🔎 تلميح الدليل ${state.round} (كلف ${player.display_name} مفتاحاً): ${currentClue(state).hint}`,
  );
}

async function handleGroup(context, parsed) {
  if (parsed.command === "help")
    return msg.sendGroup(context.threadId, helpText());
  const room = await getActiveRoom(context.threadId);
  if (!room) {
    if (parsed.command === "leave")
      return msg.sendGroup(context.threadId, "لا يوجد تسجيل نشط للبحث عن الكنز.");
    if (parsed.command === "cancel" || parsed.command === "hint")
      return msg.sendGroup(context.threadId, "لا توجد لعبة بحث عن الكنز نشطة.");
    if (parsed.command === "status")
      return msg.sendGroup(context.threadId, "لا توجد لعبة بحث عن الكنز نشطة.");
    return;
  }
  if (parsed.command === "leave") return leaveLobby(room, context.userId);
  if (parsed.command === "cancel")
    return cancelActiveGame(
      context.userId,
      context.threadId,
      adminAuth.isAdmin(context.userId),
    );

  const state = await getState(room.id);
  const players = await getPlayers(room.id);
  if (parsed.command === "status")
    return msg.sendGroup(
      context.threadId,
      `🗺️ حالة البحث عن الكنز: ${state.stage === "lobby" ? "التسجيل" : state.stage === "clue" ? `الدليل ${state.round}/${CFG.CLUE_COUNT}` : state.stage === "final" ? "القفل النهائي" : "انتهت اللعبة"}.\nالمفاتيح:\n${players.map((player) => `• ${player.display_name}: ${Number(state.keys[String(player.psid)]) || 0}`).join("\n") || "لا يوجد لاعبون."}`,
    );

  const player = players.find(
    (entry) => String(entry.psid) === String(context.userId),
  );
  if (!player) return;
  if (parsed.command === "hint")
    return withRoomLock(room.id, async () => {
      const currentRoom = await getRoom(room.id);
      if (!currentRoom || currentRoom.status !== "playing") return;
      const currentState = await getState(room.id);
      if (currentState.stage !== state.stage || currentState.round !== state.round)
        return;
      const currentPlayer = await getPlayer(room.id, context.userId);
      if (!currentPlayer) return;
      return handleHint(currentRoom, currentState, currentPlayer);
    });

  if (state.stage !== "clue" && state.stage !== "final") return;
  return withRoomLock(room.id, async () => {
    const currentRoom = await getRoom(room.id);
    if (!currentRoom || currentRoom.status !== "playing") return;
    const currentState = await getState(room.id);
    if (
      currentState.stage !== state.stage ||
      currentState.round !== state.round
    )
      return;
    const currentPlayers = await getPlayers(room.id);
    const currentPlayer = currentPlayers.find(
      (entry) => String(entry.psid) === String(context.userId),
    );
    if (!currentPlayer) return;

    if (currentState.stage === "clue") {
      if (!isCorrectAnswer(parsed.clean, currentClue(currentState).answers))
        return;
      return advanceClue(currentRoom, currentState, currentPlayers, currentPlayer);
    }

    if (
      !currentState.finalists.some(
        (finalist) => String(finalist.psid) === String(currentPlayer.psid),
      ) ||
      !isCorrectAnswer(parsed.clean, currentState.trail.final.answers)
    )
      return;
    return finishGame(
      currentRoom,
      currentState,
      [currentPlayer],
      `🏆 ${currentPlayer.display_name} فتح الصندوق وعثر على الكنز! حصل على نقطة.`,
    );
  });
}

async function leaveLobby(room, userId) {
  return withRoomLock(room.id, async () => {
    const currentRoom = await getRoom(room.id);
    if (!currentRoom || currentRoom.status !== "lobby")
      return msg.sendGroup(room.thread_id, "انتهى التسجيل للبحث عن الكنز.");
    const player = await getPlayer(room.id, userId);
    if (!player)
      return msg.sendGroup(room.thread_id, "أنت غير مسجل في البحث عن الكنز.");
    await db.query("DELETE FROM room_players WHERE room_id=? AND psid=?", [
      room.id,
      String(userId),
    ]);
    const players = await getPlayers(room.id);
    if (String(currentRoom.host_psid) === String(userId) && players.length)
      await db.query("UPDATE game_rooms SET host_psid=? WHERE id=?", [
        players[0].psid,
        room.id,
      ]);
    if (!players.length) {
      const state = await getState(room.id);
      state.stage = "cancelled";
      clearDeadline(state);
      await persistState(state);
      return msg.sendGroup(
        room.thread_id,
        "غادر الجميع التسجيل؛ أُلغي البحث عن الكنز.",
      );
    }
    return msg.sendGroup(room.thread_id, `${player.display_name} غادر التسجيل.`);
  });
}

async function cancelActiveGame(userId, threadId, isAdmin = false) {
  const room = await getActiveRoom(threadId);
  if (!room)
    return msg.sendGroup(threadId, "لا توجد لعبة بحث عن الكنز نشطة.");
  if (String(room.host_psid) !== String(userId) && !isAdmin)
    return msg.sendGroup(
      threadId,
      "⛔ مضيف اللعبة أو أدمن البوت فقط يستطيع إلغاء البحث عن الكنز.",
    );
  return withRoomLock(room.id, async () => {
    const currentRoom = await getRoom(room.id);
    if (!currentRoom || !["lobby", "playing"].includes(currentRoom.status))
      return msg.sendGroup(threadId, "لا توجد لعبة بحث عن الكنز نشطة.");
    const state = await getState(room.id);
    state.stage = "cancelled";
    clearDeadline(state);
    await persistState(state);
    return msg.sendGroup(threadId, "🚫 أُلغي البحث عن الكنز.");
  });
}

function helpText() {
  return [
    "البحث عن الكنز: لعبة جماعية من 3 إلى 8 لاعبين.",
    "ابدأ بكتابة /البحث عن الكنز في المجموعة، ثم تفاعل مع رسالة التسجيل؛ المضيف لا يُسجل تلقائياً.",
    "حلّوا أربعة أدلة متتابعة. أول لاعب يكتشف المكان يحصل على مفتاح؛ لا يرد البوت على الإجابات الخطأ.",
    "يوجد تلميح واحد مشترك لكل دليل؛ أول لاعب يطلبه بكتابة /تلميح كنز يدفع مفتاحاً، ويحتاج مفتاحين على الأقل.",
    "بعد الأدلة يظهر لغز القفل النهائي. أصحاب المفاتيح يتنافسون على فتحه؛ وإذا لم يجمع أحد مفتاحاً يحق للجميع المحاولة.",
    "إذا لم يفتح أحد الصندوق في الوقت المحدد، يفوز صاحب أكبر عدد من المفاتيح؛ التعادل يمنح نقطة لكل المتعادلين.",
    "الأوامر: /قواعد الكنز، /حالة الكنز، /خروج الكنز، /إلغاء الكنز، /تلميح كنز.",
  ].join("\n");
}

async function handleTimeout(roomId) {
  return withRoomLock(roomId, async () => {
    const room = await getRoom(roomId);
    if (!room || room.status !== "playing") return;
    const state = await getState(roomId);
    if (!state.deadlineAt || new Date(state.deadlineAt).getTime() > Date.now())
      return;
    const players = await getPlayers(roomId);
    if (state.stage === "clue")
      return advanceClue(room, state, players);
    if (state.stage === "final") {
      const winners = topKeyWinners(players, state);
      if (!winners.length)
        return finishGame(
          room,
          state,
          [],
          `⌛ انتهى الوقت ولم يُفتح الصندوق. انتهى البحث عن الكنز بلا فائز.`,
        );
      const names = winners.map((player) => player.display_name).join("، ");
      return finishGame(
        room,
        state,
        winners,
        `⌛ انتهى الوقت! فاز ${names} بأكبر عدد من المفاتيح، وحصل${winners.length > 1 ? "وا" : ""} على نقطة لكل منهم.`,
      );
    }
  });
}

async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    const lobbies = await db.query(
      `SELECT id FROM game_rooms
       WHERE game_id=? AND status='lobby' AND phase='lobby'
         AND phase_ends_at IS NOT NULL AND phase_ends_at<=NOW()`,
      [GAME_ID],
    );
    for (const room of lobbies) await startGame(room.id);

    const due = await db.query(
      "SELECT room_id FROM treasure_hunt_state WHERE deadline_at IS NOT NULL AND deadline_at<=NOW()",
    );
    for (const state of due) await handleTimeout(state.room_id);
  } catch (error) {
    console.error(`[${GAME_ID}] ticker failed:`, error.message);
  } finally {
    ticking = false;
  }
}

function startTicker() {
  if (ticker) return;
  ticker = setInterval(tick, 1000);
  ticker.unref?.();
}

async function handleMessage(context) {
  const parsed = commandParts(context.text);
  if (
    STARTS.has(parsed.clean.toLowerCase()) ||
    STARTS.has(parsed.name)
  ) {
    if (!context.isGroup)
      return msg.sendPrivate(context.userId, "ابدأ البحث عن الكنز داخل المجموعة.");
    return createRoom(context.userId, context.threadId);
  }
  if (!context.isGroup)
    return msg.sendPrivate(context.userId, "تُدار لعبة البحث عن الكنز داخل المجموعة.");
  return handleGroup(context, parsed);
}

module.exports = {
  handleMessage,
  handleReaction,
  cancelActiveGame,
  startTicker,
  assertSchema,
  _internal: {
    answerForms,
    finalPlayers,
    isCorrectAnswer,
    spendHint,
    topKeyWinners,
  },
};
