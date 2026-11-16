// أمر بنترست: «بنترست <وصف> [عدد]» يرسل أول N صور جديدة من النتائج (الافتراضي 1).
//
// ملف مستقل: يحتاج axios فقط (موجود أصلاً في المشروع). الربط في آخر الملف README/التعليقات.
//
// ⚠️ لا توجد واجهة رسمية متاحة للبحث في الدبابيس للتطبيقات العادية (search/partner/pins للشركاء فقط)،
// لذلك يستخدم هذا الملف نقطة البحث العامة التي يستخدمها موقع بنترست نفسه. هي غير موثّقة وقد تتغير
// أو تُحجب في أي وقت. عند الحجب (403/429) يتوقف الأمر تلقائياً 15 دقيقة بدل الإلحاح.
//
// أمان الحساب: الحد الأقصى للصور في الطلب، فاصل لكل مستخدم ولكل محادثة، سقف ساعي، طلب واحد
// لكل مستخدم في آن واحد. والإرسال نفسه يمر عبر طبقة الإرسال الحالية (فواصل عشوائية وحدود عامة).

const crypto = require("node:crypto");

const MAX_IMAGE_BYTES = 8 * 1024 * 1024; // أقل من حد الإرسال (10MB)
const MAX_QUERY_LENGTH = 100;
const MAX_PIN_CANDIDATES = 25;
const RECENT_IMAGE_KEY_LIMIT = 20_000;
const SESSION_TTL_MS = 30 * 60 * 1000;
const PAUSE_MS = 15 * 60 * 1000;
const BASE_URL = "https://www.pinterest.com";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

// ---------- الإعدادات (من .env) ----------
function envInt(name, fallback, min, max) {
  const raw = process.env[name];
  const n = raw === undefined || raw === "" ? NaN : Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}
const cfg = () => ({
  enabled: process.env.PINTEREST_ENABLED !== "0",
  maxImages: envInt("PINTEREST_MAX_IMAGES", 5, 1, 10),
  userCooldownMs: envInt("PINTEREST_USER_COOLDOWN_SECONDS", 20, 0, 3600) * 1000,
  threadCooldownMs: envInt("PINTEREST_THREAD_COOLDOWN_SECONDS", 8, 0, 3600) * 1000,
  maxRequestsPerHour: envInt("PINTEREST_MAX_REQUESTS_PER_HOUR", 60, 1, 10000),
  maxImagesPerHour: envInt("PINTEREST_MAX_IMAGES_PER_HOUR", 100, 1, 10000),
  progressNotice: process.env.PINTEREST_PROGRESS_NOTICE === "1",
});

// ---------- تحليل الأمر ----------
const TRIGGER = /^\s*([/!.]?)\s*(بنترست|بينترست|بنتريست|pinterest|pin)(?=\s|$)\s*([\s\S]*)$/i;
const COUNT_WORDS = "(?:صور[ةه]?|images?|pics?|photos?)";
const ARABIC_DIGITS = "٠١٢٣٤٥٦٧٨٩";

function normalizeDigits(text) {
  return String(text).replace(/[٠-٩]/g, (d) => String(ARABIC_DIGITS.indexOf(d)));
}

/**
 * يعيد null إن لم تكن الرسالة أمر بنترست، وإلا { query, count|null, usage:boolean }.
 * العدد يُقبل في بداية الوصف أو نهايته (1–2 خانة): «بنترست 3 قطط» / «بنترست قطط 3» / «قطط x3» / «3 صور قطط».
 * الأرقام الأطول (مثل 2024) تبقى جزءاً من الوصف.
 */
