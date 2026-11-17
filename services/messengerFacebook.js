// services/messenger.js - طبقة النقل عبر FCA (واجهة غير رسمية: MQTT + حساب فيسبوك)
// ⚠️ مخالف لشروط استخدام فيسبوك وقد يؤدي لقفل الحساب. استخدم حساباً مخصصاً للبوت فقط.
//
// نسخة محدّثة:
//  - الدخول بالكوكيز افتراضياً، وكلمة المرور فقط عند اختيار LOGIN_MODE=password صراحةً
//  - لا يكتب appstate.json إلا بعد ما يثبت إن الاتصال شغال (كان بيكتب فوق الكوكيز بحالة تالفة)
//  - لو فيسبوك رفض الجلسة (Not logged in / 1357004) يوقف ويشرح الحل بدل ما يفضل يعيد المحاولة
const fs = require("fs");
const path = require("path");
const { createReadStream } = require("node:fs");
const { Readable } = require("node:stream");
const readline = require("readline");
const util = require("util");
const os = require("node:os");
const fsp = require("node:fs/promises");
const secureStore = require("./secureStore");
const { acquireProcessLock } = require("./processLock");
const { redact } = require("./logRedactor");
const safety = require("./safety");
const privateSendRetry = require("./privateSendRetry");
const privateChatVerification = require("./privateChatVerification");

// بعض نسخ FCA (forks) بتصدّر الدالة مباشرة، وبعضها جوه { login } أو default
const FCA_NAME = process.env.FCA_MODULE || "fca-unofficial";
const FCA_MODULES_WITH_APPSTATE_COOKIES = new Set([
  "ws3-fca",
  "biar-fca",
  "hridoy-fca",
  "@dongdev/fca-unofficial",
  "fca-azadx69x",
  "facebook-chat-api",
]);
if (FCA_NAME === "hridoy-fca" && process.env.FCA_E2EE_NATIVE === undefined) {
  process.env.FCA_E2EE_NATIVE = "0";
}
const fcaMod = require(FCA_NAME);
console.log(`[messenger] FCA: ${FCA_NAME} | node ${process.version}`);
if (FCA_NAME === "hridoy-fca")
  console.log(
    `[messenger] native E2EE media: ${process.env.FCA_E2EE_NATIVE === "0" ? "disabled" : "enabled"}; native private images: ${process.env.FCA_E2EE_NATIVE_DM_IMAGES === "1" ? "enabled (experimental)" : "disabled"}`,
  );
const login =
  typeof fcaMod === "function"
    ? fcaMod
    : typeof fcaMod.login === "function"
      ? fcaMod.login
      : typeof fcaMod.default === "function"
        ? fcaMod.default
        : null;
if (!login) {
  console.error(
    `المكتبة "${FCA_NAME}" مش بتصدّر دالة login. الموجود فيها:`,
    Object.keys(fcaMod),
  );
  console.error(
    "جرّب مكتبة FCA مثبتة عبر FCA_MODULE، مثل @dongdev/fca-unofficial أو fca-azadx69x أو facebook-chat-api.",
  );
  process.exit(1);
}

const APPSTATE_PATH =
  process.env.APPSTATE_PATH || path.join(__dirname, "..", "appstate.json");
const LOGIN_MODE = (process.env.LOGIN_MODE || "appstate").toLowerCase();
const FB_EMAIL = process.env.FB_EMAIL || "";
const FB_PASSWORD = process.env.FB_PASSWORD || "";
const USER_AGENT = (process.env.USER_AGENT || "").trim();
const HTTPS_PROXY = (process.env.HTTPS_PROXY || "").trim();
const DELAY_MIN = Number(process.env.SEND_DELAY_MIN_MS) || 1200;
const DELAY_MAX = Number(process.env.SEND_DELAY_MAX_MS) || 2800;

const MAX_SENDS_PER_MINUTE = Number(process.env.MAX_SENDS_PER_MINUTE) || 30;
const MAX_QUEUE = Number(process.env.MAX_SEND_QUEUE) || 200;
const IMAGE_RETRIES = Math.max(0, Number(process.env.SEND_IMAGE_RETRIES ?? 2));
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_VIDEO_BYTES = 25 * 1024 * 1024;
const LOCK_PATH =
  process.env.LOGIN_LOCK_PATH ||
  path.join(__dirname, "..", ".nexca", "login-lock.json");
const PROCESS_LOCK_PATH =
  process.env.BOT_PROCESS_LOCK_PATH ||
  path.join(__dirname, "..", ".nexca", "bot.lock");
const LOCK_HOURS = Number(process.env.LOGIN_LOCK_HOURS) || 6;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = (min, max) => min + Math.random() * (max - min);

let api = null;
let selfId = null;
let e2eeConnected = false;
let stopListening = null;
let handler = null;
let reconnecting = false;
let reconnectRequested = false;
let healthy = false; // يبقى true بعد ما الاستماع يثبت بدون أخطاء
let attachToken = 0;
let warnedPlainAppState = false;
let releaseProcessLock = null;
// إعادة الاتصال: نحاول أولاً إعادة الاستماع على نفس الجلسة (بدون login جديد)،
// لأن كل login() جديد يُحتسب بداية جلسة عند فيسبوك وتكراره هو أكثر ما يسبب قيود الحساب.
const MAX_SOFT_RETRIES = Math.max(0, Number(process.env.MQTT_SOFT_RETRIES ?? 3));
let softRetries = 0;
let reconnectBackoff = 5000; // يتضاعف مع كل فشل متتالٍ ويرجع لـ5ث عند استقرار الاتصال

function errText(e) {
  if (typeof e === "string") return e;
  const x = (e && (e.error || e.message)) || e;
  if (typeof x === "string") return x;
  try {
    return JSON.stringify(x).slice(0, 500);
  } catch {
    return String(x);
  }
}

