const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const db = require("../../database");
const msg = require("../../services/messenger");
const leaderboard = require("../../services/leaderboard");
const createPromptRaceEngine = require("../promptRaceEngine");
const { loadQuotes } = require("./quotes");

test("cartoon quote loader validates user-provided excerpts and title aliases", () => {
  const file = path.join(os.tmpdir(), `cartoon-quotes-${process.pid}-${Date.now()}.json`);
  assert.deepEqual(loadQuotes(file), []);
  fs.writeFileSync(
    file,
    JSON.stringify([
      {
        quote: "هذه جملة اختبارية أصلية",
        film: "مدينة الغيم",
        alt: ["مدينة الغيوم"],
      },
      { quote: "ينقصه اسم الفيلم" },
      { quote: "طويل".repeat(71), film: "فيلم" },
      null,
    ]),
  );
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    assert.deepEqual(loadQuotes(file), [
      {
        quote: "هذه جملة اختبارية أصلية",
        answers: ["مدينة الغيم", "مدينة الغيوم"],
      },
    ]);
  } finally {
    console.warn = originalWarn;
    fs.rmSync(file, { force: true });
  }
});

test("cartoon-film prompt asks for the film and accepts its title alias", async () => {
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
      if (sql.startsWith("INSERT INTO game_rooms")) return { insertId: 7 };
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
      id: "cartoon-film-test",
      name: "من أي فيلم كرتون؟",
      kind: "quote",
      startAliases: ["اختبارفيلم"],
      helpAliases: ["قواعداختبارفيلم"],
      promptQuestion: "من أي فيلم كرتون قيلت العبارة؟",
      customHelpText: "خمّن عنوان الفيلم.",
      prompts: [
        {
          quote: "هذه جملة اختبارية أصلية",
          answers: ["مدينة الغيم", "مدينة الغيوم"],
        },
      ],
    });

    await engine.handleMessage({
      isGroup: true,
      threadId: "cartoon-film-thread",
      userId: "host",
      text: "/اختبارفيلم",
    });
    assert.match(sent[0], /من أي فيلم كرتون قيلت العبارة؟/);
    assert.match(sent[0], /هذه جملة اختبارية أصلية/);

    await engine.handleMessage({
      isGroup: true,
      threadId: "cartoon-film-thread",
      userId: "winner",
      text: "مدينة الغيوم",
    });
    assert.equal(awards[0].gameId, "cartoon-film-test");
    assert.equal(awards[0].roomId, 7);
    assert.equal(awards[0].winners[0].psid, "winner");
  } finally {
    db.withTransaction = originals.withTransaction;
    db.query = originals.query;
    msg.sendGroup = originals.sendGroup;
    msg.getUserName = originals.getUserName;
    leaderboard.recordPoints = originals.recordPoints;
  }
});
