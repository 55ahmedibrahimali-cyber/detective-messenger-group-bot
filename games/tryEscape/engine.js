const fs = require("node:fs/promises");
const path = require("node:path");
const { randomInt } = require("node:crypto");
const db = require("../../database");
const ui = require("../../services/interaction");
const msg = require("../../services/messenger");
const adminAuth = require("../../services/adminAuth");
const leaderboard = require("../../services/leaderboard");
const CFG = require("./config");

const GAME_ID = "try-escape";
const START_ALIASES = new Set([
  "حاول تهرب",
  "حاول_تهرب",
  "حاولتهرب",
  "tryescape",
]);
const COMMANDS = new Map([
  ["help", "help"],
  ["قواعدحاولتهرب", "help"],
  ["tryescapehelp", "help"],
  ["leavetryescape", "leave"],
  ["خروجتهرب", "leave"],
  ["canceltryescape", "cancel"],
  ["إلغاءتهرب", "cancel"],
  ["الغاءتهرب", "cancel"],
  ["kicktryescape", "eliminate"],
  ["استبعادتهرب", "eliminate"],
  ["اطردتهرب", "eliminate"],
  ["tryescapestatus", "status"],
  ["حالةتهرب", "status"],
]);
const FALLBACK_ANSWER = "مش عارف أجاوب على السؤال ده";
const roomLocks = new Map();
let ticker = null;
let ticking = false;

function commandParts(text) {
  const clean = String(text || "")
    .trim()
    .replace(/^[/!]\s*/, "");
  const parts = clean.split(/\s+/);
  const name = (parts.shift() || "").toLowerCase();
  return {
    clean,
    name,
    arg: parts.join(" "),
    command: COMMANDS.get(name) || null,
  };
}

function normalize(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\u064B-\u065F\u0670\u0640\u200c\u200d]/g, "")
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function shuffle(items) {
  const result = [...items];
  for (let index = result.length - 1; index > 0; index--) {
    const swapIndex = randomInt(index + 1);
    [result[index], result[swapIndex]] = [result[swapIndex], result[index]];
  }
  return result;
}

function selectJudge(players) {
  if (!Array.isArray(players) || players.length < CFG.MIN_PLAYERS)
    throw new Error("حاول تهرب تحتاج أربعة لاعبين على الأقل.");
  return players[randomInt(players.length)];
}

function assignAnswers(players, answers) {
  const cards = players.map((player) => ({
    authorId: String(player.psid),
    text: String(answers[String(player.psid)] || FALLBACK_ANSWER),
  }));
  const assigned = new Array(players.length);

  function findAssignment(index, remaining) {
    if (index === players.length) return true;
    const playerId = String(players[index].psid);
    for (const card of shuffle(
      remaining.filter((candidate) => candidate.authorId !== playerId),
    )) {
      const next = remaining.filter((candidate) => candidate !== card);
      assigned[index] = card;
      if (findAssignment(index + 1, next)) return true;
    }
    return false;
  }

  if (!findAssignment(0, shuffle(cards)))
    throw new Error("تعذر خلط الإجابات دون أن تصل إجابة لصاحبها.");
  return Object.fromEntries(
    players.map((player, index) => [String(player.psid), assigned[index]]),
  );
}

function parseEliminationTarget(value, contestants) {
  const digits = String(value || "")
    .trim()
    .replace(/[٠-٩]/g, (digit) => String("٠١٢٣٤٥٦٧٨٩".indexOf(digit)));
  if (/^\d+$/.test(digits)) {
    const index = Number(digits) - 1;
    return contestants[index] || null;
  }
  const targetName = normalize(digits);
  if (!targetName) return null;
  return contestants.find((player) => normalize(player.display_name) === targetName) || null;
}

function phaseForStage(stage) {
  if (stage === "lobby") return "lobby";
  if (stage === "performing") return "discussion";
  if (stage === "awaiting_judge") return "voting";
  if (stage === "finished" || stage === "cancelled") return "finished";
  if (stage === "awaiting_question" || stage === "collecting_answers")
    return "assigning";
  throw new Error(`Unknown حاول تهرب stage: ${stage}`);
}

function statusForStage(stage) {
  if (stage === "lobby") return "lobby";
  if (stage === "finished") return "finished";
  if (stage === "cancelled") return "cancelled";
  return "playing";
}

function setDeadline(state, seconds) {
  state.deadlineAt = new Date(Date.now() + seconds * 1000).toISOString();
}

