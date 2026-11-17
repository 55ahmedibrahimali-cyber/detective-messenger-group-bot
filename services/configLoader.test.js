const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { applyConfig, loadConfig } = require("./configLoader");

test("configuration files provide defaults without overriding host values", () => {
  const env = { MAX_PLAYERS: "10" };
  applyConfig({ MAX_PLAYERS: 8, DISCUSSION_SECONDS: 120 }, env);
  assert.equal(env.MAX_PLAYERS, "10");
  assert.equal(env.DISCUSSION_SECONDS, "120");
});

test("configuration files cannot contain secret variables", () => {
  assert.throws(
    () => applyConfig({ DB_PASSWORD: "must-not-be-here" }, {}),
    /must be provided through the environment/,
  );
});

test("the checked-in general and game files load without injecting secrets", () => {
  const env = {};
  loadConfig(path.resolve(__dirname, ".."), env);
  assert.ok(env.DB_HOST);
  assert.ok(env.MIN_PLAYERS);
  assert.ok(env.SPY_MIN_PLAYERS);
  assert.equal(env.DB_PASSWORD, undefined);
});
