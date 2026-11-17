"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  DAILY_SEARCH_LIMIT,
  reservePinterestDailySearch,
} = require("./dailyQuota");

function createMemoryQuery() {
  const rows = new Map();
  return async (sql, params) => {
    if (sql.startsWith("INSERT INTO bot_pinterest_daily_usage")) {
      const key = `${params[0]}:${params[1]}`;
      if (!rows.has(key)) rows.set(key, 0);
      return { affectedRows: 1 };
    }
    if (sql.startsWith("UPDATE bot_pinterest_daily_usage")) {
      const key = `${params[0]}:${params[1]}`;
      const count = rows.get(key) || 0;
      if (count >= params[2]) return { affectedRows: 0 };
      rows.set(key, count + 1);
      return { affectedRows: 1 };
    }
    throw new Error(`Unexpected SQL: ${sql}`);
  };
}

test("Pinterest daily quota is per user and resets on the next UTC date", async () => {
  const query = createMemoryQuery();

  for (let count = 0; count < DAILY_SEARCH_LIMIT; count += 1) {
    assert.equal(
      await reservePinterestDailySearch(query, "user-1", "2026-11-17"),
      true,
    );
  }
  assert.equal(
    await reservePinterestDailySearch(query, "user-1", "2026-11-17"),
    false,
  );
  assert.equal(
    await reservePinterestDailySearch(query, "user-2", "2026-11-17"),
    true,
  );
  assert.equal(
    await reservePinterestDailySearch(query, "user-1", "2026-11-18"),
    true,
  );
});

test("concurrent Pinterest searches cannot exceed the daily quota", async () => {
  const query = createMemoryQuery();
  const results = await Promise.all(
    Array.from({ length: 20 }, () =>
      reservePinterestDailySearch(query, "user-1", "2026-11-17"),
    ),
  );

  assert.equal(results.filter(Boolean).length, DAILY_SEARCH_LIMIT);
});

test("daily quota rejects malformed identity and date inputs", async () => {
  const query = createMemoryQuery();
  await assert.rejects(
    reservePinterestDailySearch(query, "", "2026-11-17"),
    /valid Pinterest user ID/,
  );
  await assert.rejects(
    reservePinterestDailySearch(query, "user-1", "2026-02-30"),
    /valid UTC date/,
  );
});