function safeSendError(e) {
  const reason = redact(errText(e))
    .split(/\r?\n/, 1)[0]
    .replace(
      /(password|token|cookie|authorization)\s*[:=][^\r\n]*/gi,
      "$1=[hidden]",
    )
    .trim();
  return (reason || "سبب غير معروف").slice(0, 180);
}

// أخطاء لا تُحل بإعادة المحاولة: الجلسة مرفوضة أو الحساب موقوف
const FATAL =
  /checkpoint|login_approval|login[_ -]?blocked|locked|disabled|suspended|not logged in|1357004|1357001|1357031|retrieving userid/i;
const BLOCKED_ACCOUNT =
  /checkpoint|login_approval|login[_ -]?blocked|locked|disabled|suspended/i;

function explainMissingIdentityCookie() {
  if (LOGIN_MODE === "password") {
    console.error(
      `[messenger] ${FCA_NAME} لم يستطع استخراج معرّف الحساب بعد تسجيل الدخول بالإيميل والباسورد. تحقق من حالة تسجيل الدخول ودعم المكتبة لهذا المسار.`,
    );
    console.error(
      "راجع حالة الحساب وأكمل أي تحقق مطلوب عبر Facebook مباشرة، ولا تكرر محاولات الدخول إذا رفضها Facebook.",
    );
    return;
  }
  console.error(
    `[messenger] ${FCA_NAME} لم يستطع استخراج معرّف الحساب من كوكي c_user أو i_user بعد تحميل الجلسة.`,
  );
  console.error(
    "افتح Facebook يدوياً بالحساب نفسه وأكمل أي تحقق ظاهر. بعد نجاح الدخول، صدّر appstate جديداً من الجلسة نفسها واستبدل الملف القديم. لا تعدّل قيم الكوكي يدوياً ولا ترسل ملف appstate لأي شخص.",
  );
}

// ============================== قفل الدخول (حماية الحساب) ==============================
// بعد أي رفض من فيسبوك نمنع إعادة محاولات الدخول المتكررة (حتى لو أعاد مدير العمليات تشغيل البوت)،
// لأن تكرار الدخول الفاشل هو أسرع طريق لـ checkpoint أو قفل الحساب.
function readLock() {
  try {
    return JSON.parse(fs.readFileSync(LOCK_PATH, "utf8"));
  } catch {
    return null;
  }
}

function writeLock(patch) {
  try {
    secureStore.writePrivateFile(
      LOCK_PATH,
      JSON.stringify({ ...(readLock() || {}), ...patch }, null, 2),
    );
  } catch (e) {
    console.error("[messenger] could not write login lock:", e.message);
  }
}

function assertLoginAllowed() {
  const lock = readLock();
  if (!lock || !lock.blockedUntil || Date.now() >= lock.blockedUntil) return;
  if (LOGIN_MODE === "password") {
    const until = new Date(lock.blockedUntil).toLocaleString("ar-EG");
    throw Object.assign(new Error(
      `تم إيقاف محاولات الدخول مؤقتاً حتى ${until} لحماية الحساب (السبب: ${lock.reason || "رفض من فيسبوك"}). ` +
        "أكمل أي تحقق مطلوب عبر Facebook وانتظر انتهاء المهلة قبل إعادة المحاولة.",
    ), { loginLocked: true });
  }
  let appstateTime = 0;
  try {
    appstateTime = fs.statSync(APPSTATE_PATH).mtimeMs;
  } catch {
    /* لا يوجد ملف جلسة */
  }
  if (appstateTime > Number(lock.ts || 0)) return; // جُدّدت الكوكيز بعد القفل
  const until = new Date(lock.blockedUntil).toLocaleString("ar-EG");
  throw Object.assign(new Error(
    `تم إيقاف محاولات الدخول مؤقتاً حتى ${until} لحماية الحساب (السبب: ${lock.reason || "رفض من فيسبوك"}). ` +
      `أوقف البوت ولا تحذف القفل أو تستخدم FORCE_LOGIN. راجع حالة الحساب وأكمل أي تحقق عبر Facebook يدوياً؛ بعد نجاح الدخول فقط صدّر appstate جديداً للحساب نفسه. لا تشارك ملف الجلسة.`,
  ), { loginLocked: true });
}

function die(reason) {
  const text = String(reason);
  const hardBlock =
    /checkpoint|login_approval|login[_ -]?blocked|locked|disabled|suspended/i.test(
      text,
    );
  writeLock({
    ts: Date.now(),
    blockedUntil: Date.now() + (hardBlock ? LOCK_HOURS * 3600000 : 30 * 60000),
    reason: redact(text).slice(0, 200),
  });
  console.error("\n❌ تعذّر الاتصال بحساب فيسبوك:", redact(text));
  if (hardBlock) {
    console.error(
      "[messenger] أوقف البوت؛ لن تُعاد محاولة تسجيل الدخول تلقائياً بعد رفض Facebook لها.",
    );
    console.error(
      "راجع حالة الحساب وأكمل أي تحقق مطلوب عبر Facebook مباشرة. لا تكرر محاولات FCA أو تعدّل/تشارك ملفات appstate. هذا المشروع يستخدم واجهة غير رسمية؛ استخدم واجهات Meta الرسمية للتكامل المدعوم.",
    );
    return process.exit(1);
  }
  if (/retrieving userid/i.test(String(reason))) {
    explainMissingIdentityCookie();
    return process.exit(1);
  }
  console.error("الحل:");
  console.error(
    "1) افتح Facebook بحساب البوت وتأكد من عدم وجود checkpoint أو طلب تحقق.",
  );
  if (LOGIN_MODE === "password") {
    console.error(
      "2) تحقق من FB_EMAIL وFB_PASSWORD في .env، وأكمل التحقق بخطوتين إن طُلب.",
    );
  } else {
    console.error(
      "2) بعد نجاح الدخول، صدّر appstate.json جديداً للحساب نفسه وتأكد من مساره في APPSTATE_PATH.",
    );
  }
  process.exit(1);
}

