const test = require("node:test");
const assert = require("node:assert/strict");
const db = require("../../database");
const msg = require("../../services/messenger");
const storm = require("./engine");

test("storm announces the tally without an extra all-voted group message", async () => {
  const originalOne = db.one;
  const originalQuery = db.query;
  const originalSendPrivate = msg.sendPrivate;
  const originalSendGroup = msg.sendGroup;
  const players = [
    {
      id: 1,
      psid: "player-1",
      display_name: "الأول",
      is_alive: 1,
      role_key: "investigator",
    },
    {
      id: 2,
      psid: "player-2",
      display_name: "الثاني",
      is_alive: 1,
      role_key: "doctor",
    },
  ];
  const privateMessages = [];
  const groupMessages = [];
  let resolveLockCalls = 0;

  try {
    db.one = async (sql) =>
      sql.includes("COUNT(DISTINCT sa.actor_player_id)")
        ? { voted: 2, alive: 2 }
        : {
            id: 9,
            thread_id: "group-1",
            status: "playing",
            phase: "voting",
            current_round: 1,
          };
    db.query = async (sql) => {
      if (sql.startsWith("SELECT * FROM storm_players")) return players;
      if (sql.includes("UPDATE game_rooms SET phase='tallying'")) {
        resolveLockCalls += 1;
        return { affectedRows: 0 };
      }
      return {};
    };
    msg.sendPrivate = async (_userId, text) => privateMessages.push(text);
    msg.sendGroup = async (_threadId, text) => groupMessages.push(text);

    await storm._internal.castVote(
      {
        id: 1,
        psid: "player-1",
        room_id: 9,
        status: "playing",
        phase: "voting",
        current_round: 1,
        is_alive: 1,
      },
      2,
    );

    assert.equal(privateMessages.length, 1);
    assert.match(privateMessages[0], /تم تسجيل صوتك/);
    assert.equal(resolveLockCalls, 1);
    assert.deepEqual(groupMessages, []);
  } finally {
    db.one = originalOne;
    db.query = originalQuery;
    msg.sendPrivate = originalSendPrivate;
    msg.sendGroup = originalSendGroup;
  }
});
