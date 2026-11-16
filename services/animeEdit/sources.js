// مصادر المونتاج: صور المستخدم، تحديد الشخصية، مقاطع الشخصية، والموسيقى.
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");

const VIDEO_EXT = /\.(mp4|mkv|webm|mov|m4v)$/i;
const AUDIO_EXT = /\.(mp3|m4a|wav|ogg|opus|flac|aac)$/i;
const MAX_REF_BYTES = 10 * 1024 * 1024;
const ASSETS = () => process.env.EDIT_ASSETS_DIR || path.join(__dirname, "..", "..", "assets");

let http = null;
const getHttp = () => http || (http = require("axios"));
const setHttp = (c) => {
  http = c;
};

// ---------- صور المستخدم ----------
/** صور مرفقات ماسنجر فقط (نطاقات فيسبوك CDN)، عبر HTTPS */
function isTrustedImageHost(value) {
  let u;
  try {
    u = new URL(value);
  } catch {
    return false;
  }
  if (u.protocol !== "https:" || u.username || u.password || (u.port && u.port !== "443")) return false;
  return /(^|\.)(fbcdn\.net|fbsbx\.com|facebook\.com|messenger\.com)$/i.test(u.hostname);
}

function sniffImage(buf) {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "png";
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpg";
  if (buf.length >= 12 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") return "webp";
  return null;
}

/** من messageReply.attachments (أو أي مصفوفة مرفقات) إلى [{url}] */
function referencesFromAttachments(attachments, max = 4) {
  if (!Array.isArray(attachments)) return [];
  const out = [];
  for (const a of attachments) {
    if (!a || typeof a !== "object") continue;
    const type = String(a.type || "").toLowerCase();
    if (type && !/photo|image|sticker_photo/.test(type)) continue;
    const url = a.hiResUrl || a.largePreviewUrl || a.url || a.previewUrl || a.thumbnailUrl;
    if (typeof url === "string" && url) out.push({ url });
    if (out.length >= max) break;
  }
  return out;
}

async function saveReferenceImages(refs, dir, max = 4) {
  const files = [];
  for (const ref of refs.slice(0, max)) {
    let buf = null;
    if (ref.buffer) buf = Buffer.from(ref.buffer);
    else if (ref.url && isTrustedImageHost(ref.url)) {
      try {
        const res = await getHttp().get(ref.url, {
          responseType: "arraybuffer",
          timeout: 20000,
          maxRedirects: 0,
          maxContentLength: MAX_REF_BYTES,
          validateStatus: () => true,
        });
        if (res.status === 200) buf = Buffer.from(res.data);
      } catch {
        buf = null;
      }
    }
    if (!buf || !buf.length || buf.length > MAX_REF_BYTES) continue;
    const ext = sniffImage(buf);
    if (!ext) continue;
    const file = path.join(dir, `ref${files.length}.${ext}`);
    await fsp.writeFile(file, buf);
    files.push({ file, ext, buffer: buf });
  }
  return files;
}

// ---------- تحديد الشخصية ----------
const NAME_OK = /^[\p{L}\p{N} .'\-:()]{2,60}$/u;

/**
 * الاسم المكتوب في الأمر هو الأساس. وإلا نسأل Gemini عن شخصيات الأنمي/الكرتون/الألعاب فقط،
 * ولا نعرّف أشخاصاً حقيقيين أبداً (الرد يجب أن يكون kind=fictional وإلا نتجاهله).
 */
async function identifyFictionalCharacter(image, { apiKey = process.env.GEMINI_API_KEY?.trim() } = {}) {
  if (!apiKey || process.env.EDIT_IDENTIFY === "0") return null;
  const models = [process.env.GEMINI_MODEL, process.env.GEMINI_FALLBACK_MODEL].map((m) => m?.trim()).filter(Boolean);
  if (!models.length) models.push("gemini-2.5-flash");
  const prompt =
    "Look at this image. If it shows a FICTIONAL character (anime, manga, cartoon, comic, video game), answer with JSON only: " +
    '{"kind":"fictional","name":"<canonical English name>","series":"<series title>"}. ' +
    "If it shows a real person, a photograph of a real human, or you are not sure, answer exactly " +
    '{"kind":"unknown"}. Never name a real person.';
  for (const model of models) {
    try {
      const res = await getHttp().post(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
        {
          contents: [{ parts: [{ text: prompt }, { inlineData: { mimeType: image.ext === "jpg" ? "image/jpeg" : `image/${image.ext}`, data: image.buffer.toString("base64") } }] }],
          generationConfig: { temperature: 0, responseMimeType: "application/json" },
        },
        { headers: { "x-goog-api-key": apiKey }, timeout: 25000, validateStatus: () => true },
      );
      if (res.status !== 200) continue;
      const text = res.data?.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("") || "";
      const parsed = JSON.parse(text.replace(/```json|```/g, "").trim());
      if (parsed?.kind !== "fictional") return null;
      const name = String(parsed.name || "").trim();
      const series = String(parsed.series || "").trim().slice(0, 60);
      if (!NAME_OK.test(name)) return null;
      return { name, series: NAME_OK.test(series) ? series : "" };
    } catch {
      /* جرّب النموذج التالي */
    }
  }
  return null;
}

// ---------- مقاطع الشخصية ----------
function slug(s) {
  return String(s).toLowerCase().normalize("NFKD").replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "");
}

function ffprobeDuration(file) {
  return new Promise((resolve) => {
    const p = spawn(process.env.FFPROBE_PATH || "ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file], { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    p.stdout.on("data", (c) => (out += c));
    p.on("error", () => resolve(0));
    p.on("close", () => resolve(Number(out.trim()) || 0));
  });
}

/** مكتبة محلية: assets/clips/<اسم-الشخصية>/*.mp4 (مطابقة على اسم المجلد) */
async function findLocalClips(name, max = 6) {
  const root = path.join(ASSETS(), "clips");
  let dirs;
  try {
    dirs = await fsp.readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const want = slug(name);
  const words = want.split("-").filter((w) => w.length > 1);
  const dir = dirs.find((d) => d.isDirectory() && (slug(d.name) === want || words.every((w) => slug(d.name).includes(w))));
  if (!dir) return [];
  const files = (await fsp.readdir(path.join(root, dir.name))).filter((f) => VIDEO_EXT.test(f));
  const picked = files.sort(() => Math.random() - 0.5).slice(0, max);
  const clips = [];
  for (const f of picked) {
    const file = path.join(root, dir.name, f);
    const duration = await ffprobeDuration(file);
    if (duration >= 2) clips.push({ file, duration });
  }
  return clips;
}

function runCapture(bin, args, timeoutMs) {
  return new Promise((resolve) => {
    const p = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    const timer = setTimeout(() => p.kill("SIGKILL"), timeoutMs);
    p.stdout.on("data", (c) => (out = (out + c).slice(-2_000_000)));
    p.on("error", () => {
      clearTimeout(timer);
      resolve({ code: -1, out: "" });
    });
    p.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, out });
    });
  });
}

