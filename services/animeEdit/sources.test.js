const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const src = require("./sources");

const PNG = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(40)]);

test("attachments → references; only image types", () => {
  const refs = src.referencesFromAttachments([
    { type: "photo", largePreviewUrl: "https://scontent.xx.fbcdn.net/a.jpg", url: "https://x/y" },
    { type: "video", url: "https://scontent.xx.fbcdn.net/v.mp4" },
    { type: "photo", url: "https://scontent.xx.fbcdn.net/b.jpg" },
  ]);
  assert.deepStrictEqual(refs.map((r) => r.url), ["https://scontent.xx.fbcdn.net/a.jpg", "https://scontent.xx.fbcdn.net/b.jpg"]);
  assert.deepStrictEqual(src.referencesFromAttachments(null), []);
});

test("only Facebook CDN hosts over https are downloaded (SSRF guard)", async () => {
  assert.ok(src.isTrustedImageHost("https://scontent-cai1-1.xx.fbcdn.net/v/t1/a.jpg"));
  assert.ok(!src.isTrustedImageHost("http://scontent.xx.fbcdn.net/a.jpg"));
  assert.ok(!src.isTrustedImageHost("https://evil.com/fbcdn.net/a.jpg"));
  assert.ok(!src.isTrustedImageHost("https://169.254.169.254/latest"));
  assert.ok(!src.isTrustedImageHost("https://fbcdn.net.evil.com/a.jpg"));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "src-"));
  const calls = [];
  src.setHttp({ get: async (url) => (calls.push(url), { status: 200, data: PNG }) });
  const saved = await src.saveReferenceImages([{ url: "https://evil.com/a.png" }, { url: "https://x.fbcdn.net/a.png" }, { buffer: Buffer.from("not an image") }], dir);
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(saved.length, 1);
  assert.ok(saved[0].file.endsWith(".png"));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("character identification accepts fictional characters only", async () => {
  const reply = (obj) => ({ post: async () => ({ status: 200, data: { candidates: [{ content: { parts: [{ text: JSON.stringify(obj) }] } }] } }) });
  const img = { ext: "png", buffer: PNG };
  src.setHttp(reply({ kind: "fictional", name: "Satoru Gojo", series: "Jujutsu Kaisen" }));
  assert.deepStrictEqual(await src.identifyFictionalCharacter(img, { apiKey: "k" }), { name: "Satoru Gojo", series: "Jujutsu Kaisen" });
  src.setHttp(reply({ kind: "real_person", name: "Some Actor" }));
  assert.strictEqual(await src.identifyFictionalCharacter(img, { apiKey: "k" }), null);
  src.setHttp(reply({ kind: "fictional", name: "x; rm -rf /" }));
  assert.strictEqual(await src.identifyFictionalCharacter(img, { apiKey: "k" }), null);
  assert.strictEqual(await src.identifyFictionalCharacter(img, { apiKey: "" }), null);
});

test("local clip library matches by folder name", { skip: spawnSync("ffmpeg", ["-version"]).status !== 0 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "assets-"));
  const dir = path.join(root, "clips", "Gojo Satoru");
  fs.mkdirSync(dir, { recursive: true });
  spawnSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=24:duration=3", "-c:v", "libx264", "-pix_fmt", "yuv420p", path.join(dir, "a.mp4")]);
  process.env.EDIT_ASSETS_DIR = root;
  const hit = await src.findLocalClips("gojo");
  assert.strictEqual(hit.length, 1);
  assert.ok(hit[0].duration > 2.5);
  assert.deepStrictEqual(await src.findLocalClips("naruto"), []);
  const r = await src.findClips({ name: "gojo", dir: root });
  assert.strictEqual(r.source, "local"); // يوتيوب معطّل افتراضياً
  delete process.env.EDIT_ASSETS_DIR;
  fs.rmSync(root, { recursive: true, force: true });
});
