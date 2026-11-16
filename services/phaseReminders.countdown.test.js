const test = require("node:test");
const assert = require("node:assert/strict");
const db = require("../database");
const msg = require("./messenger");
const reminders = require("./phaseReminders");

test("lobby reminders show the remaining time in seconds only", async () => {
  const originalQuery = db.query;
  const originalSendGroup = msg.sendGroup;
  const sent = [];
  reminders._sent.clear();
  db.query = async (sql) => {
    if (sql.includes("TIMESTAMPDIFF"))
      return [
        {
          id: 98531,
          game_id: "werewolf",
          thread_id: "countdown-test",
          phase: "lobby",
          current_round: 0,
          remaining: 30,
        },
      ];
    if (sql.includes("FROM werewolf_players"))
      return [{ display_name: "لاعب 1" }, { display_name: "لاعب 2" }];
    throw new Error(`Unexpected query: ${sql}`);
  };
  msg.sendGroup = async (_threadId, text) => sent.push(text);

  try {
    await reminders.check();
    assert.equal(sent.length, 1);
    assert.match(sent[0], /باقي 30 ثانية/);
    assert.doesNotMatch(sent[0], /دقيقة|:\d{2}/);
  } finally {
    db.query = originalQuery;
    msg.sendGroup = originalSendGroup;
    reminders._sent.clear();
  }
});
