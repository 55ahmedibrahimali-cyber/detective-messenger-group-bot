const test = require("node:test");
const assert = require("node:assert/strict");
const welcome = require("./welcome");

test("Messenger member-add events produce one Joud greeting", () => {
  const result = welcome.messengerMemberAdded(
    {
      type: "event",
      threadID: "group-1",
      logMessageType: "log:subscribe",
      logMessageData: {
        addedParticipants: [{ userFbId: "new-member" }],
      },
    },
    "bot-id",
  );
  assert.deepEqual(result, {
    threadId: "group-1",
    text: welcome.MESSAGE,
  });
  assert.match(result.text, /أنا جود/);
});

test("Messenger ignores bot-only and unrelated events", () => {
  assert.equal(
    welcome.messengerMemberAdded(
      {
        type: "event",
        threadID: "group-1",
        logMessageType: "log:subscribe",
        logMessageData: { addedParticipants: [{ userFbId: "bot-id" }] },
      },
      "bot-id",
    ),
    null,
  );
  assert.equal(
    welcome.messengerMemberAdded(
      { type: "event", logMessageType: "log:thread-name" },
      "bot-id",
    ),
    null,
  );
});

test("Telegram member-add messages greet human members, not the bot itself", () => {
  assert.deepEqual(
    welcome.telegramMemberAdded(
      {
        chat: { id: -123, type: "supergroup" },
        new_chat_members: [{ id: 8 }],
      },
      99,
    ),
    { threadId: "-123", text: welcome.MESSAGE },
  );
  assert.equal(
    welcome.telegramMemberAdded(
      {
        chat: { id: -123, type: "group" },
        new_chat_members: [{ id: 99 }],
      },
      99,
    ),
    null,
  );
});
