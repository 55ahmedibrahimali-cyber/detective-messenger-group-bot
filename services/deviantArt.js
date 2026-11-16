"use strict";

const crypto = require("node:crypto");

const API_BASE = "https://www.deviantart.com/api/v1/oauth2";
const TOKEN_URL = "https://www.deviantart.com/oauth2/token";
const MAX_QUERY_LENGTH = 100;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_API_BYTES = 2 * 1024 * 1024;
const MAX_CANDIDATES = 40;
const RECENT_LIMIT = 10_000;
const recentImages = new Map();
const reservedImages = new Set();
const activeUsers = new Set();
const lastByUser = new Map();
const lastByThread = new Map();
let requestTimes = [];
let imageTimes = [];
let accessToken = null;
let tokenExpiresAt = 0;
let tokenRequest = null;
let clock = () => Date.now();
let pending = Promise.resolve();

class ProviderError extends Error {
  constructor(message, kind) {
    super(message);
    this.kind = kind;
  }
}

function config() {
  const int = (name, fallback, min, max) => {
    const value = Number(process.env[name]);
    return Number.isFinite(value)
      ? Math.min(max, Math.max(min, Math.trunc(value)))
      : fallback;
  };
  return {
    enabled: process.env.DEVIANTART_ENABLED !== "0",
    maxImages: int("DEVIANTART_MAX_IMAGES", 5, 1, 10),
    userCooldownMs:
      int("DEVIANTART_USER_COOLDOWN_SECONDS", 20, 0, 3600) * 1000,
    threadCooldownMs:
      int("DEVIANTART_THREAD_COOLDOWN_SECONDS", 8, 0, 3600) * 1000,
    maxRequestsPerHour: int("DEVIANTART_MAX_REQUESTS_PER_HOUR", 60, 1, 10000),
    maxImagesPerHour: int("DEVIANTART_MAX_IMAGES_PER_HOUR", 100, 1, 10000),
    progressNotice: process.env.DEVIANTART_PROGRESS_NOTICE === "1",
  };
}

const TRIGGER =
  /^\s*([/!.]?)\s*(صورة|ديفاينت\s*(?:آ|ا)?رت|ديفينت\s*(?:آ|ا)?رت|ديفيانت\s*(?:آ|ا)?رت|دايفينت\s*(?:آ|ا)?رت|deviant\s*art|deviantart)(?=\s|$)\s*([\s\S]*)$/i;
const ARABIC_DIGITS = "٠١٢٣٤٥٦٧٨٩";
const COUNT_WORDS = "(?:صور[ةه]?|أعمال|اعمال|images?|pics?|photos?)";

function normalizeDigits(value) {
  return String(value).replace(/[٠-٩]/g, (digit) =>
    String(ARABIC_DIGITS.indexOf(digit)),
  );
}

function parseCommand(text) {
  const match = TRIGGER.exec(String(text || ""));
  if (!match) return null;
  let rest = normalizeDigits(match[3])
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (match[2] === "صورة" && !rest) return null;
  let count = null;
  let parsed = new RegExp(
    `^(\\d{1,2})\\s*(?:x|×|\\*)?\\s*${COUNT_WORDS}?\\s+(.+)$`,
    "i",
  ).exec(rest);
  if (parsed) {
    count = Number(parsed[1]);
    rest = parsed[2];
  } else {
    parsed = new RegExp(
      `^(.+?)\\s+(?:x|×|\\*)?(\\d{1,2})\\s*${COUNT_WORDS}?$`,
      "i",
    ).exec(rest);
    if (parsed) {
      count = Number(parsed[2]);
      rest = parsed[1];
    } else if (/^\d{1,2}$/.test(rest)) {
      return { query: "", count: null, usage: true };
    }
  }
  if (count !== null && count < 1) {
    rest = normalizeDigits(match[3]).replace(/\s+/g, " ").trim();
    count = null;
  }
  rest = rest.replace(new RegExp(`^${COUNT_WORDS}\\s+`, "i"), "").trim();
  return {
    query: rest.slice(0, MAX_QUERY_LENGTH),
    count,
    usage: !rest,
  };
}

