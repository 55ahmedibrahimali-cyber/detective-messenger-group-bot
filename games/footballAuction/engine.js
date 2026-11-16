const db = require("../../database");
const msg = require("../../services/messenger");
const leaderboard = require("../../services/leaderboard");

const STARTING_BUDGET = 100;
const SQUAD_SIZE = 5;
const PLAYERS = [
  { name: "ليونيل ميسي", rating: 98 },
  { name: "كريستيانو رونالدو", rating: 97 },
  { name: "كيليان مبابي", rating: 96 },
  { name: "محمد صلاح", rating: 94 },
  { name: "إيرلينغ هالاند", rating: 95 },
  { name: "نيمار", rating: 93 },
  { name: "كيفن دي بروين", rating: 94 },
  { name: "لوكا مودريتش", rating: 92 },
  { name: "فينيسيوس جونيور", rating: 93 },
  { name: "روبرت ليفاندوفسكي", rating: 93 },
  { name: "جود بيلينغهام", rating: 92 },
  { name: "سيرخيو راموس", rating: 91 },
  { name: "رياض محرز", rating: 90 },
  { name: "سالم الدوسري", rating: 89 },
  { name: "أشرف حكيمي", rating: 91 },
  { name: "تيبو كورتوا", rating: 92 },
];

const STARTS = new Set(["مزاد", "auction"]);
const JOINS = new Set(["انضمام", "دخول"]);
const HELPS = new Set(["قواعدالمزاد", "مزادhelp", "auctionhelp"]);
const activeMatches = new Map();

