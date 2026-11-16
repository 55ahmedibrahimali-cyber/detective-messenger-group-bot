const test = require("node:test");
const assert = require("node:assert/strict");
const config = require("./config");

test("werewolf player count is fixed between four and eight", () => {
  assert.equal(config.MIN_PLAYERS, 4);
  assert.equal(config.MAX_PLAYERS, 8);
});