const BLOCKED_QUERY =
  /\b(porn\w*|nude\w*|naked|xxx|nsfw|hentai|sex\w*|erotic\w*|gore|fetish)\b|سكس|اباحي|إباحي|عاري|عارية|عراة|نيك/i;

function isBlockedQuery(query) {
  if (BLOCKED_QUERY.test(query)) return true;
  const extra = (process.env.DEVIANTART_BLOCKED_TERMS || "")
    .split(",")
    .map((term) => term.trim().toLowerCase())
    .filter(Boolean);
  const normalized = query.toLowerCase();
  return extra.some((term) => normalized.includes(term));
}

function credentials() {
  const clientId = process.env.DEVIANTART_CLIENT_ID?.trim();
  const clientSecret = process.env.DEVIANTART_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) {
    throw new ProviderError(
      "يلزم تسجيل تطبيق DeviantArt وإضافة DEVIANTART_CLIENT_ID وDEVIANTART_CLIENT_SECRET إلى ملف البيئة.",
      "credentials",
    );
  }
  return { clientId, clientSecret };
}

async function readLimited(response, maxBytes) {
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > maxBytes)
    throw new ProviderError("response too large", "format");
  if (!response.body) throw new ProviderError("empty response", "format");
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new ProviderError("response too large", "format");
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, total);
}

async function readJson(response, kind) {
  const buffer = await readLimited(response, MAX_API_BYTES);
  try {
    return JSON.parse(buffer.toString("utf8"));
  } catch {
    throw new ProviderError(`invalid ${kind} response`, "format");
  }
}

async function requestAccessToken() {
  const { clientId, clientSecret } = credentials();
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: clientId,
    client_secret: clientSecret,
  });
  let response;
  try {
    response = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
      signal: AbortSignal.timeout(15000),
    });
  } catch (error) {
    throw new ProviderError(`token request failed: ${error.message}`, "network");
  }
  const result = await readJson(response, "token");
  if (!response.ok || typeof result.access_token !== "string") {
    throw new ProviderError(
      "فشل تفويض تطبيق DeviantArt. تحقق من بيانات التطبيق وصلاحية browse.",
      response.status === 429 ? "rate" : "credentials",
    );
  }
  accessToken = result.access_token;
  const expiresIn = Number(result.expires_in) || 3600;
  tokenExpiresAt = clock() + Math.max(30, expiresIn - 60) * 1000;
  return accessToken;
}

async function getAccessToken() {
  if (accessToken && clock() < tokenExpiresAt) return accessToken;
  if (!tokenRequest) {
    const currentRequest = requestAccessToken();
    tokenRequest = currentRequest;
    const clearRequest = () => {
      if (tokenRequest === currentRequest) tokenRequest = null;
    };
    currentRequest.then(clearRequest, clearRequest);
  }
  return tokenRequest;
}

async function searchTag(query, retried = false) {
  const token = await getAccessToken();
  const url = new URL(`${API_BASE}/browse/tags`);
  url.searchParams.set("tag", query);
  url.searchParams.set("limit", "50");
  let response;
  try {
    response = await fetch(url, {
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/json",
        "dA-minor-version": "20240701",
      },
      signal: AbortSignal.timeout(15000),
    });
  } catch (error) {
    throw new ProviderError(`search request failed: ${error.message}`, "network");
  }
  const result = await readJson(response, "search");
  if (response.status === 401 && !retried) {
    accessToken = null;
    tokenExpiresAt = 0;
    return searchTag(query, true);
  }
  if (!response.ok) {
    throw new ProviderError(
      `DeviantArt API returned HTTP ${response.status}`,
      response.status === 429 ? "rate" : "network",
    );
  }
  if (!Array.isArray(result.results))
    throw new ProviderError("unexpected search response", "format");
  return result.results;
}

function allowedImageUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  const allowedHost =
    host === "wixmp.com" ||
    host.endsWith(".wixmp.com") ||
    host === "deviantart.net" ||
    host.endsWith(".deviantart.net");
  if (
    url.protocol !== "https:" ||
    (url.port && url.port !== "443") ||
    url.username ||
    url.password ||
    !allowedHost
  )
    return null;
  return url;
}

function imageType(buffer) {
  if (
    buffer.length >= 8 &&
    buffer
      .subarray(0, 8)
      .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    return "image/png";
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff)
    return "image/jpeg";
  if (
    buffer.length >= 12 &&
    buffer.toString("ascii", 0, 4) === "RIFF" &&
    buffer.toString("ascii", 8, 12) === "WEBP"
  )
    return "image/webp";
  return null;
}

function imageUrls(deviation) {
  return [
    deviation.preview?.src,
    deviation.social_preview?.src,
    ...(Array.isArray(deviation.thumbs)
      ? deviation.thumbs.map((thumb) => thumb?.src)
      : []),
  ].filter((url) => allowedImageUrl(url));
}

function safeText(value, maxLength) {
  return String(value || "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function safeDeviationUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      (url.hostname === "deviantart.com" ||
        url.hostname.endsWith(".deviantart.com"))
      ? url.toString()
      : "";
  } catch {
    return "";
  }
}

function parseResults(results) {
  const seen = new Set();
  const deviations = [];
  for (const item of results) {
    if (
      !item ||
      item.is_mature === true ||
      item.is_deleted === true ||
      item.is_blocked === true ||
      item.is_published === false
    )
      continue;
    const urls = imageUrls(item);
    const id = String(item.deviationid || urls[0] || "");
    if (!id || !urls.length || seen.has(id)) continue;
    seen.add(id);
    const title = safeText(item.title, 120) || "عمل فني";
    const artist = safeText(item.author?.username, 80) || "فنان";
    const pageUrl = safeDeviationUrl(item.url);
    deviations.push({
      id,
      urls,
      caption: `🎨 ${title} — ${artist}${pageUrl ? `\n${pageUrl}` : ""}`,
    });
  }
  return deviations;
}

async function downloadImage(value) {
  let currentUrl = value;
  for (let redirects = 0; redirects <= 2; redirects++) {
    const url = allowedImageUrl(currentUrl);
    if (!url) return null;
    let response;
    try {
      response = await fetch(url, {
        redirect: "manual",
        headers: { accept: "image/png,image/jpeg,image/webp,image/*;q=0.8" },
        signal: AbortSignal.timeout(20000),
      });
    } catch {
      return null;
    }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (!location || redirects === 2) return null;
      currentUrl = new URL(location, url).toString();
      continue;
    }
    if (!response.ok) return null;
    let buffer;
    try {
      buffer = await readLimited(response, MAX_IMAGE_BYTES);
    } catch {
      return null;
    }
    const contentType = imageType(buffer);
    if (!contentType) return null;
    return {
      buffer,
      contentType,
      hash: crypto.createHash("sha256").update(buffer).digest("hex"),
    };
  }
  return null;
}

function cacheKey(kind, value) {
  return `${kind}:${value}`;
}

function trimMap(map) {
  while (map.size > RECENT_LIMIT) map.delete(map.keys().next().value);
}

