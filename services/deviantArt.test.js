"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const deviantArt = require("./deviantArt");

const PNG = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  Buffer.alloc(24),
]);

function configureEnv(overrides) {
  const previous = {};
  for (const [key, value] of Object.entries(overrides)) {
    previous[key] = process.env[key];
    if (value === null) delete process.env[key];
    else process.env[key] = value;
  }
  return () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

function context(text, overrides = {}) {
  return {
    userId: "user-1",
    threadId: "thread-1",
    isGroup: true,
    text,
    ...overrides,
  };
}

function makeDeps() {
  const sent = { texts: [], images: [], batches: [] };
  return {
    sent,
    deps: {
      sendText: async (_threadId, text) => {
        sent.texts.push(text);
        return true;
      },
      sendImage: async (_threadId, buffer, contentType, caption) => {
        sent.images.push({ buffer, contentType, caption });
        return true;
      },
      sendImages: async (threadId, images, isGroup) => {
        sent.batches.push({ threadId, images, isGroup });
        return true;
      },
    },
  };
}

function deviation(id, overrides = {}) {
  return {
    deviationid: id,
    title: `Artwork ${id}`,
    url: `https://www.deviantart.com/artist/art/Artwork-${id}`,
    author: { username: "artist" },
    is_mature: false,
    preview: {
      src: `https://images-wixmp-ed30a86b8c4ca887773594c2.wixmp.com/${id}.png`,
    },
    ...overrides,
  };
}

test("parses DeviantArt tag searches, counts, and usage", () => {
  assert.equal(deviantArt.parseCommand("hello"), null);
  assert.deepEqual(deviantArt.parseCommand("صورة قطط"), {
    query: "قطط",
    count: null,
    usage: false,
  });
  assert.equal(deviantArt.parseCommand("/صورة"), null);
  assert.deepEqual(deviantArt.parseCommand("ديفاينت ارت قطط"), {
    query: "قطط",
    count: null,
    usage: false,
  });
  assert.deepEqual(deviantArt.parseCommand("/ديفينت آرت 3 صور فن رقمي"), {
    query: "فن رقمي",
    count: 3,
    usage: false,
  });
  assert.deepEqual(deviantArt.parseCommand("deviantart cats x2"), {
    query: "cats",
    count: 2,
    usage: false,
  });
  assert.deepEqual(deviantArt.parseCommand("صورة 3 فن رقمي"), {
    query: "فن رقمي",
    count: 3,
    usage: false,
  });
  assert.equal(deviantArt.parseCommand("ديفينت آرت").usage, true);
});

test("keeps the existing bare /صورة diagnostic command available", async () => {
  const { deps } = makeDeps();
  assert.equal(await deviantArt.tryHandle(context("/صورة"), deps), false);
});

test("result parsing excludes mature items and non-DeviantArt image hosts", () => {
  const results = deviantArt._internal.parseResults([
    deviation("safe"),
    deviation("mature", { is_mature: true }),
    deviation("bad-host", {
      preview: { src: "https://evil.example/image.png" },
    }),
  ]);
  assert.deepEqual(results.map((item) => item.id), ["safe"]);
  assert.equal(
    results[0].caption,
    "🎨 Artwork safe — artist\nhttps://www.deviantart.com/artist/art/Artwork-safe",
  );
  assert.equal(
    deviantArt._internal.allowedImageUrl("http://images-wixmp.wixmp.com/a.png"),
    null,
  );
  assert.equal(
    deviantArt._internal.allowedImageUrl("https://evil.example/a.png"),
    null,
  );
});

test("searches the official tag API and sends credited preview images", async () => {
  deviantArt._internal.reset();
  const originalFetch = global.fetch;
  const restoreEnv = configureEnv({
    DEVIANTART_ENABLED: "1",
    DEVIANTART_CLIENT_ID: "test-client",
    DEVIANTART_CLIENT_SECRET: "test-secret",
    DEVIANTART_MAX_IMAGES: "2",
    DEVIANTART_USER_COOLDOWN_SECONDS: "0",
    DEVIANTART_THREAD_COOLDOWN_SECONDS: "0",
  });
  const calls = [];
  global.fetch = async (input, options = {}) => {
    const url = new URL(input);
    calls.push({ url, options });
    if (url.href === "https://www.deviantart.com/oauth2/token") {
      assert.equal(options.method, "POST");
      const body = new URLSearchParams(options.body);
      assert.equal(body.get("grant_type"), "client_credentials");
      assert.equal(body.get("client_id"), "test-client");
      assert.equal(body.get("client_secret"), "test-secret");
      return new Response(
        JSON.stringify({ access_token: "test-access-token", expires_in: 3600 }),
        { headers: { "content-type": "application/json" } },
      );
    }
    if (url.pathname === "/api/v1/oauth2/browse/tags") {
      assert.equal(url.searchParams.get("tag"), "فن رقمي");
      assert.equal(options.headers.authorization, "Bearer test-access-token");
      return new Response(
        JSON.stringify({
          results: [
            deviation("one"),
            deviation("mature", { is_mature: true }),
            deviation("two"),
          ],
        }),
        { headers: { "content-type": "application/json" } },
      );
    }
    if (url.hostname.endsWith(".wixmp.com"))
      return new Response(Buffer.concat([PNG, Buffer.from(url.pathname)]), {
        headers: { "content-type": "image/png" },
      });
    throw new Error(`Unexpected request: ${url.href}`);
  };

  const { deps, sent } = makeDeps();
  try {
    assert.equal(
      await deviantArt.tryHandle(context("صورة 2 فن رقمي"), deps),
      true,
    );
    await deviantArt.idle();
    assert.equal(calls.filter((call) => call.url.pathname.endsWith("/token")).length, 1);
    assert.equal(sent.batches.length, 1);
    assert.deepEqual(
      sent.batches[0].images.map((image) => image.caption),
      [
        "🎨 Artwork one — artist\nhttps://www.deviantart.com/artist/art/Artwork-one\n(فن رقمي)",
        "🎨 Artwork two — artist\nhttps://www.deviantart.com/artist/art/Artwork-two\n(فن رقمي)",
      ],
    );
    assert.equal(sent.batches[0].images[0].contentType, "image/png");
  } finally {
    global.fetch = originalFetch;
    restoreEnv();
    deviantArt._internal.reset();
  }
});

test("blocked queries are refused without API requests", async () => {
  deviantArt._internal.reset();
  const originalFetch = global.fetch;
  const restoreEnv = configureEnv({ DEVIANTART_BLOCKED_TERMS: "blockedword" });
  let requests = 0;
  global.fetch = async () => {
    requests++;
    throw new Error("blocked query must not call the API");
  };
  const { deps, sent } = makeDeps();
  try {
    assert.equal(
      await deviantArt.tryHandle(context("ديفينت آرت blockedword"), deps),
      true,
    );
    assert.equal(requests, 0);
    assert.match(sent.texts[0], /غير مسموح/);
  } finally {
    global.fetch = originalFetch;
    restoreEnv();
    deviantArt._internal.reset();
  }
});

test("missing app credentials are reported explicitly", async () => {
  deviantArt._internal.reset();
  const originalFetch = global.fetch;
  const restoreEnv = configureEnv({
    DEVIANTART_CLIENT_ID: "",
    DEVIANTART_CLIENT_SECRET: "",
  });
  let requests = 0;
  global.fetch = async () => {
    requests++;
    throw new Error("credentials must be checked before networking");
  };
  const { deps, sent } = makeDeps();
  try {
    await deviantArt.tryHandle(context("ديفينت آرت قطط"), deps);
    await deviantArt.idle();
    assert.equal(requests, 0);
    assert.match(sent.texts.at(-1), /DEVIANTART_CLIENT_ID/);
    assert.match(sent.texts.at(-1), /DEVIANTART_CLIENT_SECRET/);
  } finally {
    global.fetch = originalFetch;
    restoreEnv();
    deviantArt._internal.reset();
  }
});
