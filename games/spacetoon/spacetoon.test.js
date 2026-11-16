const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const db = require("../../database");
const msg = require("../../services/messenger");
const leaderboard = require("../../services/leaderboard");
const createPromptRaceEngine = require("../promptRaceEngine");
const { loadSongs } = require("./songs");

const { lyricMatches } = createPromptRaceEngine._internal;

// كل النصوص هنا مؤلفة للاختبار فقط وليست من أي أغنية حقيقية.
const EXPECTED = "ديناصور كبير بيرقص في الشارع";

test("lyric matching tolerates small mistakes but keeps word order", () => {
  assert.equal(lyricMatches(EXPECTED, EXPECTED), true);
  assert.equal(lyricMatches("ديناصور كبير بيرقص في الشارع!!", EXPECTED), true);
  assert.equal(lyricMatches("دينصور كبير بيرقص فى الشارع", EXPECTED), true);
  assert.equal(lyricMatches("ديناصور كبير بيرقص الشارع", EXPECTED), true);
  assert.equal(lyricMatches("الشارع في بيرقص كبير ديناصور", EXPECTED), false);
  assert.equal(lyricMatches("ديناصور", EXPECTED), false);
  assert.equal(lyricMatches("كلام تاني خالص مالوش علاقة", EXPECTED), false);
  assert.equal(lyricMatches("", EXPECTED), false);
  const longAnswer =
    "فهد يلاحق فراشة حمراء قرب شجرة عالية عند النهر الهادئ مساء كل يوم";
  assert.equal(
    lyricMatches("فهد يلاحق فراشة حمراء قرب شجرة عند النهر مساء كل يوم", longAnswer),
    true,
  );
  assert.equal(
    lyricMatches("فهد يلاحق فراشة حمراء شجرة عند النهر مساء كل يوم", longAnswer),
    false,
  );
  assert.equal(lyricMatches(`${longAnswer} كلام إضافي`, longAnswer), false);
  assert.equal(lyricMatches("جزمة حمرا", "جزمة حمرا"), true);
  assert.equal(lyricMatches("جزمة", "جزمة حمرا"), false);
  assert.equal(lyricMatches(`${"كلمة ".repeat(30)}${EXPECTED}`, EXPECTED), false);
});

test("songs file loader validates entries and tolerates a missing file", () => {
  const file = path.join(os.tmpdir(), `songs-${process.pid}-${Date.now()}.json`);
  assert.deepEqual(loadSongs(file), []);
  fs.writeFileSync(
    file,
    JSON.stringify([
      { show: "مثال", line: "سطر أول", answer: "سطر ثاني", alt: ["سطر تاني"] },
      { line: "ناقص الإجابة" },
      { line: "x".repeat(500), answer: "طويل" },
      "not an object",
    ]),
  );
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    assert.deepEqual(loadSongs(file), [
      { line: "سطر أول", show: "مثال", answers: ["سطر ثاني", "سطر تاني"] },
    ]);
  } finally {
    console.warn = originalWarn;
  }
  fs.writeFileSync(file, "{not json");
  assert.throws(() => loadSongs(file), /not valid JSON/);
  fs.writeFileSync(file, "{}");
  assert.throws(() => loadSongs(file), /JSON array/);
  fs.rmSync(file);
});

test("the shipped game stays loadable with no songs and says so", async () => {
  const spacetoon = require("./index");
  assert.equal(spacetoon.id, "spacetoon");
  const originalSend = msg.sendGroup;
  const sent = [];
  msg.sendGroup = async (threadId, text) => sent.push(text);
  try {
    const engine = createPromptRaceEngine({
      id: "spacetoon-empty",
      name: "أكمل الأغنية",
      kind: "lyric",
      startAliases: ["أغنية"],
      helpAliases: ["قواعد"],
      prompts: [],
      allowEmpty: true,
      emptyMessage: "مفيش أغاني",
    });
    await engine.handleMessage({ isGroup: true, threadId: "t", userId: "u", text: "/أغنية" });
    assert.deepEqual(sent, ["مفيش أغاني"]);
    assert.throws(
      () =>
        createPromptRaceEngine({
          id: "x",
          name: "x",
          kind: "lyric",
          startAliases: ["x"],
          helpAliases: ["y"],
          prompts: [],
        }),
      /needs prompts/,
    );
  } finally {
    msg.sendGroup = originalSend;
  }
});

test("a lyric round shows the line, ignores wrong guesses and awards the first correct completion", async () => {
  const originals = {
    withTransaction: db.withTransaction,
    query: db.query,
    one: db.one,
    sendGroup: msg.sendGroup,
    getUserName: msg.getUserName,
    recordPoints: leaderboard.recordPoints,
  };
  const sent = [];
  const awards = [];
  let finished = false;
  db.withTransaction = async (callback) =>
    callback(async (sql) => {
      if (sql.includes("SELECT id FROM game_rooms")) return [];
      if (sql.includes("SELECT prompt_index")) return [];
      if (sql.startsWith("INSERT INTO bot_game_prompt_usage")) return { affectedRows: 1 };
      if (sql.startsWith("INSERT INTO game_rooms")) return { insertId: 7 };
      throw new Error(`Unexpected query: ${sql}`);
    });
  db.query = async (sql) => {
    if (sql.includes("SET status='finished'")) finished = true;
    return { affectedRows: 1 };
  };
  msg.sendGroup = async (threadId, text) => sent.push(text);
  msg.getUserName = async (userId) => (userId === "u2" ? "منى" : "أحمد");
  leaderboard.recordPoints = async (gameId, roomId, winners) =>
    awards.push({ gameId, roomId, winners });
  try {
    const engine = createPromptRaceEngine({
      id: "spacetoon",
      name: "أكمل الأغنية",
      kind: "lyric",
      startAliases: ["أغنية"],
      helpAliases: ["قواعد"],
      prompts: [
        { line: "ديناصور كبير", show: "مثال", answers: [EXPECTED, "ديناصور كبير بيرقص بالشارع"] },
      ],
    });
    const base = { isGroup: true, threadId: "round-thread" };
    await engine.handleMessage({ ...base, userId: "u1", text: "/أغنية" });
    assert.match(sent[0], /كمّلوا الأغنية من «مثال»/);
    assert.match(sent[0], /«ديناصور كبير \.\.\.»/);

    await engine.handleMessage({ ...base, userId: "u1", text: "مش عارف" });
    await engine.handleMessage({ ...base, userId: "u1", text: "ديناصور" });
    assert.equal(sent.length, 1);
    assert.equal(awards.length, 0);

    await engine.handleMessage({ ...base, userId: "u2", text: "ديناصور كبير بيرقص في الشارع" });
    assert.equal(awards.length, 1);
    assert.equal(awards[0].gameId, "spacetoon");
    assert.equal(awards[0].winners[0].psid, "u2");
    assert.equal(finished, true);
    assert.match(sent.at(-1), new RegExp(`✅ ${EXPECTED} — نقطة لـمنى`));

    // بعد انتهاء الجولة تُتجاهل الإجابات المتأخرة.
    await engine.handleMessage({ ...base, userId: "u1", text: EXPECTED });
    assert.equal(awards.length, 1);
  } finally {
    Object.assign(db, { withTransaction: originals.withTransaction, query: originals.query, one: originals.one });
    msg.sendGroup = originals.sendGroup;
    msg.getUserName = originals.getUserName;
    leaderboard.recordPoints = originals.recordPoints;
  }
});
