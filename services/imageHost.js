// services/imageHost.js - رفع صورة الجولة إلى استضافة مؤقتة (litterbox.catbox.moe، بلا حساب ولا مفتاح)
// وإرجاع رابط https مؤقت. يُستعمل لأن مرفقات الصور في المحادثات الخاصة المشفّرة (E2EE) لا تظهر عند المتلقي،
// بينما الرسائل النصية تصل دائماً. الرابط عشوائي ويحذف الخادم الملف تلقائياً بعد المدة.
const API_URL = "https://litterbox.catbox.moe/resources/internals/api.php";
const ALLOWED_TTL = ["1h", "12h", "24h", "72h"];
const cache = new Map(); // imageKey -> { url, at }
const REUSE_MS = 50 * 60 * 1000;

function ttl() {
  const value = (process.env.SPY_IMAGE_HOST_TTL || "1h").toLowerCase();
  return ALLOWED_TTL.includes(value) ? value : "1h";
}

function extensionFor(contentType) {
  return contentType === "image/jpeg" ? "jpg" : contentType === "image/webp" ? "webp" : "png";
}

async function upload(buffer, contentType) {
  const form = new FormData();
  form.append("reqtype", "fileupload");
  form.append("time", ttl());
  form.append(
    "fileToUpload",
    new Blob([buffer], { type: contentType }),
    `round.${extensionFor(contentType)}`,
  );
  const response = await fetch(API_URL, {
    method: "POST",
    body: form,
    signal: AbortSignal.timeout(30000),
  });
  const text = (await response.text()).trim();
  // نقبل فقط رابط https من نفس الاستضافة (حماية من ردود غير متوقعة)
  if (!response.ok || !/^https:\/\/litter\.catbox\.moe\/[A-Za-z0-9._-]+$/.test(text))
    throw new Error(`Image host upload failed (HTTP ${response.status}): ${text.slice(0, 80)}`);
  return text;
}

/** يرجع رابطاً مؤقتاً للصورة، ويعيد استعمال نفس الرابط لكل لاعبي الجولة */
async function getUrl(imageKey, image) {
  const hit = cache.get(imageKey);
  if (hit && Date.now() - hit.at < REUSE_MS) return hit.url;
  const url = await upload(image.buffer, image.contentType);
  cache.set(imageKey, { url, at: Date.now() });
  if (cache.size > 50) cache.delete(cache.keys().next().value);
  return url;
}

module.exports = { getUrl, upload };