// ============================== طابور الإرسال ==============================
// كل رسائل البوت تمرّ عبر طابور واحد بفاصل عشوائي بينها (الإرسال السريع أسرع طريق للحظر).
let chain = Promise.resolve();
let pending = 0;
const sentTimes = [];
async function throttle() {
  safety.assertCanSend();
  for (;;) {
    const now = Date.now();
    while (sentTimes.length && now - sentTimes[0] > 60000) sentTimes.shift();
    if (sentTimes.length < MAX_SENDS_PER_MINUTE) {
      sentTimes.push(now);
      return;
    }
    await sleep(sentTimes[0] + 60000 - now + 50);
  }
}
function schedule(task) {
  if (pending >= MAX_QUEUE)
    return Promise.reject(new Error("send queue is full; message dropped"));
  pending++;
  const result = chain
    .then(async () => {
      await throttle();
      return task();
    })
    .then(
      (value) => {
        safety.onSendOk();
        return value;
      },
      (error) => {
        safety.onSendError(errText(error));
        throw error;
      },
    )
    .finally(() => {
      pending--;
    });
  chain = result
    .catch(() => {})
    .then(() => sleep(jitter(DELAY_MIN, DELAY_MAX)));
  return result;
}

function rawSend(threadId, body, isSingleUser = false, allowOptOut = false) {
  if (!api) return Promise.reject(new Error("not logged in"));
  if (isSingleUser) {
    const reason = safety.privateBlockReason(threadId, { allowOptOut });
    if (reason) throw Object.assign(new Error(reason), { safetyBlocked: true });
  }
  if (FCA_NAME === "hridoy-fca") {
    return new Promise((resolve, reject) => {
      const callback = (err, info) => (err ? reject(err) : resolve(info));
      try {
        api.sendMessage.call(
          api,
          body,
          String(threadId),
          callback,
          undefined,
          isSingleUser,
        );
      } catch (e) {
        reject(e);
      }
    });
  }
  if (isSingleUser && typeof api.sendMessageDM === "function") {
    return new Promise((resolve, reject) => {
      const callback = (err, info) => (err ? reject(err) : resolve(info));
      try {
        const result = api.sendMessageDM.call(
          api,
          body,
          String(threadId),
          callback,
        );
        if (result && typeof result.then === "function")
          result.then(resolve, reject);
      } catch (e) {
        reject(e);
      }
    });
  }
  const sendMessage = api.sendMessage;
  const target = String(threadId);
  if (FCA_NAME === "biar-fca") {
    return Promise.resolve().then(() =>
      sendMessage.call(api, body, target, undefined, isSingleUser),
    );
  }
  if (sendMessage.length >= 4) {
    return new Promise((resolve, reject) => {
      const callback = (err, info) => (err ? reject(err) : resolve(info));
      if (sendMessage.length >= 5) {
        sendMessage.call(api, body, target, callback, undefined, !isSingleUser);
      } else {
        sendMessage.call(api, body, target, callback);
      }
    });
  }
  return Promise.resolve().then(() =>
    isSingleUser
      ? sendMessage.call(api, body, target, undefined, true)
      : sendMessage.call(api, body, target),
  );
}

/** يرسل نصاً (يُقسَّم إن طال). يعيد true عند النجاح، false عند الفشل (مثلاً الخاص غير متاح). */
function formatDisplayedCommands(text) {
  return String(text).replace(
    /(^|\s)\/(?=[\p{L}][\p{L}\p{N}_]*(?=$|\s|<|[،,.؛!?]))/gu,
    "$1",
  );
}

async function sendTo(
  threadId,
  text,
  isSingleUser = false,
  includeError = false,
  allowOptOut = false,
) {
  const chunks = formatDisplayedCommands(text).match(/[\s\S]{1,1800}/g) || [""];
  if (isSingleUser) {
    // نفحص الحظر قبل الجدولة كي لا تُحتسب رسالة محجوبة من حصة الإرسال
    const blocked = safety.privateBlockReason(threadId, { allowOptOut });
    if (blocked) {
      return includeError
        ? {
            ok: false,
            reason: blocked,
            userMessage: privateChatVerification.userHint(blocked),
          }
        : false;
    }
  }
  for (const chunk of chunks) {
    try {
      const scheduledSend = () =>
        schedule(() => rawSend(threadId, chunk, isSingleUser, allowOptOut));
      if (isSingleUser) {
        await privateSendRetry.sendWithPrivateRetry(scheduledSend, sleep);
      } else {
        await scheduledSend();
      }
    } catch (e) {
      console.error(
        `[messenger] ${isSingleUser ? "private" : "group"} send failed:`,
        threadId,
        e && e.stack ? e.stack : errText(e),
      );
      return includeError
        ? {
            ok: false,
            reason: safeSendError(e),
            userMessage: privateChatVerification.userHint(e),
          }
        : false;
    }
  }
  return includeError ? { ok: true, reason: null } : true;
}

/** رسالة في المجموعة (threadID للمجموعة) */
const sendGroup = (threadId, text) => sendTo(threadId, text);
/** رسالة خاصة للاعب (في FCA الـ threadID للمحادثة الخاصة = userID) */
const sendPrivate = (userId, text) => sendTo(userId, text, true);
const sendPrivateWithResult = (userId, text) =>
  sendTo(userId, text, true, true);
const sendPrivateNotice = (userId, text) =>
  sendTo(userId, text, true, false, true);

async function sendGroupTracked(threadId, text) {
  try {
    const info = await schedule(() =>
      rawSend(threadId, formatDisplayedCommands(text)),
    );
    const messageID = info && (info.messageID || info.messageId);
    if (!messageID)
      throw new Error(
        "FCA did not return a message ID for the registration message",
      );
    return String(messageID);
  } catch (e) {
    console.error(
      "[messenger] tracked group send failed:",
      threadId,
      e && e.stack ? e.stack : errText(e),
    );
    return null;
  }
}

