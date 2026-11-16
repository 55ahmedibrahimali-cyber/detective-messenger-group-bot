"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const db = require("../../database");
const msg = require("../../services/messenger");
const leaderboard = require("../../services/leaderboard");
const engine = require("./engine");

function response(answer, correctGuess = false) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      choices: [
        {
          message: {
            content: JSON.stringify({
              answer,
              correct_guess: correctGuess,
            }),
          },
        },
      ],
    }),
  };
}

test("anime guessing accepts any message as a yes/no question and awards a correct guess", async () => {
  const originals = {
    dbOne: db.one,
    dbQuery: db.query,
    sendGroup: msg.sendGroup,
    sendPrivate: msg.sendPrivate,
    getUserName: msg.getUserName,
    recordPoints: leaderboard.recordPoints,
    fetch: global.fetch,
    random: Math.random,
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
    apiToken: process.env.CLOUDFLARE_API_TOKEN,
  };
  const sent = [];
  const requests = [];
  const awards = [];
  const queries = [];
  let activeRecord = null;
  let guesses = 0;
  db.one = async () => activeRecord;
  db.query = async (sql, params) => {
    queries.push({ sql, params });
    if (sql.startsWith("INSERT INTO game_rooms"))
      return { insertId: 715, affectedRows: 1 };
    if (sql.startsWith("UPDATE game_rooms")) {
      activeRecord = null;
      return { affectedRows: 1 };
    }
    return { affectedRows: 1 };
  };
  msg.sendGroup = async (_threadId, text) => sent.push(text);
  msg.sendPrivate = async (_userId, text) => sent.push(text);
  msg.getUserName = async (userId) => `Player ${userId}`;
  leaderboard.recordPoints = async (...args) => awards.push(args);
  process.env.CLOUDFLARE_ACCOUNT_ID = "test-account";
  process.env.CLOUDFLARE_API_TOKEN = "test-token";
  Math.random = () => 0;
  global.fetch = async (url, options) => {
    requests.push({ url, options: JSON.parse(options.body) });
    guesses++;
    return response(guesses === 1 ? "نعم" : "لا", guesses === 2);
  };

  const context = {
    isGroup: true,
    threadId: `anime-guess-${Date.now()}`,
    userId: "player-1",
    text: "",
  };
  try {
    await engine.handleMessage({ ...context, text: "احزر الشخصية" });
    assert.match(sent.at(-1), /بدأت جولة/);

    await engine.handleMessage({ ...context, text: "يمتلك قوى خارقة" });
    assert.equal(sent.at(-1), "نعم");
    assert.equal(requests.length, 1);
    assert.match(
      requests[0].url,
      /api\.cloudflare\.com\/client\/v4\/accounts\/test-account\/ai\/v1\/chat\/completions$/,
    );
    assert.equal(requests[0].options.model, "@cf/openai/gpt-oss-20b");
    assert.deepEqual(requests[0].options.response_format, {
      type: "json_object",
    });
    assert.equal(
      requests[0].options.messages.at(-1).content,
      "يمتلك قوى خارقة",
    );

    await engine.handleMessage({
      ...context,
      text: "هل الشخصية هي ناروتو؟",
      userId: "player-2",
    });
    assert.match(sent.at(-1), /الشخصية هي ناروتو أوزوماكي/);
    assert.equal(awards.length, 1);
    assert.deepEqual(awards[0][2], [
      { psid: "player-2", display_name: "Player player-2" },
    ]);
    assert.ok(
      queries.some((query) =>
        query.sql.includes("SET status='finished', phase='finished'"),
      ),
    );
  } finally {
    db.one = originals.dbOne;
    db.query = originals.dbQuery;
    msg.sendGroup = originals.sendGroup;
    msg.sendPrivate = originals.sendPrivate;
    msg.getUserName = originals.getUserName;
    leaderboard.recordPoints = originals.recordPoints;
    global.fetch = originals.fetch;
    Math.random = originals.random;
    if (originals.accountId === undefined)
      delete process.env.CLOUDFLARE_ACCOUNT_ID;
    else process.env.CLOUDFLARE_ACCOUNT_ID = originals.accountId;
    if (originals.apiToken === undefined)
      delete process.env.CLOUDFLARE_API_TOKEN;
    else process.env.CLOUDFLARE_API_TOKEN = originals.apiToken;
  }
});

test("anime guessing reports missing Cloudflare credentials and keeps the round retryable", async () => {
  const originals = {
    dbOne: db.one,
    dbQuery: db.query,
    sendGroup: msg.sendGroup,
    sendPrivate: msg.sendPrivate,
    getUserName: msg.getUserName,
    fetch: global.fetch,
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
    apiToken: process.env.CLOUDFLARE_API_TOKEN,
  };
  const sent = [];
  let fetchCalls = 0;
  let activeRecord = null;
  db.one = async () => activeRecord;
  db.query = async (sql) => {
    if (sql.startsWith("INSERT INTO game_rooms"))
      return { insertId: 716, affectedRows: 1 };
    return { affectedRows: 1 };
  };
  msg.sendGroup = async (_threadId, text) => sent.push(text);
  msg.sendPrivate = async (_userId, text) => sent.push(text);
  msg.getUserName = async () => "Player";
  process.env.CLOUDFLARE_ACCOUNT_ID = "";
  process.env.CLOUDFLARE_API_TOKEN = "";
  global.fetch = async () => {
    fetchCalls++;
    return response("لا");
  };

  const context = {
    isGroup: true,
    threadId: `anime-guess-missing-${Date.now()}`,
    userId: "player-1",
  };
  try {
    await engine.handleMessage({ ...context, text: "احزرالشخصية" });
    await engine.handleMessage({ ...context, text: "هل يطير؟" });
    assert.match(sent.at(-1), /CLOUDFLARE_ACCOUNT_ID/);
    assert.equal(fetchCalls, 0);

    process.env.CLOUDFLARE_ACCOUNT_ID = "test-account";
    process.env.CLOUDFLARE_API_TOKEN = "test-token";
    global.fetch = async () => {
      fetchCalls++;
      return response("لا");
    };
    await engine.handleMessage({ ...context, text: "هل يطير؟" });
    assert.equal(sent.at(-1), "لا");
    assert.equal(fetchCalls, 1);
  } finally {
    db.one = originals.dbOne;
    db.query = originals.dbQuery;
    msg.sendGroup = originals.sendGroup;
    msg.sendPrivate = originals.sendPrivate;
    msg.getUserName = originals.getUserName;
    global.fetch = originals.fetch;
    if (originals.accountId === undefined)
      delete process.env.CLOUDFLARE_ACCOUNT_ID;
    else process.env.CLOUDFLARE_ACCOUNT_ID = originals.accountId;
    if (originals.apiToken === undefined)
      delete process.env.CLOUDFLARE_API_TOKEN;
    else process.env.CLOUDFLARE_API_TOKEN = originals.apiToken;
  }
});
