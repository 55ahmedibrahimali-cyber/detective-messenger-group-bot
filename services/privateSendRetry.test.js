const test = require("node:test");
const assert = require("node:assert/strict");
const {
  shouldRetryPrivateSend,
  sendWithPrivateRetry,
} = require("./privateSendRetry");

test("private sends retry one transient network failure, then stop", async () => {
  let attempts = 0;
  const delays = [];
  const result = await sendWithPrivateRetry(
    async () => {
      attempts++;
      if (attempts === 1)
        throw Object.assign(new Error("request failed"), { code: "ETIMEDOUT" });
      return "sent";
    },
    async (delay) => delays.push(delay),
  );

  assert.equal(result, "sent");
  assert.equal(attempts, 2);
  assert.deepEqual(delays, [1500]);
  assert.equal(
    shouldRetryPrivateSend(
      Object.assign(new Error("connection reset"), { code: "ECONNRESET" }),
      1,
    ),
    false,
  );
});

test("private sends do not retry Facebook refusals or verification failures", async () => {
  const failures = [
    new Error("spam detected"),
    new Error("rate limit exceeded"),
    new Error("Facebook error 1545012"),
    Object.assign(new Error("request failed"), {
      code: "ECONNRESET",
      error: "Facebook rate limit reached",
    }),
    new Error("The recipient has not started a conversation"),
    Object.assign(new Error("connection reset"), { safetyBlocked: true }),
  ];

  for (const error of failures) {
    let attempts = 0;
    await assert.rejects(
      sendWithPrivateRetry(async () => {
        attempts++;
        throw error;
      }, async () => {}),
    );
    assert.equal(attempts, 1);
    assert.equal(shouldRetryPrivateSend(error), false);
  }
});