const test = require("node:test");
const assert = require("node:assert/strict");
const db = require("../database");
const msg = require("./messenger");
const phaseReminders = require("./phaseReminders");

test("lobby reminder contains only the remaining time", async () => {
  const originalQuery = db.query;
  const originalSendGroup = msg.sendGroup;
  const roomId = 987654321;
  const sent = [];
  let query;
  let queryParams;
  db.query = async (sql, params) => {
    query = sql;
    queryParams = params;
    return [
      {
        id: roomId,
        game_id: "crime",
        thread_id: "reminder-test-thread",
        phase: "lobby",
        current_round: 0,
        remaining: 29,
      },
    ];
  };
  msg.sendGroup = async (threadId, text) => sent.push({ threadId, text });

  try {
    await phaseReminders.check();
    assert.match(query, /phase_ends_at <= DATE_ADD\(NOW\(\), INTERVAL \? SECOND\)/);
    assert.deepEqual(queryParams, [30]);
    assert.deepEqual(sent, [
      { threadId: "reminder-test-thread", text: "باقي 29 ثانية" },
    ]);
  } finally {
    db.query = originalQuery;
    msg.sendGroup = originalSendGroup;
    phaseReminders._sent.delete(`${roomId}:lobby:0:30`);
    phaseReminders._sent.delete(`${roomId}:lobby:0:10`);
  }
});