const test = require("node:test");
const assert = require("node:assert/strict");
const { createSlidingWindowRateLimiter } = require("./rateLimiter");

test("sliding rate limits are independent per conversation key", () => {
  let timestamp = 0;
  const isRateLimited = createSlidingWindowRateLimiter(
    2,
    1000,
    () => timestamp,
  );

  assert.equal(isRateLimited("group-one:user"), false);
  assert.equal(isRateLimited("group-one:user"), false);
  assert.equal(isRateLimited("group-one:user"), true);
  assert.equal(isRateLimited("group-two:user"), false);

  timestamp = 1000;
  assert.equal(isRateLimited("group-one:user"), false);
});
