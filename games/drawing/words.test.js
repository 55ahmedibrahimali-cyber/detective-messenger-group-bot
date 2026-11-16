const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const { Readable } = require("node:stream");
const db = require("../../database");
const msg = require("../../services/messenger");
const { WORDS, chooseWord, matchesAnswer, normalizeAnswer } = require("./words");
const { decodePng, handleRequest } = require("../../services/drawingWebServer");
const drawingTunnel = require("../../services/drawingTunnel");
const { createTestImage } = require("../../services/testImage");
const drawingEngine = require("./engine");

test("drawing tunnel waits until the public URL responds before returning it", async () => {
  const originalFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, options) => {
    calls.push(String(url));
    if (calls.length < 3) throw new Error("ECONNREFUSED");
    return { status: 204 };
  };
  try {
    await drawingTunnel.waitForReachableUrl("https://example.test", 5000);
    assert.ok(calls.length >= 3);
  } finally {
    global.fetch = originalFetch;
  }
});

test("drawing startup verifies the exact token page before sending its link", async () => {
  const originalFetch = global.fetch;
  const calls = [];
  global.fetch = async (url) => {
    calls.push(String(url));
    return { status: calls.length < 2 ? 503 : 200 };
  };
  try {
    await drawingTunnel.waitForReachableUrl(
      "https://example.test",
      5000,
      "/draw/example-token",
    );
    assert.deepEqual(calls, [
      "https://example.test/draw/example-token",
      "https://example.test/draw/example-token",
    ]);
  } finally {
    global.fetch = originalFetch;
  }
});

test("drawing tunnel health checks require the dedicated successful probe route", async () => {
  const response = {
    writeHead(status) {
      this.status = status;
    },
    end(body) {
      this.body = body;
    },
  };
  assert.equal(
    await handleRequest(
      { method: "GET", url: "/draw/probe-healthcheck" },
      response,
    ),
    true,
  );
  assert.equal(response.status, 204);
  assert.equal(response.body, "");
});
const CFG = require("./config");

test("word choices are always drawable entries with aliases", () => {
  for (let index = 0; index < WORDS.length; index++) {
    const word = chooseWord((max) => index % max);
    assert.ok(word.word);
    assert.ok(Array.isArray(word.aliases));
    assert.ok(matchesAnswer(word.word, word));
  }
});

test("Arabic answer matching ignores tashkeel, punctuation, and common spelling variants", () => {
  assert.equal(normalizeAnswer(" قَطَّة! "), "قطه");
  assert.equal(matchesAnswer("قَطَّة!", WORDS[0]), true);
  assert.equal(matchesAnswer("الزرافه", WORDS.find((word) => word.word === "زرافة")), true);
  assert.equal(matchesAnswer("فيل", WORDS.find((word) => word.word === "قطة")), false);
});

test("drawing page PNG data is decoded and rejected when malformed or too large", () => {
  const png =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a0xkAAAAASUVORK5CYII=";
  assert.ok(decodePng(png).length > 45);
  assert.throws(() => decodePng("data:image/jpeg;base64,AAAA"), /PNG/);
  assert.throws(() => decodePng("data:image/png;base64,not-valid!"), /PNG|بيانات/);
});

test("drawing page cancellation closes the game and notifies the group handler", async () => {
  const originalTransaction = db.withTransaction;
  const statements = [];
  let notifiedThread;
  const previousHandler = require("../../services/drawingWebServer").setCancelHandler(
    async ({ threadId }) => {
      notifiedThread = threadId;
    },
  );
  db.withTransaction = async (callback) =>
    callback(async (sql) => {
      statements.push(sql);
      if (sql.includes("SELECT ds.id")) {
        return [{
          id: 1,
          room_id: 42,
          player_id: 7,
          word: "قطة",
          aliases_json: "[]",
          status: "issued",
          thread_id: "group-42",
        }];
      }
      if (sql.includes("UPDATE game_rooms")) return { affectedRows: 1 };
      return { affectedRows: 1 };
    });
  try {
    const request = Readable.from([
      Buffer.from(JSON.stringify({ token: "x".repeat(43), cancel: true })),
    ]);
    request.method = "POST";
    request.url = "/api/draw";
    request.headers = {
      host: "drawing.test",
      origin: "https://drawing.test",
      "content-type": "application/json",
    };
    const response = {
      writeHead(status) {
        this.status = status;
      },
      end(body) {
        this.body = body;
      },
    };
    assert.equal(await handleRequest(request, response), true);
    assert.equal(response.status, 200, response.body);
    assert.deepEqual(JSON.parse(response.body), { state: "cancelled" });
    assert.equal(notifiedThread, "group-42");
    assert.ok(statements.some((sql) => sql.includes("status='cancelled'")));
    assert.ok(statements.some((sql) => sql.includes("next_publish_at=NULL")));
  } finally {
    db.withTransaction = originalTransaction;
    require("../../services/drawingWebServer").setCancelHandler(previousHandler);
  }
});

