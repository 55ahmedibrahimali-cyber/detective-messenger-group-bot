const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { buildSchema } = require("./setupDatabase");

const baseSchema = fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8");

test("database setup targets a pre-created hosting database without CREATE privilege", () => {
  const schema = buildSchema(baseSchema, "panel_bot_db", false);
  assert.doesNotMatch(schema, /CREATE DATABASE|^\s*USE\s+/im);
  assert.match(schema, /CREATE TABLE IF NOT EXISTS bot_user_bans/);
});

test("database setup creates and selects the configured database by default", () => {
  const schema = buildSchema(baseSchema, "local_bot_db", true);
  assert.match(schema, /CREATE DATABASE IF NOT EXISTS `local_bot_db`/);
  assert.match(schema, /USE `local_bot_db`;/);
  assert.match(schema, /CREATE TABLE IF NOT EXISTS bot_user_bans/);
});

test("database setup rejects unsafe database names", () => {
  assert.throws(
    () => buildSchema(baseSchema, "invalid`name", false),
    /DB_NAME must be/,
  );
});
