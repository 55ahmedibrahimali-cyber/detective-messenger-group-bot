// إرسال محدود، قاطع دائرة، واحترام إيقاف الرسائل الخاصة.
const fs = require("node:fs");
const path = require("node:path");
const secureStore = require("./secureStore");

const STATE_PATH =
  process.env.SAFETY_STATE_PATH ||
  path.join(__dirname, "..", ".nexca", "safety-state.json");
const MAX_CONTACTS = 20000;
const MAX_HOURLY_SENDS = positiveLimit("MAX_SENDS_PER_HOUR", 200);
const MAX_DAILY_SENDS = positiveLimit("MAX_SENDS_PER_DAY", 1200);
const STRICT_PRIVATE = process.env.STRICT_PRIVATE !== "0";
const quietHoursValue = process.env.QUIET_HOURS || "";
const QUIET_HOURS = quietHoursValue.match(/^(\d{1,2})-(\d{1,2})$/);

if (quietHoursValue && !QUIET_HOURS) {
  throw new Error("QUIET_HOURS must use the H-H format, for example 3-7.");
}
if (
  QUIET_HOURS &&
  (Number(QUIET_HOURS[1]) > 23 || Number(QUIET_HOURS[2]) > 23)
) {
  throw new Error("QUIET_HOURS must use hours from 0 to 23.");
}

// تجاوز ساعات الصمت في وقت التشغيل (null=الافتراضي، true=تفعيل الصمت، false=تعطيل الصمت)
let quietOverride = null;

function setQuietOverride(value) {
  quietOverride = value === null ? null : Boolean(value);
}

function getQuietOverride() {
  return quietOverride;
}

function positiveLimit(name, fallback) {
  const value = process.env[name];
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return parsed;
}

function loadState() {
  let raw;
  try {
    raw = fs.readFileSync(STATE_PATH, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      return {
        accountId: null,
        optOut: [],
        contacted: [],
        pausedUntil: 0,
        strikes: 0,
        sends: [],
      };
    }
    throw new Error(`Unable to read safety state: ${error.message}`, {
      cause: error,
    });
  }

  let saved;
  try {
    saved = JSON.parse(raw);
  } catch (error) {
    throw new Error("Safety state is not valid JSON.", { cause: error });
  }

  if (
    !saved ||
    (saved.accountId !== undefined &&
      saved.accountId !== null &&
      (typeof saved.accountId !== "string" ||
        !/^\d{1,64}$/.test(saved.accountId))) ||
    !Array.isArray(saved.optOut) ||
    !Array.isArray(saved.contacted) ||
    (saved.sends !== undefined && !Array.isArray(saved.sends)) ||
    !Number.isSafeInteger(saved.pausedUntil) ||
    saved.pausedUntil < 0 ||
    !Number.isSafeInteger(saved.strikes) ||
    saved.strikes < 0 ||
    saved.strikes > 6 ||
    [...saved.optOut, ...saved.contacted].some(
      (id) => typeof id !== "string" || !id,
    ) ||
    (saved.sends || []).some(
      (timestamp) => !Number.isSafeInteger(timestamp) || timestamp < 0,
    )
  ) {
    throw new Error("Safety state has an invalid structure.");
  }

  return {
    accountId: saved.accountId || null,
    optOut: [...new Set(saved.optOut)],
    contacted: [...new Set(saved.contacted)].slice(-MAX_CONTACTS),
    pausedUntil: saved.pausedUntil,
    strikes: saved.strikes,
    sends: (saved.sends || []).filter(
      (timestamp) => Date.now() - timestamp < 86400000,
    ),
  };
}

const state = loadState();
const optOut = new Set(state.optOut);
const contacted = new Set(state.contacted);
const sends = state.sends;

function save() {
  secureStore.writePrivateFile(
    STATE_PATH,
    JSON.stringify({
      optOut: [...optOut],
      contacted: [...contacted],
      accountId: state.accountId,
      pausedUntil: state.pausedUntil,
      strikes: state.strikes,
      sends,
    }),
  );
}

function makeBlockedError(message) {
  return Object.assign(new Error(message), { safetyBlocked: true });
}

function pausedFor() {
  return Math.max(0, state.pausedUntil - Date.now());
}

function pruneSends(now) {
  while (sends.length && now - sends[0] >= 86400000) sends.shift();
}

function quietNow() {
  if (quietOverride !== null) return quietOverride;
  if (!QUIET_HOURS) return false;
  const start = Number(QUIET_HOURS[1]);
  const end = Number(QUIET_HOURS[2]);
  const hour = new Date().getHours();
  return start <= end ? hour >= start && hour < end : hour >= start || hour < end;
}

