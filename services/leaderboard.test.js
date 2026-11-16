const test = require("node:test");
const assert = require("node:assert/strict");
const db = require("../database");
const leaderboard = require("./leaderboard");

test("points are awarded once per player in a finished game", async () => {
  const originalWithTransaction = db.withTransaction;
  const awards = new Set();
  const scores = new Map();
  db.withTransaction = async (callback) =>
    callback(async (sql, params) => {
      if (sql.includes("INSERT IGNORE INTO bot_point_awards")) {
        const key = `${params[0]}:${params[2]}`;
        if (awards.has(key)) return { affectedRows: 0 };
        awards.add(key);
        return { affectedRows: 1 };
      }
      if (sql.includes("INSERT INTO bot_player_scores")) {
        const [psid, displayName, points] = params;
        const previous = scores.get(psid);
        scores.set(psid, {
          display_name: displayName,
          points: (previous?.points || 0) + points,
        });
        return { affectedRows: 1 };
      }
      throw new Error(`Unexpected query: ${sql}`);
    });

  try {
    const winners = [
      { psid: "winner-1", display_name: "الفائز" },
      { psid: "winner-1", display_name: "الفائز" },
      { psid: "", display_name: "لاعب بلا معرّف" },
    ];
    assert.equal(await leaderboard.recordPoints("spy", 12, winners), 1);
    assert.equal(await leaderboard.recordPoints("spy", 12, winners), 0);
    assert.deepEqual(scores.get("winner-1"), {
      display_name: "الفائز",
      points: 2,
    });
  } finally {
    db.withTransaction = originalWithTransaction;
  }
});

test("points can be recorded inside an existing game transaction", async () => {
  const calls = [];
  const query = async (sql, params) => {
    calls.push({ sql, params });
    return { affectedRows: 1 };
  };
  assert.equal(
    await leaderboard.recordPoints(
      "drawing",
      24,
      [{ psid: "artist", display_name: "الرسام" }],
      query,
    ),
    1,
  );
  assert.equal(calls.length, 2);
  assert.match(calls[0].sql, /INSERT IGNORE INTO bot_point_awards/);
  assert.deepEqual(calls[0].params, [24, "drawing", "artist", "الرسام", 1]);
  assert.match(calls[1].sql, /INSERT INTO bot_player_scores/);
  assert.deepEqual(calls[1].params, ["artist", "الرسام", 1]);
});

test("games award different points based on their difficulty", () => {
  assert.deepEqual(leaderboard.POINTS_BY_GAME, {
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
});

test("saved point awards are repriced and totals rebuilt", async () => {
  const originalWithTransaction = db.withTransaction;
  const statements = [];
  db.withTransaction = async (callback) =>
    callback(async (sql, params = []) => {
      statements.push({ sql, params });
      return { affectedRows: 1 };
    });
  try {
    await leaderboard.syncScores();
    assert.match(statements[0].sql, /UPDATE bot_point_awards/);
    assert.match(statements[0].sql, /CASE game_id WHEN \? THEN \?/);
    assert.deepEqual(statements[0].params.slice(0, 4), [
      "drawing",
      1,
      "spy",
      2,
    ]);
    assert.match(statements[1].sql, /DELETE FROM bot_player_scores/);
    assert.match(statements[2].sql, /SUM\(amount\)/);
    assert.match(statements[2].sql, /FROM bot_point_transactions/);
    assert.match(
      statements[2].sql,
      /CAST\(amount AS SIGNED\) AS amount\s+FROM bot_point_transactions/,
    );
  } finally {
    db.withTransaction = originalWithTransaction;
  }
});

test("unknown games cannot silently award points", async () => {
  await assert.rejects(
    leaderboard.recordPoints("unknown", 8, [
      { psid: "winner", display_name: "الفائز" },
    ]),
    /No leaderboard point value configured/,
  );
});

test("the leaderboard query is capped at ten players", async () => {
  const originalQuery = db.query;
  let statement;
  db.query = async (sql) => {
    statement = sql;
    return [];
  };
  try {
    await leaderboard.topPlayers(100);
    assert.match(statement, /ORDER BY s\.points DESC/);
    assert.match(statement, /LIMIT 10$/);
  } finally {
    db.query = originalQuery;
  }
});

test("point deductions are transactional and included in the persistent ledger", async () => {
  const originalWithTransaction = db.withTransaction;
  const statements = [];
  db.withTransaction = async (callback) =>
    callback(async (sql, params = []) => {
      statements.push({ sql, params });
      if (sql.includes("SELECT points FROM bot_player_scores"))
        return [{ points: 12 }];
      return { affectedRows: 1 };
    });

  try {
    assert.deepEqual(await leaderboard.deductPoints("player", 5), {
      psid: "player",
      previousPoints: 12,
      newPoints: 7,
      deducted: 5,
    });
    assert.match(statements[0].sql, /FOR UPDATE/);
    assert.match(statements[1].sql, /UPDATE bot_player_scores/);
    assert.match(statements[2].sql, /INSERT INTO bot_point_transactions/);
    assert.equal(statements[2].params[1], -5);
  } finally {
    db.withTransaction = originalWithTransaction;
  }
});

test("a player can query their own score, including zero", async () => {
  const originalOne = db.one;
  const lookups = [];
  db.one = async (sql, params) => {
    lookups.push({ sql, params });
    return params[0] === "scored-player" ? { points: 7 } : null;
  };
  try {
    assert.equal(await leaderboard.playerPoints("scored-player"), 7);
    assert.equal(await leaderboard.playerPoints("new-player"), 0);
    assert.deepEqual(lookups.map((lookup) => lookup.params), [
      ["scored-player"],
      ["new-player"],
    ]);
  } finally {
    db.one = originalOne;
  }
});
