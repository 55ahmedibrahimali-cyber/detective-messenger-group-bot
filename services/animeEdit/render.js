// مرحلة المونتاج: قصّات على إيقاع الموسيقى، مع الحفاظ على المشهد كاملاً وخلفية ضبابية،
// وحركة وتلوين AMV متوازنين، ثم الدمج مع الصوت باستخدام ffmpeg.
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const even = (n) => Math.max(2, Math.round(n / 2) * 2);

function ffmpegBin() {
  const configured = process.env.EDIT_FFMPEG_PATH?.trim() || process.env.FFMPEG_PATH?.trim();
  if (configured && (path.isAbsolute(configured) || fs.existsSync(configured))) return configured;
  const ffprobe = process.env.FFPROBE_PATH?.trim();
  if (ffprobe) {
    const sibling = path.join(path.dirname(ffprobe), process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg");
    if (fs.existsSync(sibling)) return sibling;
  }
  return configured || "ffmpeg";
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick(rng, list) {
  return list[Math.floor(rng() * list.length)];
}

function makeFx(rng, beatsInSeg) {
  return {
    zoom: 0.08 + rng() * 0.08,
    shake: beatsInSeg === 1 && rng() < 0.25,
    panX: (rng() - 0.5) * 0.12,
    panY: (rng() - 0.5) * 0.1,
    rgb: beatsInSeg === 1 && rng() < 0.12,
    flash: beatsInSeg === 1 && rng() < 0.14,
    hue: rng() < 0.08,
  };
}

/**
 * يبني خطة القصّات. beatTimes بالثواني (مطلقة في الأغنية)، startIndex = أول نبضة في المقطع.
 * يعيد { segments, boundaries, total } حيث boundaries أزمنة محلية تبدأ من 0 على النبضات.
 */
function planEdit({ beatTimes, startIndex, seconds, clipCount, refCount, rng }) {
  const first = beatTimes[startIndex];
  const local = [];
  for (let i = startIndex; i < beatTimes.length && beatTimes[i] - first <= seconds + 1e-6; i++) local.push(beatTimes[i] - first);
  const totalBeats = local.length - 1;
  if (totalBeats < 4) throw new Error("not enough beats for an edit");
  if (!clipCount && !refCount) throw new Error("no visual material");

  const segments = [];
  const hasRefs = refCount > 0;
  const bookend = hasRefs && totalBeats >= 8;
  let i = 0;
  let refIdx = 0;
  let clipIdx = 0;
  const addRef = (a, b) => segments.push({ kind: "ref", index: refIdx++ % refCount, a, b, fx: makeFx(rng, b - a) });
  const end = totalBeats - (bookend ? 2 : 0);
  if (bookend) {
    addRef(0, 2);
    i = 2;
  }
  while (i < end) {
    const left = end - i;
    if (hasRefs && i > 2 && (i - 2) % 16 === 0) {
      addRef(i, i + 1);
      i += 1;
      continue;
    }
    const n = pick(rng, [1, 1, 1, 2, 2, 4].filter((x) => x <= left));
    if (!clipCount) {
      addRef(i, i + n);
    } else {
      const speed = n >= 2 ? pick(rng, [1, 1, 1.25, 0.7]) : pick(rng, [1, 1.25]);
      segments.push({ kind: "clip", index: clipIdx++ % clipCount, a: i, b: i + n, speed, fx: makeFx(rng, n) });
    }
    i += n;
  }
  if (bookend) addRef(end, totalBeats);
  return { segments, boundaries: local.slice(0, totalBeats + 1), total: local[totalBeats] };
}

function commonTail({ W, H, fx, dur }) {
  const f = [];
  f.push("eq=contrast=1.08:saturation=1.18:brightness=0.005:gamma=0.98");
  f.push("curves=all='0/0 0.25/0.22 0.75/0.78 1/1'");
  f.push("vignette=PI/7");
  if (fx.rgb) f.push("rgbashift=rh=-8:bh=8:enable='lt(t,0.22)'");
  if (fx.hue) f.push("hue=h='12*sin(40*t)':enable='lt(t,0.25)'");
  if (fx.flash) f.push(`fade=in:st=0:d=${Math.min(0.09, dur / 3).toFixed(3)}:color=white`);
  f.push("unsharp=5:5:0.22:3:3:0.0");
  f.push("format=yuv420p");
  return f;
}

function compositionFilter({ W, H, fx, dur, source }) {
  const bw = even(W / 6);
  const bh = even(H / 6);
  const amp = Math.max(2, Math.round(W * 0.008));
  const z = fx.zoom.toFixed(3);
  const d = Math.max(dur, 0.1).toFixed(3);
  const shakeX = fx.shake ? `+${amp}*exp(-6*t)*sin(70*t)` : "";
  const shakeY = fx.shake ? `+${amp}*exp(-6*t)*sin(61*t)` : "";
  return [
    `${source},split=2[backgroundSource][subjectSource]`,
    `[backgroundSource]scale=${bw}:${bh}:force_original_aspect_ratio=increase:flags=area,crop=${bw}:${bh},gblur=sigma=3.2,scale=${W}:${H}:flags=bilinear,eq=brightness=-0.2:saturation=1.15[background]`,
    `[subjectSource]scale=${W}:${H}:force_original_aspect_ratio=decrease:flags=lanczos,setsar=1[subject]`,
    `[background][subject]overlay=(main_w-overlay_w)/2:(main_h-overlay_h)/2:shortest=1,scale=w='trunc(${W}*(1+${z}*t/${d})/2)*2':h='trunc(${H}*(1+${z}*t/${d})/2)*2':eval=frame:flags=lanczos,crop=${W}:${H}:x='(iw-ow)/2+(iw-ow)*${fx.panX.toFixed(3)}*sin(PI*t/${d})${shakeX}':y='(ih-oh)/2+(ih-oh)*${fx.panY.toFixed(3)}*sin(PI*t/${d})${shakeY}',${commonTail({ W, H, fx, dur }).join(",")}[v]`,
  ].join(";");
}

/** سلسلة فلاتر مقطع فيديو (clip) */
function clipFilter({ W, H, fps, speed, fx, dur }) {
  return compositionFilter({
    W,
    H,
    fx,
    dur,
    source: `[0:v]setpts=(PTS-STARTPTS)/${speed},fps=${fps}`,
  });
}

/** سلسلة فلاتر صورة ثابتة مع ملء الخلفية دون قصّ الصورة */
function refFilter({ W, H, fps, fx, dur }) {
  return compositionFilter({
    W,
    H,
    fx,
    dur,
    source: `[0:v]fps=${fps}`,
  });
}

function runFfmpeg(args, { timeoutMs = 90000 } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpegBin(), ["-hide_banner", "-loglevel", "error", "-y", ...args], { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    p.stderr.on("data", (c) => {
      err = (err + c).slice(-600);
    });
    const timer = setTimeout(() => {
      p.kill("SIGKILL");
      reject(new Error("ffmpeg timeout"));
    }, Math.max(1000, timeoutMs));
    p.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    p.on("close", (code) => {
      clearTimeout(timer);
      code === 0 ? resolve() : reject(new Error(`ffmpeg failed (${code}): ${err.trim().slice(-300)}`));
    });
  });
}

/**
 * clips: [{ file, duration }]، refs: [file]، music: { file, startTime } (بداية أول نبضة في الأغنية)
 * beatTimes/startIndex من beats.js. يعيد { file, seconds, bytes, segments }.
 */
async function renderEdit({
  clips = [],
  refs = [],
  music,
  beatTimes,
  startIndex,
  seconds,
  outFile,
  workDir,
  width = 720,
  height = 1280,
  fps = 30,
  maxBytes = 24 * 1024 * 1024,
  seed = Date.now(),
  deadline = Date.now() + 5 * 60 * 1000,
}) {
  const rng = mulberry32(seed);
  const plan = planEdit({ beatTimes, startIndex, seconds, clipCount: clips.length, refCount: refs.length, rng });
  const W = even(width);
  const H = even(height);
  const videoK = Math.max(600, Math.min(5000, Math.floor(((maxBytes * 8) / plan.total - 160000) / 1000 * 0.85)));
  const enc = ["-c:v", "libx264", "-preset", "veryfast", "-crf", "21", "-maxrate", `${videoK}k`, "-bufsize", `${videoK * 2}k`, "-pix_fmt", "yuv420p", "-r", String(fps), "-an"];
  const budget = () => {
    const left = deadline - Date.now();
    if (left < 3000) throw new Error("render deadline exceeded");
    return Math.min(90000, left);
  };

  const segFiles = [];
  for (let k = 0; k < plan.segments.length; k++) {
    const s = plan.segments[k];
    const frames = Math.round(plan.boundaries[s.b] * fps) - Math.round(plan.boundaries[s.a] * fps);
    if (frames < 1) continue;
    const dur = frames / fps;
    const out = path.join(workDir, `seg${String(k).padStart(3, "0")}.mp4`);
    if (s.kind === "clip") {
      const clip = clips[s.index];
      const srcDur = dur * s.speed + 0.3;
      const needLoop = clip.duration < srcDur + 0.2;
      const maxStart = Math.max(0, clip.duration - srcDur - 0.2);
      const ss = needLoop ? 0 : rng() * maxStart;
      const input = [...(needLoop ? ["-stream_loop", "-1"] : []), "-ss", ss.toFixed(3), "-t", srcDur.toFixed(3), "-i", clip.file];
      await runFfmpeg([...input, "-filter_complex", clipFilter({ W, H, fps, speed: s.speed, fx: s.fx, dur }), "-map", "[v]", "-frames:v", String(frames), ...enc, out], { timeoutMs: budget() });
    } else {
      await runFfmpeg(["-loop", "1", "-framerate", String(fps), "-i", refs[s.index], "-filter_complex", refFilter({ W, H, fps, fx: s.fx, dur }), "-map", "[v]", "-frames:v", String(frames), ...enc, out], { timeoutMs: budget() });
    }
    segFiles.push(out);
  }
  if (!segFiles.length) throw new Error("no segments rendered");

  const list = path.join(workDir, "concat.txt");
  fs.writeFileSync(list, segFiles.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join("\n"));
  const body = path.join(workDir, "body.mp4");
  await runFfmpeg(["-f", "concat", "-safe", "0", "-i", list, "-c", "copy", body], { timeoutMs: budget() });

  const fadeOut = Math.max(0, plan.total - 0.8);
  await runFfmpeg(
    [
      "-i", body,
      "-ss", Math.max(0, music.startTime).toFixed(3), "-t", (plan.total + 0.2).toFixed(3), "-i", music.file,
      "-map", "0:v:0", "-map", "1:a:0",
      "-c:v", "copy", "-c:a", "aac", "-b:a", "128k",
      "-af", `afade=t=in:st=0:d=0.25,afade=t=out:st=${fadeOut.toFixed(3)}:d=0.8`,
      "-t", plan.total.toFixed(3), "-movflags", "+faststart", outFile,
    ],
    { timeoutMs: budget() },
  );

  const bytes = fs.statSync(outFile).size;
  if (bytes > maxBytes) throw new Error(`output too large (${Math.round(bytes / 1048576)}MB)`);
  return { file: outFile, seconds: plan.total, bytes, segments: segFiles.length };
}

module.exports = { planEdit, renderEdit, clipFilter, refFilter, mulberry32, runFfmpeg };
