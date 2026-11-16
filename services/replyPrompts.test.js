const test = require("node:test");
const assert = require("node:assert/strict");
const { isReplyToBotPrompt } = require("./replyPrompts");

test("reply actions require the marked bot prompt", () => {
  const prompt = {
    body: "🗳️ بطاقة التصويت",
    senderID: "bot-id",
  };

  assert.equal(isReplyToBotPrompt(prompt, "بطاقة التصويت", "bot-id"), true);
  assert.equal(isReplyToBotPrompt(prompt, "بطاقة القدرة", "bot-id"), false);
  assert.equal(
    isReplyToBotPrompt({ ...prompt, senderID: "player-id" }, "بطاقة التصويت", "bot-id"),
    false,
  );
  assert.equal(isReplyToBotPrompt(prompt, "بطاقة التصويت"), false);
  assert.equal(isReplyToBotPrompt(prompt, "بطاقة التصويت", ""), false);
  assert.equal(
    isReplyToBotPrompt({ body: prompt.body }, "بطاقة التصويت", "bot-id"),
    false,
  );
  assert.equal(isReplyToBotPrompt(null, "بطاقة التصويت", "bot-id"), false);
});
