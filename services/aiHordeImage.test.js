"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const sharp = require("sharp");
const { PNG } = require("pngjs");
const aiHordeImage = require("./aiHordeImage");

function createPng(width, height) {
  const image = new PNG({ width, height });
  image.data.fill(220);
  return PNG.sync.write(image);
}

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: "",
    json: async () => body,
  };
}

test("AI Horde submits a bounded WebP reference and returns its generated image", async () => {
  const originalFetch = global.fetch;
  const previousKey = process.env.AI_HORDE_API_KEY;
  const output = await sharp({
    create: {
      width: 2,
      height: 2,
      channels: 3,
      background: { r: 80, g: 120, b: 200 },
    },
  })
    .webp()
    .toBuffer();
  const requests = [];
  process.env.AI_HORDE_API_KEY = "test-horde-key";
  global.fetch = async (url, options) => {
    requests.push({ url, options });
    if (url.endsWith("/generate/async")) {
      return jsonResponse(202, { id: "request-id" });
    }
    if (url.endsWith("/generate/check/request-id")) {
      return jsonResponse(200, { done: true, faulted: false });
    }
    if (url.endsWith("/generate/status/request-id")) {
      return jsonResponse(200, {
        generations: [
          { img: output.toString("base64"), model: "test-model", state: "ok" },
        ],
      });
    }
    throw new Error(`Unexpected request: ${url}`);
  };

  try {
    const result = await aiHordeImage.generateImage("Create a poster.", {
      buffer: createPng(800, 400),
      contentType: "image/png",
    });
    const submission = requests[0];
    const body = JSON.parse(submission.options.body);
    const convertedReference = Buffer.from(body.source_image, "base64");
    const metadata = await sharp(convertedReference).metadata();

    assert.match(submission.url, /aihorde\.net\/api\/v2\/generate\/async$/);
    assert.equal(submission.options.headers.apikey, "test-horde-key");
    assert.equal(requests[1].options.headers.apikey, undefined);
    assert.equal(body.prompt, "Create a poster.");
    assert.equal(body.params.width, 768);
    assert.equal(body.params.height, 384);
    assert.equal(metadata.format, "webp");
    assert.equal(body.shared, false);
    assert.equal(result.contentType, "image/webp");
    assert.deepEqual(result.buffer, output);
    assert.equal(result.model, "AI Horde — test-model");
  } finally {
    global.fetch = originalFetch;
    if (previousKey === undefined) delete process.env.AI_HORDE_API_KEY;
    else process.env.AI_HORDE_API_KEY = previousKey;
  }
});

test("AI Horde fallback requires an API key", async () => {
  const previousKey = process.env.AI_HORDE_API_KEY;
  delete process.env.AI_HORDE_API_KEY;
  try {
    await assert.rejects(
      aiHordeImage.generateImage("Create a poster."),
      /AI_HORDE_API_KEY/,
    );
  } finally {
    if (previousKey !== undefined) process.env.AI_HORDE_API_KEY = previousKey;
  }
});

test("AI Horde rejects invalid and oversized image output", () => {
  assert.throws(
    () => aiHordeImage._internal.decodeImage(Buffer.from("not an image").toString("base64")),
    /غير صالحة/,
  );
  const oversized = Buffer.alloc(10 * 1024 * 1024 + 1);
  oversized.write("RIFF", 0, "ascii");
  oversized.write("WEBP", 8, "ascii");
  assert.throws(
    () => aiHordeImage._internal.decodeImage(oversized.toString("base64")),
    /غير صالحة/,
  );
  assert.deepEqual(aiHordeImage._internal.imageDimensions(), {
    width: 768,
    height: 768,
  });
});
