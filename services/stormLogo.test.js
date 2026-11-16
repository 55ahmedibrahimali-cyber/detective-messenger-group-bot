const test = require("node:test");
const assert = require("node:assert/strict");
const { PNG } = require("pngjs");
const designAssistant = require("./designAssistant");
const msg = require("./messenger");
const stormLogo = require("./stormLogo");

function createImage(width, height, color) {
  const image = new PNG({ width, height });
  for (let offset = 0; offset < image.data.length; offset += 4) {
    image.data[offset] = color[0];
    image.data[offset + 1] = color[1];
    image.data[offset + 2] = color[2];
    image.data[offset + 3] = 255;
  }
  return PNG.sync.write(image);
}

test("the storm logo output is square and keeps its mark inside the circular crop area", () => {
  const background = [24, 64, 96];
  const output = stormLogo._internal.composeWithLogo({
    buffer: createImage(600, 400, background),
    contentType: "image/png",
  });
  const image = PNG.sync.read(output);

  assert.equal(image.width, 1024);
  assert.equal(image.height, 1024);
  assert.deepEqual([...image.data.subarray(0, 3)], background);

  const logoSize = Math.round(image.width * 0.19);
  const left = Math.round(image.width * 0.14);
  const top = Math.round(image.height * 0.42);
  const logoCenter =
    ((top + Math.floor(logoSize / 2)) * image.width +
      left +
      Math.floor(logoSize / 2)) *
    4;
  assert.notDeepEqual([...image.data.subarray(logoCenter, logoCenter + 3)], background);

  const radius = image.width / 2;
  for (const [x, y] of [
    [left, top],
    [left + logoSize, top],
    [left, top + logoSize],
    [left + logoSize, top + logoSize],
  ]) {
    assert.ok(Math.hypot(x - radius, y - radius) < radius);
  }
});

test("WebP input is rejected with a supported-format explanation", () => {
  assert.throws(
    () =>
      stormLogo._internal.decodeImage({
        buffer: Buffer.from("RIFF0000WEBP"),
        contentType: "image/webp",
      }),
    /WEBP غير مدعومة/,
  );
});

test("the command requires a reply to an image", async () => {
  const originalSendGroup = msg.sendGroup;
  let sentMessage;
  msg.sendGroup = async (_threadId, text) => {
    sentMessage = text;
  };
  try {
    await stormLogo.handle({
      isGroup: true,
      threadId: "storm-logo-thread",
      userId: "test-user",
      messageReply: null,
    });
    assert.match(sentMessage, /ردّ على صورة/);
  } finally {
    msg.sendGroup = originalSendGroup;
  }
});

test("requested logo locations map to safe positions around the profile circle", () => {
  const cases = [
    ["/شعار أعلى اليسار", "أعلى اليسار", 0.25, 0.25],
    ["/شعار أعلى المنتصف", "أعلى المنتصف", 0.5, 0.14],
    ["/شعار أعلى اليمين", "أعلى اليمين", 0.75, 0.25],
    ["/شعار يسار المنتصف", "منتصف اليسار", 0.14, 0.5],
    ["/شعار في المنتصف", "المنتصف", 0.5, 0.5],
    ["/شعار يمين", "منتصف اليمين", 0.86, 0.5],
    ["/شعار أسفل اليسار", "أسفل اليسار", 0.25, 0.75],
    ["/شعار بالأسفل في المنتصف", "أسفل المنتصف", 0.5, 0.86],
    ["/شعار تحت اليمين", "أسفل اليمين", 0.75, 0.75],
  ];

  for (const [command, label, centerX, centerY] of cases) {
    const placement = stormLogo._internal.parseRequestedPlacement(command);
    assert.deepEqual(placement, { centerX, centerY, label });
    assert.equal(
      stormLogo._internal.placementFitsInsideCircle(placement),
      true,
    );
  }
  assert.deepEqual(
    stormLogo._internal.parseRequestedPlacement("/شعار فوق تحت"),
    { invalid: true },
  );
});