function parseCommand(text) {
  const m = TRIGGER.exec(String(text || ""));
  if (!m) return null;
  const [, prefix, word, restRaw] = m;
  // الكلمة المختصرة pin تحتاج بادئة (/ أو ! أو .) حتى لا تتصادم مع الكلام العادي
  if (word.toLowerCase() === "pin" && !prefix) return null;

  let rest = normalizeDigits(restRaw)
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  let count = null;

  let c = new RegExp(`^(\\d{1,2})\\s*(?:x|×|\\*)?\\s*${COUNT_WORDS}?\\s+(.+)$`, "i").exec(rest);
  if (c) {
    count = Number(c[1]);
    rest = c[2];
  } else {
    c = new RegExp(`^(.+?)\\s+(?:x|×|\\*)?(\\d{1,2})\\s*${COUNT_WORDS}?$`, "i").exec(rest);
    if (c) {
      count = Number(c[2]);
      rest = c[1];
    } else if (/^\d{1,2}$/.test(rest)) {
      return { query: "", count: null, usage: true };
    }
  }
  if (count !== null && count < 1) {
    // «0» ليس عدداً صالحاً: نتركه جزءاً من الوصف
    rest = normalizeDigits(restRaw).replace(/\s+/g, " ").trim();
    count = null;
  }
  rest = rest.replace(new RegExp(`^${COUNT_WORDS}\\s+`, "i"), "").trim();
  if (!rest) return { query: "", count, usage: true };
  return { query: rest.slice(0, MAX_QUERY_LENGTH), count, usage: false };
}

// ---------- تصفية الطلبات غير اللائقة ----------
const BLOCKED_EN = /\b(porn\w*|nude\w*|naked|xxx|nsfw|hentai|sex\w*|erotic\w*|gore|fetish)\b/i;
const BLOCKED_AR = /(سكس|اباحي|إباحي|عاري|عارية|عراة|نيك)/;
function isBlockedQuery(query) {
  if (BLOCKED_EN.test(query) || BLOCKED_AR.test(query)) return true;
  const extra = (process.env.PINTEREST_BLOCKED_TERMS || "")
    .split(",")
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);
  const q = query.toLowerCase();
  return extra.some((t) => q.includes(t));
}

// ---------- HTTP (axios يُحمَّل عند أول استخدام ليسهل الاختبار) ----------
let http = null;
function getHttp() {
  if (!http) http = require("axios");
  return http;
}
function setHttp(client) {
  http = client;
}

// ---------- جلسة بنترست (app version + كوكيز الزائر) ----------
let session = null; // { appVersion, cookie, csrf, at }
let providerPausedUntil = 0;
let consecutive403 = 0;
let clock = () => Date.now();

function parseSession(response) {
  const html = typeof response.data === "string" ? response.data : "";
  const v = /"appVersion"\s*:\s*"([^"]+)"/.exec(html);
  const raw = response.headers?.["set-cookie"];
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const pairs = list.map((c) => String(c).split(";", 1)[0]).filter(Boolean);
  const csrf = pairs.map((p) => /^csrftoken=(.+)$/.exec(p)?.[1]).find(Boolean) || "";
  return { appVersion: v ? v[1] : "", cookie: pairs.join("; "), csrf, at: clock() };
}

async function ensureSession(force = false) {
  if (!force && session && clock() - session.at < SESSION_TTL_MS) return session;
  try {
    const res = await getHttp().get(`${BASE_URL}/`, {
      timeout: 15000,
      maxRedirects: 3,
      maxContentLength: 6 * 1024 * 1024,
      responseType: "text",
      validateStatus: () => true,
      headers: { "User-Agent": UA, Accept: "text/html,*/*;q=0.8", "Accept-Language": "en-US,en;q=0.9" },
    });
    session = res.status === 200 ? parseSession(res) : { appVersion: "", cookie: "", csrf: "", at: clock() };
  } catch {
    session = { appVersion: "", cookie: "", csrf: "", at: clock() };
  }
  return session;
}

class ProviderError extends Error {
  constructor(message, kind) {
    super(message);
    this.kind = kind; // "blocked" | "network" | "format"
  }
}

function pickImageVariants(pin) {
  const images = pin && pin.images;
  if (!images || typeof images !== "object") return [];
  const out = [];
  for (const key of ["orig", "736x", "564x", "474x"]) {
    const url = images[key] && images[key].url;
    if (typeof url === "string") out.push(url);
  }
  return out;
}

