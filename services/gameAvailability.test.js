const test = require("node:test");
const assert = require("node:assert/strict");
const db = require("../database");
const availability = require("./gameAvailability");

test("games are enabled by default until an owner disables them", async () => {
  const originalOne = db.one;
  db.one = async () => null;
  try {
    assert.equal(await availability.isEnabled("spy"), true);
  } finally {
    db.one = originalOne;
  }
});

test("persisted disabled states are interpreted correctly", async () => {
  const originalOne = db.one;
  let enabled = 0;
  db.one = async () => ({ enabled });
  try {
    assert.equal(await availability.isEnabled("drawing"), false);
    enabled = 1;
    assert.equal(await availability.isEnabled("drawing"), true);
  } finally {
    db.one = originalOne;
  }
});

test("enabling or disabling a game records its owner", async () => {
  const originalQuery = db.query;
  let call;
  db.query = async (sql, params) => {
    call = { sql, params };
    return { affectedRows: 1 };
  };
  try {
    await availability.setEnabled("spy", false, "owner-id");
    assert.match(call.sql, /INSERT INTO bot_game_controls/);
    assert.match(call.sql, /ON DUPLICATE KEY UPDATE/);
    assert.deepEqual(call.params, ["spy", 0, "owner-id"]);
  } finally {
    db.query = originalQuery;
  }
});
