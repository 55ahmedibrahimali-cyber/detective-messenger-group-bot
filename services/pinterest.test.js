const test = require("node:test");
const assert = require("node:assert");
const pin = require("./pinterest");
const { _internal } = pin;

const PNG = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(32)]);
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(32)]);
const GIF = Buffer.from("GIF89a" + "x".repeat(30));

test("parseCommand: default, leading/trailing count, arabic digits, long numbers", () => {
  assert.strictEqual(pin.parseCommand("مرحبا"), null);
  assert.strictEqual(pin.parseCommand("pin cats"), null); // pin بلا بادئة لا يُعتبر أمراً
  assert.deepStrictEqual(pin.parseCommand("بنترست قطط لطيفة"), { query: "قطط لطيفة", count: null, usage: false });
  assert.deepStrictEqual(pin.parseCommand("/بنترست 3 غروب الشمس"), { query: "غروب الشمس", count: 3, usage: false });
  assert.deepStrictEqual(pin.parseCommand("بنترست غروب الشمس ٤"), { query: "غروب الشمس", count: 4, usage: false });
  assert.deepStrictEqual(pin.parseCommand("بنترست cats x2"), { query: "cats", count: 2, usage: false });
  assert.deepStrictEqual(pin.parseCommand("بنترست 2 صور قطط"), { query: "قطط", count: 2, usage: false });
  assert.deepStrictEqual(pin.parseCommand("!pin red car 5 images"), { query: "red car", count: 5, usage: false });
  assert.deepStrictEqual(pin.parseCommand("بنترست موضة 2024"), { query: "موضة 2024", count: null, usage: false });
  assert.strictEqual(pin.parseCommand("بنترست").usage, true);
  assert.strictEqual(pin.parseCommand("بنترست 3").usage, true);
});

function pinsBody(list) {
  return { resource_response: { data: { results: list } } };
}
const P = (id, extra = {}) => ({
  id, type: "pin",
  images: { orig: { url: `https://i.pinimg.com/originals/${id}.png` }, "736x": { url: `https://i.pinimg.com/736x/${id}.jpg` } },
  ...extra,
});

function fakeHttp({ results, files = {}, searchStatus = 200 }) {
  const calls = { search: 0, home: 0, downloads: [] };
  return {
    calls,
    async get(url, config) {
      if (url === "https://www.pinterest.com/") {
        calls.home++;
        return { status: 200, data: '<script>{"appVersion":"abc123"}</script>', headers: { "set-cookie": ["csrftoken=tok; Path=/"] } };
      }
      if (url.includes("/resource/BaseSearchResource/get/")) {
        calls.search++;
        calls.lastHeaders = config.headers;
        calls.lastParams = config.params;
        return { status: searchStatus, data: pinsBody(results), headers: {} };
      }
      calls.downloads.push(url);
      const f = files[url];
      return f ? { status: 200, data: f, headers: {} } : { status: 404, data: Buffer.alloc(0), headers: {} };
    },
  };
}

function makeDeps() {
  const sent = { texts: [], images: [], batches: [] };
  return {
    sent,
    deps: {
      sendText: async (t, text) => { sent.texts.push(text); return true; },
      sendImage: async (t, buf, type, caption) => { sent.images.push({ buffer: buf, type, caption }); return true; },
      sendImages: async (threadId, images, isGroup) => {
        sent.batches.push({ threadId, images, isGroup });
        sent.images.push(...images);
        return true;
      },
    },
  };
}
const ctx = (text, over = {}) => ({ userId: "u1", threadId: "g1", isGroup: true, text, ...over });
const allFiles = (ids) => Object.fromEntries(ids.flatMap((id) => [
  [`https://i.pinimg.com/originals/${id}.png`, Buffer.concat([PNG.subarray(0, 8), Buffer.from(id)])],
  [`https://i.pinimg.com/736x/${id}.jpg`, Buffer.concat([JPG.subarray(0, 3), Buffer.from(id)])],
]));

test("sends exactly 1 image by default, taken from the top result", async () => {
  _internal.reset();
  const h = fakeHttp({ results: [P("a"), P("b"), P("c")], files: allFiles(["a", "b", "c"]) });
  _internal.setHttp(h);
  const { deps, sent } = makeDeps();
  assert.strictEqual(await pin.tryHandle(ctx("بنترست قطط"), deps), true);
  await pin.idle();
  assert.strictEqual(sent.images.length, 1);
  assert.deepStrictEqual(h.calls.downloads, ["https://i.pinimg.com/originals/a.png"]);
  assert.strictEqual(sent.images[0].caption, "📌 قطط");
  assert.strictEqual(h.calls.lastHeaders["X-APP-VERSION"], "abc123");
  assert.strictEqual(h.calls.lastHeaders["X-CSRFToken"], "tok");
  assert.strictEqual(JSON.parse(h.calls.lastParams.data).options.query, "قطط");
});