/** يعيد قائمة دبابيس مرتبة كما في نتائج بنترست: [{ id, variants:[url...] }] */
function parseResults(body) {
  const results = body?.resource_response?.data?.results;
  if (!Array.isArray(results)) throw new ProviderError("unexpected response shape", "format");
  const seen = new Set();
  const pins = [];
  for (const pin of results) {
    if (!pin || (pin.type && pin.type !== "pin")) continue;
    const variants = pickImageVariants(pin);
    const id = String(pin.id || pin.node_id || variants[0] || "");
    if (!variants.length || seen.has(id)) continue;
    seen.add(id);
    pins.push({ id, variants });
  }
  return pins;
}

async function searchPins(query, retried = false) {
  if (clock() < providerPausedUntil) throw new ProviderError("provider paused", "blocked");
  const s = await ensureSession(retried);
  const sourceUrl = `/search/pins/?q=${encodeURIComponent(query)}&rs=typed`;
  const data = JSON.stringify({ options: { query, scope: "pins", bookmarks: [""] }, context: {} });
  const headers = {
    "User-Agent": UA,
    Accept: "application/json, text/javascript, */*, q=0.01",
    "Accept-Language": "en-US,en;q=0.9",
    Referer: `${BASE_URL}${sourceUrl}`,
    "X-Requested-With": "XMLHttpRequest",
    "X-Pinterest-AppState": "active",
    "X-Pinterest-Source-Url": sourceUrl,
    "X-Pinterest-PWS-Handler": "www/search/[scope].js",
  };
  if (s.appVersion) headers["X-APP-VERSION"] = s.appVersion;
  if (s.csrf) headers["X-CSRFToken"] = s.csrf;
  if (s.cookie) headers.Cookie = s.cookie;

  let res;
  try {
    res = await getHttp().get(`${BASE_URL}/resource/BaseSearchResource/get/`, {
      params: { source_url: sourceUrl, data, _: clock() },
      headers,
      timeout: 15000,
      maxContentLength: 4 * 1024 * 1024,
      validateStatus: () => true,
    });
  } catch {
    throw new ProviderError("network error", "network");
  }

  if (res.status === 429 || res.status === 403) {
    if (res.status === 403 && !retried) return searchPins(query, true); // جلسة منتهية: تجديد مرة واحدة
    consecutive403 += 1;
    if (res.status === 429 || consecutive403 >= 2) {
      providerPausedUntil = clock() + PAUSE_MS;
      consecutive403 = 0;
    }
    throw new ProviderError(`HTTP ${res.status}`, "blocked");
  }
  if (res.status !== 200) throw new ProviderError(`HTTP ${res.status}`, "network");
  consecutive403 = 0;
  const body = typeof res.data === "string" ? safeJson(res.data) : res.data;
  return parseResults(body);
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    throw new ProviderError("invalid json", "format");
  }
}

// ---------- تنزيل الصور ----------
function sniffImageType(buffer) {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
    return "image/png";
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
  if (buffer.length >= 12 && buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP")
    return "image/webp";
  return null; // GIF وغيره غير مدعوم في الإرسال: نجرب نسخة أخرى من نفس الدبوس
}

/** صور بنترست فقط، عبر HTTPS (حماية من SSRF لو تغيّر شكل الرد) */
function validateImageUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  const hostOk = url.hostname === "pinimg.com" || url.hostname.endsWith(".pinimg.com");
  if (url.protocol !== "https:" || (url.port && url.port !== "443") || url.username || url.password || !hostOk)
    return null;
  return url;
}

