const test = require("node:test");
const assert = require("node:assert/strict");
const db = require("../database");
const msg = require("../services/messenger");
const leaderboard = require("../services/leaderboard");
const createPromptRaceEngine = require("./promptRaceEngine");

test("prompt games rotate through distinct challenges before starting a new cycle", async () => {
  const originals = {
    withTransaction: db.withTransaction,
    query: db.query,
    one: db.one,
    sendGroup: msg.sendGroup,
    getUserName: msg.getUserName,
    recordPoints: leaderboard.recordPoints,
    random: Math.random,
  };
  const history = new Set();
  const rooms = new Map();
  const questions = [];
  const awards = [];
  let roomId = 0;
  db.withTransaction = async (callback) =>
    callback(async (sql, params = []) => {
      if (sql.includes("SELECT id FROM game_rooms"))
        return [...rooms.values()].filter(
          (room) =>
            room.threadId === params[0] &&
            room.gameId === params[1] &&
            room.status === "playing",
        );
      if (sql.includes("SELECT prompt_index FROM bot_game_prompt_usage"))
        return [...history]
          .filter(([gameId, threadId]) => gameId === params[0] && threadId === params[1])
          .map(([, , promptIndex]) => ({ prompt_index: promptIndex }));
      if (sql.startsWith("DELETE FROM bot_game_prompt_usage")) {
        for (const entry of [...history])
          if (entry[0] === params[0] && entry[1] === params[1])
            history.delete(entry);
        return { affectedRows: 1 };
      }
      if (sql.startsWith("INSERT INTO bot_game_prompt_usage")) {
        history.add([params[0], params[1], params[2]]);
        return { affectedRows: 1 };
      }
      if (sql.startsWith("INSERT INTO game_rooms")) {
        const id = ++roomId;
        rooms.set(id, {
          id,
          gameId: params[0],
          threadId: params[1],
          hostId: params[2],
          status: "playing",
        });
        return { insertId: id };
      }
      throw new Error(`Unexpected transactional query: ${sql}`);
    });
  db.query = async (sql, params = []) => {
    const room = rooms.get(params[0]);
    if (sql.includes("SET status='finished'") && room) room.status = "finished";
    return { affectedRows: room ? 1 : 0 };
  };
  db.one = async () => null;
  msg.sendGroup = async (_threadId, text) => {
    questions.push(text);
    return true;
  };
  msg.getUserName = async (userId) => `Player ${userId}`;
  leaderboard.recordPoints = async (...args) => {
    awards.push(args);
    return 1;
  };
  Math.random = () => 0;

  const engine = createPromptRaceEngine({
    id: "prompt-test",
    name: "اختبار",
    kind: "quote",
    startAliases: ["اختبار"],
    helpAliases: ["قواعدالاختبار"],
    prompts: [0, 1, 2].map((number) => ({
      quote: `عبارة ${number}`,
      answers: [`صاحب ${number}`],
    })),
  });
  const context = {
    isGroup: true,
    threadId: "prompt-thread",
    userId: "prompt-player",
  };

  try {
    for (let number = 0; number < 4; number++) {
      await engine.handleMessage({ ...context, text: "اختبار" });
      const question = questions.at(-1);
      assert.match(question, new RegExp(`عبارة ${number % 3}`));
      await engine.handleMessage({
        ...context,
        text: number === 0 ? "صاحب 0ت" : `صاحب ${number % 3}`,
      });
    }
    assert.equal(history.size, 1);
    assert.deepEqual(
      [...rooms.values()].map((room) => room.status),
      ["finished", "finished", "finished", "finished"],
    );

    const orderingEngine = createPromptRaceEngine({
      id: "ordering-test",
      name: "ترتيب الاختبار",
      kind: "ordering",
      startAliases: ["رتب"],
      helpAliases: ["قواعدرتب"],
      prompts: [
        {
          direction: "من الأول إلى الأخير",
          items: ["باء", "ألف", "جيم"],
          answers: [["ألف"], ["باء"], ["جيم"]],
        },
      ],
    });
    const orderingContext = { ...context, threadId: "ordering-thread" };
    await orderingEngine.handleMessage({ ...orderingContext, text: "رتب" });
    const promptCount = questions.length;
    await orderingEngine.handleMessage({
      ...orderingContext,
      text: "ألف و جيم ثم باء",
    });
    assert.equal(questions.length, promptCount);
    await orderingEngine.handleMessage({
      ...orderingContext,
      text: "الالف وبعدها باء وبعدها جيم",
    });
    assert.match(questions.at(-1), /ألف، باء، جيم/);

    const wordMarketEngine = createPromptRaceEngine({
      id: "wordmarket-test",
      name: "سوق الاختبار",
      kind: "wordmarket",
      startAliases: ["سوق"],
      helpAliases: ["قواعدالسوق"],
      prompts: [
        {
          category: "دولة",
          letter: "م",
          answers: ["مصر", "ماليزيا"],
        },
      ],
    });
    const marketContext = { ...context, threadId: "market-thread" };
    await wordMarketEngine.handleMessage({ ...marketContext, text: "سوق" });
    const marketPromptCount = questions.length;
    await wordMarketEngine.handleMessage({
      ...marketContext,
      text: "البرازيل",
    });
    assert.equal(questions.length, marketPromptCount);
    await wordMarketEngine.handleMessage({
      ...marketContext,
      text: "مصرر",
    });
    assert.match(questions.at(-1), /مصر/);

    const skipEngine = createPromptRaceEngine({
      id: "skip-test",
      name: "اختبار التخطي",
      kind: "ordering",
      startAliases: ["رتب"],
      helpAliases: ["قواعدرتب"],
      prompts: [
        {
          direction: "من الأول إلى الأخير",
          items: ["باء", "ألف"],
          answers: [["ألف"], ["باء"]],
          hint: "ابدأ بالعنصر الذي يأتي أولاً في الترتيب الأبجدي.",
        },
      ],
    });
    const skipContext = { ...context, threadId: "skip-thread" };
    await skipEngine.handleMessage({ ...skipContext, text: "رتب" });
    assert.match(questions.at(-1), /اكتب تلميح.*تخطي/);
    await skipEngine.handleMessage({ ...skipContext, text: "تلميح" });
    assert.match(questions.at(-1), /ابدأ بالعنصر الذي يأتي أولاً/);
    await skipEngine.handleMessage({ ...skipContext, text: "تلميح" });
    assert.match(questions.at(-1), /استُخدم تلميح هذا السؤال بالفعل/);
    const awardsBeforeSkip = awards.length;
    await skipEngine.handleMessage({ ...skipContext, text: "تخطي" });
    assert.match(questions.at(-1), /الإجابة الصحيحة: ألف، باء/);
    assert.equal(awards.length, awardsBeforeSkip);
  } finally {
    db.withTransaction = originals.withTransaction;
    db.query = originals.query;
    db.one = originals.one;
    msg.sendGroup = originals.sendGroup;
    msg.getUserName = originals.getUserName;
    leaderboard.recordPoints = originals.recordPoints;
    Math.random = originals.random;
  }
});

