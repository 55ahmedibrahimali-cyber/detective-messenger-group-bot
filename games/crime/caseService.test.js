const test = require("node:test");
const assert = require("node:assert/strict");
const crime = require("./caseService");
const game = require("./index");

test("all built-in cases concern the murder of a man named Karim", () => {
  for (const { data } of crime.builtinCases) {
    assert.doesNotThrow(() => crime.validateGeneratedCase(data, null));
    assert.equal(data.clues.length, 3);
    for (const clue of data.clues) {
      assert.ok(clue.clue_text.length <= 180);
      assert.equal(clue.points_to, "killer");
      assert.equal(clue.target_key, data.killer.key);
    }
    assert.equal(data.victim_name, "كريم");
    assert.match(data.victim_desc, /رجل/);
    assert.match(data.victim_desc, /مقتول/);
    assert.match(data.summary, /كريم/);
    assert.match(data.summary, /قتل|قُتل|مقتل/);
    assert.match(data.solution, /كريم/);
    assert.match(data.solution, /قتل/);
  }
});

test("public case text replaces fictional character names with account names", () => {
  const players = [
    { character_name: "سامي، فني الأجهزة", display_name: "حساب سامي الرسمي" },
    { character_name: "ليلى، مساعدة الباحث", display_name: "ليلى من Messenger" },
  ];
  assert.equal(
    game.engine.replaceCharacterNames(
      "قال سامي إن ليلى كانت معه، لكن سامي دخل الغرفة.",
      players,
    ),
    "قال حساب سامي الرسمي إن ليلى من Messenger كانت معه، لكن حساب سامي الرسمي دخل الغرفة.",
  );
});

test("generated cases with a different victim are rejected", () => {
  const invalidCase = structuredClone(crime.builtinCases[0].data);
  invalidCase.victim_name = "نادر";
  assert.throws(
    () => crime.validateGeneratedCase(invalidCase, null),
    /يجب أن يكون كريم هو ضحية القضية/,
  );
});

test("the crime game starts only with جريمة", () => {
  assert.equal(game.name, "مين قتل كريم");
  assert.equal(game.startCommand, "جريمة");
  assert.deepEqual(game.startAliases, ["جريمة"]);
  assert.deepEqual(game.engine.parseCommand("جريمة"), {
    name: "new",
    arg: "",
  });
  assert.deepEqual(game.engine.parseCommand("/جريمة"), {
    name: "new",
    arg: "",
  });
  assert.equal(game.engine.parseCommand("مين قتل كريم"), null);
  assert.equal(game.engine.parseCommand("/مين قتل كريم"), null);
  assert.equal(game.engine.parseCommand("قتل كريم"), null);
  assert.equal(game.engine.parseCommand("/قتل كريم"), null);
  assert.deepEqual(game.engine.parseCommand("/قواعدقتل كريم"), {
    name: "help",
    arg: "",
  });
});