// ============================== إرسال الصور ==============================
// المشكلة الأساسية سابقاً: كان يُمرَّر لـ FCA تيار Readable.from(buffer) بلا مسار ملف (path) ولا امتداد،
// وبعض نسخ FCA تعتمد على path/الامتداد لتحديد اسم الملف ونوعه، فتفشل الصورة أو تظهر كملف مجهول.
// الحل: نكتب الصورة في ملف مؤقت بامتداد صحيح، نرسلها كـ createReadStream (له path)، ثم نحذف الملف.
// مع فحص الصورة قبل الإرسال وإعادة المحاولة عند الفشل العابر.
function imageExtension(contentType) {
  if (contentType === "image/jpeg") return "jpg";
  if (contentType === "image/webp") return "webp";
  return "png";
}

function contentTypeForPath(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === ".jpg" || extension === ".jpeg") return "image/jpeg";
  if (extension === ".webp") return "image/webp";
  return "image/png";
}

function sniffImageType(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null;
  if (buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
    return "image/png";
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff)
    return "image/jpeg";
  if (
    buffer.toString("ascii", 0, 4) === "RIFF" &&
    buffer.toString("ascii", 8, 12) === "WEBP"
  )
    return "image/webp";
  return null;
}

async function withTempImage(source, contentType, task) {
  if (!Buffer.isBuffer(source)) return task(source);
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "nexca-img-"));
  const file = path.join(dir, `game-image.${imageExtension(contentType)}`);
  try {
    await fsp.writeFile(file, source, { mode: 0o600 });
    return await task(file);
  } finally {
    // قد يتأخر ويندوز في تحرير الملف؛ الحذف محاولة بلا أثر على النتيجة
    setTimeout(
      () => fsp.rm(dir, { recursive: true, force: true }).catch(() => {}),
      5000,
    ).unref();
  }
}

async function withTempVideo(buffer, task) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "nexca-video-"));
  const file = path.join(dir, "anime-edit.mp4");
  try {
    await fsp.writeFile(file, buffer, { mode: 0o600 });
    return await task(file);
  } finally {
    setTimeout(
      () => fsp.rm(dir, { recursive: true, force: true }).catch(() => {}),
      5000,
    ).unref();
  }
}

function isMp4Buffer(buffer) {
  return (
    Buffer.isBuffer(buffer) &&
    buffer.length >= 12 &&
    buffer.toString("ascii", 4, 8) === "ftyp"
  );
}

async function withTempImages(images, task) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "nexca-img-batch-"));
  const files = [];
  try {
    for (let index = 0; index < images.length; index++) {
      const { buffer, contentType } = images[index];
      const file = path.join(
        dir,
        `image-${index + 1}.${imageExtension(contentType)}`,
      );
      await fsp.writeFile(file, buffer, { mode: 0o600 });
      files.push({ path: file, contentType });
    }
    return await task(files);
  } finally {
    setTimeout(
      () => fsp.rm(dir, { recursive: true, force: true }).catch(() => {}),
      5000,
    ).unref();
  }
}

/** يرسل صورة (Buffer أو مسار ملف) مع تعليق. يعيد { ok, messageId, reason, attempts } */
async function sendImage({ threadId, source, contentType, caption, isSingleUser }) {
  if (isSingleUser) {
    const blocked = safety.privateBlockReason(threadId);
    if (blocked) {
      return {
        ok: false,
        reason: blocked,
        messageId: null,
        userMessage: privateChatVerification.userHint(blocked),
      };
    }
  }

  let type = contentType;
  if (Buffer.isBuffer(source)) {
    const sniffed = sniffImageType(source);
    if (!sniffed)
      return { ok: false, reason: "الملف ليس صورة PNG/JPEG/WEBP صالحة", messageId: null };
    if (source.length > MAX_IMAGE_BYTES)
      return { ok: false, reason: "حجم الصورة أكبر من 10MB", messageId: null };
    type = sniffed; // نثق بمحتوى الملف لا بما أُعلن عنه
  } else {
    type = contentTypeForPath(String(source));
  }

  let lastError;
  for (let attempt = 0; attempt <= IMAGE_RETRIES; attempt++) {
    try {
      const info = await withTempImage(source, type, (file) =>
        schedule(() => {
          const attachment = createReadStream(file);
          attachment.filename = path.basename(file);
          attachment.contentType = type;
          return rawSend(
            threadId,
            { body: formatDisplayedCommands(caption || ""), attachment },
            isSingleUser,
          ).finally(() => {
            if (typeof attachment.destroy === "function") attachment.destroy();
          });
        }),
      );
      const messageId = info && (info.messageID || info.messageId);
      if (!messageId)
        throw new Error("FCA did not return a message ID for the image");
      if (attempt > 0)
        console.log(`[messenger] image sent after ${attempt + 1} attempts`);
      return { ok: true, reason: null, messageId: String(messageId), attempts: attempt + 1 };
    } catch (e) {
      lastError = e;
      console.error(
        `[messenger] ${isSingleUser ? "private" : "group"} image send failed (attempt ${attempt + 1}/${IMAGE_RETRIES + 1}):`,
        threadId,
        e && e.stack ? e.stack : errText(e),
      );
      if (
        FATAL.test(errText(e)) ||
        (isSingleUser && !privateSendRetry.shouldRetryPrivateSend(e, attempt))
      )
        break;
      if (attempt < IMAGE_RETRIES) await sleep(2000 * (attempt + 1));
    }
  }
  return {
    ok: false,
    reason: safeSendError(lastError),
    messageId: null,
    userMessage: privateChatVerification.userHint(lastError),
  };
}