test("sends N images in result order; clamps above the max and says so", async () => {
  _internal.reset();
  process.env.PINTEREST_MAX_IMAGES = "3";
  const ids = ["a", "b", "c", "d", "e"];
  _internal.setHttp(fakeHttp({ results: ids.map((i) => P(i)), files: allFiles(ids) }));
  const { deps, sent } = makeDeps();
  await pin.tryHandle(ctx("بنترست 9 سيارات"), deps);
  await pin.idle();
  assert.strictEqual(sent.images.length, 3);
  assert.strictEqual(sent.batches.length, 1);
  assert.strictEqual(sent.batches[0].threadId, "g1");
  assert.strictEqual(sent.batches[0].isGroup, true);
  assert.deepStrictEqual(sent.images.map((i) => i.caption), ["📌 سيارات (1/3)", "📌 سيارات (2/3)", "📌 سيارات (3/3)"]);
  assert.match(sent.texts.at(-1), /الحد الأقصى 3/);
  delete process.env.PINTEREST_MAX_IMAGES;
});

test("similar repeated queries skip sent pins and return the next image", async () => {
  _internal.reset();
  let now = 1_000_000;
  _internal.setClock(() => now);
  const ids = ["a", "b", "c"];
  const h = fakeHttp({ results: ids.map((id) => P(id)), files: allFiles(ids) });
  _internal.setHttp(h);
  const { deps, sent } = makeDeps();

  await pin.tryHandle(ctx("بنترست قطط"), deps);
  await pin.idle();
  now += 25_000;
  await pin.tryHandle(ctx("بنترست قطط لطيفة"), deps);
  await pin.idle();

  assert.strictEqual(sent.images.length, 2);
  assert.notDeepStrictEqual(sent.images[0].buffer, sent.images[1].buffer);
  assert.deepStrictEqual(h.calls.downloads, [
    "https://i.pinimg.com/originals/a.png",
    "https://i.pinimg.com/originals/b.png",
  ]);
});

test("identical image bytes under another pin ID are skipped too", async () => {
  _internal.reset();
  let now = 1_000_000;
  _internal.setClock(() => now);
  const ids = ["a", "b", "c"];
  const files = allFiles(ids);
  files["https://i.pinimg.com/originals/b.png"] = files["https://i.pinimg.com/originals/a.png"];
  const h = fakeHttp({ results: ids.map((id) => P(id)), files });
  _internal.setHttp(h);
  const { deps, sent } = makeDeps();

  await pin.tryHandle(ctx("بنترست قطط"), deps);
  await pin.idle();
  now += 25_000;
  await pin.tryHandle(ctx("بنترست صور قطط"), deps);
  await pin.idle();

  assert.strictEqual(sent.images.length, 2);
  assert.notDeepStrictEqual(sent.images[0].buffer, sent.images[1].buffer);
  assert.deepStrictEqual(h.calls.downloads, [
    "https://i.pinimg.com/originals/a.png",
    "https://i.pinimg.com/originals/b.png",
    "https://i.pinimg.com/originals/c.png",
  ]);
});

test("falls back to another size when the original is a GIF; skips pins that fail to download", async () => {
  _internal.reset();
  const files = { ...allFiles(["b"]), "https://i.pinimg.com/originals/a.png": GIF, "https://i.pinimg.com/736x/a.jpg": JPG };
  const h = fakeHttp({ results: [P("a"), P("x"), P("b")], files });
  _internal.setHttp(h);
  const { deps, sent } = makeDeps();
  await pin.tryHandle(ctx("بنترست 2 جبال"), deps);
  await pin.idle();
  assert.strictEqual(sent.images.length, 2);
  assert.strictEqual(sent.images[0].contentType, "image/jpeg"); // a: orig=GIF → 736x
  assert.ok(h.calls.downloads.includes("https://i.pinimg.com/originals/b.png")); // تخطّى x الفاشل وأكمل بـ b
});