async function fetchImages(query, count) {
  const deviations = parseResults(await searchTag(query));
  const images = [];
  let repeated = false;
  let candidates = 0;
  for (const deviation of deviations) {
    if (images.length >= count || candidates >= MAX_CANDIDATES) break;
    const idKey = cacheKey("deviation", deviation.id);
    if (recentImages.has(idKey) || reservedImages.has(idKey)) {
      repeated = true;
      continue;
    }
    candidates += 1;
    reservedImages.add(idKey);
    let image = null;
    for (const url of deviation.urls) {
      image = await downloadImage(url);
      if (image) break;
    }
    if (!image) {
      reservedImages.delete(idKey);
      continue;
    }
    const hashKey = cacheKey("sha256", image.hash);
    if (recentImages.has(hashKey) || reservedImages.has(hashKey)) {
      repeated = true;
      reservedImages.delete(idKey);
      continue;
    }
    reservedImages.add(hashKey);
    images.push({ ...image, idKey, hashKey, caption: deviation.caption });
  }
  return { images, repeated };
}

function rememberImage(image) {
  const now = clock();
  recentImages.set(image.idKey, now);
  recentImages.set(image.hashKey, now);
  reservedImages.delete(image.idKey);
  reservedImages.delete(image.hashKey);
  trimMap(recentImages);
}

function releaseImage(image) {
  reservedImages.delete(image.idKey);
  reservedImages.delete(image.hashKey);
}

function checkLimits(userId, threadId, count, settings, now) {
  if (activeUsers.has(userId)) return "busy";
  if (
    now - (lastByUser.get(userId) || 0) < settings.userCooldownMs &&
    lastByUser.has(userId)
  )
    return "user";
  if (
    now - (lastByThread.get(threadId) || 0) < settings.threadCooldownMs &&
    lastByThread.has(threadId)
  )
    return "thread";
  requestTimes = requestTimes.filter((time) => now - time < 3600000);
  imageTimes = imageTimes.filter((time) => now - time < 3600000);
  if (
    requestTimes.length >= settings.maxRequestsPerHour ||
    imageTimes.length + count > settings.maxImagesPerHour
  )
    return "hourly";
  return null;
}

function usageText() {
  return "اكتب: صورة <وسم> [العدد]\nمثال: صورة قطط\nمثال: صورة 3 فن رقمي\nأو: ديفينت آرت <وسم> [العدد]";
}

function errorText(error) {
  if (error.kind === "credentials") return error.message;
  if (error.kind === "rate")
    return "وصلنا حد طلبات DeviantArt مؤقتاً؛ جرّب بعد قليل.";
  if (error.kind === "format")
    return "تعذّر قراءة نتائج DeviantArt؛ حاول مرة أخرى لاحقاً.";
  return "تعذّر البحث في DeviantArt حالياً؛ جرّب بعد قليل.";
}

async function run(context, deps, query, count, clamped, settings) {
  let images = [];
  try {
    if (settings.progressNotice)
      await deps.sendText(
        context.threadId,
        `🔎 أبحث في وسم DeviantArt: ${query}`,
        context.isGroup,
      );
    const result = await fetchImages(query, count);
    images = result.images;
    if (!images.length) {
      await deps.sendText(
        context.threadId,
        result.repeated
          ? `النتائج الأولى لوسم «${query}» سبق إرسالها؛ جرّب وسماً آخر.`
          : `لم أجد صوراً مناسبة لوسم «${query}».`,
        context.isGroup,
      );
      return;
    }
    let sent = 0;
    if (images.length > 1 && typeof deps.sendImages === "function") {
      const batch = images.map((image) => ({
        ...image,
        caption: `${image.caption}\n(${query})`,
      }));
      if (await deps.sendImages(context.threadId, batch, context.isGroup)) {
        sent = batch.length;
        for (const image of images) {
          imageTimes.push(clock());
          rememberImage(image);
        }
      }
    } else {
      for (const image of images) {
        const ok = await deps.sendImage(
          context.threadId,
          image.buffer,
          image.contentType,
          `${image.caption}\n(${query})`,
          context.isGroup,
        );
        if (!ok) break;
        sent++;
        imageTimes.push(clock());
        rememberImage(image);
      }
    }
    if (!sent) {
      await deps.sendText(
        context.threadId,
        "ما قدرت أرسل الصور الآن؛ جرّب بعد قليل.",
        context.isGroup,
      );
    } else if (clamped || sent < count) {
      await deps.sendText(
        context.threadId,
        clamped
          ? `الحد الأقصى ${settings.maxImages} صور في الطلب؛ أرسلت ${sent}.`
          : `أرسلت ${sent} صورة فقط من أصل ${count} طلبتها.`,
        context.isGroup,
      );
    }
  } catch (error) {
    console.error(`[deviantart] ${error.kind || "error"}: ${error.message}`);
    await deps.sendText(
      context.threadId,
      `⚠️ ${errorText(error)}`,
      context.isGroup,
    );
  } finally {
    for (const image of images) releaseImage(image);
    activeUsers.delete(context.userId);
  }
}

