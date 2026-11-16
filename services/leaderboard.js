const db = require("../database");

const POINTS_BY_GAME = Object.freeze({
  drawing: 1,
  spy: 2,
  crime: 3,
  storm: 3,
  werewolf: 3,
  feign: 4,
  culture: 1,
  religion: 1,
  flags: 1,
  quote: 1,
  ordering: 1,
  wordmarket: 1,
  spacetoon: 1,
  "cartoon-film": 1,
  "football-auction": 1,
  "emoji-guess": 1,
  "anime-guess": 1,
  "emoji-film": 1,
  "try-escape": 1,
  "treasure-hunt": 1,
  "shadow-market": 1,
  "rescue-code": 1,
});

async function recordPoints(gameId, roomId, winners, transactionQuery = null) {
  const points = POINTS_BY_GAME[gameId];
  if (!points) throw new Error(`No leaderboard point value configured for game "${gameId}".`);
  const uniqueWinners = new Map();
  for (const winner of winners) {
    const psid = String(winner.psid || "");
    if (!psid) continue;
    uniqueWinners.set(psid, {
      psid,
      displayName: String(winner.display_name || "لاعب").slice(0, 100),
    });
  }
  if (!uniqueWinners.size) return 0;

  const applyPoints = async (query) => {
    let awarded = 0;
    for (const winner of uniqueWinners.values()) {
      const inserted = await query(
        `INSERT IGNORE INTO bot_point_awards
           (room_id, game_id, psid, display_name, points)
         VALUES (?,?,?,?,?)`,
        [roomId, gameId, winner.psid, winner.displayName, points],
      );
      if (!inserted.affectedRows) continue;
      await query(
        `INSERT INTO bot_player_scores (psid, display_name, points)
         VALUES (?,?,?)
         ON DUPLICATE KEY UPDATE
           display_name=VALUES(display_name),
           points=points+VALUES(points)`,
        [winner.psid, winner.displayName, points],
      );
      awarded++;
    }
    return awarded;
  };

  return transactionQuery
    ? applyPoints(transactionQuery)
    : db.withTransaction(applyPoints);
}

async function syncScores() {
  const weights = Object.entries(POINTS_BY_GAME);
  const caseExpression = weights
    .map(() => "WHEN ? THEN ?")
    .join(" ");
  const params = weights.flatMap(([gameId, points]) => [gameId, points]);
  const gameIds = weights.map(() => "?").join(",");

  await db.withTransaction(async (query) => {
    await query(
      `UPDATE bot_point_awards
       SET points=CASE game_id ${caseExpression} ELSE points END
       WHERE game_id IN (${gameIds})`,
      [...params, ...weights.map(([gameId]) => gameId)],
    );
    await query("DELETE FROM bot_player_scores");
    await query(
      `INSERT INTO bot_player_scores (psid, display_name, points)
       SELECT psid, COALESCE(MAX(display_name), 'لاعب'), GREATEST(0, SUM(amount))
       FROM (
         SELECT psid, display_name, CAST(points AS SIGNED) AS amount FROM bot_point_awards
         UNION ALL
         SELECT psid, 'لاعب' AS display_name, CAST(amount AS SIGNED) AS amount
         FROM bot_point_transactions
       ) point_ledger
       GROUP BY psid
       HAVING SUM(amount) > 0`,
    );
  });
}

async function topPlayers(limit = 10) {
  const safeLimit = Math.max(1, Math.min(10, Math.trunc(Number(limit) || 10)));
  return db.query(
    `SELECT s.psid, s.display_name, s.points, p.name AS title
     FROM bot_player_scores s
     LEFT JOIN bot_shop_inventory i ON i.psid=s.psid AND i.equipped=1
     LEFT JOIN bot_shop_products p ON p.id=i.product_id AND p.item_type='cosmetic'
     ORDER BY s.points DESC, s.display_name ASC, s.psid ASC
     LIMIT ${safeLimit}`,
  );
}

async function playerPoints(psid) {
  const player = await db.one(
    "SELECT points FROM bot_player_scores WHERE psid=? LIMIT 1",
    [String(psid)],
  );
  return Number(player?.points || 0);
}

async function activeTitle(psid) {
  const product = await db.one(
    `SELECT p.name
     FROM bot_shop_inventory i
     JOIN bot_shop_products p ON p.id=i.product_id
     WHERE i.psid=? AND i.equipped=1 AND p.item_type='cosmetic'
     LIMIT 1`,
    [String(psid)],
  );
  return product?.name || null;
}

async function deductPoints(psid, pointsToDeduct) {
  const safePsid = String(psid);
  const requestedAmount = Number(pointsToDeduct);
  if (!safePsid || !Number.isSafeInteger(requestedAmount) || requestedAmount <= 0) {
    return { psid: safePsid, previousPoints: 0, newPoints: 0, deducted: 0 };
  }

  return db.withTransaction(async (query) => {
    const rows = await query(
      "SELECT points FROM bot_player_scores WHERE psid=? FOR UPDATE",
      [safePsid],
    );
    const previousPoints = Number(rows[0]?.points || 0);
    const deducted = Math.min(previousPoints, requestedAmount);
    const newPoints = previousPoints - deducted;
    if (deducted > 0) {
      await query(
        "UPDATE bot_player_scores SET points=? WHERE psid=?",
        [newPoints, safePsid],
      );
      await query(
        `INSERT INTO bot_point_transactions
           (psid, amount, transaction_type, description)
         VALUES (?, ?, 'admin_deduction', 'خصم نقاط بواسطة أدمن')`,
        [safePsid, -deducted],
      );
    }
    return { psid: safePsid, previousPoints, newPoints, deducted };
  });
}

module.exports = {
  POINTS_BY_GAME,
  recordPoints,
  syncScores,
  topPlayers,
  playerPoints,
  activeTitle,
  deductPoints,
};
