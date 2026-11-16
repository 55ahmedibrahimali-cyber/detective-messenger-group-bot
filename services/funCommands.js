// services/funCommands.js — أمران ترفيهيان: «قتل» و«تهكير»
// الاستخدام: رد على رسالة الشخص المطلوب بكلمة الأمر.
//   قتل    ← صورة حسابه بالأبيض والأسود مع شريط حداد + «تم قتل <الاسم>»
//   تهكير  ← رسائل تقدم (… 70% …) ثم «تم التهكير» + لقطة بروفايل بتأثير اختراق
// الملف مستقل: لا يلمس قاعدة البيانات ولا الألعاب، ويستخدم pngjs و jpeg-js الموجودتين في المشروع.

const FB_HOSTS =
  /(^|\.)(fbcdn\.net|facebook\.com|fbsbx\.com|akamaihd\.net|telegram\.org)$/i;
const MAX_AVATAR_BYTES = 5 * 1024 * 1024;
const SIZE = 512;

// ============================== الأوامر ==============================
const TRIGGER =
  /^\s*([/!.]?)\s*(قتل|اقتل|اقتله|kill|تهكير|هكر|اهكر|اهكره|هاك|hack)\s*$/i;

function parseCommand(text) {
  const m = TRIGGER.exec(String(text || ""));
  if (!m) return null;
  const [, prefix, wordRaw] = m;
  const word = wordRaw.toLowerCase();
  const latin = word === "kill" || word === "hack";
  if (latin && !prefix) return null; // الكلمة اللاتينية وحدها تحتاج بادئة
  const kind = ["قتل", "اقتل", "اقتله", "kill"].includes(word)
    ? "kill"
    : "hack";
  return { kind };
}

// ============================== الإعدادات ==============================
function cfg() {
  return {
    enabled: process.env.FUN_COMMANDS_ENABLED !== "0",
    cooldownMs:
      Math.max(0, Number(process.env.FUN_USER_COOLDOWN_SECONDS ?? 15)) * 1000,
    stepDelayMs: Math.max(
      0,
      Number(process.env.FUN_HACK_STEP_DELAY_MS ?? 1800),
    ),
    extraHosts: (process.env.FUN_AVATAR_HOSTS || "")
      .split(",")
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean),
  };
}

let clock = () => Date.now();
let sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lastByUser = new Map();
const busyThreads = new Set();

// ============================== الصور: أدوات البكسل ==============================
// كل الرسم على {width,height,data:RGBA}؛ التشفير/فك التشفير في طبقة رقيقة منفصلة.
function createCanvas(w, h, [r, g, b] = [0, 0, 0]) {
  const data = Buffer.alloc(w * h * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = r;
    data[i + 1] = g;
    data[i + 2] = b;
    data[i + 3] = 255;
  }
  return { width: w, height: h, data };
}

function blendPx(img, x, y, [r, g, b], a = 1) {
  if (x < 0 || y < 0 || x >= img.width || y >= img.height || a <= 0) return;
  const i = (y * img.width + x) * 4;
  const d = img.data;
  d[i] = d[i] + (r - d[i]) * a;
  d[i + 1] = d[i + 1] + (g - d[i + 1]) * a;
  d[i + 2] = d[i + 2] + (b - d[i + 2]) * a;
  d[i + 3] = 255;
}

function fillRect(img, x, y, w, h, color, a = 1) {
  for (
    let yy = Math.max(0, y | 0);
    yy < Math.min(img.height, (y + h) | 0);
    yy++
  )
    for (
      let xx = Math.max(0, x | 0);
      xx < Math.min(img.width, (x + w) | 0);
      xx++
    )
      blendPx(img, xx, yy, color, a);
}

