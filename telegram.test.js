const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
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

test("Telegram can react with an X to a rate-limited message", () => {
  const projectRoot = __dirname;
  const script = [
    'const fs = require("node:fs");',
    'const os = require("node:os");',
    'const path = require("node:path");',
    'process.env.TELEGRAM_BOT_TOKEN = "123456:TEST";',
    'process.env.TELEGRAM_ENV_PATH = path.join(os.tmpdir(), "missing-rate-limit-env");',
    'const safetyPath = path.join(os.tmpdir(), `rate-limit-reaction-${process.pid}.json`);',
    'process.env.SAFETY_STATE_PATH = safetyPath;',
    'const telegram = require("./telegram");',
    'global.fetch = async (url, options) => {',
    '  const payload = JSON.parse(options.body);',
    '  if (!url.endsWith("/setMessageReaction")) throw new Error("wrong Telegram method");',
    '  if (payload.chat_id !== "-100123" || payload.message_id !== 42) throw new Error("wrong message target");',
    '  if (payload.reaction?.[0]?.emoji !== "❌") throw new Error("wrong reaction");',
    '  return { ok: true, status: 200, json: async () => ({ ok: true, result: true }) };',
    '};',
    '(async () => {',
    '  try {',
    '    await telegram._internal.reactToMessage("-100123", "42", "❌");',
    '    console.log("Telegram X reaction sent.");',
    '  } finally {',
    '    fs.rmSync(safetyPath, { force: true });',
    '  }',
    '})().catch((error) => { console.error(error.message); process.exitCode = 1; });',
  ].join("\n");
  const result = spawnSync(process.execPath, ["-e", script], {
    cwd: projectRoot,
    encoding: "utf8",
    timeout: 10000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /X reaction sent/);
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
