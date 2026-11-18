// services/humanize.js — سلوك بشري أساسي قبل كل رسالة: "قراءة" الرسالة، مؤشر كتابة
// بمدة تتناسب مع طول الرد، واستراحات عشوائية قصيرة من وقت للتاني.
// هذا تحسين إضافي فوق SEND_DELAY/MAX_SENDS الموجودين بالفعل، مش بديل عنهم.
// أي استدعاء لمكتبة FCA هنا "best-effort": لو فشل أو غير مدعوم في الفورك المستخدم،
// يُتجاهل بصمت ولا يوقف الإرسال الفعلي أبداً.

const ENABLED = process.env.HUMANIZE_ENABLED !== "0";
const MARK_SEEN = process.env.HUMANIZE_MARK_SEEN !== "0";
const SHOW_TYPING = process.env.HUMANIZE_TYPING !== "0";

// متوسط سرعة كتابة بشرية: مللي ثانية لكل حرف (افتراضي 35ms لكل حرف)
// يدعم التخصيص عبر HUMANIZE_MS_PER_CHAR أو حسابه من HUMANIZE_TYPING_WPM
const CONFIGURED_WPM = Number(process.env.HUMANIZE_TYPING_WPM) || 0;
const MS_PER_CHAR = Math.max(
  10,
  Number(process.env.HUMANIZE_MS_PER_CHAR) ||
  (CONFIGURED_WPM > 0 ? Math.round(60000 / (CONFIGURED_WPM * 5)) : 35)
);
const MIN_MS = Math.max(0, Number(process.env.HUMANIZE_MIN_TYPING_MS) || 700);
const MAX_MS = Math.max(MIN_MS, Number(process.env.HUMANIZE_MAX_TYPING_MS) || 6000);

// احتمال استراحة أطول (كإنسان مشغول لحظة) وطولها
const BREAK_CHANCE = Math.min(1, Math.max(0, Number(process.env.HUMANIZE_MICRO_BREAK_CHANCE) || 0.05));
const BREAK_MIN_MS = Math.max(0, Number(process.env.HUMANIZE_MICRO_BREAK_MIN_MS) || 8000);
const BREAK_MAX_MS = Math.max(BREAK_MIN_MS, Number(process.env.HUMANIZE_MICRO_BREAK_MAX_MS) || 25000);

let sleepFn = (ms) => new Promise((r) => setTimeout(r, ms));
let randomFn = Math.random;

/**
 * مدة كتابة واقعية ومحاكاة بشرية دقيقة مرتبطة بعدد أحرف الرسالة:
 * - تحسب عدد الأحرف الفعلية (Characters) مضروبة في سرعة الكتابة لكل حرف (MS_PER_CHAR).
 * - تتضمن تذبذباً طبيعياً (Jitter) بنسبة ±20% ليظهر التوقيت كإنسان حقيقي يكتب وليس آلة.
 * - تنحصر بين الحد الأدنى (MIN_MS) والحد الأقصى (MAX_MS) لتفادي التأخير المفرط في الرسائل الطويلة جداً.
 */
function typingDurationMs(text) {
  const clean = String(text || "").trim();
  const charCount = Math.max(1, clean.length);
  const base = charCount * MS_PER_CHAR;
  const jittered = base * (0.8 + randomFn() * 0.4);
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
 * للألعاب التنافسية وإعلانات الفائز والتلميحات: يكون الإرسال سريعاً وخفيفاً بدون تأخير يفسد جو اللعبة.
 * لا يرمي أي استثناء أبداً؛ أسوأ سيناريو هو انتظار عادي بدون مؤشرات.
 */
async function beforeSend(api, threadId, text, options = {}) {
  if (!ENABLED) return;
  markSeenCall(api, threadId);

  // إرسال سريع للألعاب التنافسية وإعلانات الفائز والتلميحات:
  const isFast = Boolean(
    options?.fast ||
    /^(?:[✅💡🔎🏆⏭️]|تلميح:)/u.test(String(text || "").trim())
  );

  if (isFast) {
    // فاصل إنساني سريع ومتزن (350-700ms) يضمن سرعة اللعبة ولا يثير خوارزميات الحظر في فيسبوك
    await sleepFn(350 + randomFn() * 350);
    return;
  }

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
