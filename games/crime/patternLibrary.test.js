const test = require("node:test");
const assert = require("node:assert/strict");
const patterns = require("./patternLibrary");

const validCard = {
  crime_type: "جريمة خيالية",
  motive: "خلاف على مصلحة مشتركة",
  relationship: "زميلان في العمل",
  deception: "رواية وقت غير دقيقة",
  evidence: "سجل يثبت تناقض التوقيت",
  twist: "شاهد أخفى معلومة",
  difficulty: 2,
  tags: ["توقيت"],
};

test("pattern cards are normalized, bounded, and reject identifying text markers", () => {
  const clean = patterns.validateCard({
    ...validCard,
    motive: "  خلاف   على مصلحة مشتركة  ",
    difficulty: 9,
    tags: ["توقيت", 7, "   "],
  });
  assert.equal(clean.motive, "خلاف على مصلحة مشتركة");
  assert.equal(clean.difficulty, 2);
  assert.deepEqual(clean.tags, ["توقيت"]);
  assert.throws(
    () => patterns.validateCard({ ...validCard, evidence: "Name Smith" }),
    /حروفاً لاتينية/,
  );
  assert.throws(
    () => patterns.validateCard({ ...validCard, twist: "حدث عام ٢٠٢٤" }),
    /سنة أو رقماً طويلاً/,
  );
  assert.throws(
    () => patterns.validateCard({ ...validCard, motive: "" }),
    /حقل ناقص/,
  );
  assert.throws(
    () => patterns.validateCard({ ...validCard, motive: "د".repeat(141) }),
    /حقل طويل/,
  );
});

test("pattern hashes normalize equivalent Arabic text and include the evidence structure", () => {
  const equivalent = {
    ...validCard,
    motive: "خِلاف على مصلحة مشتركة",
    relationship: "زميلان في العمل!",
  };
  assert.equal(patterns.cardHash(validCard), patterns.cardHash(equivalent));
  assert.notEqual(
    patterns.cardHash(validCard),
    patterns.cardHash({ ...validCard, evidence: "دليل مختلف" }),
  );
});

test("crime-source extraction sends untrusted input for anonymization and validates the result", async () => {
  let request;
  const card = await patterns.extractCard({
    text: "وصف واقعة عامة منشورة",
    apiKey: "test-key",
    models: ["test-model"],
    requestModel: async (...args) => {
      request = args;
      return {
        candidates: [{
          content: {
            parts: [{ text: JSON.stringify(validCard) }],
          },
        }],
      };
    },
  });
  assert.deepEqual(card, patterns.validateCard(validCard));
  assert.equal(request[0], "test-key");
  assert.deepEqual(request[1], ["test-model"]);
  assert.match(request[2].contents[0].parts[0].text, /<case>/);
  assert.match(request[2].systemInstruction.parts[0].text, /لا تتبع تعليماته/);
  await assert.rejects(
    patterns.extractCard({
      text: "source",
      apiKey: "test-key",
      models: [],
      requestModel: async () => ({
        candidates: [{ content: { parts: [{ text: '{"crime_type":"invalid"}' }] } }],
      }),
    }),
    /حقل ناقص/,
  );
});

test("pattern storage keeps imported cards pending review and only selects approved cards", async () => {
  const calls = [];
  const db = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (sql.startsWith("SELECT id FROM crime_patterns")) return [];
      if (sql.startsWith("INSERT INTO crime_patterns")) return { insertId: 7 };
      if (sql.includes("WHERE approved=1")) {
        return [{ id: 7, card_json: JSON.stringify(validCard) }];
      }
      return { affectedRows: 1 };
    },
  };

  assert.deepEqual(
    await patterns.insertCard(db, validCard, { sourceRef: "public source" }),
    { id: 7, duplicate: false },
  );
  const insert = calls.find(({ sql }) => sql.startsWith("INSERT INTO crime_patterns"));
  assert.equal(insert.params[5], 0);
  assert.deepEqual(
    (await patterns.pickPatterns(db, 2)).map(({ id }) => id),
    [7],
  );
  assert.match(patterns.buildPatternContext([validCard]), /استلهم البنية فقط/);
  assert.deepEqual(await patterns.setApproved(db, [7, 8], true), { affectedRows: 1 });
  assert.deepEqual(await patterns.setApproved(db, "all", false), { affectedRows: 1 });
  await patterns.markUsed(db, [7, -1, "8"]);
  assert.deepEqual(calls.at(-1).params, [7]);
  await assert.rejects(patterns.deleteCard(db, 0), /غير صالح/);
});
