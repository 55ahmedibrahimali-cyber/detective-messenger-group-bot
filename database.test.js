"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { _internal } = require("./database");

test("fixed replies schema migration adds an auto-increment id without replacing an existing primary key", async () => {
  const statements = [];
  const executeQuery = async (sql) => statements.push(sql);

  const migrated = await _internal.ensureFixedRepliesIdColumn(
    [
      { COLUMN_NAME: "trigger_key", COLUMN_KEY: "PRI" },
      { COLUMN_NAME: "trigger_text", COLUMN_KEY: "" },
    ],
    executeQuery,
  );

  assert.equal(migrated, true);
  assert.deepEqual(statements, [
    "ALTER TABLE bot_fixed_replies ADD COLUMN id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT UNIQUE FIRST",
  ]);
});

test("fixed replies schema migration makes id primary when the legacy table has no primary key", async () => {
  const statements = [];
  await _internal.ensureFixedRepliesIdColumn(
    [{ COLUMN_NAME: "trigger_text", COLUMN_KEY: "" }],
    async (sql) => statements.push(sql),
  );

  assert.deepEqual(statements, [
    "ALTER TABLE bot_fixed_replies ADD COLUMN id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY FIRST",
  ]);
});

test("fixed replies schema migration leaves an existing id unchanged", async () => {
  let executed = false;
  const migrated = await _internal.ensureFixedRepliesIdColumn(
    [{ COLUMN_NAME: "id", COLUMN_KEY: "PRI" }],
    async () => {
      executed = true;
    },
  );

  assert.equal(migrated, false);
  assert.equal(executed, false);
});