test("a requested logo location overrides Cloudflare analysis", async () => {
  const originalGetReplyImage = designAssistant.getReplyImage;
  const originalSendGroupImage = msg.sendGroupImageBufferTracked;
  const originalFetch = global.fetch;
  const originalError = console.error;
  const originalEnv = {
    analysis: process.env.STORM_LOGO_AI_ANALYSIS,
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
    apiToken: process.env.CLOUDFLARE_API_TOKEN,
  };
  const background = [24, 64, 96];
  const reply = { attachments: [{ type: "photo" }] };
  let requests = 0;
  let sent;

  process.env.STORM_LOGO_AI_ANALYSIS = "1";
  process.env.CLOUDFLARE_ACCOUNT_ID = "test-account";
  process.env.CLOUDFLARE_API_TOKEN = "test-token";
  designAssistant.getReplyImage = async () => ({
    buffer: createImage(200, 200, background),
    contentType: "image/png",
  });
  msg.sendGroupImageBufferTracked = async (_threadId, buffer, _type, caption) => {
    sent = { buffer, caption };
    return "sent-image";
  };
  global.fetch = async () => {
    requests += 1;
    throw new Error("manual position should not call Cloudflare");
  };
  console.error = () => {};
  try {
    await stormLogo.handle({
      text: "/شعار بالأسفل في المنتصف",
      isGroup: true,
      threadId: "storm-logo-thread",
      userId: "test-user",
      messageReply: reply,
    });

    assert.equal(requests, 0);
    assert.match(sent.caption, /الموضع: أسفل المنتصف/);
    const image = PNG.sync.read(sent.buffer);
    const manualPosition = stormLogo._internal.logoPosition(
      stormLogo._internal.parseRequestedPlacement("/شعار أسفل المنتصف"),
    );
    const manualCenter =
      ((manualPosition.top + Math.floor(manualPosition.logoSize / 2)) *
        image.width +
        manualPosition.left +
        Math.floor(manualPosition.logoSize / 2)) *
      4;
    assert.notDeepEqual(
      [...image.data.subarray(manualCenter, manualCenter + 3)],
      background,
    );
  } finally {
    designAssistant.getReplyImage = originalGetReplyImage;
    msg.sendGroupImageBufferTracked = originalSendGroupImage;
    global.fetch = originalFetch;
    console.error = originalError;
    if (originalEnv.analysis === undefined)
      delete process.env.STORM_LOGO_AI_ANALYSIS;
    else process.env.STORM_LOGO_AI_ANALYSIS = originalEnv.analysis;
    if (originalEnv.accountId === undefined)
      delete process.env.CLOUDFLARE_ACCOUNT_ID;
    else process.env.CLOUDFLARE_ACCOUNT_ID = originalEnv.accountId;
    if (originalEnv.apiToken === undefined)
      delete process.env.CLOUDFLARE_API_TOKEN;
    else process.env.CLOUDFLARE_API_TOKEN = originalEnv.apiToken;
  }
});

test("the command composites and sends only the replied image", async () => {
  const originalGetReplyImage = designAssistant.getReplyImage;
  const originalSendGroupImage = msg.sendGroupImageBufferTracked;
  const reply = { attachments: [{ type: "photo" }] };
  const sent = {};
  designAssistant.getReplyImage = async (messageReply) => {
    assert.equal(messageReply, reply);
    return {
      buffer: createImage(600, 400, [24, 64, 96]),
      contentType: "image/png",
    };
  };
  msg.sendGroupImageBufferTracked = async (
    threadId,
    buffer,
    contentType,
    caption,
  ) => {
    Object.assign(sent, { threadId, buffer, contentType, caption });
    return "sent-image";
  };
  try {
    const result = await stormLogo.handle({
      isGroup: true,
      threadId: "storm-logo-thread",
      userId: "test-user",
      messageReply: reply,
    });
    assert.equal(result, "sent-image");
    assert.equal(sent.threadId, "storm-logo-thread");
    assert.equal(sent.contentType, "image/png");
    assert.match(sent.caption, /STORM/);
    assert.deepEqual(
      [PNG.sync.read(sent.buffer).width, PNG.sync.read(sent.buffer).height],
      [1024, 1024],
    );
  } finally {
    designAssistant.getReplyImage = originalGetReplyImage;
    msg.sendGroupImageBufferTracked = originalSendGroupImage;
  }
});

test("logo analysis is opt-in and keeps the configured logo size", async () => {
  const originalFetch = global.fetch;
  const originalAccountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const originalApiToken = process.env.CLOUDFLARE_API_TOKEN;
  const originalAnalysis = process.env.STORM_LOGO_AI_ANALYSIS;
  const originalModel = process.env.STORM_LOGO_AI_MODEL;
  let request;
  process.env.CLOUDFLARE_ACCOUNT_ID = "test-account";
  process.env.CLOUDFLARE_API_TOKEN = "logo-analysis-test-token";
  process.env.STORM_LOGO_AI_MODEL =
    "@cf/meta/llama-3.2-11b-vision-instruct";
  process.env.STORM_LOGO_AI_ANALYSIS = "1";
  global.fetch = async (url, options) => {
    request = { url, options, body: JSON.parse(options.body) };
    return {
      ok: true,
      status: 200,
      json: async () => ({
        result: {
          response: JSON.stringify({
            centerX: 0.5,
            centerY: 0.18,
            style: "hair_accessory",
            confidence: 0.95,
          }),
        },
        success: true,
        errors: [],
        messages: [],
      }),
    };
  };
  try {
    const reference = {
      buffer: createImage(600, 400, [24, 64, 96]),
      contentType: "image/png",
    };
    const placement = await stormLogo._internal.getLogoPlacement(reference);
    assert.equal(placement.style, "hair_accessory");
    assert.equal(
      request.url,
      "https://api.cloudflare.com/client/v4/accounts/test-account/ai/run/@cf/meta/llama-3.2-11b-vision-instruct",
    );
    assert.equal(
      request.options.headers.Authorization,
      "Bearer logo-analysis-test-token",
    );
    const userContent = request.body.messages[0].content;
    assert.ok(
      userContent[0].image_url.url.startsWith("data:image/jpeg;base64,"),
    );
    assert.equal(userContent[1].text.includes("must not be resized"), true);
    assert.equal(
      stormLogo._internal.logoPosition(placement).logoSize,
      Math.round(1024 * 0.19),
    );
    const image = PNG.sync.read(
      stormLogo._internal.composeWithLogo(reference, placement),
    );
    assert.equal(image.width, 1024);
    assert.equal(image.height, 1024);
  } finally {
    global.fetch = originalFetch;
    if (originalAccountId === undefined)
      delete process.env.CLOUDFLARE_ACCOUNT_ID;
    else process.env.CLOUDFLARE_ACCOUNT_ID = originalAccountId;
    if (originalApiToken === undefined)
      delete process.env.CLOUDFLARE_API_TOKEN;
    else process.env.CLOUDFLARE_API_TOKEN = originalApiToken;
    if (originalModel === undefined) delete process.env.STORM_LOGO_AI_MODEL;
    else process.env.STORM_LOGO_AI_MODEL = originalModel;
    if (originalAnalysis === undefined)
      delete process.env.STORM_LOGO_AI_ANALYSIS;
    else process.env.STORM_LOGO_AI_ANALYSIS = originalAnalysis;
  }
});

