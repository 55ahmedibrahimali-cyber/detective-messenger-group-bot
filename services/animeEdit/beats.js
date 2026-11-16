// كشف الإيقاع (BPM + مواضع النبضات) بدون مكتبات خارجية: ffmpeg يفكّ الصوت ونحسب منحنى الطاقة.
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const SR = 11025;
const HOP = 256; // ≈ 23ms
const HOP_SEC = HOP / SR;

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

/** يفك أول maxSeconds ثانية من الملف إلى Float32 أحادي */
function decodePcm(file, maxSeconds = 150) {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpegBin(), ["-v", "error", "-t", String(maxSeconds), "-i", file, "-vn", "-ac", "1", "-ar", String(SR), "-f", "f32le", "pipe:1"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const chunks = [];
    let err = "";
    p.stdout.on("data", (c) => chunks.push(c));
    p.stderr.on("data", (c) => (err += c));
    p.on("error", reject);
    p.on("close", (code) => {
      if (code !== 0) return reject(new Error(`ffmpeg decode failed: ${err.slice(-200)}`));
      const buf = Buffer.concat(chunks);
      resolve(new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 4)).slice());
    });
  });
}

/** قوة البدايات (onset): فرق اللوغاريتم الموجب لطاقة كل إطار */
function onsetEnvelope(samples) {
  const frames = Math.floor(samples.length / HOP);
  const energy = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    let sum = 0;
    for (let j = i * HOP; j < (i + 1) * HOP; j++) sum += samples[j] * samples[j];
    energy[i] = Math.log1p(1000 * Math.sqrt(sum / HOP));
  }
  const env = new Float32Array(frames);
  for (let i = 1; i < frames; i++) env[i] = Math.max(0, energy[i] - energy[i - 1]);
  return env;
}

function estimateTempo(env, { minBpm = 80, maxBpm = 170 } = {}) {
  const minLag = Math.floor(60 / maxBpm / HOP_SEC);
  const maxLag = Math.ceil(60 / minBpm / HOP_SEC);
  const n = env.length;
  const ac = new Float64Array(maxLag + 2);
  for (let lag = minLag - 1; lag <= maxLag + 1; lag++) {
    let s = 0;
    for (let i = lag; i < n; i++) s += env[i] * env[i - lag];
    ac[lag] = s / (n - lag || 1);
  }
  let best = minLag;
  let bestScore = -1;
  for (let lag = minLag; lag <= maxLag; lag++) {
    const bpm = 60 / (lag * HOP_SEC);
    const prior = Math.exp(-0.5 * Math.pow(Math.log2(bpm / 120) / 0.9, 2)); // تفضيل 90–160 لتفادي أخطاء الضعف/النصف
    const score = ac[lag] * prior;
    if (score > bestScore) {
      bestScore = score;
      best = lag;
    }
  }
  // تحسين دون-الإطار بالاستيفاء المكافئ
  const a = ac[best - 1], b = ac[best], c = ac[best + 1];
  const denom = a - 2 * b + c;
  const refined = denom !== 0 ? best + (0.5 * (a - c)) / denom : best;
  const lag = Math.abs(refined - best) <= 1 ? refined : best;
  const beatSec = lag * HOP_SEC;

  // الطور: أفضل إزاحة تجمع أكبر onset على شبكة النبضات
  let bestPhase = 0;
  let bestSum = -1;
  const steps = Math.max(1, Math.round(beatSec / HOP_SEC));
  for (let ph = 0; ph < steps; ph++) {
    let s = 0;
    for (let t = ph; t < n; t += lag) {
      const i = Math.round(t);
      s += env[i] + 0.5 * (env[i - 1] || 0) + 0.5 * (env[i + 1] || 0);
    }
    if (s > bestSum) {
      bestSum = s;
      bestPhase = ph;
    }
  }
  return { bpm: 60 / beatSec, beatSec, offsetSec: bestPhase * HOP_SEC };
}

/** يعيد { bpm, beats:[ثوانٍ], duration, env, hopSec } */
async function analyze(file, maxSeconds = 150) {
  const samples = await decodePcm(file, maxSeconds);
  const duration = samples.length / SR;
  if (duration < 4) throw new Error("audio too short");
  const env = onsetEnvelope(samples);
  const { bpm, beatSec, offsetSec } = estimateTempo(env);
  const beats = [];
  for (let t = offsetSec; t < duration - 0.01; t += beatSec) beats.push(t);
  return { bpm, beats, duration, env, hopSec: HOP_SEC };
}

/** يختار أقوى مقطع بطول `seconds` (يُرجَّح أنه «الدروب») ويرجع فهرس أول نبضة فيه */
function pickLoudestWindow(analysis, seconds) {
  const { beats, env, hopSec } = analysis;
  const prefix = new Float64Array(env.length + 1);
  for (let i = 0; i < env.length; i++) prefix[i + 1] = prefix[i] + env[i];
  const sumBetween = (t0, t1) => {
    const a = Math.max(0, Math.floor(t0 / hopSec));
    const b = Math.min(env.length, Math.floor(t1 / hopSec));
    return prefix[b] - prefix[a];
  };
  let bestIndex = 0;
  let best = -1;
  for (let i = 0; i < beats.length; i++) {
    if (beats[i] + seconds > analysis.duration) break;
    const s = sumBetween(beats[i], beats[i] + seconds);
    if (s > best) {
      best = s;
      bestIndex = i;
    }
  }
  return bestIndex;
}

/** مسار إيقاعي احتياطي (كيك + هاي-هات) إن لم توجد موسيقى في المجلد */
function makeFallbackTrack(outFile, { bpm = 128, seconds = 40 } = {}) {
  const p = 60 / bpm;
  const u = `mod(t,${p.toFixed(6)})`;
  const kick = `0.9*sin(2*PI*(45*${u}+110*(1-exp(-35*${u}))/35))*exp(-7*${u})`;
  const hat = `0.10*(random(0)*2-1)*exp(-70*mod(t+${(p / 2).toFixed(6)},${p.toFixed(6)}))`;
  return new Promise((resolve, reject) => {
    const pr = spawn(ffmpegBin(), ["-v", "error", "-y", "-f", "lavfi", "-i", `aevalsrc=${`${kick}+${hat}`.replace(/,/g, "\\,")}:s=44100:d=${seconds}`, "-ac", "2", outFile], { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    pr.stderr.on("data", (c) => (err += c));
    pr.on("error", reject);
    pr.on("close", (code) => (code === 0 ? resolve(outFile) : reject(new Error(`fallback track failed: ${err.slice(-200)}`))));
  });
}

module.exports = { analyze, pickLoudestWindow, makeFallbackTrack, decodePcm, onsetEnvelope, estimateTempo };
