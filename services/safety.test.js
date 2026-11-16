const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bot-safety-"));
process.env.SAFETY_STATE_PATH = path.join(tempDir, "state.json");
process.env.STRICT_PRIVATE = "1";
process.env.MAX_SENDS_PER_HOUR = "2";
process.env.MAX_SENDS_PER_DAY = "3";
fs.writeFileSync(
  process.env.SAFETY_STATE_PATH,
  JSON.stringify({
    optOut: ["456"],
    contacted: ["456"],
    pausedUntil: 0,
    strikes: 0,
  }),
);

test.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

test("private opt-out and send protections persist across reloads", () => {
  let safety = require("./safety");

  assert.equal(safety.isOptOut("456"), true);
  assert.equal(safety.privateBlockReason("456"), "اللاعب طلب إيقاف الرسائل الخاصة");
  assert.equal(safety.privateBlockReason("123"), "اللاعب لم يبدأ محادثة خاصة مع البوت بعد");
  assert.equal(safety.privateBlockReason("123", { requireContact: false }), null);
  safety.noteContact("123");
  assert.equal(safety.privateBlockReason("123"), null);

  safety.setOptOut("123", true);
  assert.equal(safety.privateBlockReason("123"), "اللاعب طلب إيقاف الرسائل الخاصة");
  assert.equal(
    safety.privateBlockReason("123", { requireContact: false }),
    "اللاعب طلب إيقاف الرسائل الخاصة",
  );
  assert.equal(safety.privateBlockReason("123", { allowOptOut: true }), null);

  safety.assertCanSend();
  safety.assertCanSend();
  assert.throws(safety.assertCanSend, /hourly send cap reached/);

  safety.onSendError("too many requests");
  assert.equal(safety.status().paused, true);

  delete require.cache[require.resolve("./safety")];
  safety = require("./safety");

  assert.equal(safety.isOptOut("123"), true);
  assert.equal(safety.status().paused, true);
  assert.throws(safety.assertCanSend, /sending paused/);

  safety.noteContact("789");
  assert.equal(safety.privateBlockReason("789"), null);
  assert.equal(safety.setAccountId("100000000000001"), true);
  assert.equal(
    safety.privateBlockReason("789"),
    "اللاعب لم يبدأ محادثة خاصة مع البوت بعد",
  );
  safety.noteContact("789");
  assert.equal(safety.setAccountId("100000000000001"), false);
  assert.equal(safety.privateBlockReason("789"), null);

  const beforeSwitch = JSON.parse(
    fs.readFileSync(process.env.SAFETY_STATE_PATH, "utf8"),
  );
  assert.equal(safety.setAccountId("100000000000002"), true);
  const afterSwitch = JSON.parse(
    fs.readFileSync(process.env.SAFETY_STATE_PATH, "utf8"),
  );
  assert.deepEqual(afterSwitch.contacted, []);
  assert.deepEqual(afterSwitch.optOut, beforeSwitch.optOut);
  assert.deepEqual(afterSwitch.sends, beforeSwitch.sends);
  assert.equal(afterSwitch.pausedUntil, beforeSwitch.pausedUntil);
  assert.equal(afterSwitch.strikes, beforeSwitch.strikes);

  delete require.cache[require.resolve("./safety")];
  safety = require("./safety");
  assert.equal(safety.setAccountId("100000000000002"), false);
  assert.equal(
    safety.privateBlockReason("789"),
    "اللاعب لم يبدأ محادثة خاصة مع البوت بعد",
  );
  assert.equal(safety.isOptOut("123"), true);
});