test("logo analysis makes no external request unless explicitly enabled", async () => {
  const originalFetch = global.fetch;
  const originalAnalysis = process.env.STORM_LOGO_AI_ANALYSIS;
  let requests = 0;
  process.env.STORM_LOGO_AI_ANALYSIS = "0";
  global.fetch = async () => {
    requests += 1;
    throw new Error("unexpected request");
  };
  try {
    const placement = await stormLogo._internal.getLogoPlacement({
      buffer: createImage(200, 200, [24, 64, 96]),
      contentType: "image/png",
    });
    assert.equal(placement, null);
    assert.equal(requests, 0);
  } finally {
    global.fetch = originalFetch;
    if (originalAnalysis === undefined)
      delete process.env.STORM_LOGO_AI_ANALYSIS;
    else process.env.STORM_LOGO_AI_ANALYSIS = originalAnalysis;
  }
});

test("unsafe AI placement coordinates are rejected", () => {
  assert.throws(
    () =>
      stormLogo._internal.normalizePlacement({
        centerX: 0.99,
        centerY: 0.5,
        style: "clear_area",
        confidence: 0.9,
      }),
    /منطقة القص الآمنة/,
  );
});

test("failed opt-in analysis uses the default position and reports the fallback", async () => {
  const originalGetReplyImage = designAssistant.getReplyImage;
  const originalSendGroupImage = msg.sendGroupImageBufferTracked;
  const originalSendGroup = msg.sendGroup;
  const originalError = console.error;
  const originalAccountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const originalApiToken = process.env.CLOUDFLARE_API_TOKEN;
  const originalAnalysis = process.env.STORM_LOGO_AI_ANALYSIS;
  let sent;
  delete process.env.CLOUDFLARE_ACCOUNT_ID;
  delete process.env.CLOUDFLARE_API_TOKEN;
  process.env.STORM_LOGO_AI_ANALYSIS = "1";
  designAssistant.getReplyImage = async () => ({
    buffer: createImage(200, 200, [24, 64, 96]),
    contentType: "image/png",
  });
  msg.sendGroupImageBufferTracked = async (_threadId, buffer, _type, caption) => {
    sent = { buffer, caption };
    return "sent-image";
  };
  msg.sendGroup = async () => {};
  console.error = () => {};
  try {
    await stormLogo.handle({
      isGroup: true,
      threadId: "storm-logo-thread",
      userId: "test-user",
      messageReply: { attachments: [{ type: "photo" }] },
    });
    assert.match(sent.caption, /استُخدم موضع الشعار الافتراضي/);
    assert.equal(PNG.sync.read(sent.buffer).width, 1024);
  } finally {
    designAssistant.getReplyImage = originalGetReplyImage;
    msg.sendGroupImageBufferTracked = originalSendGroupImage;
    msg.sendGroup = originalSendGroup;
    console.error = originalError;
    if (originalAccountId === undefined)
      delete process.env.CLOUDFLARE_ACCOUNT_ID;
    else process.env.CLOUDFLARE_ACCOUNT_ID = originalAccountId;
    if (originalApiToken === undefined)
      delete process.env.CLOUDFLARE_API_TOKEN;
    else process.env.CLOUDFLARE_API_TOKEN = originalApiToken;
    if (originalAnalysis === undefined)
      delete process.env.STORM_LOGO_AI_ANALYSIS;
    else process.env.STORM_LOGO_AI_ANALYSIS = originalAnalysis;
  }
});
