const test = require("node:test");
const assert = require("node:assert/strict");
const db = require("../../database");
const msg = require("../../services/messenger");
const leaderboard = require("../../services/leaderboard");
const createPromptRaceEngine = require("../promptRaceEngine");
const { loadEmojiPrompts } = require("../cartoonMovies/emojiPrompts");

test("emoji film puzzles are limited to titles in the supplied film data", () => {
  const prompts = loadEmojiPrompts([
    ["الأسد الملك", "ملك الغابة"],
    ["فيلم غير موجود"],
  ]);
  assert.deepEqual(prompts, [
    { clue: "🦁 + 👑", answers: ["الأسد الملك", "ملك الغابة"] },
  ]);
});

test("emoji-film rounds still accept a film title from an emoji clue", () => {
  const prompt = { clue: "🦁 + 👑", answers: ["الأسد الملك"] };
  assert.equal(
    createPromptRaceEngine._internal.isCorrect("emoji", prompt, "الأسد الملك"),
    true,
  );
  assert.match(
    createPromptRaceEngine._internal.promptText("emoji", prompt),
    /الإيموجي/,
  );
});

test("emoji description rounds award the first player to send the described emoji", async () => {
  const originals = {
    withTransaction: db.withTransaction,
    query: db.query,
    sendGroup: msg.sendGroup,
    getUserName: msg.getUserName,
    recordPoints: leaderboard.recordPoints,
  };
  const sent = [];
  const awards = [];
  db.withTransaction = async (callback) =>
    callback(async (sql) => {
      if (sql.includes("SELECT id FROM game_rooms")) return [];
      if (sql.includes("SELECT prompt_index")) return [];
      if (sql.startsWith("INSERT INTO bot_game_prompt_usage"))
        return { affectedRows: 1 };
      if (sql.startsWith("INSERT INTO game_rooms")) return { insertId: 12 };
      throw new Error(`Unexpected query: ${sql}`);
    });
  db.query = async (sql) => {
    if (sql.includes("SET status='finished'")) return { affectedRows: 1 };
    throw new Error(`Unexpected query: ${sql}`);
  };
  msg.sendGroup = async (_threadId, text) => sent.push(text);
  msg.getUserName = async () => "لاعب";
  leaderboard.recordPoints = async (gameId, roomId, winners) =>
    awards.push({ gameId, roomId, winners });
  try {
    const engine = createPromptRaceEngine({
      id: "emoji-test",
      name: "خمن الإيموجي من الوصف",
      kind: "emoji-description",
      startAliases: ["خمنالإيموجي"],
      helpAliases: ["قواعدالإيموجي"],
      prompts: [
        { description: "حشرة تطير بين الأزهار وتصنع العسل.", answers: ["🐝"] },
      ],
    });
    const context = {
      isGroup: true,
      threadId: "emoji-round",
    };
    await engine.handleMessage({
      ...context,
      userId: "host",
      text: "/خمنالإيموجي",
    });
    assert.match(sent[0], /خمنوا الإيموجي من الوصف/);
    assert.match(sent[0], /حشرة تطير بين الأزهار/);

    await engine.handleMessage({
      ...context,
      userId: "wrong-text",
      text: "نحلة",
    });
    await engine.handleMessage({
      ...context,
      userId: "wrong-emoji",
      text: "🍯",
    });
    assert.equal(awards.length, 0);

    await engine.handleMessage({
      ...context,
      userId: "winner",
      text: "🐝",
    });
    assert.equal(awards[0].gameId, "emoji-test");
    assert.equal(awards[0].roomId, 12);
    assert.equal(awards[0].winners[0].psid, "winner");
    assert.match(sent.at(-1), /✅ 🐝/);
  } finally {
    db.withTransaction = originals.withTransaction;
    db.query = originals.query;
    msg.sendGroup = originals.sendGroup;
    msg.getUserName = originals.getUserName;
    leaderboard.recordPoints = originals.recordPoints;
  }
});