function normalize(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\u064B-\u065F\u0670\u0640]/g, "")
    .replace(/[أإآ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

function commandParts(text) {
  return String(text || "")
    .trim()
    .replace(/^[/!]\s*/, "")
    .split(/\s+/);
}

function rosterText(player) {
  return player.squad.length
    ? player.squad.map((item) => item.name).join("، ")
    : "لم يضم لاعبين بعد";
}

function availableList(match) {
  return match.available
    .map(
      (player) =>
        `${player.number}. ${player.name} (${player.rating} تقييم)`,
    )
    .join("\n");
}

function getPlayer(match, userId) {
  return match.players.find((player) => player.id === String(userId)) || null;
}

function otherPlayer(match, player) {
  return match.players.find((item) => item.id !== player.id);
}

function nextAuctioneer(match, preferredIndex) {
  for (let offset = 0; offset < match.players.length; offset++) {
    const index = (preferredIndex + offset) % match.players.length;
    if (match.players[index].squad.length < SQUAD_SIZE) return match.players[index];
  }
  return null;
}

function maxBid(player) {
  const slotsAfterThisBid = SQUAD_SIZE - player.squad.length - 1;
  return player.budget - slotsAfterThisBid;
}

function finishMatch(match, winner, finalMessage) {
  return (async () => {
    await db.query(
      "UPDATE game_rooms SET status='finished', phase='finished' WHERE id=? AND status IN ('lobby','playing')",
      [match.roomId],
    );
    if (winner) {
      await leaderboard.recordPoints("football-auction", match.roomId, [
        { psid: winner.id, display_name: winner.name },
      ]);
    }
    activeMatches.delete(match.threadId);
    return msg.sendGroup(match.threadId, finalMessage);
  })();
}

async function simulateMatch(match) {
  const [left, right] = match.players;
  const leftAverage = left.squad.reduce((sum, player) => sum + player.rating, 0) / SQUAD_SIZE;
  const rightAverage = right.squad.reduce((sum, player) => sum + player.rating, 0) / SQUAD_SIZE;
  const score = (average) =>
    Math.min(
      6,
      Math.floor(Math.max(0.25, 1 + (average - 80) / 10) + Math.random() * 2.2),
    );
  const leftGoals = score(leftAverage);
  const rightGoals = score(rightAverage);
  let winner;
  let resultLine = `${leftGoals} - ${rightGoals}`;

  if (leftGoals === rightGoals) {
    const leftPenalties = Math.round(leftAverage / 10 + Math.random() * 10);
    const rightPenalties = Math.round(rightAverage / 10 + Math.random() * 10);
    winner =
      leftPenalties === rightPenalties
        ? leftAverage >= rightAverage
          ? left
          : right
        : leftPenalties > rightPenalties
          ? left
          : right;
    resultLine += ` (ركلات الترجيح ${leftPenalties} - ${rightPenalties})`;
  } else {
    winner = leftGoals > rightGoals ? left : right;
  }

  const teamText = (player, average) =>
    `${player.name}: ${rosterText(player)}\nالمعدل ${average.toFixed(1)} | الرصيد ${player.budget}`;
  const finalMessage = [
    "انتهى المزاد",
    teamText(left, leftAverage),
    teamText(right, rightAverage),
    `النتيجة: ${resultLine}`,
    `الفائز: ${winner.name} (+1)`,
  ].join("\n\n");
  return finishMatch(match, winner, finalMessage);
}

async function closeLot(match, winner) {
  const { player } = match.lot;
  const price = match.lot.highBid;
  winner.budget -= price;
  winner.squad.push(player);
  match.available = match.available.filter((item) => item.number !== player.number);
  const previousAuctioneerIndex = match.players.findIndex(
    (item) => item.id === match.lot.auctioneerId,
  );
  match.lot = null;

  if (match.players.every((item) => item.squad.length === SQUAD_SIZE))
    return simulateMatch(match);

  const next = nextAuctioneer(match, (previousAuctioneerIndex + 1) % 2);
  match.auctioneerId = next.id;
  return msg.sendGroup(
    match.threadId,
    `تمت الصفقة: ${player.name} إلى ${winner.name} بـ${price}.\n` +
      `${match.players.map((item) => `${item.name}: ${item.squad.length}/${SQUAD_SIZE}، رصيد ${item.budget}`).join(" | ")}\n` +
      `دور ${next.name}: رشح <رقم>\n${availableList(match)}`,
  );
}

async function handleMessage(context) {
  if (!context.isGroup)
    return msg.sendPrivate(context.userId, "استخدم مزاد كرة القدم داخل المجموعة.");

  const parts = commandParts(context.text);
  const command = (parts.shift() || "").toLowerCase();
  const argument = parts.join(" ").trim();
  if (HELPS.has(command))
    return msg.sendGroup(
      context.threadId,
      "مزاد كرة القدم: مزاد ثم انضمام. رشح لاعباً، زايد <مبلغ> أو مرر. لكل لاعب 100 رصيد وخمسة لاعبين؛ الفائز بالمباراة ينال نقطة.",
    );

  if (STARTS.has(command)) {
    const current = activeMatches.get(context.threadId);
    if (current)
      return msg.sendGroup(context.threadId, "المزاد قائم بالفعل.");
    const existing = await db.one(
      "SELECT id FROM game_rooms WHERE thread_id=? AND game_id='football-auction' AND status IN ('lobby','playing') ORDER BY id DESC LIMIT 1",
      [context.threadId],
    );
    if (existing)
      return msg.sendGroup(
        context.threadId,
        "يوجد مزاد سابق؛ ألغِه أولاً.",
      );
    const name = String((await msg.getUserName(context.userId)) || "اللاعب الأول").slice(0, 100);
    const result = await db.query(
      "INSERT INTO game_rooms (game_id, thread_id, host_psid, status, phase) VALUES ('football-auction', ?, ?, 'lobby', 'lobby')",
      [context.threadId, String(context.userId)],
    );
    activeMatches.set(context.threadId, {
      roomId: result.insertId,
      threadId: context.threadId,
      hostId: String(context.userId),
      phase: "lobby",
      players: [{ id: String(context.userId), name, budget: STARTING_BUDGET, squad: [] }],
      available: PLAYERS.map((player, index) => ({ ...player, number: index + 1 })),
      auctioneerId: String(context.userId),
      lot: null,
    });
    return msg.sendGroup(
      context.threadId,
      `بدأ المزاد. ينتظر ${name} لاعباً ثانياً: انضمام`,
    );
  }

  const match = activeMatches.get(context.threadId);
  if (!match && JOINS.has(command))
    return msg.sendGroup(context.threadId, "لا يوجد مزاد. اكتب مزاد للبدء.");
  if (match?.phase === "lobby" && JOINS.has(command)) {
    if (String(context.userId) === match.hostId)
      return msg.sendGroup(context.threadId, "ينبغي أن ينضم لاعب آخر إلى المزاد.");
    const name = String((await msg.getUserName(context.userId)) || "اللاعب الثاني").slice(0, 100);
    match.players.push({
      id: String(context.userId),
      name,
      budget: STARTING_BUDGET,
      squad: [],
    });
    match.phase = "auction";
    await db.query(
      "UPDATE game_rooms SET status='playing', phase='discussion' WHERE id=? AND status='lobby'",
      [match.roomId],
    );
    return msg.sendGroup(
      context.threadId,
      `بدأ المزاد: ${match.players[0].name} و${name} (رصيد ${STARTING_BUDGET}).\n${match.players[0].name} يرشّح:\n${availableList(match)}`,
    );
  }
  if (!match) return;
  if (match.phase === "lobby")
    return msg.sendGroup(context.threadId, "بانتظار لاعب ثانٍ: انضمام");

  const actor = getPlayer(match, context.userId);
  if (!actor) return;
  if (command === "رشح" || command === "ترشيح") {
    if (match.lot)
      return msg.sendGroup(context.threadId, "أنهوا المزايدة الحالية أولاً.");
    if (actor.id !== match.auctioneerId)
      return msg.sendGroup(context.threadId, `الدور على ${getPlayer(match, match.auctioneerId).name}.`);
    if (actor.squad.length >= SQUAD_SIZE)
      return msg.sendGroup(context.threadId, "اكتملت تشكيلتك من خمسة لاعبين.");
    const number = Number(argument);
    const nominee = match.available.find((player) => player.number === number);
    if (!nominee)
      return msg.sendGroup(context.threadId, "اختر رقماً من القائمة.");
    match.lot = {
      player: nominee,
      auctioneerId: actor.id,
      highBid: 0,
      highBidderId: null,
    };
    return msg.sendGroup(
      context.threadId,
      `${nominee.name} (${nominee.rating}) — ${actor.name} يبدأ: زايد <مبلغ>`,
    );
  }

  if (command === "زايد" || command === "زايدوا") {
    const lot = match.lot;
    if (!lot)
      return msg.sendGroup(context.threadId, "لا يوجد لاعب معروض. اكتب رشح <رقم>.");
    if (actor.squad.length >= SQUAD_SIZE)
      return msg.sendGroup(context.threadId, "اكتملت تشكيلتك من خمسة لاعبين.");
    const amount = Number(argument);
    if (!Number.isSafeInteger(amount) || amount < 1)
      return msg.sendGroup(context.threadId, "اكتب زايد <مبلغ صحيح>.");
    if (!lot.highBidderId && actor.id !== lot.auctioneerId)
      return msg.sendGroup(context.threadId, `صاحب الدور ${getPlayer(match, lot.auctioneerId).name} يبدأ المزايدة.`);
    if (lot.highBidderId === actor.id)
      return msg.sendGroup(context.threadId, "انتظر الخصم أو مرر.");
    if (lot.highBidderId && amount <= lot.highBid)
      return msg.sendGroup(context.threadId, `يجب أن تتجاوز المزايدة الحالية (${lot.highBid}).`);
    if (amount > maxBid(actor))
      return msg.sendGroup(
        context.threadId,
        `أقصى مزايدة لك: ${Math.max(0, maxBid(actor))}.`,
      );
    lot.highBid = amount;
    lot.highBidderId = actor.id;
    const opponent = otherPlayer(match, actor);
    return msg.sendGroup(
      context.threadId,
      `${actor.name}: ${amount} لـ${lot.player.name}. ${opponent.name}: زايد أعلى أو مرر.`,
    );
  }

  if (command === "مرر" || command === "تمرير") {
    const lot = match.lot;
    if (!lot)
      return msg.sendGroup(context.threadId, "لا توجد مزايدة مفتوحة.");
    if (!lot.highBidderId) {
      if (actor.id !== lot.auctioneerId)
        return msg.sendGroup(context.threadId, "صاحب الدور فقط يستطيع سحب اللاعب قبل بدء المزايدة.");
      const auctioneerIndex = match.players.findIndex((player) => player.id === lot.auctioneerId);
      match.lot = null;
      const next = nextAuctioneer(match, (auctioneerIndex + 1) % 2);
      match.auctioneerId = next.id;
      return msg.sendGroup(
        context.threadId,
        `تم سحب ${lot.player.name} من المزاد. الدور الآن على ${next.name}: رشح <رقم>.`,
      );
    }
    if (lot.highBidderId === actor.id)
      return msg.sendGroup(context.threadId, "لا يمكنك تمرير مزايدتك؛ اترك خصمك يرد.");
    const winner = getPlayer(match, lot.highBidderId);
    return closeLot(match, winner);
  }

  if (command === "قائمة" || command === "اللاعبون")
    return msg.sendGroup(context.threadId, `اللاعبون المتاحون:\n${availableList(match)}`);
}

async function cancelActiveGame(userId, threadId, isAdmin = false) {
  const room = await db.one(
    "SELECT id, host_psid FROM game_rooms WHERE thread_id=? AND game_id='football-auction' AND status IN ('lobby','playing') ORDER BY id DESC LIMIT 1",
    [threadId],
  );
  if (!room)
    return msg.sendGroup(threadId, "لا يوجد مزاد لإلغائه.");
  if (String(room.host_psid) !== String(userId) && !isAdmin)
    return msg.sendGroup(threadId, "المضيف فقط يلغي المزاد.");
  const result = await db.query(
    "UPDATE game_rooms SET status='cancelled', phase='finished' WHERE id=? AND status IN ('lobby','playing')",
    [room.id],
  );
  if (!result.affectedRows)
    return msg.sendGroup(threadId, "لا يوجد مزاد لإلغائه.");
  if (activeMatches.get(threadId)?.roomId === room.id)
    activeMatches.delete(threadId);
  return msg.sendGroup(threadId, "أُلغي المزاد.");
}

module.exports = {
  handleMessage,
  handleReaction: async () => null,
  cancelActiveGame,
  startTicker: async () => null,
  simulateMatch,
  PLAYERS,
  STARTING_BUDGET,
  SQUAD_SIZE,
};
