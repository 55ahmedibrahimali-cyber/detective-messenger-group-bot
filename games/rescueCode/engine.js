const fs = require("node:fs/promises");
const path = require("node:path");
const { randomInt } = require("node:crypto");
const db = require("../../database");
const ui = require("../../services/interaction");
const msg = require("../../services/messenger");
const adminAuth = require("../../services/adminAuth");
const leaderboard = require("../../services/leaderboard");
const CFG = require("./config");
const PUZZLES = require("./puzzles");

const GAME_ID = "rescue-code";
const STARTS = new Set([
  "شفرة الإنقاذ",
  "شفرة_الإنقاذ",
  "شفرةالإنقاذ",
  "شفرة",
]);
const COMMANDS = new Map([
  ["قواعدالإنقاذ", "help"],
  ["حالةالإنقاذ", "status"],
  ["معلومةالإنقاذ", "clue"],
  ["خروجالإنقاذ", "leave"],
  ["إلغاءالإنقاذ", "cancel"],
  ["الغاءالإنقاذ", "cancel"],
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

function normalizeDigits(value) {
  return String(value || "")
    .replace(/[٠-٩]/g, (digit) => String("٠١٢٣٤٥٦٧٨٩".indexOf(digit)))
    .replace(/[۰-۹]/g, (digit) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(digit)));
}

function shuffle(items) {
  const result = [...items];
  for (let index = result.length - 1; index > 0; index--) {
    const swap = randomInt(index + 1);
    [result[index], result[swap]] = [result[swap], result[index]];
  }
  return result;
}

function withRoomLock(roomId, operation) {
  const key = String(roomId);
  const previous = roomLocks.get(key) || Promise.resolve();
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const current = previous.then(() => gate);
  roomLocks.set(key, current);
  return previous
    .catch(() => {})
    .then(operation)
    .finally(() => {
      release();
      if (roomLocks.get(key) === current) roomLocks.delete(key);
    });
}

function setDeadline(state, seconds) {
  state.deadlineAt = new Date(Date.now() + seconds * 1000).toISOString();
}

function clearDeadline(state) {
  state.deadlineAt = null;
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
const getActiveRoomForPlayer = (userId) =>
  db.one(
    `SELECT gr.* FROM game_rooms gr
     JOIN room_players rp ON rp.room_id=gr.id
     WHERE gr.game_id=? AND gr.status IN ('lobby','playing') AND rp.psid=?
     ORDER BY gr.id DESC LIMIT 1`,
    [GAME_ID, String(userId)],
  );
const getPlayers = (roomId) =>
  db.query(
    "SELECT id, psid, display_name FROM room_players WHERE room_id=? ORDER BY id",
    [roomId],
  );
const getPlayer = (roomId, userId) =>
  db.one(
    "SELECT id, psid, display_name FROM room_players WHERE room_id=? AND psid=?",
    [roomId, String(userId)],
  );

async function getState(roomId) {
  const row = await db.one(
    "SELECT state_json FROM rescue_code_state WHERE room_id=?",
    [roomId],
  );
  if (!row) throw new Error(`Missing rescue code state for room ${roomId}.`);
  return JSON.parse(row.state_json);
}

async function persistState(state) {
  const status =
    state.stage === "lobby"
      ? "lobby"
      : state.stage === "cancelled"
        ? "cancelled"
        : state.stage === "finished"
          ? "finished"
          : "playing";
  const phase =
    state.stage === "lobby"
      ? "lobby"
      : state.stage === "playing"
        ? "discussion"
        : "finished";
  const seconds = state.deadlineAt
    ? Math.max(
        0,
        Math.ceil((new Date(state.deadlineAt).getTime() - Date.now()) / 1000),
      )
    : null;

  await db.withTransaction(async (query) => {
    if (seconds === null) {
      await query(
        "UPDATE rescue_code_state SET state_json=?, deadline_at=NULL WHERE room_id=?",
        [JSON.stringify(state), state.roomId],
      );
      await query(
        "UPDATE game_rooms SET status=?, phase=?, current_round=?, total_rounds=?, phase_ends_at=NULL WHERE id=? AND game_id=?",
        [status, phase, state.round || 0, CFG.ROUND_COUNT, state.roomId, GAME_ID],
      );
      return;
    }

    await query(
      "UPDATE rescue_code_state SET state_json=?, deadline_at=DATE_ADD(NOW(), INTERVAL ? SECOND) WHERE room_id=?",
      [JSON.stringify(state), seconds, state.roomId],
    );
    await query(
      "UPDATE game_rooms SET status=?, phase=?, current_round=?, total_rounds=?, phase_ends_at=DATE_ADD(NOW(), INTERVAL ? SECOND) WHERE id=? AND game_id=?",
      [
        status,
        phase,
        state.round || 0,
        CFG.ROUND_COUNT,
        seconds,
        state.roomId,
        GAME_ID,
      ],
    );
  });
}

function assignClues(players, puzzle) {
  const recipients = shuffle(players);
  const coreClues = shuffle(puzzle.clues.slice(0, 4));
  const supportClues = shuffle(puzzle.clues.slice(4));
  const clues = {};
  for (let index = 0; index < 4; index++)
    clues[String(recipients[index].psid)] = coreClues[index];
  for (let index = 4; index < players.length; index++)
    clues[String(recipients[index].psid)] = supportClues[index - 4];
  return clues;
}

function clueMessage(state, player) {
  const clue = state.cluesByPlayer[String(player.psid)];
  return [
    `شفرة الإنقاذ — الجولة ${state.round}/${CFG.ROUND_COUNT}.`,
    `معلومتك السرية: ${clue.text}`,
    "شارك المعلومة مع فريقك في المجموعة، ثم حاولوا الرمز معاً.",
    "لمعرفة المعلومة مجدداً أرسل للبوت في الخاص: /معلومة الإنقاذ.",
    "لإرسال محاولة في المجموعة: رمز <أربعة أرقام مختلفة من 1 إلى 9>.",
  ].join("\n");
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
      `⚠️ توجد لعبة نشطة بالفعل (${existing.game_id}). أنهِها قبل بدء شفرة الإنقاذ.`,
    );

  const state = {
    roomId: null,
    stage: "lobby",
    round: 0,
    puzzles: [],
    cluesByPlayer: {},
    guesses: [],
    solvedCodes: [],
    deadlineAt: null,
  };
  let created;
  try {
    created = await db.withTransaction(async (query) => {
      const room = await query(
        "INSERT INTO game_rooms (game_id, thread_id, host_psid, status, phase, total_rounds) VALUES (?,?,?,'lobby','lobby',?)",
        [GAME_ID, threadId, String(userId), CFG.ROUND_COUNT],
      );
      state.roomId = room.insertId;
      await query(
        "INSERT INTO rescue_code_state (room_id, state_json) VALUES (?,?)",
        [room.insertId, JSON.stringify(state)],
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
      `شفرة الإنقاذ | التسجيل مفتوح (${CFG.MIN_PLAYERS}–${CFG.MAX_PLAYERS} لاعبين، ينتهي بعد ${CFG.LOBBY_SECONDS} ثانية)`,
      "لعبة تعاون: يحصل كل لاعب على دليل سري مختلف، وتتشاركون الأدلة في المجموعة لكسر ثلاثة أقفال.",
      "تفاعلوا مع هذه الرسالة للانضمام؛ المضيف لا يُسجل تلقائياً. راسلوا البوت في الخاص أولاً لاستلام الدليل.",
    ].join("\n"),
  );
  if (!messageId) {
    state.stage = "cancelled";
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
      return msg.sendGroup(room.thread_id, "⛔ اكتمل عدد لاعبي شفرة الإنقاذ.");

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

async function deliverClues(room, state, players) {
  const failures = [];
  for (const player of players) {
    try {
      const sent = await msg.sendPrivate(
        String(player.psid),
        clueMessage(state, player),
      );
      if (sent !== true) {
        failures.push(player.display_name);
      }
    } catch (error) {
      console.error(
        `[${GAME_ID}] clue delivery failed for room ${room.id}, player ${player.psid}:`,
        error.message,
      );
      failures.push(player.display_name);
    }
  }
  if (!failures.length) return true;
  state.stage = "cancelled";
  clearDeadline(state);
  await persistState(state);
  await msg.sendGroup(
    room.thread_id,
    `تعذّر إرسال الدليل السري إلى ${failures.join("، ")}؛ أُلغيت شفرة الإنقاذ.`,
  );
  return false;
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
        `انتهى التسجيل دون ${CFG.MIN_PLAYERS} لاعبين؛ أُلغيت شفرة الإنقاذ.`,
      );
    }

    const state = await getState(room.id);
    state.stage = "playing";
    state.round = 1;
    state.puzzles = shuffle(PUZZLES).slice(0, CFG.ROUND_COUNT);
    state.cluesByPlayer = assignClues(players, state.puzzles[0]);
    state.guesses = [];
    state.solvedCodes = [];
    setDeadline(state, CFG.ROUND_SECONDS);
    await persistState(state);
    if (!(await deliverClues(room, state, players))) return;
    return msg.sendGroup(
      room.thread_id,
      [
        `🧩 بدأت شفرة الإنقاذ! الجولة 1/${CFG.ROUND_COUNT}.`,
        `الفريق: ${players.map((player, index) => `${index + 1}. ${player.display_name}`).join(" | ")}`,
        "الرمز أربعة أرقام مختلفة من 1 إلى 9؛ في كل زوج متجاور الرقم الأيسر أكبر من الأيمن.",
        `أمامكم ${CFG.ROUND_SECONDS} ثانية و${CFG.MAX_ATTEMPTS} محاولات. شاركوا أدلتكم، ثم أرسلوا: رمز <أربعة أرقام>.`,
      ].join("\n"),
    );
  });
}

function normalizeCode(value) {
  return normalizeDigits(value).replace(/\s+/g, "");
}

function parseGuess(text) {
  const guess = normalizeCode(text);
  if (!/^[1-9]{4}$/.test(guess) || new Set(guess).size !== 4)
    return null;
  return guess;
}

function feedback(code, guess) {
  let exact = 0;
  let misplaced = 0;
  for (let index = 0; index < code.length; index++) {
    if (code[index] === guess[index]) exact++;
    else if (code.includes(guess[index])) misplaced++;
  }
  return { exact, misplaced };
}

function clueMatches(code, clue) {
  const digits = code.split("").map(Number);
  if (clue.type === "sum") {
    const pair = clue.pair === "first" ? digits.slice(0, 2) : digits.slice(2, 4);
    return pair[0] + pair[1] === clue.value;
  }
  if (clue.type === "product") {
    const pair = clue.pair === "first" ? digits.slice(0, 2) : digits.slice(2, 4);
    return pair[0] * pair[1] === clue.value;
  }
  if (clue.type === "parity")
    return (digits[clue.position] % 2 === 0 ? "even" : "odd") === clue.value;
  return false;
}

function validCode(code) {
  const digits = code.split("").map(Number);
  return (
    /^[1-9]{4}$/.test(code) &&
    new Set(digits).size === 4 &&
    digits[0] > digits[1] &&
    digits[2] > digits[3]
  );
}

function findSolutions(clues) {
  const solutions = [];
  for (let first = 1; first <= 9; first++) {
    for (let second = 1; second < first; second++) {
      for (let third = 1; third <= 9; third++) {
        for (let fourth = 1; fourth < third; fourth++) {
          const code = `${first}${second}${third}${fourth}`;
          if (
            new Set(code).size === 4 &&
            clues.every((clue) => clueMatches(code, clue))
          )
            solutions.push(code);
        }
      }
    }
  }
  return solutions;
}

function statusText(state, players) {
  if (state.stage === "lobby")
    return `شفرة الإنقاذ — التسجيل (${players.length}/${CFG.MAX_PLAYERS})، والحد الأدنى ${CFG.MIN_PLAYERS} لاعبين.`;
  const remaining = state.deadlineAt
    ? Math.max(0, Math.ceil((new Date(state.deadlineAt).getTime() - Date.now()) / 1000))
    : 0;
  return `شفرة الإنقاذ — الجولة ${state.round}/${CFG.ROUND_COUNT}، المحاولات ${state.guesses.length}/${CFG.MAX_ATTEMPTS}، الوقت المتبقي ${remaining} ثانية.`;
}

async function finishFailure(room, state, reason) {
  const answer = state.puzzles[state.round - 1].code;
  state.stage = "finished";
  state.result = "failed";
  clearDeadline(state);
  await persistState(state);
  return msg.sendGroup(
    room.thread_id,
    `انتهت شفرة الإنقاذ: ${reason} في الجولة ${state.round}. الرمز كان ${answer}. نجحتم في فتح ${state.solvedCodes.length} من ${CFG.ROUND_COUNT} أقفال؛ لا تُمنح نقطة هذه المرة.`,
  );
}

async function finishSuccess(room, state, players) {
  await leaderboard.recordPoints(
    GAME_ID,
    room.id,
    players.map((player) => ({
      psid: String(player.psid),
      display_name: player.display_name,
    })),
  );
  state.stage = "finished";
  state.result = "success";
  clearDeadline(state);
  await persistState(state);
  return msg.sendGroup(
    room.thread_id,
    `🏆 أنقذتم الفريق وفتحتم الأقفال الثلاثة! كل المشاركين حصلوا على نقطة. الرموز: ${state.puzzles.map((puzzle) => puzzle.code).join("، ")}.`,
  );
}

async function advanceRound(room, state, players) {
  state.solvedCodes.push(state.puzzles[state.round - 1].code);
  if (state.round >= CFG.ROUND_COUNT)
    return finishSuccess(room, state, players);

  state.round += 1;
  state.guesses = [];
  state.cluesByPlayer = assignClues(
    players,
    state.puzzles[state.round - 1],
  );
  setDeadline(state, CFG.ROUND_SECONDS);
  await persistState(state);
  if (!(await deliverClues(room, state, players))) return;
  return msg.sendGroup(
    room.thread_id,
    `🔓 فُتح القفل ${state.round - 1}. بدأت الجولة ${state.round}/${CFG.ROUND_COUNT}؛ أمامكم ${CFG.ROUND_SECONDS} ثانية و${CFG.MAX_ATTEMPTS} محاولات.`,
  );
}

async function handleGuess(roomId, threadId, userId, text, messageId = null) {
  const guess = parseGuess(text);
  if (!guess)
    return msg.sendGroup(
      threadId,
      "أرسل أربعة أرقام مختلفة من 1 إلى 9، مثلاً: رمز ٨٥٣٢.",
    );

  return withRoomLock(roomId, async () => {
    const room = await getRoom(roomId);
    if (!room || room.status !== "playing") return;
    const state = await getState(roomId);
    if (state.stage !== "playing") return;
    if (state.deadlineAt && new Date(state.deadlineAt).getTime() <= Date.now()) {
      return finishFailure(room, state, "انتهى الوقت");
    }
    const players = await getPlayers(roomId);
    const player = players.find((entry) => String(entry.psid) === String(userId));
    if (!player) return;

    const answer = state.puzzles[state.round - 1].code;
    if (guess === answer) {
      if (messageId && typeof msg.reactToMessage === "function") {
        msg.reactToMessage(threadId, messageId, "✅").catch(() => {});
      }
      state.guesses.push({ psid: String(userId), guess, exact: 4, misplaced: 0 });
      return advanceRound(room, state, players);
    }

    const result = feedback(answer, guess);
    state.guesses.push({
      psid: String(userId),
      guess,
      exact: result.exact,
      misplaced: result.misplaced,
    });
    if (state.guesses.length >= CFG.MAX_ATTEMPTS)
      return finishFailure(room, state, "نفدت المحاولات");
    await persistState(state);
    return msg.sendGroup(
      room.thread_id,
      `المحاولة ${state.guesses.length}/${CFG.MAX_ATTEMPTS} — ${player.display_name}: ${result.exact} في مكانها و${result.misplaced} في مكان آخر.`,
    );
  });
}

async function handleTimeout(roomId) {
  return withRoomLock(roomId, async () => {
    const room = await getRoom(roomId);
    if (!room || room.status !== "playing") return;
    const state = await getState(roomId);
    if (
      state.stage !== "playing" ||
      !state.deadlineAt ||
      new Date(state.deadlineAt).getTime() > Date.now()
    )
      return;
    return finishFailure(room, state, "انتهى الوقت");
  });
}

async function leaveLobby(room, userId) {
  return withRoomLock(room.id, async () => {
    const currentRoom = await getRoom(room.id);
    if (!currentRoom || currentRoom.status !== "lobby")
      return msg.sendGroup(room.thread_id, "انتهى التسجيل لشفرة الإنقاذ.");
    const player = await getPlayer(room.id, userId);
    if (!player)
      return msg.sendGroup(room.thread_id, "أنت غير مسجل في شفرة الإنقاذ.");
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
        "غادر الجميع التسجيل؛ أُلغيت شفرة الإنقاذ.",
      );
    }
    return msg.sendGroup(room.thread_id, `${player.display_name} غادر التسجيل.`);
  });
}

