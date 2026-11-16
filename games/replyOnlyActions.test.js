const test = require("node:test");
const assert = require("node:assert/strict");
const db = require("../database");
const msg = require("../services/messenger");
const engines = {
  crime: require("./crime/engine"),
  storm: require("./storm/engine"),
  spy: require("./spy/engine"),
  feign: require("./feign/engine"),
  werewolf: require("./werewolf/engine"),
};

async function exerciseAction({
  game,
  text,
  phase,
  roleKey,
  messageReply = null,
  extraSession = {},
}) {
  const session = {
    id: 1,
    player_id: 1,
    room_id: 10,
    psid: "player-id",
    status: "playing",
    phase,
    current_round: 1,
    is_alive: 1,
    is_out: 0,
    is_spy: 0,
    guess_used: 0,
    role_key: roleKey,
    team: "town",
    ...extraSession,
  };
  let queryCount = 0;
  const messages = [];
  db.one = async (sql) =>
    sql.includes("FROM werewolf_state")
      ? {
          sheriff_election_done: 1,
          sheriff_player_id: 1,
          pending_hunter_player_id: 1,
        }
      : session;
  db.query = async (sql) => {
    queryCount += 1;
    return sql.startsWith("UPDATE spy_players")
      ? { affectedRows: 0 }
      : [];
  };
  msg.sendPrivate = async (_userId, body) => {
    messages.push(body);
    return true;
  };

  await engines[game].handleMessage({
    userId: "player-id",
    threadId: "reply-test-thread",
    isGroup: false,
    text,
    messageReply,
  });
  return { queryCount, messages };
}

test("direct vote and ability commands are rejected across voting games", async () => {
  const originalOne = db.one;
  const originalQuery = db.query;
  const originalSendPrivate = msg.sendPrivate;
  const originalSelfId = msg.selfId;
  msg.selfId = () => "bot-id";

  const directActions = [
    { game: "crime", text: "/vote 1", phase: "voting" },
    { game: "crime", text: "1", phase: "voting" },
    { game: "storm", text: "/vote 1", phase: "voting" },
    { game: "storm", text: "1", phase: "voting" },
    {
      game: "storm",
      text: "/protect 1",
      phase: "night",
      roleKey: "doctor",
    },
    {
      game: "storm",
      text: "/درع",
      phase: "discussion",
      roleKey: "trickster",
    },
    { game: "spy", text: "/spyvote 1", phase: "voting" },
    { game: "spy", text: "1", phase: "voting" },
    {
      game: "spy",
      text: "/spyguess image",
      phase: "spy_guess",
      extraSession: { is_spy: 1, is_out: 1 },
    },
    {
      game: "spy",
      text: "image",
      phase: "spy_guess",
      extraSession: { is_spy: 1, is_out: 1 },
    },
    { game: "feign", text: "/fvote 1", phase: "voting" },
    { game: "feign", text: "1", phase: "voting" },
    {
      game: "feign",
      text: "/fa 1",
      phase: "night",
      roleKey: "serial_killer",
    },
    { game: "werewolf", text: "/wvote 1", phase: "voting" },
    { game: "werewolf", text: "1", phase: "voting" },
    {
      game: "werewolf",
      text: "/wa 1",
      phase: "night",
      roleKey: "werewolf",
      extraSession: { team: "wolves" },
    },
    {
      game: "werewolf",
      text: "/whunt 1",
      phase: "hunter",
      roleKey: "hunter",
    },
    {
      game: "werewolf",
      text: "/whandoff 1",
      phase: "discussion",
      roleKey: "villager",
    },
  ];

  try {
    for (const action of directActions) {
      const { queryCount, messages } = await exerciseAction(action);
      assert.equal(queryCount, 0, `${action.game}: ${action.text} reached game logic`);
      assert.ok(messages.length, `${action.game}: ${action.text} was not rejected`);
    }
  } finally {
    db.one = originalOne;
    db.query = originalQuery;
    msg.sendPrivate = originalSendPrivate;
    msg.selfId = originalSelfId;
  }
});

test("replying to the bot's matching prompt reaches vote and ability validation", async () => {
  const originalOne = db.one;
  const originalQuery = db.query;
  const originalSendPrivate = msg.sendPrivate;
  const originalSelfId = msg.selfId;
  msg.selfId = () => "bot-id";

  const replies = [
    {
      game: "crime",
      text: "1",
      phase: "voting",
      marker: "🗳️ بطاقة التصويت في مين قتل كريم",
    },
    {
      game: "storm",
      text: "1",
      phase: "voting",
      marker: "🗳️ بطاقة التصويت السري في STORM",
    },
    {
      game: "storm",
      text: "1",
      phase: "night",
      roleKey: "shadow_leader",
      extraSession: { team: "shadow" },
      marker: "🌙 اختيار ضحية الظلال",
    },
    {
      game: "spy",
      text: "1",
      phase: "voting",
      marker: "🗳️ بطاقة التصويت في لعبة الجاسوس",
    },
    {
      game: "spy",
      text: "image",
      phase: "spy_guess",
      extraSession: { is_spy: 1, is_out: 1 },
      marker: "🎯 بطاقة تخمين الجاسوس",
    },
    {
      game: "feign",
      text: "1",
      phase: "voting",
      marker: "🗳️ بطاقة التصويت في فيجن",
    },
    {
      game: "feign",
      text: "1",
      phase: "night",
      roleKey: "serial_killer",
      marker: "🌙 بطاقة القدرة الليلية في فيجن",
    },
    {
      game: "werewolf",
      text: "1",
      phase: "voting",
      marker: "🗳️ بطاقة التصويت في لعبة المستذئب",
    },
    {
      game: "werewolf",
      text: "1",
      phase: "night",
      roleKey: "werewolf",
      extraSession: { team: "wolves" },
      marker: "🌙 بطاقة القدرة الليلية في المستذئب",
    },
    {
      game: "werewolf",
      text: "1",
      phase: "hunter",
      roleKey: "hunter",
      marker: "🎯 بطاقة طلقة الصياد في المستذئب",
    },
    {
      game: "werewolf",
      text: "1",
      phase: "discussion",
      roleKey: "villager",
      marker: "⭐ بطاقة اختيار خليفة العمدة في المستذئب",
    },
  ];

  try {
    for (const reply of replies) {
      const result = await exerciseAction({
        ...reply,
        messageReply: {
          body: reply.marker,
          senderID: "bot-id",
        },
      });
      assert.ok(
        result.queryCount > 0,
        `${reply.game}: valid reply did not reach action validation`,
      );

      const spoofed = await exerciseAction({
        ...reply,
        messageReply: {
          body: reply.marker,
          senderID: "player-id",
        },
      });
      assert.equal(
        spoofed.queryCount,
        0,
        `${reply.game}: a non-bot prompt reached action validation`,
      );
    }
  } finally {
    db.one = originalOne;
    db.query = originalQuery;
    msg.sendPrivate = originalSendPrivate;
    msg.selfId = originalSelfId;
  }
});