async function sendVideo({ threadId, buffer, caption, isSingleUser }) {
  if (isSingleUser) {
    const blocked = safety.privateBlockReason(threadId);
    if (blocked) {
      return {
        ok: false,
        reason: blocked,
        messageId: null,
        userMessage: privateChatVerification.userHint(blocked),
      };
    }
  }
  if (!isMp4Buffer(buffer))
    return { ok: false, reason: "الملف ليس فيديو MP4 صالحاً", messageId: null };
  if (buffer.length > MAX_VIDEO_BYTES)
    return { ok: false, reason: "حجم الفيديو أكبر من 25MB", messageId: null };

  let lastError;
  for (let attempt = 0; attempt <= IMAGE_RETRIES; attempt++) {
    try {
      const info = await withTempVideo(buffer, (file) =>
        schedule(() => {
          const attachment = createReadStream(file);
          attachment.filename = path.basename(file);
          attachment.contentType = "video/mp4";
          return rawSend(
            threadId,
            { body: formatDisplayedCommands(caption || ""), attachment },
            isSingleUser,
          ).finally(() => {
            if (typeof attachment.destroy === "function") attachment.destroy();
          });
        }),
      );
      const messageId = info && (info.messageID || info.messageId);
      if (!messageId)
        throw new Error("FCA did not return a message ID for the video");
      return {
        ok: true,
        reason: null,
        messageId: String(messageId),
        attempts: attempt + 1,
      };
    } catch (error) {
      lastError = error;
      console.error(
        `[messenger] ${isSingleUser ? "private" : "group"} video send failed (attempt ${attempt + 1}/${IMAGE_RETRIES + 1}):`,
        threadId,
        error && error.stack ? error.stack : errText(error),
      );
      if (
        FATAL.test(errText(error)) ||
        (isSingleUser &&
          !privateSendRetry.shouldRetryPrivateSend(error, attempt))
      )
        break;
      if (attempt < IMAGE_RETRIES) await sleep(2000 * (attempt + 1));
    }
  }
  return {
    ok: false,
    reason: safeSendError(lastError),
    messageId: null,
    userMessage: privateChatVerification.userHint(lastError),
  };
}

async function sendImageBatch({ threadId, images, isSingleUser }) {
  if (isSingleUser) {
    const blocked = safety.privateBlockReason(threadId);
    if (blocked) {
      return {
        ok: false,
        reason: blocked,
        messageId: null,
        userMessage: privateChatVerification.userHint(blocked),
      };
    }
  }
  if (!Array.isArray(images) || images.length < 2 || images.length > 10) {
    return {
      ok: false,
      reason: "إرسال مجموعة الصور يتطلب من صورتين إلى 10 صور.",
      messageId: null,
    };
  }

  const checkedImages = [];
  for (const image of images) {
    const { buffer } = image || {};
    const contentType = sniffImageType(buffer);
    if (!contentType)
      return {
        ok: false,
        reason: "أحد الملفات ليس صورة PNG/JPEG/WEBP صالحة.",
        messageId: null,
      };
    if (buffer.length > MAX_IMAGE_BYTES)
      return {
        ok: false,
        reason: "حجم إحدى الصور أكبر من 10MB.",
        messageId: null,
      };
    checkedImages.push({ buffer, contentType });
  }

  const body = images
    .map((image) => formatDisplayedCommands(image.caption || ""))
    .filter(Boolean)
    .join("\n");
  let lastError;
  for (let attempt = 0; attempt <= IMAGE_RETRIES; attempt++) {
    try {
      const info = await withTempImages(checkedImages, (files) =>
        schedule(() => {
          const attachments = files.map(({ path: file, contentType }) => {
            const attachment = createReadStream(file);
            attachment.filename = path.basename(file);
            attachment.contentType = contentType;
            return attachment;
          });
          return Promise.resolve()
            .then(() =>
              rawSend(
                threadId,
                { body, attachment: attachments },
                isSingleUser,
              ),
            )
            .finally(() => {
              for (const attachment of attachments) attachment.destroy();
            });
        }),
      );
      const messageId = info && (info.messageID || info.messageId);
      if (!messageId)
        throw new Error("FCA did not return a message ID for the image batch");
      if (attempt > 0)
        console.log(`[messenger] image batch sent after ${attempt + 1} attempts`);
      return {
        ok: true,
        reason: null,
        messageId: String(messageId),
        attempts: attempt + 1,
      };
    } catch (error) {
      lastError = error;
      console.error(
        `[messenger] ${isSingleUser ? "private" : "group"} image batch send failed (attempt ${attempt + 1}/${IMAGE_RETRIES + 1}):`,
        threadId,
        error && error.stack ? error.stack : errText(error),
      );
      if (
        FATAL.test(errText(error)) ||
        (isSingleUser && !privateSendRetry.shouldRetryPrivateSend(error, attempt))
      )
        break;
      if (attempt < IMAGE_RETRIES) await sleep(2000 * (attempt + 1));
    }
  }
  return {
    ok: false,
    reason: safeSendError(lastError),
    messageId: null,
    userMessage: privateChatVerification.userHint(lastError),
  };
}

async function sendGroupImageTracked(threadId, imagePath, caption) {
  const result = await sendImage({
    threadId,
    source: imagePath,
    caption,
    isSingleUser: false,
  });
  return result.ok ? result.messageId : null;
}

async function sendGroupImageBufferTracked(threadId, buffer, contentType, caption) {
  const result = await sendImage({
    threadId,
    source: buffer,
    contentType,
    caption,
    isSingleUser: false,
  });
  return result.ok ? result.messageId : null;
}

async function sendGroupVideoBufferTracked(
  threadId,
  buffer,
  _contentType,
  caption,
) {
  const result = await sendVideo({
    threadId,
    buffer,
    caption,
    isSingleUser: false,
  });
  return result.ok ? result.messageId : null;
}

async function sendGroupImageBuffersTracked(threadId, images) {
  const result = await sendImageBatch({
    threadId,
    images,
    isSingleUser: false,
  });
  return result.ok ? result.messageId : null;
}

