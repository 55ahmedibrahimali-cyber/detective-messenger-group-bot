const test = require("node:test");
const assert = require("node:assert/strict");
const db = require("../../database");
const msg = require("../../services/messenger");
const leaderboard = require("../../services/leaderboard");
const engine = require("./engine");

test("football auction is two-player, reserves full squads, and simulates a winner", async () => {
  const originals = {
    one: db.one,
    query: db.query,
    sendGroup: msg.sendGroup,
    sendPrivate: msg.sendPrivate,
    getUserName: msg.getUserName,
    recordPoints: leaderboard.recordPoints,
    random: Math.random,
  };
  const room = { id: 64, host_psid: "host", status: "none" };
  const sentMessages = [];
  const pointAwards = [];
  db.one = async (sql) =>
    sql.includes("SELECT id FROM game_rooms") &&
    ["lobby", "playing"].includes(room.status)
      ? room
      : null;
  db.query = async (sql) => {
    if (sql.startsWith("INSERT INTO game_rooms")) {
      room.status = "lobby";
      return { insertId: room.id };
    }
    if (sql.includes("SET status='playing'")) room.status = "playing";
    if (sql.includes("SET status='finished'")) room.status = "finished";
    if (sql.includes("SET status='cancelled'")) room.status = "cancelled";
    return { affectedRows: 1 };
  };
  msg.sendGroup = async (_threadId, text) => {
    sentMessages.push(text);
    return true;
  };
  msg.sendPrivate = async () => {};
  msg.getUserName = async (userId) => `Player ${userId}`;
  leaderboard.recordPoints = async (...args) => pointAwards.push(args);
  Math.random = () => 0;

  const context = (userId, text) => ({
    userId,
    text,
    isGroup: true,
    threadId: "auction-thread",
  });
  try {
    await engine.handleMessage(context("host", "مزاد"));
    await engine.handleMessage(context("host", "انضمام"));
    await engine.handleMessage(context("guest", "انضمام"));
    assert.match(sentMessages.at(-1), /100/);

    await engine.handleMessage(context("host", "رشح 1"));
    await engine.handleMessage(context("host", "زايد 97"));
    assert.match(sentMessages.at(-1), /أقصى مزايدة لك: 96/);

    for (let index = 1; index <= engine.SQUAD_SIZE * 2; index++) {
      const bidder = index % 2 === 1 ? "host" : "guest";
      const opponent = bidder === "host" ? "guest" : "host";
      await engine.handleMessage(context(bidder, `رشح ${index}`));
      await engine.handleMessage(context(bidder, "زايد 1"));
      await engine.handleMessage(context(opponent, "مرر"));
    }

    assert.equal(room.status, "finished");
    assert.equal(pointAwards.length, 1);
    assert.equal(pointAwards[0][0], "football-auction");
    assert.match(sentMessages.at(-1), /انتهى المزاد/);
    assert.match(sentMessages.at(-1), /: Player host/);
    assert.match(sentMessages.at(-1), /النتيجة:/);
    assert.match(sentMessages.at(-1), /الفائز: Player host/);
  } finally {
    db.one = originals.one;
    db.query = originals.query;
    msg.sendGroup = originals.sendGroup;
    msg.sendPrivate = originals.sendPrivate;
    msg.getUserName = originals.getUserName;
    leaderboard.recordPoints = originals.recordPoints;
    Math.random = originals.random;
  }
});