async function downloadVariant(value) {
  const url = validateImageUrl(value);
  if (!url) return null;
  let res;
  try {
    res = await getHttp().get(url.toString(), {
      responseType: "arraybuffer",
      timeout: 20000,
      maxRedirects: 0,
      maxContentLength: MAX_IMAGE_BYTES,
      validateStatus: () => true,
      headers: { "User-Agent": UA, Accept: "image/webp,image/jpeg,image/png,image/*;q=0.8", Referer: `${BASE_URL}/` },
    });
  } catch {
    return null; // يشمل تجاوز الحجم الأقصى
  }
  if (res.status !== 200) return null;
  const buffer = Buffer.from(res.data);
  if (!buffer.length || buffer.length > MAX_IMAGE_BYTES) return null;
  const contentType = sniffImageType(buffer);
  return contentType ? { buffer, contentType } : null;
}

async function downloadPin(pin) {
  for (const variant of pin.variants) {
    const image = await downloadVariant(variant);
    if (image)
      return {
        ...image,
        id: pin.id,
        hash: crypto.createHash("sha256").update(image.buffer).digest("hex"),
      };
  }
  return null;
}

const recentlySentImages = new Map();
const reservedImages = new Set();

function pinCacheKey(id) {
  return `pin:${id}`;
}

function imageCacheKey(hash) {
  return `sha256:${hash}`;
}

function rememberSentImage(image) {
  const now = clock();
  const keys = [pinCacheKey(image.id), imageCacheKey(image.hash)];
  for (const key of keys) {
    recentlySentImages.set(key, now);
    reservedImages.delete(key);
  }
  trimMap(recentlySentImages, RECENT_IMAGE_KEY_LIMIT);
}

function releaseReservedImage(image) {
  reservedImages.delete(pinCacheKey(image.id));
  reservedImages.delete(imageCacheKey(image.hash));
}

/** يجلب صوراً غير مرسلة سابقاً، ويمر إلى النتائج التالية عند تكرارها */
async function fetchImages(query, count) {
  const pins = await searchPins(query);
  if (!pins.length) return { images: [], repeated: false };
  const images = [];
  let candidates = 0;
  let repeated = false;
  for (const pin of pins) {
    if (images.length >= count || candidates >= MAX_PIN_CANDIDATES) break;
    const idKey = pinCacheKey(pin.id);
    if (recentlySentImages.has(idKey) || reservedImages.has(idKey)) {
      repeated = true;
      continue;
    }
    candidates += 1;
    const image = await downloadPin(pin);
    if (!image) continue;
    const hashKey = imageCacheKey(image.hash);
    const imageIdKey = pinCacheKey(image.id);
    if (recentlySentImages.has(hashKey) || reservedImages.has(hashKey)) {
      repeated = true;
      continue;
    }
    reservedImages.add(imageIdKey);
    reservedImages.add(hashKey);
    images.push(image);
  }
  return { images, repeated };
}

// ---------- حدود الاستخدام ----------
const lastByUser = new Map();
const lastByThread = new Map();
const noticeAt = new Map();
const inFlight = new Set();
let requestTimes = [];
let imageTimes = [];

function prune(list, now) {
  return list.filter((t) => now - t < 3600000);
}
function trimMap(map, max = 5000) {
  while (map.size > max) map.delete(map.keys().next().value);
}

function checkLimits(userId, threadId, count, c, now) {
  if (inFlight.has(userId)) return "busy";
  const u = lastByUser.get(userId);
  if (u && now - u < c.userCooldownMs) return "user";
  const t = lastByThread.get(threadId);
  if (t && now - t < c.threadCooldownMs) return "thread";
  requestTimes = prune(requestTimes, now);
  imageTimes = prune(imageTimes, now);
  if (requestTimes.length >= c.maxRequestsPerHour || imageTimes.length + count > c.maxImagesPerHour)
    return "hourly";
  return null;
}

// ---------- المعالج الرئيسي ----------
const USAGE =
  "📌 اكتب: بنترست + وصف الصورة.\nولو تريد أكثر من صورة أضف العدد.\nمثال: بنترست قطط لطيفة\nمثال: بنترست 3 غروب الشمس";

let pending = Promise.resolve();

async function notice(deps, ctx, text) {
  const key = `${ctx.userId}`;
  const now = clock();
  if (now - (noticeAt.get(key) || 0) < 30000) return; // لا نرد على كل تكرار: كل رد هو رسالة إرسال إضافية
  noticeAt.set(key, now);
  trimMap(noticeAt);
  await deps.sendText(ctx.threadId, text, ctx.isGroup);
}

