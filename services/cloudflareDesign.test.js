"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { PNG } = require("pngjs");
const cloudflareDesign = require("./cloudflareDesign");

function createPng(width, height) {
  const image = new PNG({ width, height });
  image.data.fill(200);
  return PNG.sync.write(image);
}

function setCredentials() {
  const previous = {
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
    apiToken: process.env.CLOUDFLARE_API_TOKEN,
  };
  process.env.CLOUDFLARE_ACCOUNT_ID = "test-account";
  process.env.CLOUDFLARE_API_TOKEN = "test-token";
  return () => {
    if (previous.accountId === undefined)
      delete process.env.CLOUDFLARE_ACCOUNT_ID;
    else process.env.CLOUDFLARE_ACCOUNT_ID = previous.accountId;
    if (previous.apiToken === undefined)
      delete process.env.CLOUDFLARE_API_TOKEN;
    else process.env.CLOUDFLARE_API_TOKEN = previous.apiToken;
  };
}

test("references are resized to the model limit without changing aspect ratio", () => {
  const reference = cloudflareDesign._internal.resizeReference({
    buffer: createPng(800, 400),
  });
  const decoded = PNG.sync.read(reference.buffer);
  assert.deepEqual([decoded.width, decoded.height], [512, 256]);
  assert.deepEqual(
    cloudflareDesign._internal.outputDimensions(reference),
    { width: 1024, height: 512 },
  );
});

test("image generation sends the prompt, bounded reference, and dimensions to Cloudflare", async () => {
  const originalFetch = global.fetch;
  const restoreEnv = setCredentials();
  const output = createPng(2, 2);
  let request;
  global.fetch = async (url, options) => {
    request = { url, options };
    return {
      ok: true,
      json: async () => ({ success: true, result: { image: output.toString("base64") } }),
    };
  };
  try {
    const result = await cloudflareDesign.generateImage("بوستر جديد", {
      buffer: createPng(800, 400),
      contentType: "image/png",
    });
    const file = request.options.body.get("input_image_0");
    const input = PNG.sync.read(Buffer.from(await file.arrayBuffer()));
    assert.match(request.url, /@cf\/black-forest-labs\/flux-2-dev$/);
    assert.equal(request.options.body.get("prompt"), "بوستر جديد");
    assert.equal(request.options.body.get("width"), "1024");
    assert.equal(request.options.body.get("height"), "512");
    assert.deepEqual([input.width, input.height], [512, 256]);
    assert.equal(result.contentType, "image/png");
    assert.deepEqual(result.buffer, output);
  } finally {
    global.fetch = originalFetch;
    restoreEnv();
  }
});

test("image generation reports missing Cloudflare credentials", async () => {
  const previousAccount = process.env.CLOUDFLARE_ACCOUNT_ID;
  const previousToken = process.env.CLOUDFLARE_API_TOKEN;
  delete process.env.CLOUDFLARE_ACCOUNT_ID;
  delete process.env.CLOUDFLARE_API_TOKEN;
  try {
    await assert.rejects(
      cloudflareDesign.generateImage("بوستر"),
      /CLOUDFLARE_ACCOUNT_ID وCLOUDFLARE_API_TOKEN/,
    );
  } finally {
    if (previousAccount !== undefined)
      process.env.CLOUDFLARE_ACCOUNT_ID = previousAccount;
    if (previousToken !== undefined)
      process.env.CLOUDFLARE_API_TOKEN = previousToken;
  }
});
