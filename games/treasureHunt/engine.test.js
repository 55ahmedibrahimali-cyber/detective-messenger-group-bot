const test = require("node:test");
const assert = require("node:assert/strict");
const { _internal } = require("./engine");

test("Arabic answers tolerate diacritics, hamza forms, and the definite article", () => {
  assert.equal(_internal.isCorrectAnswer("المنارة", ["منارة"]), true);
  assert.equal(_internal.isCorrectAnswer("مَغَارَة", ["المغارة"]), true);
  assert.equal(_internal.isCorrectAnswer("ميناء", ["مرسى", "ميناء"]), true);
  assert.equal(_internal.isCorrectAnswer("شاطئ", ["كهف"]), false);
});

test("a hint costs one key and only one hint can be used for each clue", () => {
  const state = {
    stage: "clue",
    round: 2,
    keys: { player: 3, another: 1 },
    hintUsed: [],
  };

  assert.equal(_internal.spendHint(state, "another"), false);
  assert.equal(_internal.spendHint(state, "player"), true);
  assert.equal(state.keys.player, 2);
  assert.equal(_internal.spendHint(state, "player"), false);
  assert.equal(state.keys.player, 2);
});

test("only key holders enter the final lock unless nobody has a key", () => {
  const players = [
    { psid: "1", display_name: "أ" },
    { psid: "2", display_name: "ب" },
    { psid: "3", display_name: "ج" },
  ];

  assert.deepEqual(
    _internal.finalPlayers(players, { keys: { "2": 1 } }),
    [players[1]],
  );
  assert.deepEqual(_internal.finalPlayers(players, { keys: {} }), players);
});

test("if the final lock stays closed, all players tied for most keys win", () => {
  const players = [
    { psid: "1", display_name: "أ" },
    { psid: "2", display_name: "ب" },
    { psid: "3", display_name: "ج" },
  ];

  assert.deepEqual(
    _internal.topKeyWinners(players, { keys: { "1": 1, "2": 2, "3": 2 } }),
    [players[1], players[2]],
  );
  assert.deepEqual(_internal.topKeyWinners(players, { keys: {} }), []);
});