function fillRoundRect(img, x, y, w, h, r, color, a = 1) {
  for (let yy = y | 0; yy < ((y + h) | 0); yy++) {
    for (let xx = x | 0; xx < ((x + w) | 0); xx++) {
      const cx = Math.min(Math.max(xx, x + r), x + w - r);
      const cy = Math.min(Math.max(yy, y + r), y + h - r);
      const dist = Math.hypot(xx - cx, yy - cy);
      const cover = Math.min(1, Math.max(0, r - dist + 0.5));
      blendPx(img, xx, yy, color, a * cover);
    }
  }
}

function fillCircle(img, cx, cy, r, color, a = 1) {
  for (let y = Math.floor(cy - r - 1); y <= Math.ceil(cy + r + 1); y++)
    for (let x = Math.floor(cx - r - 1); x <= Math.ceil(cx + r + 1); x++) {
      const cover = Math.min(
        1,
        Math.max(0, r - Math.hypot(x + 0.5 - cx, y + 0.5 - cy) + 0.5),
      );
      blendPx(img, x, y, color, a * cover);
    }
}

/** تصغير/تكبير بالاستكمال الخطي مع قص مركزي (cover) إلى w×h */
function resizeCover(src, w, h) {
  const out = createCanvas(w, h);
  const scale = Math.max(w / src.width, h / src.height);
  const sw = w / scale;
  const sh = h / scale;
  const ox = (src.width - sw) / 2;
  const oy = (src.height - sh) / 2;
  for (let y = 0; y < h; y++) {
    const fy = Math.min(
      src.height - 1,
      Math.max(0, oy + (y + 0.5) / scale - 0.5),
    );
    const y0 = Math.floor(fy);
    const y1 = Math.min(src.height - 1, y0 + 1);
    const ty = fy - y0;
    for (let x = 0; x < w; x++) {
      const fx = Math.min(
        src.width - 1,
        Math.max(0, ox + (x + 0.5) / scale - 0.5),
      );
      const x0 = Math.floor(fx);
      const x1 = Math.min(src.width - 1, x0 + 1);
      const tx = fx - x0;
      const o = (y * w + x) * 4;
      for (let c = 0; c < 3; c++) {
        const p = (xx, yy) => src.data[(yy * src.width + xx) * 4 + c];
        const top = p(x0, y0) * (1 - tx) + p(x1, y0) * tx;
        const bot = p(x0, y1) * (1 - tx) + p(x1, y1) * tx;
        out.data[o + c] = top * (1 - ty) + bot * ty;
      }
      out.data[o + 3] = 255;
    }
  }
  return out;
}

/** يلصق صورة داخل دائرة */
function drawImageCircle(dst, src, cx, cy, r) {
  const d = r * 2;
  const fit = resizeCover(src, d, d);
  for (let y = 0; y < d; y++)
    for (let x = 0; x < d; x++) {
      const cover = Math.min(
        1,
        Math.max(0, r - Math.hypot(x + 0.5 - r, y + 0.5 - r) + 0.5),
      );
      const i = (y * d + x) * 4;
      blendPx(
        dst,
        Math.round(cx - r + x),
        Math.round(cy - r + y),
        [fit.data[i], fit.data[i + 1], fit.data[i + 2]],
        cover,
      );
    }
}

// خط بكسلي صغير (5×7) لنص «ACCESS GRANTED» ونسب مئوية — لا يحتاج مكتبة خطوط
const GLYPHS = {
  A: ".###.#...##...#######...##...##...#",
  C: ".#####....#....#....#....#.....####",
  E: "######....#....####.#....#....#####",
  S: ".#####....#.....###.....#....#####.",
  G: ".#####....#....#..###...##...#.###.",
  R: "####.#...##...#####.#.#..#..#.#...#",
  N: "#...###..###..###.#.##..###..##...#",
  T: "#####..#....#....#....#....#....#..",
  D: "####.#...##...##...##...##...#####.",
  H: "#...##...##...#######...##...##...#",
  K: "#...##..#.#.#..##...#.#..#..#.#...#",
  " ": "                                   ",
};
function drawText(img, text, x, y, scale, color) {
  let cx = x;
  for (const ch of text) {
    const g = GLYPHS[ch];
    if (g) {
      for (let row = 0; row < 7; row++)
        for (let col = 0; col < 5; col++)
          if (g[row * 5 + col] === "#")
            fillRect(
              img,
              cx + col * scale,
              y + row * scale,
              scale,
              scale,
              color,
            );
    }
    cx += 6 * scale;
  }
  return cx - x;
}
const textWidth = (text, scale) => text.length * 6 * scale - scale;

