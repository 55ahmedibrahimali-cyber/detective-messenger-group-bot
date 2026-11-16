// أمر «ايديت»: رد على صورة (أو أكثر) بالأمر، فيبحث البوت عن مقاطع للشخصية ويصنع فيديو ايديت (AMV)
// على إيقاع الموسيقى مع الحفاظ على كامل المشهد، وخلفية ضبابية للمقاطع الأفقية، وحركة وتلوين متوازنين.
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { parseCommand, MIN_SECONDS } = require("./command");

let backends = null;
function be() {
  if (!backends) backends = { sources: require("./sources"), beats: require("./beats"), render: require("./render") };
  return backends;
}

function envInt(name, fallback, min, max) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && process.env[name] !== "" && process.env[name] !== undefined ? Math.min(max, Math.max(min, Math.trunc(n))) : fallback;
}
const cfg = () => ({
  enabled: process.env.EDIT_ENABLED !== "0",
  defaultSeconds: envInt("EDIT_DEFAULT_SECONDS", 15, MIN_SECONDS, 60),
  maxSeconds: envInt("EDIT_MAX_SECONDS", 30, MIN_SECONDS, 60),
  userCooldownMs: envInt("EDIT_USER_COOLDOWN_SECONDS", 600, 0, 86400) * 1000,
  threadCooldownMs: envInt("EDIT_THREAD_COOLDOWN_SECONDS", 120, 0, 86400) * 1000,
  maxPerHour: envInt("EDIT_MAX_PER_HOUR", 6, 1, 1000),
  timeoutMs: envInt("EDIT_TIMEOUT_SECONDS", 300, 30, 3600) * 1000,
  width: envInt("EDIT_WIDTH", 720, 240, 2160),
  height: envInt("EDIT_HEIGHT", 1280, 240, 3840),
  maxBytes: Math.min(envInt("EDIT_MAX_MB", 24, 1, 24), 24) * 1024 * 1024,
});

const USAGE =
  "🎬 ردّ على صورة الشخصية بـ: ايديت\nوإن أردت حدد الاسم والمدة: ايديت Gojo 20\nللعرضي أضف: افقي";

const lastByUser = new Map();
const lastByThread = new Map();
const noticeAt = new Map();
let running = false;
let times = [];
let clock = () => Date.now();
let pending = Promise.resolve();

const trim = (m, max = 5000) => {
  while (m.size > max) m.delete(m.keys().next().value);
};

async function notice(deps, ctx, text, gapMs = 30000) {
  const now = clock();
  if (now - (noticeAt.get(ctx.userId) || 0) < gapMs) return;
  noticeAt.set(ctx.userId, now);
  trim(noticeAt);
  await deps.sendText(ctx.threadId, text, ctx.isGroup);
}

async function run(ctx, deps, parsed, c) {
  const { sources, beats, render } = be();
  const workDir = await fsp.mkdtemp(path.join(os.tmpdir(), "anime-edit-"));
  const deadline = clock() + c.timeoutMs;
  try {
    await deps.sendText(ctx.threadId, "🎬 بدأت أشتغل على الايديت، يأخذ دقيقة أو دقيقتين...", ctx.isGroup);

    const refs = await sources.saveReferenceImages(ctx.referenceImages, workDir);
    if (!refs.length) {
      await deps.sendText(ctx.threadId, "ما قدرت أقرأ الصورة، جرّب أرسلها من جديد وردّ عليها بالأمر.", ctx.isGroup);
      return;
    }

    let character = parsed.name ? { name: parsed.name, series: "" } : await sources.identifyFictionalCharacter(refs[0]);
    if (!character) {
      await deps.sendText(ctx.threadId, "ما عرفت من الشخصية. اكتب اسمها مع الأمر، مثال: ايديت Gojo Satoru", ctx.isGroup);
      return;
    }

    const { clips, source } = await sources.findClips({ name: character.name, series: character.series, dir: workDir });
    if (!clips.length && refs.length < 2) {
      await deps.sendText(
        ctx.threadId,
        `ما لقيت مقاطع لـ «${character.name}». أضف مقاطعها في assets/clips/<الاسم> أو فعّل بحث يوتيوب، أو أرسل أكثر من صورة وسأصنع ايديت منها.`,
        ctx.isGroup,
      );
      return;
    }

    let seconds = Math.min(parsed.seconds || c.defaultSeconds, c.maxSeconds);
    let musicFile = await sources.pickMusic();
    if (!musicFile) {
      musicFile = path.join(workDir, "fallback-beat.wav");
      await beats.makeFallbackTrack(musicFile, { bpm: 128, seconds: seconds + 30 });
    }
    const analysis = await beats.analyze(musicFile);
    seconds = Math.min(seconds, Math.floor(analysis.duration - 1));
    const startIndex = beats.pickLoudestWindow(analysis, seconds);

    const landscape = parsed.landscape;
    const out = path.join(workDir, "edit.mp4");
    const result = await render.renderEdit({
      clips,
      refs: refs.map((r) => r.file),
      music: { file: musicFile, startTime: analysis.beats[startIndex] },
      beatTimes: analysis.beats,
      startIndex,
      seconds,
      outFile: out,
      workDir,
      width: landscape ? Math.max(c.width, c.height) : Math.min(c.width, c.height),
      height: landscape ? Math.min(c.width, c.height) : Math.max(c.width, c.height),
      maxBytes: c.maxBytes,
      deadline,
    });

    const note = clips.length ? "" : " (من الصور فقط)";
    const ok = await deps.sendVideo(ctx.threadId, result.file, `🎬 ${character.name}${note}`, ctx.isGroup);
    if (!ok) await deps.sendText(ctx.threadId, "جهّزت الفيديو لكن ما قدرت أرسله الآن، جرّب بعد قليل.", ctx.isGroup);
    console.log(`[edit] done: ${result.segments} cuts, ${result.seconds.toFixed(1)}s, ${(result.bytes / 1048576).toFixed(1)}MB, clips=${clips.length} (${source})`);
  } catch (error) {
    console.error("[edit] failed:", error && error.message);
    await deps.sendText(ctx.threadId, "تعذّر صنع الايديت حالياً، جرّب بعد قليل.", ctx.isGroup).catch(() => {});
  } finally {
    await fsp.rm(workDir, { recursive: true, force: true }).catch(() => {});
    running = false;
  }
}

