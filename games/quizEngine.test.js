const test = require("node:test");
const assert = require("node:assert/strict");
const db = require("../database");
const msg = require("../services/messenger");
const leaderboard = require("../services/leaderboard");
const createQuizEngine = require("./quizEngine");

test("quiz rounds pick a question without choices and finish on the first correct answer", async () => {
  const originals = {
    one: db.one,
    query: db.query,
    sendGroup: msg.sendGroup,
    sendPrivate: msg.sendPrivate,
    getUserName: msg.getUserName,
    recordPoints: leaderboard.recordPoints,
    random: Math.random,
  };
  const messages = [];
  const queries = [];
  const awards = [];
  db.one = async () => null;
  db.query = async (sql, params) => {
    queries.push({ sql, params });
    return { insertId: 42, affectedRows: 1 };
  };
  msg.sendGroup = async (_threadId, text) => messages.push(text);
  msg.sendPrivate = async () => {};
  msg.getUserName = async (userId) => `Player ${userId}`;
  leaderboard.recordPoints = async (...args) => awards.push(args);
  Math.random = () => 0;

  const engine = createQuizEngine({
    id: "quiz-test",
    name: "اختبار",
    startAliases: ["اختبار"],
    helpAliases: ["قواعداختبار"],
    questions: [
      { text: "ما عاصمة أستراليا؟", answers: ["كانبرا"] },
      { text: "ما رمز الحديد؟", answers: ["الحديد"] },
    ],
  });
  const context = {
    isGroup: true,
    threadId: "quiz-test-thread",
    userId: "user-1",
  };

  try {
    await engine.handleMessage({ ...context, text: "اختبار" });
    assert.match(messages.at(-1), /ما عاصمة أستراليا؟/);
    assert.doesNotMatch(messages.at(-1), /A\)|B\)|C\)|D\)/);

    await engine.handleMessage({ ...context, text: "سيدني" });
    assert.equal(messages.length, 1);
    assert.equal(awards.length, 0);

    await engine.handleMessage({ ...context, text: "كانبراا" });
    assert.match(messages.at(-1), /صح/);
    assert.equal(awards.length, 1);
    assert.equal(awards[0][0], "quiz-test");
    assert.equal(awards[0][1], 42);
    assert.deepEqual(awards[0][2], [
      { psid: "user-1", display_name: "Player user-1" },
    ]);
    assert.match(
      queries.at(-1).sql,
      /SET status='finished', phase='finished'/,
    );

    await engine.handleMessage({ ...context, text: "كانبرا" });
    assert.equal(awards.length, 1);
    assert.match(messages.at(-1), /لا توجد جولة نشطة/);

    await engine.handleMessage({ ...context, text: "اختبار" });
    assert.match(messages.at(-1), /اكتب تلميح.*تخطي/);
    await engine.handleMessage({ ...context, text: "تلميح" });
    assert.match(messages.at(-1), /تبدأ الإجابة بحرف «ح»/);
    await engine.handleMessage({ ...context, text: "تلميح" });
    assert.match(messages.at(-1), /استُخدم تلميح هذا السؤال بالفعل/);
    await engine.handleMessage({ ...context, text: "تخطي" });
    assert.match(messages.at(-1), /الإجابة الصحيحة: الحديد/);
    assert.equal(awards.length, 1);
    assert.match(queries.at(-1).sql, /SET status='finished', phase='finished'/);
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