async function run(ctx, deps, parsed, count, clamped, c) {
  const { query } = parsed;
  let selectedImages = [];
  try {
    if (c.progressNotice) await deps.sendText(ctx.threadId, `🔎 أبحث في بنترست عن: ${query}`, ctx.isGroup);
    const { images, repeated } = await fetchImages(query, count);
    selectedImages = images;
    if (!images.length) {
      const message = repeated
        ? `النتائج الأولى لـ «${query}» سبق إرسالها؛ جرّب وصفاً أدق للحصول على صور جديدة.`
        : `ما لقيت صور مناسبة لـ «${query}» 😕 جرّب وصفاً آخر.`;
      await deps.sendText(ctx.threadId, message, ctx.isGroup);
      return;
    }
    let sent = 0;
    if (images.length > 1 && typeof deps.sendImages === "function") {
      const batch = images.map((image, index) => ({
        ...image,
        caption: `📌 ${query} (${index + 1}/${images.length})`,
      }));
      if (await deps.sendImages(ctx.threadId, batch, ctx.isGroup)) {
        sent = batch.length;
        for (const image of images) {
          imageTimes.push(clock());
          rememberSentImage(image);
        }
      }
    } else {
      for (let i = 0; i < images.length; i++) {
        const caption = images.length > 1 ? `📌 ${query} (${i + 1}/${images.length})` : `📌 ${query}`;
        const ok = await deps.sendImage(ctx.threadId, images[i].buffer, images[i].contentType, caption, ctx.isGroup);
        if (!ok) break; // فشل الإرسال (حد أمان/رفض): لا نواصل الإلحاح
        sent += 1;
        imageTimes.push(clock());
        rememberSentImage(images[i]);
      }
    }
    if (sent === 0) {
      await deps.sendText(ctx.threadId, "ما قدرت أرسل الصورة الآن، جرّب بعد قليل.", ctx.isGroup);
    } else if (clamped || sent < count) {
      let why;
      if (clamped) why = `الحد الأقصى ${c.maxImages} صور في الطلب، فأرسلت ${sent}.`;
      else if (repeated) why = `أرسلت ${sent} صورة جديدة فقط؛ بقية النتائج سبق إرسالها.`;
      else why = `ما وجدت إلا ${sent} من ${count} صور صالحة.`;
      await deps.sendText(ctx.threadId, why, ctx.isGroup);
    }
  } catch (error) {
    const kind = error && error.kind;
    console.error(`[pinterest] ${kind || "error"}: ${error && error.message}`);
    const msg =
      kind === "blocked"
        ? "بنترست مشغول الآن، جرّب بعد قليل."
        : "تعذّر البحث في بنترست حالياً، جرّب بعد قليل.";
    await deps.sendText(ctx.threadId, msg, ctx.isGroup).catch(() => {});
  } finally {
    for (const image of selectedImages) releaseReservedImage(image);
    inFlight.delete(ctx.userId);
  }
}

/**
 * ctx: { userId, threadId, isGroup, text }
 * deps: { sendText, sendImage, sendImages(threadId, images, isGroup) → boolean }
 * يعيد true إن كانت الرسالة أمر بنترست (حتى لو رُفضت بسبب الحدود) كي لا تصل للألعاب.
 * البحث والإرسال يعملان في الخلفية فلا يعطّلان طابور المحادثة.
 */
