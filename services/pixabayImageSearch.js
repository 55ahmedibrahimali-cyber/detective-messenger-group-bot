const axios = require("axios");

const API_URL = "https://pixabay.com/api/";
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_REDIRECTS = 3;
// بعض خوادم الصور (Cloudflare) ترفض الطلبات بلا User-Agent متصفح (HTTP 403) فلا تصل أي صورة
const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
  Accept: "image/jpeg,image/png,image/webp,image/*;q=0.8",
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function assertConfigured() {
  if (!process.env.PIXABAY_API_KEY?.trim())
    throw new Error("PIXABAY_API_KEY is not configured.");
}

function imageContentType(buffer) {
  if (
    buffer.length >= 8 &&
    buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    return "image/png";
  if (
    buffer.length >= 3 &&
    buffer[0] === 0xff &&
    buffer[1] === 0xd8 &&
    buffer[2] === 0xff
  )
    return "image/jpeg";
  if (
    buffer.length >= 12 &&
    buffer.toString("ascii", 0, 4) === "RIFF" &&
    buffer.toString("ascii", 8, 12) === "WEBP"
  )
    return "image/webp";
  return null;
}

function validateImageUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Pixabay returned an invalid image URL.");
  }
  if (
    url.protocol !== "https:" ||
    (url.port && url.port !== "443") ||
    url.username ||
    url.password ||
    !(url.hostname === "pixabay.com" || url.hostname.endsWith(".pixabay.com"))
  )
    throw new Error("Pixabay returned an image URL outside its trusted HTTPS hosts.");
  return url;
}

async function downloadImage(value, redirects = 0) {
  const url = validateImageUrl(value);
  if (redirects > MAX_REDIRECTS)
    throw new Error("Pixabay image URL exceeded the redirect limit.");

  let response;
  try {
    response = await axios.get(url.toString(), {
      responseType: "arraybuffer",
      timeout: 20000,
      headers: HEADERS,
      maxRedirects: 0,
      maxContentLength: MAX_IMAGE_BYTES,
      validateStatus: (status) => status >= 200 && status < 400,
    });
  } catch (error) {
    const status = error.response?.status;
    throw new Error(
      `Pixabay image download failed${status ? ` (HTTP ${status})` : ""}.`,
    );
  }

  if (response.status >= 300) {
    const location = response.headers.location;
    if (!location) throw new Error("Pixabay image redirect has no destination.");
    return downloadImage(new URL(location, url).toString(), redirects + 1);
  }

  const buffer = Buffer.from(response.data);
  if (!buffer.length || buffer.length > MAX_IMAGE_BYTES)
    throw new Error("Pixabay returned an empty or oversized image.");

  const contentType = imageContentType(buffer);
  const responseType = String(response.headers["content-type"] || "")
    .split(";", 1)[0]
    .trim()
    .toLowerCase();
  // نعتمد على فحص بايتات الملف نفسه (توقيع PNG/JPEG/WEBP) لا على ترويسة الخادم فقط
  if (!contentType || !/^image\//.test(responseType || "image/"))
    throw new Error("Pixabay did not return a supported image file.");

  return { buffer, contentType };
}

async function fetchHits(query) {
  let response;
  try {
    response = await axios.get(API_URL, {
      params: {
        key: process.env.PIXABAY_API_KEY.trim(),
        q: query,
        lang: "en",
        image_type: "photo",
        orientation: "horizontal",
        safesearch: "true",
        min_width: 640,
        min_height: 360,
        per_page: 20,
      },
      headers: HEADERS,
      timeout: 15000,
      maxContentLength: 2 * 1024 * 1024,
    });
  } catch (error) {
    const status = error.response?.status;
    throw new Error(
      `Pixabay image search failed${status ? ` (HTTP ${status})` : ""}. Check the API key, quota, and network connection.`,
    );
  }
  return (response.data?.hits || []).filter(
    (hit) => hit && Number.isInteger(hit.id) && (hit.webformatURL || hit.largeImageURL),
  );
}

/**
 * يبحث عن صورة عشوائية من أول 20 نتيجة (بدل أول نتيجة دائماً، فتتنوّع الصور بين الجولات).
 * يعيد { buffer, contentType, id } ويجرّب نتائج أخرى إذا فشل تنزيل إحداها.
 */
async function searchImage(query, { excludeIds = [] } = {}) {
  assertConfigured();
  if (!query?.trim() || query.length > 100)
    throw new Error("Pixabay search query must contain 1 to 100 characters.");

  const hits = await fetchHits(query);
  if (!hits.length) throw new Error(`Pixabay returned no safe images for "${query}".`);

  const fresh = hits.filter((hit) => !excludeIds.includes(hit.id));
  const pool = (fresh.length ? fresh : hits).slice();
  // خلط Fisher–Yates
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }

  let lastError;
  for (const hit of pool.slice(0, 4)) {
    try {
      const image = await downloadImage(hit.webformatURL || hit.largeImageURL);
      return { ...image, id: hit.id };
    } catch (error) {
      lastError = error;
      console.error(`[pixabay] hit ${hit.id} download failed:`, error.message);
      await sleep(400);
    }
  }
  throw lastError || new Error("Pixabay image download failed.");
}

const searchFirstImage = searchImage; // توافق مع الاستدعاءات القديمة

module.exports = { assertConfigured, imageContentType, searchFirstImage, searchImage };
