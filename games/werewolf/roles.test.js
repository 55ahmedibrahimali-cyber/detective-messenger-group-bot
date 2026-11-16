const test = require("node:test");
const assert = require("node:assert/strict");
const { ROLES, createRoleSet } = require("./roles");
const {
  tallyWeightedVotes,
  mixedLoversWin,
  mixedLoversAreAlive,
  commandParts,
} = require("./engine");

test("the werewolf lobby supports a text join command as well as reactions", () => {
  assert.equal(commandParts("/انضمذئب").command, "join");
  assert.equal(commandParts("انضمذئب").command, "join");
});

test("Cupid is added at eight players while all role sets match player count", () => {
  for (let count = 4; count <= 8; count++) {
    const roles = createRoleSet(count, () => 0);
    assert.equal(roles.length, count);
    assert.equal(
      roles.filter((role) => role.key === "cupid").length,
      count >= 8 ? 1 : 0,
    );
    assert.equal(
      roles.filter((role) => role.key === "werewolf").length,
      Math.floor(count / 4),
    );
    assert.ok(roles.every((role) => role.team === ROLES[role.key].team));
  }
  assert.throws(() => createRoleSet(3), RangeError);
  assert.throws(() => createRoleSet(9), RangeError);
});

test("cross-team lovers win only when they are the last two alive", () => {
  const couple = [
    { id: 4, team: "wolves" },
    { id: 7, team: "village" },
  ];
  assert.equal(mixedLoversWin(couple, [4, 7]), true);
  assert.equal(mixedLoversWin(couple, [4, 8]), false);
  assert.equal(
    mixedLoversWin([...couple, { id: 9, team: "village" }], [4, 7]),
    false,
  );
  assert.equal(
    mixedLoversWin(
      [
        { id: 4, team: "village" },
        { id: 7, team: "village" },
      ],
      [4, 7],
    ),
    false,
  );
});

test("living cross-team lovers override normal team parity until their goal", () => {
  const lovers = [
    { id: 4, team: "wolves", is_alive: 1 },
    { id: 7, team: "village", is_alive: 1 },
  ];
  assert.equal(mixedLoversAreAlive(lovers, [4, 7]), true);
  assert.equal(
    mixedLoversAreAlive(
      [...lovers, { id: 9, team: "village", is_alive: 1 }],
      [4, 7],
    ),
    true,
  );
  assert.equal(
    mixedLoversAreAlive(
      [
        { id: 4, team: "wolves", is_alive: 0 },
        { id: 7, team: "village", is_alive: 1 },
      ],
      [4, 7],
    ),
    false,
  );
});

test("the sheriff's vote counts twice without duplicating ballot records", () => {
  const result = tallyWeightedVotes(
    [
      { voter_player_id: 1, target_player_id: 4 },
      { voter_player_id: 2, target_player_id: 3 },
      { voter_player_id: 3, target_player_id: 4 },
    ],
    2,
  );
  assert.deepEqual(
    result.sort((left, right) => left.targetId - right.targetId),
    [
      { targetId: 3, count: 2 },
      { targetId: 4, count: 2 },
    ],
  );
});
