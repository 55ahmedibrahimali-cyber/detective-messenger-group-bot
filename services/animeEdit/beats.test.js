const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const beats = require("./beats");

const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;

test("detects ~128 BPM and a beat grid aligned to the kicks", { skip: !hasFfmpeg }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "beats-"));
  const file = path.join(dir, "t.wav");
  await beats.makeFallbackTrack(file, { bpm: 128, seconds: 20 });
  const a = await beats.analyze(file);
  assert.ok(Math.abs(a.bpm - 128) < 3, `bpm=${a.bpm}`);
  const period = 60 / 128;
  const phase = (a.beats[0] % period) / period;
  assert.ok(phase < 0.12 || phase > 0.88, `phase=${phase}`); // النبضة الأولى قرب بداية كيك (t=0)
  assert.ok(a.beats.length > 30);
  const w = beats.pickLoudestWindow(a, 8);
  assert.ok(w >= 0 && w < a.beats.length);
  fs.rmSync(dir, { recursive: true, force: true });
});
