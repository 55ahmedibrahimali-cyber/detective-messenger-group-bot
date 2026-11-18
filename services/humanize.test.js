const test = require("node:test");
const assert = require("node:assert/strict");
const humanize = require("./humanize");
const { _internal } = humanize;

function fixedRandom(seq) {
  let i = 0;
  return () => seq[Math.min(i++, seq.length - 1)];
}

test("typingDurationMs يتناسب مع عدد الكلمات وضمن الحدود", () => {
  _internal.setRandom(() => 0.5); // منتصف نطاق التذبذب
  const short = _internal.typingDurationMs("كلمة واحدة");
  const long = _internal.typingDurationMs(new Array(200).fill("كلمة").join(" "));
  assert.ok(short >= 700);
  assert.ok(long <= 6000);
  assert.ok(long > short);
  _internal.reset();
});

test("maybeMicroBreak يحترم الاحتمال", () => {
  process.env.HUMANIZE_MICRO_BREAK_CHANCE = "0.5";
  delete require.cache[require.resolve("./humanize")];
  const h = require("./humanize");
  h._internal.setRandom(fixedRandom([0.1])); // أقل من 0.5 → استراحة
  assert.ok(h._internal.maybeMicroBreak() > 0);
  h._internal.setRandom(fixedRandom([0.9])); // أكبر من 0.5 → بدون استراحة
  assert.equal(h._internal.maybeMicroBreak(), 0);
  delete process.env.HUMANIZE_MICRO_BREAK_CHANCE;
  h._internal.reset();
});

test("beforeSend يستدعي markAsRead وsendTypingIndicator بأمان حتى لو رمت استثناء", async () => {
  delete require.cache[require.resolve("./humanize")];
  const h = require("./humanize");
  const calls = [];
  h._internal.setSleep(async (ms) => calls.push(["sleep", ms]));
  h._internal.setRandom(() => 0.5);
  const api = {
    markAsRead: (id) => {
      calls.push(["markAsRead", id]);
      throw new Error("fork لا يدعم هذه الدالة");
    },
    sendTypingIndicator: (id, cb) => {
      calls.push(["typing", id]);
      cb(null);
    },
  };
  await assert.doesNotReject(() => h.beforeSend(api, "123", "رد قصير"));
  assert.ok(calls.some((c) => c[0] === "markAsRead"));
  assert.ok(calls.some((c) => c[0] === "typing"));
  h._internal.reset();
});

test("beforeSend لا يفعل شيئاً عند HUMANIZE_ENABLED=0", async () => {
  process.env.HUMANIZE_ENABLED = "0";
  delete require.cache[require.resolve("./humanize")];
  const h = require("./humanize");
  let slept = false;
  h._internal.setSleep(async () => {
    slept = true;
  });
  await h.beforeSend({ markAsRead: () => {}, sendTypingIndicator: () => {} }, "1", "a");
  assert.equal(slept, false);
  delete process.env.HUMANIZE_ENABLED;
  h._internal.reset();
});

test("markSeen بدون api لا يرمي استثناء", () => {
  assert.doesNotThrow(() => humanize.markSeen(null, "1"));
});
