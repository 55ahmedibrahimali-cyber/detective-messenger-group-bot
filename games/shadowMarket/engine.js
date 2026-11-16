const fs = require("node:fs/promises");
const path = require("node:path");
const { randomInt } = require("node:crypto");
const db = require("../../database");
const ui = require("../../services/interaction");
const msg = require("../../services/messenger");
const adminAuth = require("../../services/adminAuth");
const leaderboard = require("../../services/leaderboard");
const CFG = require("./config");
const ITEMS = require("./items");

const GAME_ID = "shadow-market";
const STARTS = new Set(["سوق الظلال", "سوق_الظلال", "سوقالظلال", "ظلال"]);
const COMMANDS = new Map([
  ["قواعدالظلال", "help"],
  ["حالةالظلال", "status"],
  ["حقيبةالظلال", "inventory"],
  ["خروجالظلال", "leave"],
  ["إلغاءالظلال", "cancel"],
  ["الغاءالظلال", "cancel"],
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
  return String(value || "").replace(/[٠-٩]/g, (digit) =>
    String("٠١٢٣٤٥٦٧٨٩".indexOf(digit)),
  );
}

function shuffle(items) {
  const result = [...items];
  for (let index = result.length - 1; index > 0; index--) {
    const swap = randomInt(index + 1);
    [result[index], result[swap]] = [result[swap], result[index]];
  }
  return result;
}

function setDeadline(state, seconds) {
  state.deadlineAt = new Date(Date.now() + seconds * 1000).toISOString();
}

function clearDeadline(state) {
  state.deadlineAt = null;
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
    "SELECT state_json FROM shadow_market_state WHERE room_id=?",
    [roomId],
  );
  if (!row)
    throw new Error(`Missing shadow market state for room ${roomId}.`);
  return JSON.parse(row.state_json);
}

function roomStatus(stage) {
  if (stage === "lobby") return "lobby";
  if (stage === "cancelled") return "cancelled";
  if (stage === "finished") return "finished";
  return "playing";
}