async function tryHandle(context, deps) {
  const parsed = parseCommand(context?.text);
  if (!parsed) return false;
  if (!config().enabled) {
    await deps.sendText(
      context.threadId,
      "أمر DeviantArt متوقف حالياً.",
      context.isGroup,
    );
    return true;
  }
  context = {
    ...context,
    userId: String(context.userId),
    threadId: String(context.threadId),
  };
  if (parsed.usage) {
    await deps.sendText(context.threadId, usageText(), context.isGroup);
    return true;
  }
  if (isBlockedQuery(parsed.query)) {
    await deps.sendText(context.threadId, "هذا الطلب غير مسموح 🚫", context.isGroup);
    return true;
  }
  const settings = config();
  const requested = parsed.count ?? 1;
  const count = Math.min(requested, settings.maxImages);
  const now = clock();
  const limited = checkLimits(
    context.userId,
    context.threadId,
    count,
    settings,
    now,
  );
  if (limited) {
    const message =
      limited === "hourly"
        ? "وصلنا للحد الأقصى لطلبات DeviantArt هذه الساعة."
        : limited === "busy"
          ? "لديك طلب DeviantArt قيد التنفيذ؛ انتظر حتى ينتهي."
          : "تمهّل قليلاً بين طلبات DeviantArt ⏳";
    await deps.sendText(context.threadId, message, context.isGroup);
    return true;
  }
  activeUsers.add(context.userId);
  lastByUser.set(context.userId, now);
  lastByThread.set(context.threadId, now);
  requestTimes.push(now);
  pending = run(
    context,
    deps,
    parsed.query,
    count,
    requested > count,
    settings,
  ).catch((error) =>
    console.error("[deviantart] unable to complete request:", error.message),
  );
  return true;
}

function createDeps(messenger) {
  return {
    sendText: (threadId, text, isGroup) =>
      isGroup
        ? messenger.sendGroup(threadId, text)
        : messenger.sendPrivate(threadId, text),
    sendImage: async (threadId, buffer, contentType, caption, isGroup) => {
      if (isGroup)
        return Boolean(
          await messenger.sendGroupImageBufferTracked(
            threadId,
            buffer,
            contentType,
            caption,
          ),
        );
      const result = await messenger.sendPrivateImageBufferWithResult(
        threadId,
        buffer,
        contentType,
        caption,
      );
      return Boolean(result?.ok);
    },
    sendImages: async (threadId, images, isGroup) => {
      if (isGroup)
        return Boolean(
          await messenger.sendGroupImageBuffersTracked(
            threadId,
            images,
          ),
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
    parseResults,
    allowedImageUrl,
    imageType,
    reset() {
      accessToken = null;
      tokenExpiresAt = 0;
      tokenRequest = null;
      activeUsers.clear();
      lastByUser.clear();
      lastByThread.clear();
      requestTimes = [];
      imageTimes = [];
      recentImages.clear();
      reservedImages.clear();
      pending = Promise.resolve();
      clock = () => Date.now();
    },
    setClock: (fn) => {
      clock = fn;
    },
  },
};
