const test = require("node:test");
const assert = require("node:assert/strict");
const verification = require("./privateChatVerification");

test("private-chat verification failures provide a safe user hint", () => {
  assert.equal(
    verification.isPrivateChatVerificationError(
      "The recipient has not started a conversation",
    ),
    true,
  );
  assert.match(
    verification.userHint("message request is pending"),
    /إرسال رسالة أولاً/,
  );
  assert.equal(verification.userHint("ETIMEDOUT"), null);
});