// ============================== تأثير الحداد ==============================
function renderMourning(avatar) {
  const img = resizeCover(avatar, SIZE, SIZE);
  const d = img.data;
  const cx = SIZE / 2;
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const i = (y * SIZE + x) * 4;
      const luma = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      // تظليل أطراف خفيف (vignette)
      const dist = Math.hypot(x - cx, y - cx) / (SIZE * 0.72);
      const k = 0.82 * (1 - Math.min(1, dist * dist) * 0.55);
      const v = luma * k;
      d[i] = d[i + 1] = d[i + 2] = v;
    }
  }
  // شريط الحداد الأسود قطرياً عند الزاوية العلوية اليمنى
  const c1 = SIZE * 0.5;
  const bandW = 78;
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const t = (x - y - c1) / Math.SQRT2; // المسافة العمودية عن حافة الشريط
      const cover =
        Math.min(1, Math.max(0, t + 0.5)) *
        Math.min(1, Math.max(0, bandW - t + 0.5));
      if (cover > 0) blendPx(img, x, y, [8, 8, 8], cover);
      // خيط أبيض رفيع داخل الشريط
      const edge = Math.abs(t - 9);
      if (t > 0 && t < bandW && edge < 1.2)
        blendPx(img, x, y, [210, 210, 210], 0.55 * (1 - edge / 1.2));
    }
  }
  // إطار أسود
  const B = 12;
  fillRect(img, 0, 0, SIZE, B, [0, 0, 0]);
  fillRect(img, 0, SIZE - B, SIZE, B, [0, 0, 0]);
  fillRect(img, 0, 0, B, SIZE, [0, 0, 0]);
  fillRect(img, SIZE - B, 0, B, SIZE, [0, 0, 0]);
  return img;
}

// ============================== تأثير التهكير ==============================
function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 4294967296;
  };
}

function glitch(img, rand) {
  const { width: w, height: h, data } = img;
  const copy = Buffer.from(data);
  const bands = 7;
  for (let n = 0; n < bands; n++) {
    const by = Math.floor(rand() * (h - 40));
    const bh = 6 + Math.floor(rand() * 26);
    const shift = Math.round((rand() - 0.5) * 70);
    for (let y = by; y < Math.min(h, by + bh); y++) {
      for (let x = 0; x < w; x++) {
        const sx = Math.min(w - 1, Math.max(0, x - shift));
        const o = (y * w + x) * 4;
        const s = (y * w + sx) * 4;
        // فصل القنوات اللونية RGB
        const sr = (y * w + Math.min(w - 1, Math.max(0, sx - 6))) * 4;
        const sb = (y * w + Math.min(w - 1, Math.max(0, sx + 6))) * 4;
        data[o] = copy[sr];
        data[o + 1] = copy[s + 1];
        data[o + 2] = copy[sb + 2];
      }
    }
  }
  for (
    let y = 0;
    y < h;
    y += 3 // خطوط مسح
  )
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      data[o] *= 0.88;
      data[o + 1] *= 0.88;
      data[o + 2] *= 0.88;
    }
}

