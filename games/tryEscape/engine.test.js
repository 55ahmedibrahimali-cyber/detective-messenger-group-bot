const test = require("node:test");
const assert = require("node:assert/strict");
const { _internal } = require("./engine");

test("answer assignments are shuffled without returning a player's own answer", () => {
  const players = ["11", "22", "33", "44", "55"].map((psid) => ({ psid }));
  const answers = Object.fromEntries(
    players.map((player) => [player.psid, `answer-${player.psid}`]),
  );

  for (let attempt = 0; attempt < 20; attempt++) {
    const assigned = _internal.assignAnswers(players, answers);
    assert.deepEqual(
      Object.keys(assigned).sort(),
      players.map((player) => player.psid).sort(),
    );
    assert.deepEqual(
      Object.values(assigned)
        .map((card) => card.text)
        .sort(),
      Object.values(answers).sort(),
    );
    for (const player of players)
      assert.notEqual(assigned[player.psid].authorId, player.psid);
  }
});

test("the judge is selected from a valid group and undersized games are rejected", () => {
  const players = ["11", "22", "33", "44"].map((psid) => ({ psid }));
  assert.ok(players.includes(_internal.selectJudge(players)));
  assert.throws(() => _internal.selectJudge(players.slice(0, 3)), /أربعة/);
});

test("elimination accepts a one-based Arabic number or normalized player name", () => {
  const contestants = [
    { psid: "11", display_name: "أحمد علي" },
    { psid: "22", display_name: "سارة" },
  ];
  assert.equal(
    _internal.parseEliminationTarget("٢", contestants),
    contestants[1],
  );
  assert.equal(
    _internal.parseEliminationTarget("احمد علي", contestants),
    contestants[0],
  );
  assert.equal(_internal.parseEliminationTarget("3", contestants), null);
});