test("prompt race engine reacts with checkmark to the first correct answer", async () => {
  const reactions = [];
  const originalReact = msg.reactToMessage;
  const originalSendGroup = msg.sendGroup;
  const originalWithTx = db.withTransaction;
  const originalQuery = db.query;
  const originalOne = db.one;
  const originalUserName = msg.getUserName;
  const originalRecordPoints = leaderboard.recordPoints;

  msg.reactToMessage = async (threadId, messageId, emoji) => {
    reactions.push({ threadId, messageId, emoji });
    return true;
  };
  msg.sendGroup = async () => true;
  msg.getUserName = async () => "لاعب";
  leaderboard.recordPoints = async () => 1;
  db.one = async () => null;
  db.query = async () => ({ affectedRows: 1 });
  db.withTransaction = async (cb) =>
    cb(async (sql) => {
      if (sql.includes("SELECT id FROM game_rooms")) return [];
      if (sql.includes("SELECT prompt_index")) return [];
      if (sql.startsWith("INSERT INTO bot_game_prompt_usage")) return { affectedRows: 1 };
      if (sql.startsWith("INSERT INTO game_rooms")) return { insertId: 99 };
      return [];
    });

  const engine = createPromptRaceEngine({
    id: "react-test",
    name: "سباق التفاعل",
    kind: "quote",
    startAliases: ["سباق"],
    helpAliases: ["قواعدالسباق"],
    prompts: [{ quote: "العلم نور", answers: ["علي بن أبي طالب"] }],
  });

  try {
    const threadId = "thread-react";
    await engine.handleMessage({
      isGroup: true,
      threadId,
      userId: "user-1",
      messageId: "msg-start",
      text: "سباق",
    });

    // إجابة خاطئة -> لا تفاعل
    await engine.handleMessage({
      isGroup: true,
      threadId,
      userId: "user-2",
      messageId: "msg-wrong",
      text: "شخص آخر",
    });
    assert.equal(reactions.length, 0);

    // إجابة صحيحة -> تفاعل فوري بـ ✅
    await engine.handleMessage({
      isGroup: true,
      threadId,
      userId: "user-1",
      messageId: "msg-correct",
      text: "علي بن ابي طالب",
    });
    assert.equal(reactions.length, 1);
    assert.deepEqual(reactions[0], {
      threadId,
      messageId: "msg-correct",
      emoji: "✅",
    });
  } finally {
    msg.reactToMessage = originalReact;
    msg.sendGroup = originalSendGroup;
    db.withTransaction = originalWithTx;
    db.query = originalQuery;
    db.one = originalOne;
    msg.getUserName = originalUserName;
    leaderboard.recordPoints = originalRecordPoints;
  }
});