function renderHack(avatar, seed = 1) {
  const W = 540;
  const H = 960;
  const rand = rng(seed);
  const img = createCanvas(W, H, [240, 242, 245]);

  // الشريط العلوي
  fillRect(img, 0, 0, W, 64, [24, 119, 242]);
  fillCircle(img, 40, 32, 14, [255, 255, 255], 0.95);
  fillRoundRect(img, 72, 20, 250, 24, 12, [255, 255, 255], 0.35);
  fillCircle(img, W - 44, 32, 12, [255, 255, 255], 0.5);
  fillCircle(img, W - 90, 32, 12, [255, 255, 255], 0.5);

  // الغلاف: صورة الحساب مكبّرة ومموّهة تقريباً (تظليل شديد)
  const cover = resizeCover(avatar, W, 260);
  for (let y = 0; y < 260; y++)
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const o = ((y + 64) * W + x) * 4;
      img.data[o] = cover.data[i] * 0.45 + 30;
      img.data[o + 1] = cover.data[i + 1] * 0.45 + 40;
      img.data[o + 2] = cover.data[i + 2] * 0.45 + 55;
    }

  // الصورة الشخصية بدائرة مع إطار أبيض
  const R = 108;
  const ay = 64 + 260;
  fillCircle(img, W / 2, ay, R + 8, [255, 255, 255]);
  drawImageCircle(img, avatar, W / 2, ay, R);

  // اسم (شريط)، أزرار، صفوف معلومات
  let y = ay + R + 28;
  fillRoundRect(img, W / 2 - 130, y, 260, 30, 15, [40, 44, 52]);
  fillRoundRect(img, W / 2 - 90, y + 42, 180, 16, 8, [150, 156, 165]);
  y += 84;
  fillRoundRect(img, 40, y, 270, 44, 10, [24, 119, 242]);
  fillRoundRect(img, 322, y, 178, 44, 10, [210, 214, 220]);
  y += 76;
  const rows = 4;
  for (let i = 0; i < rows; i++) {
    fillRoundRect(img, 30, y, W - 60, 62, 14, [255, 255, 255]);
    fillCircle(img, 68, y + 31, 15, [180, 186, 196]);
    fillRoundRect(
      img,
      100,
      y + 17,
      150 + ((i * 53) % 140),
      12,
      6,
      [60, 64, 72],
    );
    fillRoundRect(
      img,
      100,
      y + 38,
      90 + ((i * 37) % 120),
      9,
      4.5,
      [175, 180, 190],
    );
    y += 74;
  }
  glitch(img, rand);

  // لافتة الاختراق الخضراء بالأسفل
  const label = "ACCESS GRANTED";
  const scale = 4;
  const bw = textWidth(label, scale) + 44;
  const bx = Math.round((W - bw) / 2);
  const by = H - 96;
  fillRoundRect(img, bx, by, bw, 62, 8, [4, 16, 8], 0.92);
  fillRoundRect(img, bx, by, bw, 3, 1.5, [0, 255, 90]);
  fillRoundRect(img, bx, by + 59, bw, 3, 1.5, [0, 255, 90]);
  drawText(img, label, bx + 22, by + 17, scale, [0, 255, 90]);

  // إطار أخضر خافت
  const G = [0, 230, 90];
  fillRect(img, 0, 0, W, 4, G, 0.7);
  fillRect(img, 0, H - 4, W, 4, G, 0.7);
  fillRect(img, 0, 0, 4, H, G, 0.7);
  fillRect(img, W - 4, 0, 4, H, G, 0.7);
  return img;
}

/** صورة رمزية بديلة إذا تعذر تنزيل صورة الحساب */
function placeholderAvatar(seed = 1) {
  const rand = rng(seed);
  const hue = [
    Math.round(90 + rand() * 80),
    Math.round(100 + rand() * 80),
    Math.round(130 + rand() * 90),
  ];
  const img = createCanvas(256, 256, hue);
  fillCircle(img, 128, 100, 48, [235, 238, 242]);
  fillCircle(img, 128, 290, 110, [235, 238, 242]);
  return img;
}

// ============================== التنزيل والترميز ==============================
function validateAvatarUrl(raw, extraHosts = []) {
  let u;
  try {
    u = new URL(String(raw));
  } catch {
    return null;
  }
  if (u.protocol !== "https:") return null;
  const host = u.hostname.toLowerCase();
  if (
    FB_HOSTS.test(host) ||
    extraHosts.some((h) => host === h || host.endsWith(`.${h}`))
  )
    return u.toString();
  return null;
}