async function persistState(state) {
  const status = roomStatus(state.stage);
  const phase = state.stage === "lobby" ? "lobby" : state.stage === "market" ? "discussion" : "finished";
  const seconds = state.deadlineAt
    ? Math.max(
        0,
        Math.ceil((new Date(state.deadlineAt).getTime() - Date.now()) / 1000),
      )
    : null;

  await db.withTransaction(async (query) => {
    if (seconds === null) {
      await query(
        "UPDATE shadow_market_state SET state_json=?, deadline_at=NULL WHERE room_id=?",
        [JSON.stringify(state), state.roomId],
      );
      await query(
        "UPDATE game_rooms SET status=?, phase=?, current_round=?, total_rounds=?, phase_ends_at=NULL WHERE id=? AND game_id=?",
        [status, phase, state.round || 0, CFG.ROUND_COUNT, state.roomId, GAME_ID],
      );
      return;
    }

    await query(
      "UPDATE shadow_market_state SET state_json=?, deadline_at=DATE_ADD(NOW(), INTERVAL ? SECOND) WHERE room_id=?",
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

function chooseGoal() {
  const goals = [
    { type: "collector", category: "مجوهرات" },
    { type: "collector", category: "مخطوطات" },
    { type: "collector", category: "تحف" },
    { type: "investor" },
    { type: "negotiator" },
  ];
  return goals[randomInt(goals.length)];
}

function dealRound(state, players) {
  const smugglerId = Object.keys(state.roles).find(
    (userId) => state.roles[userId] === "smuggler",
  );
  for (const player of players) {
    const item = ITEMS[randomInt(ITEMS.length)];
    const isFake = String(player.psid) === smugglerId;
    state.cards.push({
      id: `${state.round}:${player.psid}`,
      round: state.round,
      initialOwnerId: String(player.psid),
      ownerId: String(player.psid),
      name: item.name,
      category: item.category,
      value: isFake ? 0 : item.value,
      authentic: !isFake,
      traded: false,
      description: null,
      knownBy: [String(player.psid)],
    });
  }
}

function assignSecretRoles(state, players) {
  const order = shuffle(players);
  state.roles = {};
  state.goals = {};
  state.coins = {};
  state.tradeCounts = {};
  state.fakeSales = 0;
  state.inspectedFakes = 0;
  state.inspectionsUsed = {};
  state.roles[String(order[0].psid)] = "smuggler";
  state.goals[String(order[0].psid)] = { type: "smuggler" };
  state.roles[String(order[1].psid)] = "inspector";
  state.goals[String(order[1].psid)] = { type: "inspector" };
  for (const player of players) {
    const userId = String(player.psid);
    state.coins[userId] = CFG.STARTING_COINS;
    state.tradeCounts[userId] = 0;
    if (!state.roles[userId]) {
      state.roles[userId] = "merchant";
      state.goals[userId] = chooseGoal();
    }
  }
}

function playerByNumber(players, number) {
  if (!Number.isSafeInteger(number) || number < 1 || number > players.length)
    return null;
  return players[number - 1];
}

function roleDescription(role, goal) {
  if (role === "smuggler")
    return "أنت المهرّب. بطاقتك مزيفة؛ حاول بيعها بسعر جيد. تحصل على مكافأة عن كل بطاقة مزيفة تبيعها لغيرك.";
  if (role === "inspector")
    return "أنت المفتش. مرة واحدة في كل جولة، اكتب في الخاص: فحص <رقم اللاعب>. ستعرف حقيقة بطاقته، ولك مكافأة عن كل بطاقة مزيفة تكشفها.";
  if (goal.type === "collector")
    return `عقدك السري: اجمع بطاقتين أصليتين على الأقل من فئة «${goal.category}» لتحصل على مكافأة.`;
  if (goal.type === "investor")
    return "عقدك السري: احتفظ بـ14 قطعة نقدية على الأقل عند نهاية اللعبة لتحصل على مكافأة.";
  return "عقدك السري: أكمل صفقتين على الأقل خلال اللعبة لتحصل على مكافأة.";
}

function cardForRound(state, ownerId, round = state.round) {
  return state.cards.find(
    (card) =>
      card.round === round && card.initialOwnerId === String(ownerId),
  ) || null;
}

function cardDetails(card) {
  return [
    `البطاقة: ${card.name} (${card.category})`,
    `الحقيقة: ${card.authentic ? "أصلية" : "مزيفة"}`,
    `القيمة الحقيقية: ${card.value} عملات`,
  ].join("\n");
}

function privateStartMessage(state, player) {
  const userId = String(player.psid);
  const card = cardForRound(state, userId);
  return [
    `سوق الظلال — دورك السري: ${state.roles[userId] === "smuggler" ? "المهرّب" : state.roles[userId] === "inspector" ? "المفتش" : "تاجر"}.`,
    roleDescription(state.roles[userId], state.goals[userId]),
    cardDetails(card),
    `رصيدك: ${state.coins[userId]} عملات.`,
    `لفتح صفقة، أرسل: عرض <رقم اللاعب> <السعر> | <وصفك للقطعة>`,
  ].join("\n\n");
}

function privateRoundMessage(state, player) {
  const userId = String(player.psid);
  const card = cardForRound(state, userId);
  return [
    `بدأت الجولة ${state.round}/${CFG.ROUND_COUNT} في سوق الظلال.`,
    roleDescription(state.roles[userId], state.goals[userId]),
    cardDetails(card),
    `رصيدك: ${state.coins[userId]} عملات.`,
    `اعرضها على لاعب آخر: عرض <رقم اللاعب> <السعر> | <وصفك للقطعة>`,
  ].join("\n\n");
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
      `⚠️ توجد لعبة نشطة بالفعل (${existing.game_id}). أنهِها قبل بدء سوق الظلال.`,
    );

  const state = {
    roomId: null,
    stage: "lobby",
    round: 0,
    roles: {},
    goals: {},
    coins: {},
    cards: [],
    offers: [],
    nextOfferId: 1,
    roundTrades: [],
    tradeCounts: {},
    fakeSales: 0,
    inspectedFakes: 0,
    inspectionsUsed: {},
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
        "INSERT INTO shadow_market_state (room_id, state_json) VALUES (?,?)",
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
      `سوق الظلال | التسجيل مفتوح (${CFG.MIN_PLAYERS}–${CFG.MAX_PLAYERS} لاعبين، ينتهي بعد ${CFG.LOBBY_SECONDS} ثانية)`,
      "تفاوضوا على القطع في المجموعة، وأرسلوا العروض وقبولها للبوت في الخاص. بينكم مهرّب ومفتش وعقود سرية.",
      "تفاعلوا مع هذه الرسالة للانضمام؛ المضيف لا يُسجل تلقائياً. للمغادرة: /خروج الظلال",
      "راسلوا البوت في الخاص أولاً لاستلام رسائل اللعبة.",
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
      return msg.sendGroup(room.thread_id, "⛔ اكتمل عدد لاعبي سوق الظلال.");

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

async function deliverPrivateMessages(room, state, players, initial = false) {
  const failures = [];
  for (const player of players) {
    try {
      await msg.sendPrivate(
        String(player.psid),
        initial ? privateStartMessage(state, player) : privateRoundMessage(state, player),
      );
    } catch (error) {
      console.error(
        `[${GAME_ID}] private delivery failed for room ${room.id}, player ${player.psid}:`,
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
    `تعذّر إيصال الدور أو البطاقة السرية إلى ${failures.join("، ")}؛ أُلغي سوق الظلال لحماية سرية الأدوار.`,
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
        `انتهى التسجيل دون ${CFG.MIN_PLAYERS} لاعبين؛ أُلغي سوق الظلال.`,
      );
    }

    const state = await getState(room.id);
    state.stage = "market";
    state.round = 1;
    assignSecretRoles(state, players);
    dealRound(state, players);
    setDeadline(state, CFG.ROUND_SECONDS);
    await persistState(state);
    if (!(await deliverPrivateMessages(room, state, players, true))) return;
    return msg.sendGroup(
      room.thread_id,
      [
        `🕶️ بدأ سوق الظلال! الجولة 1/${CFG.ROUND_COUNT}.`,
        `اللاعبون: ${players.map((player, index) => `${index + 1}. ${player.display_name}`).join(" | ")}`,
        `معكم ${CFG.ROUND_SECONDS} ثانية للتفاوض. العروض والقبول في الخاص، ولكل لاعب ${CFG.STARTING_COINS} عملات.`,
        "اكتبوا «حقيبة الظلال» في الخاص لرؤية بطاقاتكم؛ لا تكشفوا بطاقاتكم السرية.",
      ].join("\n"),
    );
  });
}

function findOffer(state, offerId) {
  return state.offers.find(
    (offer) => offer.id === offerId && offer.round === state.round,
  ) || null;
}

function parseOffer(text) {
  const separator = text.indexOf("|");
  const commandText = separator >= 0 ? text.slice(0, separator) : text;
  const description =
    separator >= 0
      ? text
          .slice(separator + 1)
          .replace(/[\r\n]+/g, " ")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 120)
      : "";
  const parts = normalizeDigits(commandText).trim().split(/\s+/u);
  return {
    targetNumber: Number(parts[1]),
    price: Number(parts[2]),
    description: description || "قطعة أثرية مختومة",
  };
}

function statusText(state, players) {
  if (state.stage === "lobby")
    return `سوق الظلال — التسجيل (${players.length}/${CFG.MAX_PLAYERS})، والحد الأدنى ${CFG.MIN_PLAYERS} لاعبين.`;
  const remaining = state.deadlineAt
    ? Math.max(0, Math.ceil((new Date(state.deadlineAt).getTime() - Date.now()) / 1000))
    : 0;
  return [
    `سوق الظلال — الجولة ${state.round}/${CFG.ROUND_COUNT} (${remaining}ث متبقية).`,
    ...players.map(
      (player, index) =>
        `${index + 1}. ${player.display_name}: ${state.coins[String(player.psid)] || 0} عملات`,
    ),
    `العروض المعلّقة: ${state.offers.length}.`,
  ].join("\n");
}

function inventoryText(state, player) {
  const userId = String(player.psid);
  const cards = state.cards.filter(
    (card) =>
      card.initialOwnerId === userId ||
      card.ownerId === userId ||
      card.knownBy.includes(userId),
  );
  const lines = cards.map((card) => {
    const knowsTruth =
      card.initialOwnerId === userId || card.knownBy.includes(userId);
    const relationship =
      card.ownerId === userId
        ? "بحوزتك"
        : card.initialOwnerId === userId
          ? "بعتها"
          : "بطاقة فحصتها";
    if (knowsTruth)
      return `• الجولة ${card.round}: ${relationship} — ${cardDetails(card).replace(/\n/g, "؛ ")}`;
    return `• الجولة ${card.round}: بحوزتك — وصف البائع «${card.description || "قطعة مختومة"}»، لم تُفحص بعد.`;
  });
  return [
    `حقيبتك | الرصيد: ${state.coins[userId] || 0} عملات.`,
    ...lines,
  ].join("\n");
}

function goalBonus(playerId, state, cards) {
  const goal = state.goals[playerId];
  if (goal.type === "smuggler") return state.fakeSales * 4;
  if (goal.type === "inspector") return state.inspectedFakes * 2;
  if (goal.type === "investor")
    return (Number(state.coins[playerId]) || 0) >= 14 ? 4 : 0;
  if (goal.type === "negotiator")
    return (Number(state.tradeCounts[playerId]) || 0) >= 2 ? 4 : 0;
  if (goal.type === "collector") {
    const count = cards.filter(
      (card) =>
        card.authentic &&
        card.category === goal.category &&
        card.ownerId === playerId,
    ).length;
    return count >= 2 ? 4 : 0;
  }
  return 0;
}

function calculateScores(players, state) {
  return players.map((player) => {
    const userId = String(player.psid);
    const ownedCards = state.cards.filter(
      (card) => card.ownerId === userId && card.authentic,
    );
    const itemValue = ownedCards.reduce((sum, card) => sum + card.value, 0);
    const bonus = goalBonus(userId, state, state.cards);
    return {
      player,
      coins: Number(state.coins[userId]) || 0,
      itemValue,
      bonus,
      score: (Number(state.coins[userId]) || 0) + itemValue + bonus,
    };
  });
}

function settleTrade(state, offer, buyerId) {
  const buyer = String(buyerId);
  const card = state.cards.find((entry) => entry.id === offer.cardId);
  const buyerCoins = Number(state.coins[buyer]);
  if (
    offer.targetId !== buyer ||
    !card ||
    card.ownerId !== offer.sellerId ||
    card.traded
  )
    return { error: "invalid-offer" };
  if (!Number.isSafeInteger(buyerCoins) || buyerCoins < offer.price)
    return { error: "insufficient-coins" };

  state.coins[buyer] = buyerCoins - offer.price;
  state.coins[offer.sellerId] =
    (Number(state.coins[offer.sellerId]) || 0) + offer.price;
  card.ownerId = buyer;
  card.traded = true;
  card.description = offer.description;
  state.roundTrades.push({
    sellerId: offer.sellerId,
    buyerId: buyer,
    price: offer.price,
    description: offer.description,
  });
  state.tradeCounts[offer.sellerId] =
    (Number(state.tradeCounts[offer.sellerId]) || 0) + 1;
  state.tradeCounts[buyer] = (Number(state.tradeCounts[buyer]) || 0) + 1;
  if (
    !card.authentic &&
    state.roles[offer.sellerId] === "smuggler" &&
    buyer !== offer.sellerId
  )
    state.fakeSales++;
  return { card };
}

function finalMessage(players, state, scores) {
  const maxScore = Math.max(...scores.map((entry) => entry.score));
  const winners = scores.filter((entry) => entry.score === maxScore);
  const roleNames = { smuggler: "المهرّب", inspector: "المفتش", merchant: "تاجر" };
  const roleLines = players.map((player) => {
    const userId = String(player.psid);
    return `• ${player.display_name}: ${roleNames[state.roles[userId]]}؛ ${roleDescription(state.roles[userId], state.goals[userId])}`;
  });
  const cardLines = state.cards.map((card) => {
    const owner = players.find((player) => String(player.psid) === card.ownerId);
    const name = owner ? owner.display_name : "لا أحد";
    return `• ج${card.round}: ${card.name} — ${card.authentic ? "أصلية" : "مزيفة"}، قيمتها ${card.value}؛ بحوزة ${name}`;
  });
  const scoreLines = scores.map(
    (entry) =>
      `• ${entry.player.display_name}: ${entry.coins} عملات + ${entry.itemValue} قيمة بطاقات + ${entry.bonus} مكافأة = ${entry.score}`,
  );
  return [
    `🏁 انتهى سوق الظلال! الفائز${winners.length > 1 ? "ون" : ""}: ${winners.map((entry) => entry.player.display_name).join("، ")} (+1 لكل منهم).`,
    `النتائج:\n${scoreLines.join("\n")}`,
    `كشف الأدوار والعقود:\n${roleLines.join("\n")}`,
    `حقيقة البطاقات:\n${cardLines.join("\n")}`,
  ].join("\n\n");
}

async function finishGame(room, state, players) {
  const scores = calculateScores(players, state);
  const maxScore = Math.max(...scores.map((entry) => entry.score));
  const winners = scores.filter((entry) => entry.score === maxScore);
  await leaderboard.recordPoints(
    GAME_ID,
    room.id,
    winners.map((entry) => ({
      psid: String(entry.player.psid),
      display_name: entry.player.display_name,
    })),
  );
  state.stage = "finished";
  clearDeadline(state);
  await persistState(state);
  return msg.sendGroup(room.thread_id, finalMessage(players, state, scores));
}

function roundTradeSummary(state, players) {
  if (!state.roundTrades.length) return "لم تتم صفقات في هذه الجولة.";
  return state.roundTrades
    .map((trade) => {
      const seller = players.find((player) => String(player.psid) === trade.sellerId);
      const buyer = players.find((player) => String(player.psid) === trade.buyerId);
      return `• ${seller?.display_name || "لاعب"} باع قطعة إلى ${buyer?.display_name || "لاعب"} مقابل ${trade.price} عملات.`;
    })
    .join("\n");
}

async function advanceRound(room, state, players) {
  state.offers = [];
  if (state.round >= CFG.ROUND_COUNT)
    return finishGame(room, state, players);

  const summary = roundTradeSummary(state, players);
  state.roundTrades = [];
  state.round += 1;
  state.inspectionsUsed = {};
  dealRound(state, players);
  setDeadline(state, CFG.ROUND_SECONDS);
  await persistState(state);
  if (!(await deliverPrivateMessages(room, state, players))) return;
  return msg.sendGroup(
    room.thread_id,
    `انتهت الجولة ${state.round - 1}. الصفقات:\n${summary}\n\nبدأت الجولة ${state.round}/${CFG.ROUND_COUNT}. أمامكم ${CFG.ROUND_SECONDS} ثانية للتفاوض.`,
  );
}

async function handleTimeout(roomId) {
  return withRoomLock(roomId, async () => {
    const room = await getRoom(roomId);
    if (!room || room.status !== "playing") return;
    const state = await getState(roomId);
    if (
      state.stage !== "market" ||
      !state.deadlineAt ||
      new Date(state.deadlineAt).getTime() > Date.now()
    )
      return;
    const players = await getPlayers(roomId);
    return advanceRound(room, state, players);
  });
}

async function makeOffer(room, state, players, seller, parsed) {
  const { targetNumber, price, description } = parseOffer(parsed.clean);
  const target = playerByNumber(players, targetNumber);
  if (!target || String(target.psid) === String(seller.psid))
    return msg.sendPrivate(
      seller.psid,
      "اختر رقم لاعب آخر من قائمة المجموعة: عرض <رقم اللاعب> <السعر> | <وصف القطعة>.",
    );
  if (
    !Number.isSafeInteger(price) ||
    price < 1 ||
    price > CFG.MAX_OFFER_PRICE
  )
    return msg.sendPrivate(
      seller.psid,
      `السعر يجب أن يكون رقماً صحيحاً من 1 إلى ${CFG.MAX_OFFER_PRICE}.`,
    );

  const card = cardForRound(state, seller.psid);
  if (!card || card.ownerId !== String(seller.psid) || card.traded)
    return msg.sendPrivate(
      seller.psid,
      "لا تملك بطاقة قابلة للعرض في هذه الجولة؛ كل لاعب يحصل على بطاقة واحدة في الجولة.",
    );
  if (state.offers.some((offer) => offer.cardId === card.id))
    return msg.sendPrivate(seller.psid, "لديك عرض معلّق لهذه البطاقة بالفعل.");

  const offer = {
    id: state.nextOfferId++,
    round: state.round,
    sellerId: String(seller.psid),
    targetId: String(target.psid),
    cardId: card.id,
    price,
    description,
  };
  state.offers.push(offer);
  await persistState(state);
  try {
    await msg.sendPrivate(
      target.psid,
      `عرض صفقة #${offer.id} من ${seller.display_name}:\n«${description}» مقابل ${price} عملات.\nللقبول: قبول ${offer.id}\nللرفض: رفض ${offer.id}`,
    );
  } catch (error) {
    state.offers = state.offers.filter((entry) => entry.id !== offer.id);
    await persistState(state);
    console.error(`[${GAME_ID}] offer delivery failed in room ${room.id}:`, error.message);
    throw error;
  }
  return msg.sendPrivate(
    seller.psid,
    `أُرسل عرضك #${offer.id} إلى ${target.display_name}. البطاقة محجوزة حتى يقبل العرض أو يرفضه أو تنتهي الجولة.`,
  );
}

async function acceptOffer(room, state, players, buyer, text) {
  const offerId = Number(normalizeDigits(text));
  if (!Number.isSafeInteger(offerId) || offerId < 1)
    return msg.sendPrivate(buyer.psid, "اكتب رقم العرض: قبول <رقم العرض>.");
  const offer = findOffer(state, offerId);
  if (!offer || offer.targetId !== String(buyer.psid))
    return msg.sendPrivate(buyer.psid, "هذا العرض غير موجود أو غير موجّه إليك.");
  const seller = players.find(
    (player) => String(player.psid) === offer.sellerId,
  );
  if (!seller)
    return msg.sendPrivate(buyer.psid, "تعذّر إتمام الصفقة؛ العرض أو الرصيد لم يعد صالحاً.");
  const buyerId = String(buyer.psid);
  const result = settleTrade(state, offer, buyerId);
  if (result.error === "insufficient-coins")
    return msg.sendPrivate(buyer.psid, "رصيدك لا يكفي لقبول هذا العرض.");
  if (result.error)
    return msg.sendPrivate(buyer.psid, "تعذّر إتمام الصفقة؛ العرض لم يعد صالحاً.");
  state.offers = state.offers.filter((entry) => entry.id !== offer.id);
  await persistState(state);
  return msg.sendGroup(
    room.thread_id,
    `🤝 تمت الصفقة #${offer.id}: ${seller.display_name} باع قطعة إلى ${buyer.display_name} مقابل ${offer.price} عملات.`,
  );
}

async function rejectOffer(state, players, buyer, text) {
  const offerId = Number(normalizeDigits(text));
  if (!Number.isSafeInteger(offerId) || offerId < 1)
    return msg.sendPrivate(buyer.psid, "اكتب رقم العرض: رفض <رقم العرض>.");
  const offer = findOffer(state, offerId);
  if (!offer || offer.targetId !== String(buyer.psid))
    return msg.sendPrivate(buyer.psid, "هذا العرض غير موجود أو غير موجّه إليك.");
  state.offers = state.offers.filter((entry) => entry.id !== offer.id);
  await persistState(state);
  const seller = players.find(
    (player) => String(player.psid) === offer.sellerId,
  );
  if (seller)
    await msg.sendPrivate(
      seller.psid,
      `رفض ${buyer.display_name} عرضك #${offer.id}.`,
    );
  return msg.sendPrivate(buyer.psid, `رفضت العرض #${offer.id}.`);
}

async function inspectCard(state, players, inspector, text) {
  if (state.roles[String(inspector.psid)] !== "inspector")
    return msg.sendPrivate(inspector.psid, "الفحص متاح للمفتش فقط.");
  const targetNumber = Number(normalizeDigits(text));
  const target = playerByNumber(players, targetNumber);
  if (!target || String(target.psid) === String(inspector.psid))
    return msg.sendPrivate(inspector.psid, "اختر رقم لاعب آخر من قائمة المجموعة.");
  if (state.inspectionsUsed[String(inspector.psid)])
    return msg.sendPrivate(inspector.psid, "استخدمت فحص هذه الجولة بالفعل.");

  const card = cardForRound(state, target.psid);
  if (!card)
    return msg.sendPrivate(inspector.psid, "لا توجد بطاقة حالية لهذا اللاعب.");
  state.inspectionsUsed[String(inspector.psid)] = true;
  if (!card.knownBy.includes(String(inspector.psid)))
    card.knownBy.push(String(inspector.psid));
  if (!card.authentic) state.inspectedFakes++;
  await persistState(state);
  return msg.sendPrivate(
    inspector.psid,
    `نتيجة الفحص السري لبطاقة ${target.display_name}:\n${cardDetails(card)}`,
  );
}

async function handlePrivate(context, parsed) {
  const room = await getActiveRoomForPlayer(context.userId);
  if (!room) {
    if (parsed.command === "help")
      return msg.sendPrivate(context.userId, helpText());
    return msg.sendPrivate(context.userId, "لا توجد لك مشاركة نشطة في سوق الظلال.");
  }
  if (parsed.command === "help")
    return msg.sendPrivate(context.userId, helpText());
  if (parsed.command === "cancel" || parsed.command === "leave")
    return msg.sendPrivate(
      context.userId,
      "أوامر المغادرة والإلغاء تُستخدم في المجموعة التي بدأت فيها اللعبة.",
    );

  return withRoomLock(room.id, async () => {
    const currentRoom = await getRoom(room.id);
    if (!currentRoom || currentRoom.status !== "playing")
      return msg.sendPrivate(context.userId, "انتهى سوق الظلال.");
    const state = await getState(room.id);
    const players = await getPlayers(room.id);
    const player = players.find(
      (entry) => String(entry.psid) === String(context.userId),
    );
    if (!player) return;
    if (parsed.command === "status")
      return msg.sendPrivate(context.userId, statusText(state, players));
    if (parsed.command === "inventory" && state.stage === "lobby")
      return msg.sendPrivate(context.userId, "ستظهر حقيبتك عند بدء السوق وتوزيع البطاقات.");
    if (parsed.command === "inventory")
      return msg.sendPrivate(context.userId, inventoryText(state, player));
    if (state.stage !== "market")
      return msg.sendPrivate(context.userId, "لا توجد جولة سوق نشطة.");
    if (
      state.deadlineAt &&
      new Date(state.deadlineAt).getTime() <= Date.now()
    ) {
      await advanceRound(currentRoom, state, players);
      return msg.sendPrivate(context.userId, "انتهى وقت الجولة؛ انتقلت اللعبة إلى المرحلة التالية.");
    }

    if (parsed.name === "عرض")
      return makeOffer(currentRoom, state, players, player, parsed);
    if (parsed.name === "قبول")
      return acceptOffer(currentRoom, state, players, player, parsed.arg);
    if (parsed.name === "رفض")
      return rejectOffer(state, players, player, parsed.arg);
    if (parsed.name === "فحص")
      return inspectCard(state, players, player, parsed.arg);
    return msg.sendPrivate(
      context.userId,
      "أوامر الخاص: عرض <رقم اللاعب> <السعر> | <الوصف>، قبول <رقم العرض>، رفض <رقم العرض>، فحص <رقم اللاعب> للمفتش، /حقيبة الظلال.",
    );
  });
}

async function leaveLobby(room, userId) {
  return withRoomLock(room.id, async () => {
    const currentRoom = await getRoom(room.id);
    if (!currentRoom || currentRoom.status !== "lobby")
      return msg.sendGroup(room.thread_id, "انتهى التسجيل لسوق الظلال.");
    const player = await getPlayer(room.id, userId);
    if (!player)
      return msg.sendGroup(room.thread_id, "أنت غير مسجل في سوق الظلال.");
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
        "غادر الجميع التسجيل؛ أُلغي سوق الظلال.",
      );
    }
    return msg.sendGroup(room.thread_id, `${player.display_name} غادر التسجيل.`);
  });
}

async function cancelActiveGame(userId, threadId, isAdmin = false) {
  const room = await getActiveRoom(threadId);
  if (!room)
    return msg.sendGroup(threadId, "لا يوجد سوق ظلال نشط.");
  if (String(room.host_psid) !== String(userId) && !isAdmin)
    return msg.sendGroup(
      threadId,
      "⛔ مضيف اللعبة أو أدمن البوت فقط يستطيع إلغاء سوق الظلال.",
    );
  return withRoomLock(room.id, async () => {
    const currentRoom = await getRoom(room.id);
    if (!currentRoom || !["lobby", "playing"].includes(currentRoom.status))
      return msg.sendGroup(threadId, "لا يوجد سوق ظلال نشط.");
    const state = await getState(room.id);
    state.stage = "cancelled";
    clearDeadline(state);
    await persistState(state);
    return msg.sendGroup(threadId, "🚫 أُلغي سوق الظلال.");
  });
}

function helpText() {
  return [
    "سوق الظلال: لعبة تفاوض وأدوار وعقود سرية من 4 إلى 8 لاعبين، في ثلاث جولات.",
    "سجّلوا بالتفاعل مع رسالة التسجيل؛ المضيف لا يُسجل تلقائياً. لكل لاعب 10 عملات وبطاقة جديدة كل جولة.",
    "تفاوضوا علناً، ثم أرسلوا للبوت في الخاص: عرض <رقم اللاعب> <السعر> | <وصف القطعة>. يقبل المستلم أو يرفض العرض في الخاص.",
    "أحدكم مهرّب يحمل بطاقات مزيفة، وآخر مفتش يفحص بطاقة لاعب مرة واحدة في الجولة بكتابة: فحص <رقم اللاعب>. الأدوار والعقود لا تُكشف إلا في النهاية.",
    "تُحسب قيمة العملات والبطاقات الأصلية والمكافآت السرية؛ الفائز أو المتعادلون يحصلون على نقطة.",
    "أوامر المجموعة: /قواعد الظلال، /حالة الظلال، /خروج الظلال، /إلغاء الظلال. الخاص: /حقيبة الظلال.",
  ].join("\n");
}

async function handleGroup(context, parsed) {
  if (parsed.command === "help")
    return msg.sendGroup(context.threadId, helpText());
  const room = await getActiveRoom(context.threadId);
  if (!room) {
    if (["status", "inventory", "leave", "cancel"].includes(parsed.command))
      return msg.sendGroup(context.threadId, "لا يوجد سوق ظلال نشط.");
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
  if (parsed.command === "inventory")
    return msg.sendGroup(
      context.threadId,
      "حقيبة البطاقات سرية؛ أرسل /حقيبة الظلال للبوت في الخاص.",
    );
  if (parsed.name === "عرض" || parsed.name === "قبول" || parsed.name === "رفض")
    return msg.sendGroup(
      context.threadId,
      "أرسل عروض السوق وقبولها أو رفضها في الخاص مع البوت.",
    );
  if (parsed.name === "فحص")
    return msg.sendGroup(
      context.threadId,
      "الفحص متاح للمفتش فقط؛ أرسل فحص <رقم اللاعب> للبوت في الخاص.",
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
      "SELECT room_id FROM shadow_market_state WHERE deadline_at IS NOT NULL AND deadline_at<=NOW()",
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
      return msg.sendPrivate(context.userId, "ابدأ سوق الظلال داخل المجموعة.");
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
    assignSecretRoles,
    calculateScores,
    dealRound,
    findOffer,
    normalizeDigits,
    parseOffer,
    playerByNumber,
    settleTrade,
  },
};