async function cancelActiveGame(userId, threadId, isAdmin = false) {
  const room = await getActiveRoom(threadId);
  if (!room)
    return msg.sendGroup(threadId, "لا توجد شفرة إنقاذ نشطة.");
  if (String(room.host_psid) !== String(userId) && !isAdmin)
    return msg.sendGroup(
      threadId,
      "⛔ مضيف اللعبة أو أدمن البوت فقط يستطيع إلغاء شفرة الإنقاذ.",
    );
  return withRoomLock(room.id, async () => {
    const currentRoom = await getRoom(room.id);
    if (!currentRoom || !["lobby", "playing"].includes(currentRoom.status))
      return msg.sendGroup(threadId, "لا توجد شفرة إنقاذ نشطة.");
    const state = await getState(room.id);
    state.stage = "cancelled";
    clearDeadline(state);
    await persistState(state);
    return msg.sendGroup(threadId, "🚫 أُلغيت شفرة الإنقاذ.");
  });
}

function helpText() {
  return [
    "شفرة الإنقاذ: لعبة تعاونية من 4 إلى 6 لاعبين وثلاثة أقفال.",
    "سجّلوا بالتفاعل مع رسالة التسجيل؛ يحصل كل لاعب على دليل مختلف في الخاص.",
    "الرمز من أربعة أرقام مختلفة بين 1 و9، والرقم الأيسر أكبر في كل زوج متجاور. شاركوا الأدلة في المجموعة.",
    `لكل قفل ${CFG.ROUND_SECONDS} ثانية و${CFG.MAX_ATTEMPTS} محاولات. أرسلوا التخمين في المجموعة: رمز <أربعة أرقام>. بعد كل تخمين خاطئ يكشف البوت عدد الأرقام الصحيحة ومواقعها.`,
    "الأوامر: /قواعد الإنقاذ، /حالة الإنقاذ، /معلومة الإنقاذ، /خروج الإنقاذ، /إلغاء الإنقاذ.",
  ].join("\n");
}