test("test image is emitted as a valid JPEG payload", () => {
  const image = createTestImage();
  assert.equal(image[0], 0xff);
  assert.equal(image[1], 0xd8);
  assert.equal(image[2], 0xff);
});

test("drawing defaults keep a 5 minute round and 30 second publishing interval", async () => {
  assert.equal(CFG.PUBLISH_INTERVAL_SECONDS, 30);
  assert.equal(CFG.ROUND_DURATION_SECONDS, 300);
  assert.equal("ARTIST_IDLE_SECONDS" in CFG, false);
  assert.equal(CFG.TOKEN_TTL_MINUTES, 180);
  const response = {
    writeHead(status) {
      this.status = status;
    },
    end(body) {
      this.body = body;
    },
  };
  assert.equal(
    await handleRequest({ method: "POST", url: "/draw/not-a-token" }, response),
    true,
  );
  assert.equal(response.status, 405);
});

test("drawing tunnel provider defaults to auto and rejects unknown providers", () => {
  assert.equal(drawingTunnel.publicHttpsPort, 443);
  assert.equal(drawingTunnel._internal.watchdogIntervalMs(undefined), 60000);
  assert.equal(drawingTunnel._internal.watchdogIntervalMs("0"), 0);
  assert.throws(
    () => drawingTunnel._internal.watchdogIntervalMs("-1"),
    /must be an integer/,
  );
  assert.equal(drawingTunnel._internal.fallbackAllowed(undefined), true);
  assert.equal(drawingTunnel._internal.fallbackAllowed("0"), false);
  assert.equal(drawingTunnel._internal.keepTailscaleFunnel(false, "1"), true);
  assert.equal(drawingTunnel._internal.keepTailscaleFunnel(true, "0"), true);
  assert.equal(drawingTunnel._internal.keepTailscaleFunnel(false, "0"), false);
  assert.equal(
    drawingTunnel._internal.tailscalePublicUrl("https://bot.ts.net:443"),
    "https://bot.ts.net",
  );
  assert.deepEqual(drawingTunnel.tailscaleStopArgs(3000), [
    "funnel",
    "--yes",
    "--https=443",
    "http://127.0.0.1:3000",
    "off",
  ]);
  const original = process.env.DRAWING_TUNNEL_PROVIDER;
  try {
    delete process.env.DRAWING_TUNNEL_PROVIDER;
    assert.equal(drawingTunnel.configuredProvider(), "auto");
    process.env.DRAWING_TUNNEL_PROVIDER = "tailscale";
    assert.equal(drawingTunnel.configuredProvider(), "tailscale");
    process.env.DRAWING_TUNNEL_PROVIDER = "unknown";
    assert.throws(() => drawingTunnel.configuredProvider(), /must be auto/);
  } finally {
    if (original === undefined) delete process.env.DRAWING_TUNNEL_PROVIDER;
    else process.env.DRAWING_TUNNEL_PROVIDER = original;
  }
});

test("the drawing command selects its reply target as the only artist", () => {
  assert.equal(drawingEngine.artistIdForCommand({ userId: "caller" }), "caller");
  assert.equal(
    drawingEngine.artistIdForCommand({
      userId: "caller",
      messageReply: { senderID: "replied-player" },
    }),
    "replied-player",
  );
  assert.equal(
    drawingEngine.artistIdForCommand({
      userId: "caller",
      messageReply: { senderID: "" },
    }),
    "caller",
  );
});

test("private drawing link serves the personalized web page", async () => {
  const originalOne = db.one;
  const token = "x".repeat(43);
  const response = {
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
    },
    end(body) {
      this.body = body;
    },
  };
  db.one = async () => ({ word: "قطة" });
  try {
    assert.equal(
      await handleRequest(
        { method: "GET", url: `/draw/${token}` },
        response,
      ),
      true,
    );
    assert.equal(response.status, 200);
    assert.match(response.headers["Content-Security-Policy"], /connect-src 'self'/);
    assert.match(response.body, /قطة/);
    assert.match(response.body, new RegExp(token));
    assert.doesNotMatch(response.body, /__DRAWING_[A-Z_]+__/);
  } finally {
    db.one = originalOne;
  }
});