async function defaultDownload(url, extraHosts = []) {
  const axios = require("axios");
  let currentUrl = url;
  for (let redirects = 0; redirects <= 3; redirects++) {
    const safeUrl = validateAvatarUrl(currentUrl, extraHosts);
    if (!safeUrl) throw new Error("unsupported avatar URL");
    const response = await axios.get(safeUrl, {
      responseType: "arraybuffer",
      timeout: 12000,
      maxContentLength: MAX_AVATAR_BYTES,
      maxBodyLength: MAX_AVATAR_BYTES,
      maxRedirects: 0,
      validateStatus: () => true,
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers?.location;
      if (!location || redirects === 3)
        throw new Error("avatar redirect limit exceeded");
      currentUrl = new URL(location, safeUrl).toString();
      continue;
    }
    if (response.status < 200 || response.status >= 300)
      throw new Error(`avatar request failed with HTTP ${response.status}`);
    return Buffer.from(response.data);
  }
  throw new Error("avatar redirect limit exceeded");
}

function defaultDecode(buf) {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8) {
    const jpeg = require("jpeg-js");
    const { width, height, data } = jpeg.decode(buf, {
      useTArray: true,
      maxMemoryUsageInMB: 128,
    });
    return { width, height, data: Buffer.from(data) };
  }
  if (buf.length > 8 && buf.readUInt32BE(0) === 0x89504e47) {
    const { PNG } = require("pngjs");
    const png = PNG.sync.read(buf);
    return {
      width: png.width,
      height: png.height,
      data: Buffer.from(png.data),
    };
  }
  throw new Error("unsupported avatar format");
}

function defaultEncode(img) {
  const { PNG } = require("pngjs");
  const png = new PNG({ width: img.width, height: img.height });
  img.data.copy(png.data);
  return PNG.sync.write(png);
}

let io = {
  download: defaultDownload,
  decode: defaultDecode,
  encode: defaultEncode,
};

async function loadAvatar(profile, extraHosts) {
  const urls =
    (profile && profile.avatarUrls) ||
    (profile && profile.avatarUrl ? [profile.avatarUrl] : []);
  for (const raw of urls) {
    const url = validateAvatarUrl(raw, extraHosts);
    if (!url) continue;
    try {
      return io.decode(await io.download(url, extraHosts));
    } catch {
      /* جرّب الرابط التالي */
    }
  }
  return null;
}

// ============================== التنفيذ ==============================
const stageBar = (pct) => {
  const filled = Math.round(pct / 10);
  return `${"▰".repeat(filled)}${"▱".repeat(10 - filled)} ${pct}%`;
};

const HACK_STAGES = [
  (n) => `💻 جاري التهكير على ${n}...\n${stageBar(12)}\n▓▒░ البحث عن ثغرات ░▒▓`,
  (n) => `📡 الاتصال بالخادم...\n${stageBar(37)}\n🔑 كسر كلمة المرور`,
  (n) =>
    `⚡ تجاوز الحماية الثنائية...\n${stageBar(70)}\n🛰️ سحب البيانات من الحساب`,
  (n) => `🔓 تم الدخول، جاري تحميل الملف الشخصي...\n${stageBar(94)}`,
];

async function send(deps, ctx, text) {
  try {
    await deps.sendText(ctx.threadId, text, ctx.isGroup);
  } catch (e) {
    console.error("[fun] send failed:", e && e.message ? e.message : e);
  }
}