function clearDeadline(state) {
  state.deadlineAt = null;
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
    "SELECT id, psid, display_name, is_alive FROM room_players WHERE room_id=? ORDER BY id",
    [roomId],
  );
const getPlayer = (roomId, psid) =>
  db.one("SELECT * FROM room_players WHERE room_id=? AND psid=?", [
    roomId,
    String(psid),
  ]);
const getSession = (psid) =>
  db.one(
    `SELECT rp.*, gr.thread_id, gr.host_psid, gr.status, gr.phase, gr.current_round
     FROM room_players rp JOIN game_rooms gr ON gr.id=rp.room_id
     WHERE rp.psid=? AND gr.game_id=? AND gr.status IN ('lobby','playing')
     ORDER BY gr.id DESC LIMIT 1`,
    [String(psid), GAME_ID],
  );

async function getState(roomId) {
  const row = await db.one(
    "SELECT state_json FROM try_escape_state WHERE room_id=?",
    [roomId],
  );
  if (!row) throw new Error(`Missing حاول تهرب state for room ${roomId}.`);
  return JSON.parse(row.state_json);
}

async function persistState(state) {
  const stage = state.stage;
  const roomStatus = statusForStage(stage);
  const phase = phaseForStage(stage);
  const remainingSeconds = state.deadlineAt
    ? Math.max(
        0,
        Math.ceil((new Date(state.deadlineAt).getTime() - Date.now()) / 1000),
      )
    : null;
  await db.withTransaction(async (query) => {
    if (remainingSeconds === null) {
      await query(
        "UPDATE try_escape_state SET state_json=?, deadline_at=NULL WHERE room_id=?",
        [JSON.stringify(state), state.roomId],
      );
    } else {
      await query(
        "UPDATE try_escape_state SET state_json=?, deadline_at=DATE_ADD(NOW(), INTERVAL ? SECOND) WHERE room_id=?",
        [JSON.stringify(state), remainingSeconds, state.roomId],
      );
    }
    await query(
      "UPDATE game_rooms SET status=?, phase=?, current_round=?, phase_ends_at=NULL WHERE id=? AND game_id=?",
      [roomStatus, phase, state.round || 0, state.roomId, GAME_ID],
    );
  });
}

function aliveContestants(players, state) {
  const eliminated = new Set((state.eliminatedIds || []).map(String));
  return players.filter(
    (player) =>
      String(player.psid) !== String(state.judgeId) &&
      !eliminated.has(String(player.psid)),
  );
}

function numberedList(players) {
  return players
    .map((player, index) => `${index + 1}. ${player.display_name}`)
    .join("\n");
}

async function cancelRoom(room, state, text) {
  state.stage = "cancelled";
  clearDeadline(state);
  await persistState(state);
  return msg.sendGroup(room.thread_id, text);
}