async function removeUserFromGroup(userId, threadId) {
  if (!api || typeof api.removeUserFromGroup !== "function") {
    throw new Error("واجهة FCA لا تدعم طرد أعضاء المجموعة.");
  }
  return new Promise((resolve, reject) => {
    const callback = (err, info) => {
      if (err) return reject(err);
      resolve(info ?? true);
    };
    try {
      const result = api.removeUserFromGroup(String(userId), String(threadId), callback);
      if (result && typeof result.then === "function")
        result.then(resolve, reject);
    } catch (error) {
      reject(error);
    }
  });
}

function sendPrivateImageWithResult(userId, imagePath, caption) {
  return sendImage({ threadId: userId, source: imagePath, caption, isSingleUser: true });
}

function sendPrivateImageBufferWithResult(userId, buffer, contentType, caption) {
  return sendImage({
    threadId: userId,
    source: buffer,
    contentType,
    caption,
    isSingleUser: true,
  });
}

function sendPrivateVideoBufferWithResult(
  userId,
  buffer,
  _contentType,
  caption,
) {
  return sendVideo({
    threadId: userId,
    buffer,
    caption,
    isSingleUser: true,
  });
}

function sendPrivateImageBuffersWithResult(userId, images) {
  return sendImageBatch({
    threadId: userId,
    images,
    isSingleUser: true,
  });
}

async function getReactors(threadId, messageId) {
  if (!api) throw new Error("not logged in");
  if (typeof api.getThreadHistory !== "function") {
    throw new Error(
      "FCA does not provide getThreadHistory for reaction recovery",
    );
  }

  const getThreadHistory = api.getThreadHistory;
  const history =
    getThreadHistory.length >= 4
      ? await new Promise((resolve, reject) => {
          getThreadHistory.call(
            api,
            String(threadId),
            100,
            null,
            (err, messages) => (err ? reject(err) : resolve(messages)),
          );
        })
      : await getThreadHistory.call(api, String(threadId), 100, null);

  if (!Array.isArray(history))
    throw new Error("FCA returned an invalid thread history");
  const message = history.find(
    (item) => String(item.messageID) === String(messageId),
  );
  if (!message || !Array.isArray(message.messageReactions)) return [];
  return [
    ...new Set(
      message.messageReactions
        .map((reaction) => reaction.userID)
        .filter(Boolean)
        .map(String),
    ),
  ];
}

// ============================== الأسماء ==============================
const nameCache = new Map();
// الأسماء تُدرج داخل رسائل البوت: نمنع أسطراً جديدة/رموز تحكم/أسماء طويلة قد تنتحل رسائل البوت
function cleanName(value) {
  return String(value || "")
    .replace(/[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 30);
}
function normalizeUserInfo(userId, data) {
  const id = String(userId);
  if (Array.isArray(data))
    return data.find((user) => String(user?.id) === id) || null;
  if (!data || typeof data !== "object") return null;
  if (data[id] && typeof data[id] === "object") return data[id];
  return String(data.id) === id ? data : null;
}
function normalizeUserProfile(userId, data) {
  const user = normalizeUserInfo(userId, data);
  if (!user) return null;
  const name = cleanName(
    user.name || [user.firstName, user.lastName].filter(Boolean).join(" "),
  );
  const avatarUrl =
    typeof user.thumbSrc === "string"
      ? user.thumbSrc
      : typeof user.profilePictureUrl === "string"
        ? user.profilePictureUrl
        : "";
  return { name, avatarUrls: avatarUrl ? [avatarUrl] : [] };
}
function getUserName(userId) {
  if (nameCache.has(userId)) return Promise.resolve(nameCache.get(userId));
  return new Promise((resolve) => {
    const fallback = () =>
      resolve(`لاعب${Math.floor(Math.random() * 900 + 100)}`);
    if (!api) return fallback();
    api.getUserInfo(userId, (err, data) => {
      const u = !err && normalizeUserInfo(userId, data);
      const name = cleanName(
        u && (u.firstName || (u.name || "").split(" ")[0]),
      );
      if (!name) return fallback();
      nameCache.set(userId, name);
      resolve(name);
    });
  });
}
function getUserProfile(userId) {
  return new Promise((resolve, reject) => {
    if (!api || typeof api.getUserInfo !== "function") return resolve(null);
    api.getUserInfo(userId, (err, data) => {
      if (err) return reject(err);
      resolve(normalizeUserProfile(userId, data));
    });
  });
}

// ============================== الدخول ==============================
function ask(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.question(question, (a) => {
      rl.close();
      resolve(a.trim());
    });
  });
}

/** تسجيل دخول عبر المكتبة، مع دعم كود التحقق بخطوتين */
function doLogin(creds) {
  return new Promise((resolve, reject) => {
    const cb = async (err, a) => {
      if (err) {
        if (
          err.error === "login-approval" &&
          typeof err.continue === "function"
        ) {
          const code = await ask("أدخل كود التحقق بخطوتين (2FA): ");
          return err.continue(code);
        }
        if (/retrieving userid/i.test(errText(err)))
          explainMissingIdentityCookie();
        // نطبع الخطأ الخام كامل عشان نعرف السبب الحقيقي (بعض المكتبات بترجع خطأ فاضي)
        console.error(
          "[messenger] login error (raw):",
          util.inspect(err, { depth: 3 }),
        );
        return reject(
          new Error(
            errText(err) ||
              util.inspect(err, { depth: 2 }) ||
              "unknown login error",
          ),
        );
      }
      resolve(a);
    };
    try {
      const options = {};
      if (USER_AGENT) options.userAgent = USER_AGENT;
      if (HTTPS_PROXY) options.proxy = HTTPS_PROXY;
      if (Object.keys(options).length) login(creds, options, cb);
      else login(creds, cb);
    } catch (e) {
      // خطأ حصل جوه المكتبة نفسها: نطبع الـ stack عشان نعرف أنهي ملف
      console.error(
        "[messenger] المكتبة رمت خطأ أثناء الدخول:\n",
        e && e.stack ? e.stack : e,
      );
      reject(e);
    }
  });
}