test("rejects non-pinimg hosts (SSRF guard) and non-pin results", () => {
  assert.strictEqual(_internal.validateImageUrl("http://i.pinimg.com/a.jpg"), null);
  assert.strictEqual(_internal.validateImageUrl("https://evil.com/i.pinimg.com/a.jpg"), null);
  assert.strictEqual(_internal.validateImageUrl("https://169.254.169.254/x"), null);
  assert.ok(_internal.validateImageUrl("https://i.pinimg.com/originals/a.png"));
  const parsed = _internal.parseResults(pinsBody([P("a"), { type: "story", id: "s", images: P("s").images }, P("a")]));
  assert.deepStrictEqual(parsed.map((p) => p.id), ["a"]);
});

test("blocked queries are refused without any network call", async () => {
  _internal.reset();
  const h = fakeHttp({ results: [] });
  _internal.setHttp(h);
  const { deps, sent } = makeDeps();
  assert.strictEqual(await pin.tryHandle(ctx("بنترست nsfw girls"), deps), true);
  await pin.idle();
  assert.strictEqual(h.calls.search + h.calls.home, 0);
  assert.match(sent.texts[0], /غير مسموح/);
});

test("per-user cooldown, per-thread cooldown and in-flight guard", async () => {
  _internal.reset();
  let now = 1_000_000;
  _internal.setClock(() => now);
  const h = fakeHttp({ results: [P("a"), P("b")], files: allFiles(["a", "b"]) });
  _internal.setHttp(h);
  const { deps, sent } = makeDeps();
  await pin.tryHandle(ctx("بنترست قطط"), deps);
  await pin.idle();
  await pin.tryHandle(ctx("بنترست كلاب"), deps); // نفس المستخدم فوراً
  await pin.idle();
  assert.strictEqual(h.calls.search, 1);
  now += 25_000;
  await pin.tryHandle(ctx("بنترست كلاب"), deps);
  await pin.idle();
  assert.strictEqual(h.calls.search, 2);
  now += 3_000; // مستخدم آخر لكن نفس المجموعة خلال 8 ثوانٍ
  await pin.tryHandle(ctx("بنترست طيور", { userId: "u2" }), deps);
  await pin.idle();
  assert.strictEqual(h.calls.search, 2);
  assert.strictEqual(sent.images.length, 2);
});

test("429 pauses the provider for 15 minutes with a friendly message", async () => {
  _internal.reset();
  let now = 5_000_000;
  _internal.setClock(() => now);
  const h = fakeHttp({ results: [], searchStatus: 429 });
  _internal.setHttp(h);
  const { deps, sent } = makeDeps();
  await pin.tryHandle(ctx("بنترست قطط"), deps);
  await pin.idle();
  assert.match(sent.texts.at(-1), /مشغول/);
  assert.strictEqual(h.calls.search, 1);
  now += 60_000;
  await pin.tryHandle(ctx("بنترست قطط"), deps);
  await pin.idle();
  assert.strictEqual(h.calls.search, 1); // متوقف: لا طلب جديد لبنترست
});

test("a failed image send stops the batch (no hammering)", async () => {
  _internal.reset();
  const ids = ["a", "b", "c"];
  _internal.setHttp(fakeHttp({ results: ids.map((i) => P(i)), files: allFiles(ids) }));
  let batchCalls = 0;
  let singleCalls = 0;
  const deps = {
    sendText: async () => true,
    sendImage: async () => (++singleCalls, false),
    sendImages: async (_threadId, images) => {
      batchCalls += 1;
      assert.strictEqual(images.length, 3);
      return false;
    },
  };
  await pin.tryHandle(ctx("بنترست 3 بحر"), deps);
  await pin.idle();
  assert.strictEqual(batchCalls, 1);
  assert.strictEqual(singleCalls, 0);
});

test("createDeps forwards a requested batch through one transport call", async () => {
  const calls = [];
  const deps = pin.createDeps({
    sendGroupImageBuffersTracked: async (threadId, images) => {
      calls.push({ threadId, images });
      return "batch-message";
    },
  });
  const images = [
    { buffer: PNG, contentType: "image/png", caption: "صورة 1" },
    { buffer: JPG, contentType: "image/jpeg", caption: "صورة 2" },
  ];

  assert.strictEqual(await deps.sendImages("group-1", images, true), true);
  assert.deepStrictEqual(calls, [{ threadId: "group-1", images }]);
});

test("empty results gives a clear message", async () => {
  _internal.reset();
  _internal.setHttp(fakeHttp({ results: [] }));
  const { deps, sent } = makeDeps();
  await pin.tryHandle(ctx("بنترست zzzzqqq"), deps);
  await pin.idle();
  assert.match(sent.texts.at(-1), /ما لقيت/);
});