/**
 * بحث يوتيوب عبر yt-dlp (اختياري). تنزيل مقاطع يوتيوب يخالف شروط الخدمة وقد يخالف حقوق النشر،
 * لذلك لا يعمل إلا بتفعيل صريح: EDIT_ALLOW_YOUTUBE_DOWNLOAD=1 مع وجود yt-dlp.
 */
async function findYoutubeClips(name, series, dir, want = 4) {
  if (process.env.EDIT_ALLOW_YOUTUBE_DOWNLOAD !== "1") return [];
  const bin = process.env.EDIT_YTDLP_PATH || "yt-dlp";
  const suffix = process.env.EDIT_SEARCH_SUFFIX || "anime scenes 4k";
  const query = `ytsearch8:${[name, series, suffix].filter(Boolean).join(" ")}`;
  const search = await runCapture(bin, ["--flat-playlist", "--dump-json", "--no-warnings", query], 40000);
  if (search.code !== 0) return [];
  const entries = search.out
    .split("\n")
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter((e) => e && /^[\w-]{11}$/.test(e.id || "") && e.duration >= 15 && e.duration <= 900);
  const chosen = entries.sort(() => Math.random() - 0.5).slice(0, want);
  const clips = [];
  const ffprobePath = process.env.FFPROBE_PATH;
  const ffmpegDir = ffprobePath && path.isAbsolute(ffprobePath) ? path.dirname(ffprobePath) : null;
  for (let i = 0; i < chosen.length; i++) {
    const e = chosen[i];
    const len = 25;
    const start = Math.floor(Math.max(0, (e.duration - len) * (0.1 + Math.random() * 0.5)));
    const file = path.join(dir, `yt${i}.mp4`);
    const r = await runCapture(
      bin,
      [
        "--no-playlist", "--no-warnings", "--socket-timeout", "20", "--max-filesize", "80M",
        ...(ffmpegDir ? ["--ffmpeg-location", ffmpegDir] : []),
        "-f", "bv*[height<=720][ext=mp4]/b[height<=720][ext=mp4]/b[height<=720]",
        "--download-sections", `*${start}-${start + len}`, "--force-keyframes-at-cuts",
        "--merge-output-format", "mp4", "-o", file, `https://www.youtube.com/watch?v=${e.id}`,
      ],
      120000,
    );
    if (r.code !== 0 || !fs.existsSync(file)) continue;
    const duration = await ffprobeDuration(file);
    if (duration >= 3) clips.push({ file, duration });
  }
  return clips;
}

async function findClips({ name, series = "", dir }) {
  const local = await findLocalClips(name);
  if (local.length >= 3) return { clips: local, source: "local" };
  const yt = await findYoutubeClips(name, series, dir);
  const all = [...local, ...yt];
  return { clips: all, source: yt.length ? (local.length ? "local+youtube" : "youtube") : local.length ? "local" : "none" };
}

// ---------- الموسيقى ----------
async function pickMusic() {
  const dir = process.env.EDIT_MUSIC_DIR || path.join(ASSETS(), "edit-music");
  try {
    const files = (await fsp.readdir(dir)).filter((f) => AUDIO_EXT.test(f));
    if (files.length) return path.join(dir, files[Math.floor(Math.random() * files.length)]);
  } catch {
    /* لا يوجد مجلد */
  }
  return null;
}

module.exports = {
  referencesFromAttachments,
  saveReferenceImages,
  identifyFictionalCharacter,
  findClips,
  findLocalClips,
  pickMusic,
  isTrustedImageHost,
  setHttp,
};