function readAppState() {
  return secureStore.readAppState(APPSTATE_PATH);
}

function getAccountCookieStatus(appState) {
  const accountCookie = appState.find(
    (cookie) =>
      cookie && ["c_user", "i_user"].includes(cookie.name || cookie.key),
  );
  if (!accountCookie) return "missing";
  return /^\d+$/.test(String(accountCookie.value || "").trim())
    ? "valid"
    : "invalid";
}

async function loginOnce() {
  assertLoginAllowed();
  const appState = LOGIN_MODE === "password" ? null : readAppState();
  let a;
  if (appState) {
    if (FCA_MODULES_WITH_APPSTATE_COOKIES.has(FCA_NAME)) {
      const cookieStatus = getAccountCookieStatus(appState);
      if (cookieStatus === "missing") {
        throw Object.assign(
          new Error(
            `ملف الجلسة ${APPSTATE_PATH} لا يحتوي كوكي c_user أو i_user؛ صدّر appstate جديداً بعد تسجيل الدخول إلى حساب البوت.`,
          ),
          { invalidAppState: true },
        );
      }
      if (cookieStatus === "invalid") {
        throw Object.assign(
          new Error(
            `قيمة كوكي الحساب c_user/i_user في ${APPSTATE_PATH} ليست معرّفاً رقمياً صالحاً. سجّل الدخول إلى Facebook بالحساب الصحيح ثم صدّر appstate جديداً؛ لا تعدّل قيمة الكوكي يدوياً.`,
          ),
          { invalidAppState: true },
        );
      }
    }
    console.log("[messenger] الدخول بالكوكيز (appstate.json)...");
    a = await doLogin({ appState });
  } else if (FB_EMAIL && FB_PASSWORD && LOGIN_MODE === "password") {
    console.log("[messenger] الدخول بالإيميل والباسورد...");
    a = await doLogin({ email: FB_EMAIL, password: FB_PASSWORD });
  } else {
    throw new Error(LOGIN_MODE !== "password"
      ? `وضع appstate مفعّل لكن لا يوجد ملف جلسة صالح في ${APPSTATE_PATH}`
      : "سجّل FB_EMAIL وFB_PASSWORD في .env لاستخدام تسجيل الدخول بكلمة المرور.");
  }
  a.setOptions({
    listenEvents: true,
    selfListen: false,
    autoMarkRead: true,
    online: false,
    // hridoy-fca's E2EE typing indicator uses an MQTT client not connected by its E2EE bridge.
    humanize: { reactDelayMs: [0, 0] },
  });
  const accountId = String(a.getCurrentUserID() || "");
  if (!/^\d{1,64}$/.test(accountId))
    throw new Error(
      "Messenger login returned no valid numeric account ID; check the session and selected FCA library.",
    );
  safety.setAccountId(accountId);
  api = a;
  selfId = accountId;
  e2eeConnected = false;
  return a;
}

async function connectE2EE() {
  try {
    if (FCA_NAME === "hridoy-fca") {
      if (typeof api?._connectE2EEAndMerge !== "function") {
        console.error(
          "[messenger] hridoy-fca does not expose its E2EE connection helper; encrypted DMs may not work.",
        );
        return;
      }
      await api._connectE2EEAndMerge();
      e2eeConnected = Boolean(api.e2ee?.isConnected?.());
      if (!e2eeConnected)
        console.error(
          "[messenger] E2EE is not connected; private messages in encrypted threads may fail.",
        );
      return;
    }

    if (typeof api?.connectE2EE !== "function") return;
    await new Promise((resolve, reject) => {
      api.connectE2EE((error) => (error ? reject(error) : resolve()));
    });
    e2eeConnected = true;
  } catch (e) {
    console.error(
      "[messenger] E2EE connection failed:",
      e && e.stack ? e.stack : errText(e),
    );
  }
}

/** يحفظ الكوكيز فقط بعد ما الاتصال يثبت (مشفّرة إن وُجد APPSTATE_ENCRYPTION_KEY، وبصلاحيات المالك فقط) */
function saveAppState() {
  if (LOGIN_MODE === "password" || !api || !healthy) return;
  try {
    const encrypted = secureStore.saveAppState(APPSTATE_PATH, api.getAppState());
    if (!encrypted && !warnedPlainAppState) {
      warnedPlainAppState = true;
      console.warn(
        "[security] appstate.json محفوظ بدون تشفير. أضف APPSTATE_ENCRYPTION_KEY (16 حرفاً فأكثر) في .env لتشفيره.",
      );
    }
  } catch (e) {
    console.error("[messenger] saveAppState:", e.message);
  }
}

function attach() {
  healthy = false;
  const token = ++attachToken;
  let failed = false;
  if (typeof stopListening === "function") {
    try {
      stopListening();
    } catch {
      /* ignore */
    }
  }
  const listener = api.listenMqtt((err, event) => {
    if (err) {
      failed = true;
      healthy = false;
      const m = errText(err);
      console.error("[messenger] listen error:", m);
      if (FATAL.test(m)) return die(m);
      return reconnect();
    }
    if (event) handler(event);
  });
  stopListening =
    typeof listener === "function"
      ? listener
      : listener && typeof listener.stopListening === "function"
        ? () => listener.stopListening()
        : null;
  // لو عدّى 45 ثانية بدون خطأ نعتبر الاتصال سليم ونحفظ الكوكيز
  setTimeout(() => {
    if (!failed && token === attachToken) {
      healthy = true;
      softRetries = 0;
      reconnectBackoff = 5000;
      console.log("[messenger] الاتصال مستقر ✅");
      saveAppState();
      if (readLock()?.blockedUntil) writeLock({ blockedUntil: 0 });
    }
  }, 45000);
}