async function handleGroup(context, parsed) {
  if (parsed.command === "help")
    return msg.sendGroup(context.threadId, helpText());
  const room = await getActiveRoom(context.threadId);
  if (!room) {
    if (["status", "clue", "leave", "cancel"].includes(parsed.command))
      return msg.sendGroup(context.threadId, "لا توجد شفرة إنقاذ نشطة.");
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
    return msg.sendGroup(context.threadId, statusText(state, players));
  if (parsed.command === "clue")
    return msg.sendGroup(
      context.threadId,
      "الأدلة سرية؛ أرسل /معلومة الإنقاذ للبوت في الخاص.",
    );
  if (parsed.name === "رمز")
    return handleGuess(room.id, context.threadId, context.userId, parsed.arg, context.messageId);
  if (/^[0-9٠-٩۰-۹]{4}$/.test(parsed.clean))
    return handleGuess(room.id, context.threadId, context.userId, parsed.clean, context.messageId);
}

async function handlePrivate(context, parsed) {
  if (parsed.command === "help")
    return msg.sendPrivate(context.userId, helpText());
  const room = await getActiveRoomForPlayer(context.userId);
  if (!room)
    return msg.sendPrivate(context.userId, "لا توجد لك مشاركة نشطة في شفرة الإنقاذ.");
  if (parsed.command === "cancel" || parsed.command === "leave")
    return msg.sendPrivate(
      context.userId,
      "أوامر المغادرة والإلغاء تُستخدم في المجموعة التي بدأت فيها اللعبة.",
    );
  const state = await getState(room.id);
  const players = await getPlayers(room.id);
  const player = players.find(
    (entry) => String(entry.psid) === String(context.userId),
  );
  if (parsed.command === "status")
    return msg.sendPrivate(context.userId, statusText(state, players));
  if (parsed.command === "clue") {
    if (state.stage !== "playing")
      return msg.sendPrivate(context.userId, "لم يبدأ توزيع الأدلة بعد.");
    return msg.sendPrivate(context.userId, clueMessage(state, player));
  }
  if (parsed.name === "رمز")
    return msg.sendPrivate(
      context.userId,
      "أرسل الرمز في المجموعة ليشارك الفريق نتيجة المحاولة.",
    );
  return msg.sendPrivate(
    context.userId,
    "استخدم /معلومة الإنقاذ لإعادة دليلك، وأرسل التخمين في المجموعة بصيغة: رمز <أربعة أرقام>.",
  );
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
      "SELECT room_id FROM rescue_code_state WHERE deadline_at IS NOT NULL AND deadline_at<=NOW()",
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
  if (STARTS.has(parsed.clean.toLowerCase()) || STARTS.has(parsed.name)) {
    if (!context.isGroup)
      return msg.sendPrivate(context.userId, "ابدأ شفرة الإنقاذ داخل المجموعة.");
    return createRoom(context.userId, context.threadId);
  }
  if (!context.isGroup) return handlePrivate(context, parsed);
  return handleGroup(context, parsed);
}

module.exports = {
  handleMessage,
  handleReaction,
  cancelActiveGame,
  startTicker,
  assertSchema,
  _internal: {
    assignClues,
    clueMatches,
    feedback,
    findSolutions,
    normalizeDigits,
    parseGuess,
    validCode,
    deliverClues,
  },
};
