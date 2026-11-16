const test = require("node:test");
const assert = require("node:assert/strict");
const db = require("../../database");
const msg = require("../../services/messenger");
const PUZZLES = require("./puzzles");
const { _internal } = require("./engine");

test("every puzzle has one solution from its four shared core clues", () => {
  for (const puzzle of PUZZLES) {
    assert.equal(_internal.validCode(puzzle.code), true);
    assert.ok(puzzle.clues.every((clue) => _internal.clueMatches(puzzle.code, clue)));
    assert.deepEqual(
      _internal.findSolutions(puzzle.clues.slice(0, 4)),
      [puzzle.code],
    );
  }
});

test("every participant gets a unique clue, with core clues spread across players", () => {
  const puzzle = PUZZLES[0];
  const fourPlayers = ["a", "b", "c", "d"].map((psid) => ({ psid }));
  const sixPlayers = ["a", "b", "c", "d", "e", "f"].map((psid) => ({ psid }));

  const fourClues = _internal.assignClues(fourPlayers, puzzle);
  const sixClues = _internal.assignClues(sixPlayers, puzzle);

  assert.equal(Object.keys(fourClues).length, 4);
  assert.equal(new Set(Object.values(fourClues).map((clue) => clue.text)).size, 4);
  assert.deepEqual(
    Object.values(fourClues).map((clue) => clue.type).sort(),
    ["product", "product", "sum", "sum"],
  );
  assert.equal(Object.keys(sixClues).length, 6);
  assert.equal(new Set(Object.values(sixClues).map((clue) => clue.text)).size, 6);
});

test("guess parsing accepts Arabic and Persian numerals but rejects invalid codes", () => {
  assert.equal(_internal.parseGuess("٨٥٣٢"), "8532");
  assert.equal(_internal.parseGuess("۸۵۳۲"), "8532");
  assert.equal(_internal.parseGuess("رمز 8532"), null);
  assert.equal(_internal.parseGuess("8832"), null);
  assert.equal(_internal.parseGuess("0532"), null);
  assert.equal(_internal.parseGuess("853"), null);
});

test("guess feedback distinguishes exact and misplaced digits", () => {
  assert.deepEqual(_internal.feedback("8532", "8352"), {
    exact: 2,
    misplaced: 2,
  });
  assert.deepEqual(_internal.feedback("8532", "1479"), {
    exact: 0,
    misplaced: 0,
  });
});

test("failed private clue delivery cancels the game instead of starting without a clue", async () => {
  const originalTransaction = db.withTransaction;
  const originalSendPrivate = msg.sendPrivate;
  const originalSendGroup = msg.sendGroup;
  const groupMessages = [];
  const state = {
    roomId: 55,
    stage: "playing",
    round: 1,
    deadlineAt: new Date(Date.now() + 30_000).toISOString(),
    cluesByPlayer: { player: { text: "الدليل السري" } },
  };
  try {
    db.withTransaction = async (operation) => operation(async () => {});
    msg.sendPrivate = async () => false;
    msg.sendGroup = async (...args) => groupMessages.push(args);

    const delivered = await _internal.deliverClues(
      { id: 55, thread_id: "group" },
      state,
      [{ psid: "player", display_name: "لاعب" }],
    );

    assert.equal(delivered, false);
    assert.equal(state.stage, "cancelled");
    assert.equal(state.deadlineAt, null);
    assert.match(groupMessages[0][1], /لاعب/);
  } finally {
    db.withTransaction = originalTransaction;
    msg.sendPrivate = originalSendPrivate;
    msg.sendGroup = originalSendGroup;
  }
});