async function reconnect() {
  if (reconnecting) {
    reconnectRequested = true;
    return;
  }
  reconnecting = true;
  try {
    for (;;) {
      reconnectRequested = false;
      try {
        // فاصل عشوائي + تضاعف أسي: يمنع نمط إعادة اتصال منتظم يشبه البوتات
        const wait = Math.round(reconnectBackoff * (0.8 + Math.random() * 0.4));
        reconnectBackoff = Math.min(reconnectBackoff * 2, 300000);
        await sleep(wait);
        if (typeof stopListening === "function") {
          try {
            stopListening();
          } catch {
            // Ignore listener cleanup errors before reconnecting.
          }
          stopListening = null;
        }
        if (api && softRetries < MAX_SOFT_RETRIES) {
          softRetries++;
          console.warn(
            `[messenger] إعادة الاستماع على نفس الجلسة (${softRetries}/${MAX_SOFT_RETRIES}) بدون تسجيل دخول جديد...`,
          );
          attach();
          console.log("[messenger] listener re-attached");
        } else {
          await loginOnce();
          await connectE2EE();
          attach();
          console.log("[messenger] reconnected");
        }
      } catch (e) {
        const m = errText(e);
        console.error("[messenger] reconnect failed:", m);
        if (e && e.loginLocked) return process.exit(1);
        // لا نعيد المحاولة على جلسة مرفوضة/حساب موقوف: يزيد الأمر سوءاً. تدخّل يدوي مطلوب.
        if (FATAL.test(m)) return die(m);
        continue;
      }
      if (!reconnectRequested) return;
    }
  } finally {
    reconnecting = false;
  }
}

/** قبول طلبات الرسائل الخاصة (اللاعبون غير الأصدقاء تصل رسائلهم كـ "طلبات") */
function acceptRequests() {
  if (
    !api ||
    typeof api.getThreadList !== "function" ||
    typeof api.handleMessageRequest !== "function"
  )
    return;
  try {
    api.getThreadList(10, null, ["PENDING"], (err, list) => {
      if (err) {
        const message = errText(err);
        if (FATAL.test(message)) return die(message);
        console.warn("[messenger] could not check message requests:", message);
        return;
      }
      if (!Array.isArray(list)) return;
      for (const t of list) {
        if (t.isGroup) continue; // لا نقبل مجموعات عشوائية
        api.handleMessageRequest(t.threadID, true, () => {});
      }
    });
  } catch (e) {
    console.error("[messenger] acceptRequests:", e.message);
  }
}

/** تسجيل الدخول وبدء استقبال الأحداث. onEvent(event) تُستدعى لكل حدث MQTT. */
async function start(onEvent) {
  if (!["appstate", "password", "auto"].includes(LOGIN_MODE)) {
    throw new Error(
      `LOGIN_MODE غير صالح: ${LOGIN_MODE}. استخدم appstate أو password.`,
    );
  }
  if (LOGIN_MODE !== "password" && !USER_AGENT) {
    throw new Error(
      "USER_AGENT is required for appstate login; set the exact user-agent reported by the browser session that exported appstate.",
    );
  }
  handler = onEvent;
  if (LOGIN_MODE !== "password") secureStore.warnIfLoose(APPSTATE_PATH);
  secureStore.warnIfLoose(path.join(__dirname, "..", ".env"));
  releaseProcessLock = acquireProcessLock(PROCESS_LOCK_PATH);
  try {
    await loginOnce();
    await connectE2EE();
    attach();
    console.log(`[messenger] logged in as ${selfId}`);
  } catch (error) {
    if (BLOCKED_ACCOUNT.test(errText(error)) && !error.loginLocked) {
      writeLock({
        ts: Date.now(),
        blockedUntil: Date.now() + LOCK_HOURS * 3600000,
        reason: redact(errText(error)).slice(0, 200),
      });
      console.error(
        "[messenger] تم رصد checkpoint أو login_blocked؛ أُوقف بدء البوت وسُجّل القفل. لا تُعد المحاولة تلقائياً؛ أكمل التحقق يدوياً أولاً.",
      );
    }
    releaseProcessLock();
    releaseProcessLock = null;
    throw error;
  }
  setInterval(saveAppState, 30 * 60 * 1000);
  if (process.env.AUTO_ACCEPT_REQUESTS !== "false") {
    // فحص طلبات الرسائل كل 3-5 دقائق (بدل كل دقيقة ثابتة): أقل نمطية وأقل طلبات على فيسبوك
    const base = Math.max(60, Number(process.env.ACCEPT_REQUESTS_SECONDS) || 240);
    const loop = () => {
      acceptRequests();
      setTimeout(loop, Math.round(base * (0.75 + Math.random() * 0.5)) * 1000).unref();
    };
    setTimeout(loop, 30000).unref();
  }
}

module.exports = {
  start,
  sendGroup,
  sendGroupTracked,
  sendGroupImageTracked,
  sendGroupImageBufferTracked,
  sendGroupVideoBufferTracked,
  sendGroupImageBuffersTracked,
  sendPrivateImageWithResult,
  sendPrivateImageBufferWithResult,
  sendPrivateVideoBufferWithResult,
  sendPrivateImageBuffersWithResult,
  sendPrivate,
  sendPrivateWithResult,
  sendPrivateNotice,
  removeUserFromGroup,
  getReactors,
  getUserName,
  normalizeUserInfo,
  getUserProfile,
  normalizeUserProfile,
  formatDisplayedCommands,
  getConnectionStatus: () => ({
    loggedIn: Boolean(api && selfId),
    listenerHealthy: healthy,
    e2eeSupported:
      FCA_NAME === "hridoy-fca" || typeof api?.connectE2EE === "function",
    e2eeConnected:
      e2eeConnected || Boolean(api?.e2ee?.isConnected?.()),
  }),
  selfId: () => selfId,
};
