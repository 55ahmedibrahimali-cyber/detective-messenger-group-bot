const test = require("node:test");
const assert = require("node:assert/strict");
const fun = require("./funCommands");
const { _internal } = fun;

function setup() {
  _internal.reset();
  process.env.FUN_USER_COOLDOWN_SECONDS = "0";
  _internal.setSleep(async () => {});
  _internal.setIO({
    download: async () => Buffer.from([1]),
    decode: () => _internal.placeholderAvatar(5),
    encode: (img) => Buffer.from(`png:${img.width}x${img.height}`),
  });
  const log = { texts: [], images: [], events: [] };
  const deps = {
    sendText: async (t, text) => {
      log.texts.push(text);
      log.events.push({ type: "text", text });
    },
    sendImage: async (t, buf, type, caption) => {
      log.images.push({ buf: buf.toString(), caption });
      log.events.push({ type: "image", caption });
      return true;
    },
    selfId: () => "999",
    getProfile: async () => ({ name: "سامي", avatarUrls: ["https://scontent.xx.fbcdn.net/a.jpg"] }),
  };
  const ctx = (text, reply = { senderID: "123" }) => ({
    userId: "1", threadId: "10", isGroup: true, text, messageReply: reply,
  });
  return { log, deps, ctx };
}

test("parseCommand", () => {
  assert.deepEqual(fun.parseCommand("قتل"), { kind: "kill" });
  assert.deepEqual(fun.parseCommand("/قتل"), { kind: "kill" });
  assert.deepEqual(fun.parseCommand(" تهكير "), { kind: "hack" });
  assert.deepEqual(fun.parseCommand("هكر"), { kind: "hack" });
  assert.equal(fun.parseCommand("kill"), null);
  assert.deepEqual(fun.parseCommand("/hack"), { kind: "hack" });
  assert.equal(fun.parseCommand("قتل كريم"), null); // أمر لعبة مين قتل كريم
  assert.equal(fun.parseCommand("مين قتل كريم"), null);
});

test("بدون رد على رسالة لا يعالج", async () => {
  const { deps, ctx } = setup();
  assert.equal(await fun.tryHandle(ctx("قتل", null), deps), false);
});

test("قتل: صورة + اسم المستخدم", async () => {
  const { log, deps, ctx } = setup();
  assert.equal(await fun.tryHandle(ctx("قتل"), deps), true);
  assert.equal(log.images.length, 1);
  assert.match(log.images[0].caption, /تم قتل سامي/);
  assert.equal(log.images[0].buf, "png:512x512");
  assert.equal(log.texts.at(-1), "Just kidding");
  assert.deepEqual(log.events.slice(-2).map((event) => event.type), ["image", "text"]);
});

test("تهكير: مراحل تشمل 70% ثم صورة", async () => {
  const { log, deps, ctx } = setup();
  assert.equal(await fun.tryHandle(ctx("تهكير"), deps), true);
  assert.equal(log.texts.length, 5);
  assert.ok(log.texts.some((t) => t.includes("70%")));
  assert.match(log.images[0].caption, /تم التهكير/);
  assert.match(log.images[0].caption, /سامي/);
  assert.equal(log.texts.at(-1), "Just kidding");
});

test("لا تعمل الأوامر في المحادثات الخاصة", async () => {
  const { log, deps, ctx } = setup();
  assert.equal(
    await fun.tryHandle({ ...ctx("قتل"), isGroup: false }, deps),
    false,
  );
  assert.equal(log.images.length, 0);
  assert.equal(log.texts.length, 0);
});

test("الرد على البوت نفسه", async () => {
  const { log, deps, ctx } = setup();
  assert.equal(await fun.tryHandle(ctx("قتل", { senderID: "999" }), deps), true);
  assert.equal(log.images.length, 0);
  assert.equal(log.texts.length, 1);
});

test("فشل تنزيل الصورة يستخدم صورة بديلة", async () => {
  const { log, deps, ctx } = setup();
  _internal.setIO({ download: async () => { throw new Error("x"); } });
  await fun.tryHandle(ctx("قتل"), deps);
  assert.equal(log.images.length, 1);
});

test("فشل إرسال الصورة يرسل الكابشن نصاً", async () => {
  const { log, deps, ctx } = setup();
  deps.sendImage = async () => false;
  await fun.tryHandle(ctx("قتل"), deps);
  assert.match(log.texts[0], /تم قتل سامي/);
  assert.equal(log.texts.at(-1), "Just kidding");
});

test("التحقق من رابط الصورة", () => {
  assert.ok(_internal.validateAvatarUrl("https://scontent.fbcdn.net/x.jpg"));
  assert.equal(_internal.validateAvatarUrl("http://scontent.fbcdn.net/x.jpg"), null);
  assert.equal(_internal.validateAvatarUrl("https://evil.example.com/x.jpg"), null);
  assert.equal(_internal.validateAvatarUrl("https://127.0.0.1/x.jpg"), null);
});

test("فترة الانتظار بين الأوامر", async () => {
  const { log, deps, ctx } = setup();
  process.env.FUN_USER_COOLDOWN_SECONDS = "30";
  await fun.tryHandle(ctx("قتل"), deps);
  await fun.tryHandle(ctx("قتل"), deps);
  assert.equal(log.images.length, 1);
  process.env.FUN_USER_COOLDOWN_SECONDS = "0";
});
