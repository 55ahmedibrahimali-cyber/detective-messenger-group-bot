const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const beats = require("./beats");
const { planEdit, renderEdit, mulberry32 } = require("./render");

const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;

test("planEdit: segments tile the beat grid exactly, with ref bookends", () => {
  const beatTimes = Array.from({ length: 64 }, (_, i) => i * 0.46875);
  const plan = planEdit({ beatTimes, startIndex: 4, seconds: 12, clipCount: 3, refCount: 2, rng: mulberry32(7) });
  assert.strictEqual(plan.segments[0].kind, "ref");
  assert.strictEqual(plan.segments.at(-1).kind, "ref");
  let cursor = 0;
  for (const s of plan.segments) {
    assert.strictEqual(s.a, cursor);
    assert.ok(s.b > s.a);
    cursor = s.b;
  }
  assert.strictEqual(plan.boundaries[cursor], plan.total);
  assert.ok(plan.total <= 12 && plan.total > 10);
  assert.ok(plan.segments.some((s) => s.kind === "clip"));
  assert.throws(() => planEdit({ beatTimes, startIndex: 0, seconds: 12, clipCount: 0, refCount: 0, rng: mulberry32(1) }), /no visual/);
});

test("planEdit works with only reference images (no clips found)", () => {
  const beatTimes = Array.from({ length: 40 }, (_, i) => i * 0.5);
  const plan = planEdit({ beatTimes, startIndex: 0, seconds: 8, clipCount: 0, refCount: 1, rng: mulberry32(3) });
  assert.ok(plan.segments.every((s) => s.kind === "ref"));
});

test("renderEdit produces a playable vertical mp4 with audio, synced to the music length", { skip: !hasFfmpeg, timeout: 120000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "render-"));
  const sh = (args) => assert.strictEqual(spawnSync("ffmpeg", ["-v", "error", "-y", ...args]).status, 0);
  const clipA = path.join(dir, "a.mp4"), clipB = path.join(dir, "b.mp4"), ref = path.join(dir, "ref.png"), song = path.join(dir, "song.wav");
  sh(["-f", "lavfi", "-i", "testsrc2=size=640x360:rate=24:duration=6", "-c:v", "libx264", "-pix_fmt", "yuv420p", clipA]);
  sh(["-f", "lavfi", "-i", "smptebars=size=480x270:rate=24:duration=2", "-c:v", "libx264", "-pix_fmt", "yuv420p", clipB]); // أقصر من المطلوب: يختبر التكرار
  sh(["-f", "lavfi", "-i", "color=c=orange:size=500x500", "-frames:v", "1", ref]);
  await beats.makeFallbackTrack(song, { bpm: 128, seconds: 20 });
  const analysis = await beats.analyze(song);
  const startIndex = beats.pickLoudestWindow(analysis, 8);
  const out = path.join(dir, "out.mp4");
  const res = await renderEdit({
    clips: [{ file: clipA, duration: 6 }, { file: clipB, duration: 2 }],
    refs: [ref],
    music: { file: song, startTime: analysis.beats[startIndex] },
    beatTimes: analysis.beats, startIndex, seconds: 8, outFile: out, workDir: dir, width: 360, height: 640, seed: 42,
  });
  const probe = JSON.parse(spawnSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type,width,height,duration", "-of", "json", out], { encoding: "utf8" }).stdout);
  const v = probe.streams.find((s) => s.codec_type === "video");
  const a = probe.streams.find((s) => s.codec_type === "audio");
  assert.strictEqual(v.width, 360);
  assert.strictEqual(v.height, 640);
  assert.ok(a, "audio stream missing");
  assert.ok(Math.abs(Number(v.duration) - res.seconds) < 0.15, `video ${v.duration} vs plan ${res.seconds}`);
  assert.ok(res.seconds > 6 && res.seconds <= 8);
  assert.ok(res.bytes < 24 * 1024 * 1024 && res.bytes > 10000);
  fs.rmSync(dir, { recursive: true, force: true });
});
