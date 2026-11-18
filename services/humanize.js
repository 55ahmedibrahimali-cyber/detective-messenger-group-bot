// services/humanize.js — سلوك بشري أساسي قبل كل رسالة: "قراءة" الرسالة، مؤشر كتابة
// بمدة تتناسب مع طول الرد، واستراحات عشوائية قصيرة من وقت للتاني.
// هذا تحسين إضافي فوق SEND_DELAY/MAX_SENDS الموجودين بالفعل، مش بديل عنهم.
// أي استدعاء لمكتبة FCA هنا "best-effort": لو فشل أو غير مدعوم في الفورك المستخدم،
// يُتجاهل بصمت ولا يوقف الإرسال الفعلي أبداً.

const ENABLED = process.env.HUMANIZE_ENABLED !== "0";
const MARK_SEEN = process.env.HUMANIZE_MARK_SEEN !== "0";
const SHOW_TYPING = process.env.HUMANIZE_TYPING !== "0";

// متوسط سرعة كتابة على الموبايل تقريباً، مع هامش بطء طبيعي (كلمة/دقيقة)
const WPM = Math.max(10, Number(process.env.HUMANIZE_TYPING_WPM) || 38);
const MIN_MS = Math.max(0, Number(process.env.HUMANIZE_MIN_TYPING_MS) || 700);
const MAX_MS = Math.max(MIN_MS, Number(process.env.HUMANIZE_MAX_TYPING_MS) || 6000);

// احتمال استراحة أطول (كإنسان مشغول لحظة) وطولها
const BREAK_CHANCE = Math.min(1, Math.max(0, Number(process.env.HUMANIZE_MICRO_BREAK_CHANCE) || 0.05));
const BREAK_MIN_MS = Math.max(0, Number(process.env.HUMANIZE_MICRO_BREAK_MIN_MS) || 8000);
const BREAK_MAX_MS = Math.max(BREAK_MIN_MS, Number(process.env.HUMANIZE_MICRO_BREAK_MAX_MS) || 25000);

let sleepFn = (ms) => new Promise((r) => setTimeout(r, ms));
let randomFn = Math.random;

/** مدة كتابة واقعية بناءً على عدد الكلمات، بحد أدنى/أقصى وتذبذب ±30% */
function typingDurationMs(text) {
  const words = Math.max(1, String(text || "").trim().split(/\s+/).filter(Boolean).length);
  const base = (words / WPM) * 60000;
  const jittered = base * (0.7 + randomFn() * 0.6);
  return Math.min(MAX_MS, Math.max(MIN_MS, Math.round(jittered)));
}

/** يعيد مدة استراحة إضافية (مللي ثانية) أو 0 */
function maybeMicroBreak() {
  if (randomFn() >= BREAK_CHANCE) return 0;
  return Math.round(BREAK_MIN_MS + randomFn() * (BREAK_MAX_MS - BREAK_MIN_MS));
}

/** يستدعي دالة FCA بأمان: لا يرمي خطأ أبداً مهما كان توقيعها أو حالتها */
function callSafely(fn, thisArg, args) {
  if (typeof fn !== "function") return;
  try {
    const result = fn.apply(thisArg, args);
    if (result && typeof result.catch === "function") result.catch(() => {});
  } catch {
    /* تجاهل: ميزة تجميلية، لا تمنع الإرسال الفعلي */
  }
}

function markSeenCall(api, threadId) {
  if (!MARK_SEEN || !api) return;
  callSafely(api.markAsRead, api, [String(threadId), () => {}]);
}

function typingCall(api, threadId) {
  if (!SHOW_TYPING || !api) return;
  callSafely(api.sendTypingIndicator, api, [String(threadId), () => {}]);
}

/**
 * ينفَّذ قبل أي رسالة فعلية: يعلّم المحادثة كمقروءة، يبعت مؤشر كتابة،
 * وينتظر مدة تتناسب مع طول الرد (مع احتمال استراحة أطول أحياناً).
 * لا يرمي أي استثناء أبداً؛ أسوأ سيناريو هو انتظار عادي بدون مؤشرات.
 */
async function beforeSend(api, threadId, text) {
  if (!ENABLED) return;
  markSeenCall(api, threadId);
  await sleepFn(150 + randomFn() * 350); // فاصل قصير بين "القراءة" و"بدء الكتابة"
  const extra = maybeMicroBreak();
  if (extra) await sleepFn(extra);
  typingCall(api, threadId);
  await sleepFn(typingDurationMs(text));
}

/** علامة "مقروءة" فقط، بدون مؤشر كتابة ولا انتظار — مناسبة قبل إرسال صورة/وسائط */
function markSeen(api, threadId) {
  if (!ENABLED) return;
  markSeenCall(api, threadId);
}

module.exports = {
  beforeSend,
  markSeen,
  _internal: {
    typingDurationMs,
    maybeMicroBreak,
    setSleep(fn) {
      sleepFn = fn;
    },
    setRandom(fn) {
      randomFn = fn;
    },
    reset() {
      sleepFn = (ms) => new Promise((r) => setTimeout(r, ms));
      randomFn = Math.random;
    },
  },
};