async function tryHandle(ctx, deps) {
  const parsed = parseCommand(ctx && ctx.text);
  if (!parsed) return false;
  const c = cfg();
  if (!c.enabled) return false;

  ctx = { ...ctx, userId: String(ctx.userId), threadId: String(ctx.threadId) };
  if (parsed.usage) {
    await notice(deps, ctx, USAGE);
    return true;
  }
  if (isBlockedQuery(parsed.query)) {
    await notice(deps, ctx, "هذا الطلب غير مسموح 🚫");
    return true;
  }

  const requested = parsed.count ?? 1;
  const count = Math.min(requested, c.maxImages);
  const now = clock();
  const limited = checkLimits(ctx.userId, ctx.threadId, count, c, now);
  if (limited) {
    if (limited === "hourly") await notice(deps, ctx, "وصلنا للحد الأقصى لطلبات بنترست هذه الساعة، جرّبوا لاحقاً.");
    else if (limited === "user") await notice(deps, ctx, "تمهّل قليلاً بين طلبات بنترست ⏳");
    return true;
  }

  inFlight.add(ctx.userId);
  lastByUser.set(ctx.userId, now);
  lastByThread.set(ctx.threadId, now);
  trimMap(lastByUser);
  trimMap(lastByThread);
  requestTimes.push(now);

  pending = run(ctx, deps, parsed, count, requested > count, c).catch(() => {});
  return true;
}

/** يربط الأمر بأي طبقة رسائل فيها نفس واجهة messengerFacebook/telegram */
function createDeps(messenger) {
  return {
    sendText: (threadId, text, isGroup) =>
      isGroup ? messenger.sendGroup(threadId, text) : messenger.sendPrivate(threadId, text),
    sendImage: async (threadId, buffer, contentType, caption, isGroup) => {
      if (isGroup) return Boolean(await messenger.sendGroupImageBufferTracked(threadId, buffer, contentType, caption));
      const r = await messenger.sendPrivateImageBufferWithResult(threadId, buffer, contentType, caption);
      return Boolean(r && r.ok);
    },
    sendImages: async (threadId, images, isGroup) => {
      if (isGroup)
        return Boolean(
          await messenger.sendGroupImageBuffersTracked(threadId, images),
        );
      const result = await messenger.sendPrivateImageBuffersWithResult(
        threadId,
        images,
      );
      return Boolean(result?.ok);
    },
  };
}

module.exports = {
  tryHandle,
  parseCommand,
  createDeps,
  idle: () => pending,
  _internal: {
    setHttp,
    setClock: (fn) => {
      clock = fn;
    },
    parseResults,
    validateImageUrl,
    isBlockedQuery,
    reset() {
      session = null;
      providerPausedUntil = 0;
      consecutive403 = 0;
      lastByUser.clear();
      lastByThread.clear();
      noticeAt.clear();
      inFlight.clear();
      requestTimes = [];
      imageTimes = [];
      recentlySentImages.clear();
      reservedImages.clear();
      pending = Promise.resolve();
      clock = () => Date.now();
    },
  },
};

/*
=== الربط (3 أسطر) ===

server.js (ماسنجر) — فوق استدعاء aiChat.tryHandle داخل enqueue:
  const pinterest = require('./services/pinterest');
  const pinterestDeps = pinterest.createDeps(messenger);
  ...
  if (await pinterest.tryHandle({ userId: String(ev.senderID), threadId: String(ev.threadID), isGroup, text }, pinterestDeps)) return;

telegram.js — نفس الشيء داخل enqueueUpdate قبل aiChat.tryHandle:
  if (await pinterest.tryHandle(context, pinterest.createDeps(telegramMessenger()))) return;

.env (اختياري):
  PINTEREST_MAX_IMAGES=5                 # أقصى صور في الطلب (الحد الأعلى 10)
  PINTEREST_USER_COOLDOWN_SECONDS=20
  PINTEREST_THREAD_COOLDOWN_SECONDS=8
  PINTEREST_MAX_REQUESTS_PER_HOUR=60
  PINTEREST_MAX_IMAGES_PER_HOUR=100
  PINTEREST_BLOCKED_TERMS=كلمة1,كلمة2    # كلمات ممنوعة إضافية
  PINTEREST_PROGRESS_NOTICE=0            # 1 = رسالة «أبحث...» قبل الصور (تستهلك رسالة إرسال)
  PINTEREST_ENABLED=1                    # 0 لإيقاف الأمر
*/