async function sendPrivateChecked(userId, text) {
  const result = await msg.sendPrivateWithResult(userId, text);
  return result?.ok
    ? { ok: true }
    : {
        ok: false,
        message:
          result?.userMessage ||
          "تعذّر إرسال الخاص. افتح محادثة البوت وابدأها أولاً.",
      };
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
      `⚠️ توجد لعبة نشطة بالفعل (${existing.game_id}). أنهِها قبل بدء حاول تهرب.`,
    );

  let created;
  const initialState = {
    roomId: null,
    stage: "lobby",
    judgeId: null,
    round: 0,
    question: "",
    answers: {},
    assignments: {},
    performanceOrder: [],
    performances: {},
    currentIndex: 0,
    eliminatedIds: [],
    deadlineAt: null,
  };
  try {
    created = await db.withTransaction(async (query) => {
      const room = await query(
        "INSERT INTO game_rooms (game_id, thread_id, host_psid, status, phase) VALUES (?,?,?,'lobby','lobby')",
        [GAME_ID, threadId, String(userId)],
      );
      initialState.roomId = room.insertId;
      await query(
        "INSERT INTO try_escape_state (room_id, state_json) VALUES (?,?)",
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
    ui.lobbyMessage({
      title: "حاول تهرب",
      tagline: "أقنع القاضي أنك تستطيع الهروب من أسوأ إجابة.",
      min: CFG.MIN_PLAYERS,
      max: CFG.MAX_PLAYERS,
      seconds: CFG.LOBBY_SECONDS,
      leaveCommand: "خروج تهرب",
    }),
  );
  if (!messageId) {
    const state = { ...initialState, stage: "cancelled" };
    await persistState(state);
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
      return msg.sendGroup(room.thread_id, "⛔ اكتمل عدد لاعبي حاول تهرب.");
    let displayName = await msg.getUserName(userId);
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
    console.error(`[try-escape] reaction recovery failed for room ${roomId}:`, error);
  }

  return withRoomLock(roomId, async () => {
    const room = await getRoom(roomId);
    if (!room || room.status !== "lobby" || room.phase !== "lobby") return;
    const players = await getPlayers(roomId);
    const state = await getState(roomId);
    if (players.length < CFG.MIN_PLAYERS) {
      return cancelRoom(
        room,
        state,
        `لم يكتمل العدد (${CFG.MIN_PLAYERS})؛ أُلغيت لعبة حاول تهرب.`,
      );
    }
    if (players.length > CFG.MAX_PLAYERS)
      throw new Error(`Room ${roomId} exceeds the حاول تهرب player limit.`);

    const judge = selectJudge(players);
    state.judgeId = String(judge.psid);
    state.round = 1;
    state.stage = "awaiting_question";
    setDeadline(state, CFG.QUESTION_SECONDS);
    await persistState(state);

    for (const player of players) {
      const text =
        String(player.psid) === state.judgeId
          ? "🎩 أنت القاضي في حاول تهرب. أرسل سؤالاً يحتاج إلى تفكير أو استنتاج في الخاص للبوت؛ سيصل السؤال للمتسابقين في الخاص."
          : "🎭 أنت متسابق في حاول تهرب. انتظر سؤال القاضي في الخاص، ثم أرسل أسوأ إجابة تخطر ببالك.";
      const result = await sendPrivateChecked(player.psid, text);
      if (!result.ok)
        return cancelRoom(
          room,
          state,
          `تعذّر بدء اللعبة؛ ${player.display_name}: ${result.message} أُلغيت الجولة.`,
        );
    }
    return msg.sendGroup(
      room.thread_id,
      `🎩 بدأت لعبة حاول تهرب! القاضي هو ${judge.display_name}. أرسل القاضي سؤاله في الخاص مع البوت.`,
    );
  });
}

async function acceptQuestion(room, state, question) {
  const cleanQuestion = String(question || "").trim();
  if (cleanQuestion.length < 3 || cleanQuestion.length > 500)
    return msg.sendPrivate(
      state.judgeId,
      "أرسل سؤالاً واضحاً يحتاج إلى تفكير أو استنتاج، ولا يتجاوز 500 حرف.",
    );

  const players = aliveContestants(await getPlayers(room.id), state);
  state.question = cleanQuestion;
  state.answers = {};
  state.assignments = {};
  state.performances = {};
  state.stage = "collecting_answers";
  setDeadline(state, CFG.ANSWER_SECONDS);
  await persistState(state);

  for (const player of players) {
    const result = await sendPrivateChecked(
      player.psid,
      `❓ سؤال القاضي:\n${cleanQuestion}\n\nأرسل أسوأ إجابة تخطر ببالك في الخاص. لا ترسلها في المجموعة.`,
    );
    if (!result.ok)
      return cancelRoom(
        room,
        state,
        `تعذّر إرسال السؤال إلى ${player.display_name}: ${result.message} أُلغيت الجولة.`,
      );
  }
  return msg.sendGroup(
    room.thread_id,
    `📩 وصل سؤال القاضي للمتسابقين في الخاص. أمامهم ${CFG.ANSWER_SECONDS} ثانية لإرسال إجاباتهم.`,
  );
}

async function startPresentations(room, state, players, timedOut = false) {
  const contestants = aliveContestants(players, state);
  for (const player of contestants) {
    if (!state.answers[String(player.psid)])
      state.answers[String(player.psid)] = FALLBACK_ANSWER;
  }
  state.assignments = assignAnswers(contestants, state.answers);
  state.performanceOrder = shuffle(contestants.map((player) => String(player.psid)));
  state.performances = {};
  state.currentIndex = 0;
  state.stage = "performing";
  setDeadline(state, CFG.PERFORMANCE_SECONDS);
  await persistState(state);
  const prefix = timedOut
    ? "⌛ انتهى وقت الإجابات؛ من لم يرسل إجابة حصل على إجابة افتراضية."
    : "✅ وصلت إجابات الجميع.";
  await msg.sendGroup(
    room.thread_id,
    `${prefix}\n❓ سؤال الجولة ${state.round}: ${state.question}\nسيحاول كل متسابق تبرير الإجابة التي وصلت له.`,
  );
  return announcePerformer(room, state, players);
}

async function finishPresentations(room, state, players) {
  state.stage = "awaiting_judge";
  setDeadline(state, CFG.JUDGE_SECONDS);
  await persistState(state);
  const contestants = aliveContestants(players, state);
  return msg.sendGroup(
    room.thread_id,
    `🎩 حان قرار القاضي ${nameFor(players, state.judgeId)}. اختر من سيخرج بكتابة «استبعاد تهرب <رقم>» أو اسمه:\n${numberedList(contestants)}`,
  );
}

function nameFor(players, psid) {
  return players.find((player) => String(player.psid) === String(psid))
    ?.display_name || "القاضي";
}

async function announcePerformer(room, state, players, timedOut = false) {
  if (state.currentIndex >= state.performanceOrder.length)
    return finishPresentations(room, state, players);
  const psid = state.performanceOrder[state.currentIndex];
  const player = players.find((entry) => String(entry.psid) === String(psid));
  if (!player) throw new Error(`Missing performer ${psid} in room ${room.id}.`);
  const assigned = state.assignments[psid];
  const prefix = timedOut
    ? "⌛ انتهى وقت المتسابق السابق."
    : "";
  return msg.sendGroup(
    room.thread_id,
    `${prefix}\n🎤 دور ${player.display_name}!\nالإجابة التي وصلتك: «${assigned.text}»\nلديك ${CFG.PERFORMANCE_SECONDS} ثانية لتبريرها والهروب من الموقف. اكتب تبريرك في المجموعة.`,
  );
}

async function advancePerformer(
  room,
  state,
  players,
  performance = null,
  timedOut = false,
) {
  const psid = state.performanceOrder[state.currentIndex];
  if (!psid) return;
  if (performance) state.performances[psid] = String(performance).slice(0, 500);
  else state.performances[psid] = "";
  state.currentIndex += 1;
  if (state.currentIndex >= state.performanceOrder.length)
    return finishPresentations(room, state, players);
  setDeadline(state, CFG.PERFORMANCE_SECONDS);
  await persistState(state);
  return announcePerformer(room, state, players, timedOut);
}

async function submitAnswer(room, state, player, text) {
  const answer = String(text || "").trim();
  if (!answer || answer.length > 300)
    return msg.sendPrivate(
      player.psid,
      "أرسل إجابة من 1 إلى 300 حرفاً.",
    );
  state.answers[String(player.psid)] = answer;
  const players = aliveContestants(await getPlayers(room.id), state);
  if (players.every((candidate) => state.answers[String(candidate.psid)])) {
    await persistState(state);
    await msg.sendPrivate(player.psid, "✅ وصلت إجابتك؛ بدأ دور المتسابقين.");
    return startPresentations(room, state, await getPlayers(room.id));
  }
  await persistState(state);
  return msg.sendPrivate(
    player.psid,
    `✅ وصلت إجابتك (${Object.keys(state.answers).length}/${players.length}). يمكنك تعديلها قبل انتهاء الوقت.`,
  );
}

async function chooseElimination(room, state, players, choice) {
  const contestants = aliveContestants(players, state);
  const eliminated = parseEliminationTarget(choice, contestants);
  if (!eliminated)
    return msg.sendGroup(
      room.thread_id,
      `لم أتعرف على المتسابق. اختر رقماً من القائمة:\n${numberedList(contestants)}`,
    );
  state.eliminatedIds.push(String(eliminated.psid));
  const remaining = contestants.filter(
    (player) => String(player.psid) !== String(eliminated.psid),
  );
  if (remaining.length === 1) {
    await leaderboard.recordPoints(GAME_ID, room.id, [
      {
        psid: String(remaining[0].psid),
        display_name: remaining[0].display_name,
      },
    ]);
    state.stage = "finished";
    clearDeadline(state);
    await persistState(state);
    return msg.sendGroup(
      room.thread_id,
      `🚪 خرج ${eliminated.display_name}.\n🏆 فاز ${remaining[0].display_name} بلعبة حاول تهرب وحصل على نقطة!`,
    );
  }

  state.round += 1;
  state.question = "";
  state.answers = {};
  state.assignments = {};
  state.performanceOrder = [];
  state.performances = {};
  state.currentIndex = 0;
  state.stage = "awaiting_question";
  setDeadline(state, CFG.QUESTION_SECONDS);
  await persistState(state);
  const judgeResult = await sendPrivateChecked(
    state.judgeId,
    `بدأت الجولة ${state.round}. أرسل سؤال الجولة الجديدة في الخاص مع البوت.`,
  );
  if (!judgeResult.ok)
    return cancelRoom(
      room,
      state,
      `تعذّر إرسال تعليمات الجولة إلى القاضي: ${judgeResult.message} أُلغيت اللعبة.`,
    );
  return msg.sendGroup(
    room.thread_id,
    `🚪 خرج ${eliminated.display_name}. تستمر اللعبة مع ${remaining.length} متسابقين؛ أرسل القاضي سؤال الجولة ${state.round} في الخاص.`,
  );
}

async function handlePrivate(context) {
  const session = await getSession(context.userId);
  if (!session)
    return msg.sendPrivate(
      context.userId,
      "للانضمام إلى حاول تهرب سجّل أولاً في المجموعة.",
    );
  return withRoomLock(session.room_id, async () => {
    const room = await getRoom(session.room_id);
    if (!room || room.status !== "playing") return;
    const state = await getState(room.id);
    const players = await getPlayers(room.id);
    const player = players.find(
      (entry) => String(entry.psid) === String(context.userId),
    );
    if (!player) return;

    if (
      state.stage === "awaiting_question" &&
      String(context.userId) === String(state.judgeId)
    )
      return acceptQuestion(room, state, context.text);

    if (state.stage === "collecting_answers") {
      if (String(context.userId) === String(state.judgeId))
        return msg.sendPrivate(context.userId, "انتظر إجابات المتسابقين.");
      if (!aliveContestants(players, state).some(
        (candidate) => String(candidate.psid) === String(context.userId),
      ))
        return msg.sendPrivate(context.userId, "لم تعد مشاركاً في هذه الجولة.");
      return submitAnswer(room, state, player, context.text);
    }

    return msg.sendPrivate(
      context.userId,
      state.stage === "awaiting_question"
        ? "انتظر سؤال القاضي."
        : "لا يوجد طلب خاص مطلوب منك في هذه المرحلة.",
    );
  });
}

async function handleGroup(context, parsed) {
  if (parsed.command === "help")
    return msg.sendGroup(context.threadId, helpText());
  const room = await getActiveRoom(context.threadId);
  if (!room) {
    if (parsed.command === "leave")
      return msg.sendGroup(context.threadId, "لا يوجد تسجيل نشط في حاول تهرب.");
    if (parsed.command === "cancel" || parsed.command === "eliminate")
      return msg.sendGroup(context.threadId, "لا توجد لعبة حاول تهرب نشطة.");
    return;
  }
  if (parsed.command === "leave") return leaveLobby(room, context.userId);
  if (parsed.command === "cancel")
    return cancelActiveGame(
      context.userId,
      context.threadId,
      adminAuth.isAdmin(context.userId),
    );
  if (parsed.command === "status") {
    const state = await getState(room.id);
    const players = await getPlayers(room.id);
    return msg.sendGroup(
      context.threadId,
      `حالة حاول تهرب: الجولة ${state.round || 0}، المرحلة ${state.stage}.\nالمتسابقون:\n${numberedList(aliveContestants(players, state)) || "لا يوجد"}`,
    );
  }
  return withRoomLock(room.id, async () => {
    const currentRoom = await getRoom(room.id);
    if (!currentRoom || currentRoom.status !== "playing") return;
    const state = await getState(room.id);
    const players = await getPlayers(room.id);

    if (state.stage === "performing") {
      const currentPsid = state.performanceOrder[state.currentIndex];
      if (String(context.userId) !== String(currentPsid)) return;
      return advancePerformer(currentRoom, state, players, parsed.clean);
    }

    if (state.stage === "awaiting_judge") {
      if (String(context.userId) !== String(state.judgeId))
        return msg.sendGroup(context.threadId, "قرار الإقصاء متاح للقاضي فقط.");
      if (parsed.command === "eliminate" || !parsed.command)
        return chooseElimination(
          currentRoom,
          state,
          players,
          parsed.arg || parsed.clean,
        );
    }
  });
}

async function leaveLobby(room, userId) {
  return withRoomLock(room.id, async () => {
    const currentRoom = await getRoom(room.id);
    if (!currentRoom || currentRoom.status !== "lobby")
      return msg.sendGroup(room.thread_id, "انتهى التسجيل في حاول تهرب.");
    const player = await getPlayer(room.id, userId);
    if (!player)
      return msg.sendGroup(room.thread_id, "أنت غير مسجل في حاول تهرب.");
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
    if (!players.length)
      return cancelRoom(
        currentRoom,
        await getState(room.id),
        "غادر الجميع التسجيل؛ أُلغيت لعبة حاول تهرب.",
      );
    return msg.sendGroup(room.thread_id, `${player.display_name} غادر التسجيل.`);
  });
}

async function cancelActiveGame(userId, threadId, isAdmin = false) {
  const room = await getActiveRoom(threadId);
  if (!room)
    return msg.sendGroup(threadId, "لا توجد لعبة حاول تهرب نشطة.");
  if (String(room.host_psid) !== String(userId) && !isAdmin)
    return msg.sendGroup(
      threadId,
      "⛔ مضيف اللعبة أو أدمن البوت فقط يستطيع إلغاء حاول تهرب.",
    );
  return withRoomLock(room.id, async () => {
    const currentRoom = await getRoom(room.id);
    if (!currentRoom || !["lobby", "playing"].includes(currentRoom.status))
      return msg.sendGroup(threadId, "لا توجد لعبة حاول تهرب نشطة.");
    return cancelRoom(
      currentRoom,
      await getState(room.id),
      "🚫 أُلغيت لعبة حاول تهرب.",
    );
  });
}

function helpText() {
  return [
    "حاول تهرب: لعبة جماعية من 4 إلى 5 لاعبين.",
    "للانضمام تفاعل مع رسالة التسجيل؛ منشئ اللعبة لا يُسجل تلقائياً. يختار البوت قاضياً عشوائياً.",
    "يرسل القاضي سؤالاً للبوت في الخاص. يجيب المتسابقون في الخاص بأسوأ إجابة تخطر ببالهم.",
    "يخلط البوت الإجابات ويوزعها؛ يبرر كل متسابق الإجابة التي وصلته في المجموعة خلال 30 ثانية.",
    "بعد انتهاء الجميع، يختار القاضي من يخرج بكتابة /استبعاد تهرب <رقم أو اسم>. تستمر الجولات حتى يبقى فائز واحد.",
    "الأوامر: /قواعد حاول تهرب، /خروج تهرب، /إلغاء تهرب، /حالة تهرب.",
  ].join("\n");
}

async function handleMessage(context) {
  const parsed = commandParts(context.text);
  const fullName = parsed.clean.toLowerCase();
  if (START_ALIASES.has(fullName) || START_ALIASES.has(parsed.name)) {
    if (!context.isGroup)
      return msg.sendPrivate(context.userId, "ابدأ حاول تهرب داخل المجموعة.");
    return createRoom(context.userId, context.threadId);
  }
  if (!context.isGroup) return handlePrivate(context);
  return handleGroup(context, parsed);
}

async function handleTimeout(roomId) {
  return withRoomLock(roomId, async () => {
    const room = await getRoom(roomId);
    if (!room || room.status !== "playing") return;
    const state = await getState(roomId);
    if (!state.deadlineAt || new Date(state.deadlineAt).getTime() > Date.now())
      return;
    const players = await getPlayers(roomId);

    if (state.stage === "awaiting_question")
      return cancelRoom(
        room,
        state,
        "⌛ لم يرسل القاضي سؤالاً في الوقت المحدد؛ أُلغيت لعبة حاول تهرب.",
      );
    if (state.stage === "collecting_answers")
      return startPresentations(room, state, players, true);
    if (state.stage === "performing") {
      return advancePerformer(room, state, players, null, true);
    }
    if (state.stage === "awaiting_judge")
      return cancelRoom(
        room,
        state,
        "⌛ لم يختر القاضي من سيخرج في الوقت المحدد؛ أُلغيت اللعبة.",
      );
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
      "SELECT room_id FROM try_escape_state WHERE deadline_at IS NOT NULL AND deadline_at<=NOW()",
    );
    for (const state of due) await handleTimeout(state.room_id);
  } catch (error) {
    console.error("[try-escape] ticker failed:", error.message);
  } finally {
    ticking = false;
  }
}

function startTicker() {
  if (ticker) return;
  ticker = setInterval(tick, 1000);
  ticker.unref?.();
}

module.exports = {
  handleMessage,
  handleReaction,
  cancelActiveGame,
  startTicker,
  assertSchema,
  _internal: {
    assignAnswers,
    parseEliminationTarget,
    selectJudge,
    startGame,
    tick,
  },
};
