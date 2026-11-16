const test = require("node:test");
const assert = require("node:assert/strict");
const db = require("../../database");
const msg = require("../../services/messenger");
const spy = require("./engine");

test("spy vote progress is reported privately instead of posting for each vote", async () => {
  const originalOne = db.one;
  const originalQuery = db.query;
  const originalSendPrivate = msg.sendPrivate;
  const originalSendGroup = msg.sendGroup;
  const players = [
    { id: 1, psid: "player-1", display_name: "الأول", is_out: 0 },
    { id: 2, psid: "player-2", display_name: "الثاني", is_out: 0 },
  ];
  const privateMessages = [];
  const groupMessages = [];

  try {
    db.one = async () => ({ count: 1 });
    db.query = async (sql) =>
      sql.startsWith("SELECT * FROM spy_players") ? players : {};
    msg.sendPrivate = async (_userId, text) => privateMessages.push(text);
    msg.sendGroup = async (_threadId, text) => groupMessages.push(text);

    await spy._internal.castVote(
      "player-1",
      {
        id: 1,
        room_id: 7,
        thread_id: "group-1",
        status: "playing",
        phase: "voting",
        is_out: 0,
      },
      1,
    );

    assert.equal(privateMessages.length, 1);
    assert.match(privateMessages[0], /سُجل تصويتك/);
    assert.deepEqual(groupMessages, []);
  } finally {
    db.one = originalOne;
    db.query = originalQuery;
    msg.sendPrivate = originalSendPrivate;
    msg.sendGroup = originalSendGroup;
  }
});