test("drawing page polls its current round without resending the image", async () => {
  const originalTransaction = db.withTransaction;
  const response = {
    writeHead(status) {
      this.status = status;
    },
    end(body) {
      this.body = body;
    },
  };
  db.withTransaction = async (callback) =>
    callback(async (sql) => {
      assert.match(sql, /SELECT ds\.id/);
      return [
        {
          id: 1,
          room_id: 2,
          player_id: 3,
          word: "قطة",
          aliases_json: "[]",
          status: "published",
          token_expires_at: new Date(Date.now() + 60_000),
        },
      ];
    });
  const request = Object.assign(
    Readable.from([
      Buffer.from(JSON.stringify({ token: "x".repeat(43), statusOnly: true })),
    ]),
    {
      method: "POST",
      url: "/api/draw",
      headers: {
        origin: "https://draw.example.test",
        host: "draw.example.test",
        "content-type": "application/json",
      },
    },
  );
  try {
    assert.equal(await handleRequest(request, response), true);
    assert.equal(response.status, 200);
    assert.deepEqual(JSON.parse(response.body), { state: "waiting" });
  } finally {
    db.withTransaction = originalTransaction;
  }
});

test("the drawing page cannot start another challenge after a round is solved", async () => {
  const originalTransaction = db.withTransaction;
  const response = {
    writeHead(status) {
      this.status = status;
    },
    end(body) {
      this.body = body;
    },
  };
  db.withTransaction = async (callback) =>
    callback(async (sql) => {
      assert.match(sql, /SELECT ds\.id/);
      return [
        {
          id: 1,
          room_id: 2,
          player_id: 3,
          word: "قطة",
          aliases_json: "[]",
          status: "solved",
        },
      ];
    });
  const request = Object.assign(
    Readable.from([
      Buffer.from(
        JSON.stringify({
          token: "x".repeat(43),
          statusOnly: true,
        }),
      ),
    ]),
    {
      method: "POST",
      url: "/api/draw",
      headers: {
        origin: "https://draw.example.test",
        host: "draw.example.test",
        "content-type": "application/json",
      },
    },
  );
  try {
    assert.equal(await handleRequest(request, response), true);
    assert.equal(response.status, 200);
    assert.deepEqual(JSON.parse(response.body), { state: "finished" });
  } finally {
    db.withTransaction = originalTransaction;
  }
});

test("finishing a drawing round closes the room and cancels pending drawings", async () => {
  const statements = [];
  const finished = await drawingEngine.finishRound(async (sql) => {
    statements.push(sql);
    return { affectedRows: 1 };
  }, 42);
  assert.equal(finished, true);
  assert.match(statements[0], /status='finished'/);
  assert.match(statements[1], /next_publish_at=NULL/);
  assert.match(statements[2], /status='cancelled'/);
});

test("repeating the drawing command cannot issue a second challenge", async () => {
  const originalOne = db.one;
  const originalSendGroup = msg.sendGroup;
  let roomLookupCount = 0;
  db.one = async () => {
    roomLookupCount++;
    return { id: 42, thread_id: "thread", status: "playing" };
  };
  msg.sendGroup = async () => true;
  try {
    await drawingEngine.handleMessage({
      text: "/رسم",
      isGroup: true,
      threadId: "thread",
      userId: "artist",
    });
    assert.equal(roomLookupCount, 1);
  } finally {
    db.one = originalOne;
    msg.sendGroup = originalSendGroup;
  }
});

test("the responsive drawing page includes manual cancellation and separate send countdown", () => {
  const html = fs.readFileSync(`${__dirname}/public/index.html`, "utf8");
  const match = html.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(match);
  const script = match[1]
    .replace("__DRAWING_TOKEN_JSON__", JSON.stringify("x".repeat(43)))
    .replace("__DRAWING_WORD_JSON__", JSON.stringify("قطة"))
    .replace("__DRAWING_INTERVAL_SECONDS_JSON__", "30");
  assert.match(script, /setInterval/);
  assert.match(script, /fetch\("\/api\/draw"/);
  assert.match(script, /cancel: true/);
  assert.match(script, /sendCountdown\.textContent/);
  assert.doesNotMatch(script, /notifyArtistIdle|artistIdleSeconds|idle: true/);
  assert.doesNotThrow(() => new vm.Script(script));
  assert.match(html, /id="undo"/);
  assert.match(html, /id="cancel"/);
  assert.match(html, /id="sendCountdown"/);
  assert.match(html, /id="size" type="range"/);
  assert.match(html, /@media \(max-width: 520px\)/);
});
