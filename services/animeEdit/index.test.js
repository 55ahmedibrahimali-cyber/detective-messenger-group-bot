const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const edit = require("./index");
const { _internal } = edit;

const PNG = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(40)]);
const ctx = (text, over = {}) => ({ userId: "u1", threadId: "g1", isGroup: true, text, referenceImages: [{ buffer: PNG }], ...over });
function deps() {
  const log = { texts: [], videos: [] };
  return {
    log,
    deps: {
      sendText: async (t, text) => (log.texts.push(text), true),
      sendVideo: async (t, file, caption) => (log.videos.push({ file, caption, exists: fs.existsSync(file), size: fs.existsSync(file) ? fs.statSync(file).size : 0 }), true),
    },
  };
}

test("not a command / no image → hint only, once", async () => {
  _internal.reset();
  const { deps: d, log } = deps();
  assert.strictEqual(await edit.tryHandle(ctx("hello"), d), false);
  assert.strictEqual(await edit.tryHandle(ctx("ايديت", { referenceImages: [] }), d), true);
  assert.strictEqual(await edit.tryHandle(ctx("ايديت", { referenceImages: [] }), d), true);
  assert.strictEqual(log.texts.length, 1);
  assert.match(log.texts[0], /ردّ على صورة/);
});

test("pipeline orchestration with fake backends: name from command, cooldown, cleanup", async () => {
  _internal.reset();
  const calls = [];
  _internal.setBackends({
    sources: {
      saveReferenceImages: async (refs, dir) => (calls.push("refs"), [{ file: path.join(dir, "r.png"), ext: "png", buffer: PNG }]),
      identifyFictionalCharacter: async () => (calls.push("identify"), null),
      findClips: async ({ name }) => (calls.push(`clips:${name}`), { clips: [{ file: "/x.mp4", duration: 10 }], source: "local" }),
      pickMusic: async () => "/song.mp3",
    },
    beats: {
      analyze: async () => ({ duration: 60, beats: Array.from({ length: 100 }, (_, i) => i * 0.5) }),
      pickLoudestWindow: () => 3,
      makeFallbackTrack: async () => {},
    },
    render: { renderEdit: async (o) => (calls.push(`render:${o.seconds}:${o.width}x${o.height}`), fs.writeFileSync(o.outFile, "mp4"), { file: o.outFile, seconds: o.seconds, bytes: 3, segments: 5 }) },
  });
  let now = 10_000_000;
  _internal.setClock(() => now);
  const { deps: d, log } = deps();
  assert.strictEqual(await edit.tryHandle(ctx("ايديت Gojo Satoru 20 افقي"), d), true);
  await edit.idle();
  assert.deepStrictEqual(calls, ["refs", "clips:Gojo Satoru", "render:20:1280x720"]); // الاسم من الأمر فلا يُستدعى التعريف بالصورة
  assert.strictEqual(log.videos.length, 1);
  assert.strictEqual(log.videos[0].caption, "🎬 Gojo Satoru");
  assert.ok(!fs.existsSync(path.dirname(log.videos[0].file)), "temp dir should be cleaned");
  // نفس المستخدم مباشرة: فاصل انتظار
  assert.strictEqual(await edit.tryHandle(ctx("ايديت Gojo"), d), true);
  await edit.idle();
  assert.strictEqual(log.videos.length, 1);
  assert.match(log.texts.at(-1), /انتظر/);
});

test("unknown character asks for the name; no clips + one image refuses politely", async () => {
  _internal.reset();
  const base = {
    saveReferenceImages: async (refs, dir) => [{ file: path.join(dir, "r.png"), ext: "png", buffer: PNG }],
    pickMusic: async () => null,
  };
  _internal.setBackends({ sources: { ...base, identifyFictionalCharacter: async () => null, findClips: async () => ({ clips: [], source: "none" }) }, beats: {}, render: {} });
  let { deps: d, log } = deps();
  await edit.tryHandle(ctx("ايديت"), d);
  await edit.idle();
  assert.match(log.texts.at(-1), /اكتب اسمها/);

  _internal.reset();
  _internal.setBackends({ sources: { ...base, identifyFictionalCharacter: async () => null, findClips: async () => ({ clips: [], source: "none" }) }, beats: {}, render: {} });
  ({ deps: d, log } = deps());
  await edit.tryHandle(ctx("ايديت Naruto"), d);
  await edit.idle();
  assert.match(log.texts.at(-1), /ما لقيت مقاطع/);
  assert.strictEqual(log.videos.length, 0);
});

test("end-to-end with real ffmpeg: local clips + fallback beat → real mp4 sent", { skip: spawnSync("ffmpeg", ["-version"]).status !== 0, timeout: 180000 }, async () => {
  _internal.reset();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-"));
  const dir = path.join(root, "clips", "gojo");
  fs.mkdirSync(dir, { recursive: true });
  for (const [i, src] of ["testsrc2", "smptebars", "rgbtestsrc"].entries())
    spawnSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", `${src}=size=640x360:rate=24:duration=5`, "-c:v", "libx264", "-pix_fmt", "yuv420p", path.join(dir, `c${i}.mp4`)]);
  process.env.EDIT_ASSETS_DIR = root;
  process.env.EDIT_WIDTH = "360";
  process.env.EDIT_HEIGHT = "640";
  const png = path.join(root, "ref.png");
  spawnSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=purple:size=400x400", "-frames:v", "1", png]);
  const { deps: d, log } = deps();
  await edit.tryHandle(ctx("ايديت gojo 8", { referenceImages: [{ buffer: fs.readFileSync(png) }] }), d);
  await edit.idle();
  assert.strictEqual(log.videos.length, 1, JSON.stringify(log.texts));
  assert.ok(log.videos[0].exists && log.videos[0].size > 20000);
  delete process.env.EDIT_ASSETS_DIR; delete process.env.EDIT_WIDTH; delete process.env.EDIT_HEIGHT;
  fs.rmSync(root, { recursive: true, force: true });
});
