const test = require("node:test");
const assert = require("node:assert/strict");
const telegram = require("./telegram");

test("Telegram message contexts preserve group, private, and reply identifiers", () => {
  const group = telegram.contextFromMessage({
    message_id: 123,
    chat: { id: -100123, type: "supergroup" },
    from: { id: 456 },
    text: " /مساعدة ",
    reply_to_message: {
      from: { id: 789 },
      text: "سؤال سابق",
    },
  });
  assert.deepEqual(group, {
    userId: "456",
    threadId: "-100123",
    messageId: "123",
    isGroup: true,
    userName: "",
    text: "/مساعدة",
    messageReply: { senderID: "789", body: "سؤال سابق" },
  });

  const direct = telegram.contextFromMessage({
    message_id: 124,
    chat: { id: 456, type: "private" },
    from: { id: 456 },
    text: "/start",
  });
  assert.equal(direct.threadId, "456");
  assert.equal(direct.messageId, "124");
  assert.equal(direct.isGroup, false);
  assert.equal(direct.text, "/start");
  assert.equal(
    telegram.contextFromMessage({
      message_id: 125,
      chat: { id: 1, type: "private" },
      from: { id: 1, first_name: "سارة", last_name: "علي" },
      text: "أهلاً",
    }).userName,
    "سارة علي",
  );
  assert.equal(
    telegram.contextFromMessage({
      message_id: 126,
      chat: { id: 456, type: "private" },
      from: { id: 456 },
      caption: "/تصميم تحسين",
    }).text,
    "/تصميم تحسين",
  );
});

test("Telegram helpers classify chats, translate Messenger lobby prompts, and split Unicode safely", () => {
  assert.equal(telegram.isGroupChat({ type: "group" }), true);
  assert.equal(telegram.isGroupChat({ type: "supergroup" }), true);
  assert.equal(telegram.isGroupChat({ type: "private" }), false);
  assert.match(telegram.platformText("تفاعل للانضمام"), /اضغط «انضمام/);
  assert.match(
    telegram.platformText("تعذّر إرسال الخاص. راجع طلبات الرسائل."),
    /\/start/,
  );
  assert.match(
    telegram.platformText("لم تصل الأدوار؛ راجعوا طلبات الرسائل وأعيدوا المحاولة."),
    /\/start/,
  );
  assert.deepEqual(telegram.splitText("a😀", 2), ["a", "😀"]);
  assert.match(
    telegram.privateMessageUserHint("لم يبدأ محادثة خاصة"),
    /\/start/,
  );
});

test("Telegram identifies the standalone quality command for photo downloads", () => {
  assert.equal(telegram.isQualityCommand("/جودة"), true);
  assert.equal(telegram.isQualityCommand("quality"), true);
  assert.equal(telegram.isQualityCommand("تصميم جودة"), false);
});

test("Telegram polling fails fast on invalid tokens and conflicting pollers", () => {
  assert.match(
    telegram.fatalPollingError({ telegramCode: 401 }).message,
    /TELEGRAM_BOT_TOKEN/,
  );
  assert.match(
    telegram.fatalPollingError({ telegramCode: 409 }).message,
    /instances.*webhook/i,
  );
  assert.equal(telegram.fatalPollingError({ telegramCode: 429 }), null);
});

test("Telegram group sends follow migrated chat IDs and explain permission failures", () => {
  const previous = "-1009876543210";
  const migrated = "-10019876543210";
  telegram.rememberChatMigration(previous, migrated);
  assert.equal(telegram.resolveMigratedChatId(previous), migrated);
  assert.equal(
    telegram.groupSendHint(new Error("Forbidden: bot was kicked from the group")),
    "تأكد أن البوت ما زال عضواً في المجموعة.",
  );
  assert.equal(
    telegram.groupSendHint(new Error("Forbidden: not enough rights to send text messages")),
    "تحقق من صلاحية البوت لإرسال الرسائل في إعدادات المجموعة.",
  );
  assert.equal(telegram.groupSendHint(new Error("network timeout")), null);
});

test("Telegram video helper recognizes MP4 file signatures", () => {
  const mp4 = Buffer.alloc(12);
  mp4.write("ftyp", 4, "ascii");
  assert.equal(telegram._internal.isMp4Buffer(mp4), true);
  assert.equal(telegram._internal.isMp4Buffer(Buffer.from("not-video")), false);
});