function assertCanSend() {
  if (Date.now() < state.pausedUntil) {
    throw makeBlockedError(
      `safety: sending paused for ${Math.ceil(pausedFor() / 60000)} more minutes`,
    );
  }
  if (quietNow()) throw makeBlockedError("safety: quiet hours");

  const now = Date.now();
  pruneSends(now);
  if (sends.length >= MAX_DAILY_SENDS) {
    throw makeBlockedError("safety: daily send cap reached");
  }
  const hourlyCount = sends.filter(
    (timestamp) => now - timestamp < 3600000,
  ).length;
  if (hourlyCount >= MAX_HOURLY_SENDS) {
    throw makeBlockedError("safety: hourly send cap reached");
  }

  sends.push(now);
  try {
    save();
  } catch (error) {
    sends.pop();
    throw error;
  }
}

function trip() {
  state.strikes = Math.min(state.strikes + 1, 6);
  const minutes = Math.min(30 * 2 ** (state.strikes - 1), 720);
  state.pausedUntil = Date.now() + minutes * 60000;
  console.error(
    `[safety] إرسال متوقف مؤقتاً لمدة ${minutes} دقيقة بعد رفض المنصة للإرسال.`,
  );
  save();
}

const SUSPICIOUS_SEND_ERROR =
  /spam|automated|unusual activity|rate.?limit|too many|temporarily (blocked|unavailable)|try again later|checkpoint|1545\d+|1357\d+|action.?required/i;

function onSendError(error) {
  if (isSuspiciousSendError(error)) trip();
}

function isSuspiciousSendError(error) {
  return SUSPICIOUS_SEND_ERROR.test(String(error || ""));
}

function onSendOk() {
  if (state.strikes && Date.now() > state.pausedUntil + 3600000) {
    state.strikes = 0;
    save();
  }
}

function validateUserId(userId) {
  const id = String(userId).trim();
  if (!id) throw new TypeError("A user ID is required.");
  return id;
}

function setAccountId(accountId) {
  const id = String(accountId).trim();
  if (!/^\d{1,64}$/.test(id)) {
    throw new TypeError("A numeric Messenger account ID is required.");
  }
  if (state.accountId === id) return false;

  const previousAccountId = state.accountId;
  const previousContacts = [...contacted];
  state.accountId = id;
  contacted.clear();
  try {
    save();
  } catch (error) {
    state.accountId = previousAccountId;
    for (const previousId of previousContacts) contacted.add(previousId);
    throw error;
  }
  return true;
}

function noteContact(userId) {
  const id = validateUserId(userId);
  if (contacted.has(id)) return;
  const previous = [...contacted];
  contacted.add(id);
  if (contacted.size > MAX_CONTACTS) {
    contacted.delete(contacted.values().next().value);
  }
  try {
    save();
  } catch (error) {
    contacted.clear();
    for (const previousId of previous) contacted.add(previousId);
    throw error;
  }
}

function setOptOut(userId, value) {
  const id = validateUserId(userId);
  const wasOptedOut = optOut.has(id);
  if (value) optOut.add(id);
  else optOut.delete(id);
  try {
    save();
  } catch (error) {
    if (wasOptedOut) optOut.add(id);
    else optOut.delete(id);
    throw error;
  }
}

function privateBlockReason(
  userId,
  { allowOptOut = false, requireContact = STRICT_PRIVATE } = {},
) {
  const id = validateUserId(userId);
  if (optOut.has(id) && !allowOptOut) {
    return "اللاعب طلب إيقاف الرسائل الخاصة";
  }
  if (requireContact && !contacted.has(id)) {
    return "اللاعب لم يبدأ محادثة خاصة مع البوت بعد";
  }
  return null;
}

const STOP_RE = /^\s*\/?(stop|unsubscribe|إيقاف|ايقاف|توقف|وقف|إلغاء|الغاء)\s*$/i;
const START_RE = /^\s*\/?(start|resume|ابدأ|ابدا|تشغيل|رجوع)\s*$/i;

module.exports = {
  assertCanSend,
  onSendError,
  isSuspiciousSendError,
  onSendOk,
  isStopCommand: (text) => STOP_RE.test(text || ""),
  isStartCommand: (text) => START_RE.test(text || ""),
  setAccountId,
  noteContact,
  setOptOut,
  isOptOut: (userId) => optOut.has(String(userId)),
  privateBlockReason,
  setQuietOverride,
  getQuietOverride,
  quietNow,
  status: () => ({
    paused: Date.now() < state.pausedUntil,
    pausedMs: pausedFor(),
    strikes: state.strikes,
  }),
};