async function run(ctx, deps, parsed, c) {
  const targetId = String(ctx.messageReply.senderID);
  let profile = null;
  try {
    profile = deps.getProfile ? await deps.getProfile(targetId, ctx) : null;
  } catch {
    profile = null;
  }
  const name = String((profile && profile.name) || "المستخدم").slice(0, 40);
  const seed = Number(
    BigInt.asUintN(32, BigInt(/^\d+$/.test(targetId) ? targetId : "7")),
  );

  if (parsed.kind === "hack") {
    for (const stage of HACK_STAGES) {
      await send(deps, ctx, stage(name));
      if (c.stepDelayMs) await sleep(c.stepDelayMs);
    }
  }

  const avatar =
    (await loadAvatar(profile, c.extraHosts)) || placeholderAvatar(seed);
  const art =
    parsed.kind === "kill" ? renderMourning(avatar) : renderHack(avatar, seed);
  const caption =
    parsed.kind === "kill"
      ? `تم قتل ${name} 🖤🥀\nالله يرحمه 🕊️`
      : `✅ تم التهكير بنجاح\n${stageBar(100)}\n🔓 تم الدخول إلى حساب ${name}`;

  let ok = false;
  try {
    ok = await deps.sendImage(
      ctx.threadId,
      io.encode(art),
      "image/png",
      caption,
      ctx.isGroup,
    );
  } catch (e) {
    console.error("[fun] image failed:", e && e.message ? e.message : e);
  }
  if (!ok) await send(deps, ctx, caption);
  await send(
    deps,
    ctx,
    "Just kidding",
  );
}

/** يعيد true إذا عالج الرسالة */
async function tryHandle(ctx, deps) {
  const parsed = parseCommand(ctx && ctx.text);
  if (!parsed) return false;
  if (!ctx.isGroup) return false;
  const c = cfg();
  if (!c.enabled) return false;
  // لا يعمل إلا كرد على رسالة شخص آخر (حتى لا يتعارض مع أوامر الألعاب النصية)
  const target = ctx.messageReply && ctx.messageReply.senderID;
  if (!target) return false;

  ctx = { ...ctx, userId: String(ctx.userId), threadId: String(ctx.threadId) };
  const targetId = String(target);

  if (deps.selfId && targetId === String(deps.selfId())) {
    await send(
      deps,
      ctx,
      parsed.kind === "kill"
        ? "تقتلني أنا؟ 😏 أنا أصلاً مش بموت."
        : "حاول تهكرني يا شاطر 😎 الباسورد عندي 123456.. بس مش هقولك.",
    );
    return true;
  }

  const now = clock();
  const last = lastByUser.get(ctx.userId) || 0;
  if (now - last < c.cooldownMs) return true; // نتجاهل التكرار السريع بصمت
  if (busyThreads.has(ctx.threadId)) return true;
  lastByUser.set(ctx.userId, now);
  if (lastByUser.size > 2000) lastByUser.delete(lastByUser.keys().next().value);

  busyThreads.add(ctx.threadId);
  try {
    await run(ctx, deps, parsed, c);
  } finally {
    busyThreads.delete(ctx.threadId);
  }
  return true;
}

/** ماسنجر: messenger = ./services/messenger */
function createDeps(messenger, extra = {}) {
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
      const r = await messenger.sendPrivateImageBufferWithResult(
        threadId,
        buffer,
        contentType,
        caption,
      );
      return Boolean(r && r.ok);
    },
    selfId: () => (messenger.selfId ? messenger.selfId() : ""),
    getProfile:
      extra.getProfile || ((userId) => messenger.getUserProfile(userId)),
  };
}

module.exports = {
  tryHandle,
  parseCommand,
  createDeps,
  _internal: {
    renderMourning,
    renderHack,
    placeholderAvatar,
    validateAvatarUrl,
    stageBar,
    setIO(next) {
      io = { ...io, ...next };
    },
    setSleep(fn) {
      sleep = fn;
    },
    setClock(fn) {
      clock = fn;
    },
    reset() {
      io = {
        download: defaultDownload,
        decode: defaultDecode,
        encode: defaultEncode,
      };
      sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      clock = () => Date.now();
      lastByUser.clear();
      busyThreads.clear();
    },
  },
};