/**
 * ctx: { userId, threadId, isGroup, text, referenceImages: [{url}|{buffer}] }
 * deps: { sendText(threadId, text, isGroup), sendVideo(threadId, filePath, caption, isGroup) → boolean }
 */
async function tryHandle(ctx, deps) {
  const parsed = parseCommand(ctx && ctx.text);
  if (!parsed) return false;
  const c = cfg();
  if (!c.enabled) return false;
  ctx = { ...ctx, userId: String(ctx.userId), threadId: String(ctx.threadId), referenceImages: ctx.referenceImages || [] };

  if (!ctx.referenceImages.length) {
    await notice(deps, ctx, USAGE, 60000);
    return true;
  }
  const now = clock();
  if (running) {
    await notice(deps, ctx, "في ايديت قيد الصنع الآن ⏳ جرّب بعد ما ينتهي.");
    return true;
  }
  times = times.filter((t) => now - t < 3600000);
  const u = lastByUser.get(ctx.userId);
  const t = lastByThread.get(ctx.threadId);
  if (u && now - u < c.userCooldownMs) {
    const mins = Math.ceil((c.userCooldownMs - (now - u)) / 60000);
    await notice(deps, ctx, `انتظر حوالي ${mins} دقيقة قبل الايديت التالي ⏳`);
    return true;
  }
  if ((t && now - t < c.threadCooldownMs) || times.length >= c.maxPerHour) {
    await notice(deps, ctx, "كثرت طلبات الايديت حالياً، جرّبوا بعد قليل.");
    return true;
  }

  running = true;
  lastByUser.set(ctx.userId, now);
  lastByThread.set(ctx.threadId, now);
  trim(lastByUser);
  trim(lastByThread);
  times.push(now);
  pending = run(ctx, deps, parsed, c).catch(() => {});
  return true;
}

function createDeps(messenger) {
  return {
    sendText: (threadId, text, isGroup) => (isGroup ? messenger.sendGroup(threadId, text) : messenger.sendPrivate(threadId, text)),
    // المشروع يرسل الفيديو من الذاكرة (buffer)، فنقرأ الملف الناتج (≤24MB) ونمرره
    sendVideo: async (threadId, filePath, caption, isGroup) => {
      const buffer = await fsp.readFile(filePath);
      if (isGroup) return Boolean(await messenger.sendGroupVideoBufferTracked(threadId, buffer, "video/mp4", caption));
      const r = await messenger.sendPrivateVideoBufferWithResult(threadId, buffer, "video/mp4", caption);
      return Boolean(r && r.ok);
    },
  };
}

/** يستخرج صور الرد (والمرفقات في نفس الرسالة إن وُجدت) بصيغة [{url}] */
function referencesFromMessage(messageReply, ownAttachments) {
  const { referencesFromAttachments } = be().sources;
  const fromReply = referencesFromAttachments(messageReply && messageReply.attachments);
  return fromReply.length ? fromReply : referencesFromAttachments(ownAttachments);
}

module.exports = {
  tryHandle,
  createDeps,
  referencesFromMessage,
  idle: () => pending,
  _internal: {
    setBackends: (b) => {
      backends = b;
    },
    setClock: (fn) => {
      clock = fn;
    },
    reset() {
      lastByUser.clear();
      lastByThread.clear();
      noticeAt.clear();
      running = false;
      times = [];
      pending = Promise.resolve();
      clock = () => Date.now();
      backends = null;
    },
  },
};

/*
=== الربط ===
server.js (ماسنجر) — قبل aiChat.tryHandle داخل enqueue:
  const animeEdit = require('./services/animeEdit');
  const animeEditDeps = animeEdit.createDeps(messenger);
  ...
  if (await animeEdit.tryHandle({
    userId: String(ev.senderID), threadId: String(ev.threadID), isGroup, text,
    referenceImages: animeEdit.referencesFromMessage(ev.messageReply, ev.attachments),
  }, animeEditDeps)) return;

.env (اختياري):
  EDIT_DEFAULT_SECONDS=15  EDIT_MAX_SECONDS=30  EDIT_USER_COOLDOWN_SECONDS=600
  EDIT_THREAD_COOLDOWN_SECONDS=120  EDIT_MAX_PER_HOUR=6  EDIT_TIMEOUT_SECONDS=300
  EDIT_WIDTH=720  EDIT_HEIGHT=1280  EDIT_MAX_MB=24
  EDIT_ASSETS_DIR=./assets            # assets/clips/<اسم الشخصية>/*.mp4  و  assets/edit-music/*.mp3
  EDIT_ALLOW_YOUTUBE_DOWNLOAD=0       # 1 = بحث وتنزيل مقاطع من يوتيوب عبر yt-dlp (يخالف شروط يوتيوب)
  EDIT_YTDLP_PATH=yt-dlp  EDIT_SEARCH_SUFFIX="anime scenes 4k"
  EDIT_IDENTIFY=1                     # تعريف شخصيات الأنمي بالصورة عبر Gemini (لا يعرّف أشخاصاً حقيقيين)
  EDIT_ENABLED=1
*/
