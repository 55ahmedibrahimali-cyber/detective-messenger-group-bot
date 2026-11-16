"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const sharp = require("sharp");
const { PNG } = require("pngjs");
const designAssistant = require("./designAssistant");
const cloudflareDesign = require("./cloudflareDesign");
const aiHordeImage = require("./aiHordeImage");

const png = createPng(2, 2);

function createPng(width, height) {
  const image = new PNG({ width, height });
  image.data.fill(255);
  return PNG.sync.write(image);
}

function configureCloudflare() {
  const previous = {
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
    apiToken: process.env.CLOUDFLARE_API_TOKEN,
  };
  process.env.CLOUDFLARE_ACCOUNT_ID = "test-account";
  process.env.CLOUDFLARE_API_TOKEN = "design-test-token";
  return () => {
    if (previous.accountId === undefined)
      delete process.env.CLOUDFLARE_ACCOUNT_ID;
    else process.env.CLOUDFLARE_ACCOUNT_ID = previous.accountId;
    if (previous.apiToken === undefined)
      delete process.env.CLOUDFLARE_API_TOKEN;
    else process.env.CLOUDFLARE_API_TOKEN = previous.apiToken;
  };
}

function context(text, extra = {}) {
  return {
    threadId: `design-${Date.now()}-${Math.random()}`,
    userId: "design-user",
    isGroup: true,
    text,
    ...extra,
  };
}

function messaging(sent) {
  return {
    sendText: async (_threadId, text) => sent.push({ type: "text", text }),
    sendImage: async (_threadId, buffer, contentType, caption) => {
      sent.push({ type: "image", buffer, contentType, caption });
      return true;
    },
  };
}

test("design commands select templates and parse prompted edits", () => {
  const parsed = designAssistant._internal.parseCommand(
    "/تصميم قالب بوستر بنفسجي لعبة تحقيق",
  );
  assert.equal(parsed.action, "template");
  assert.equal(parsed.template.id, "purple-poster");
  assert.equal(parsed.input, "لعبة تحقيق");
  assert.equal(
    designAssistant._internal.parseCommand("تصميم بطاقة شخصية بطلة فضائية")
      .template.id,
    "character-card",
  );
  assert.equal(
    designAssistant._internal.parseCommand("تصميم تعديل غيّر الخلفية").action,
    "edit",
  );
  assert.equal(
    designAssistant._internal.parseCommand(
      "تصميم منشور افتتاح مقهى جديد",
    ).action,
    "facebookPost",
  );
  assert.equal(
    designAssistant._internal.parseCommand(
      "تصميم قالب فيسبوك افتتاح مقهى جديد",
    ).template.id,
    "facebook-post",
  );
  assert.equal(
    designAssistant._internal.parseCommand(
      "توليد هوية بصرية أصلية لمقهى",
    ).action,
    "generate",
  );
  assert.equal(
    designAssistant._internal.parseCommand(
      "قالب فيسبوك افتتاح مقهى جديد",
    ).template.id,
    "facebook-post",
  );
  assert.equal(
    designAssistant._internal.parseCommand("تعديل غيّر الخلفية").action,
    "edit",
  );
});

test("standalone design help is separate from general help", async () => {
  const sent = [];
  assert.equal(
    await designAssistant.tryHandle(context("مساعدة"), messaging(sent)),
    false,
  );
  assert.equal(
    await designAssistant.tryHandle(
      context("مساعدة التصميم"),
      messaging(sent),
    ),
    true,
  );
  assert.equal(
    await designAssistant.tryHandle(
      context("مساعدة_التصميم"),
      messaging(sent),
    ),
    true,
  );
  assert.match(sent.at(-1).text, /منشور <الموضوع>/);
  assert.match(sent.at(-1).text, /تعديل <التغيير>/);
});

test("ordinary messages starting with template aliases do not trigger designs", async () => {
  const sent = [];
  assert.equal(
    await designAssistant.tryHandle(
      context("لعبة تحقيق جديدة الليلة"),
      messaging(sent),
    ),
    false,
  );
  assert.equal(
    await designAssistant.tryHandle(
      context("بوستر اللعبة الجديد"),
      messaging(sent),
    ),
    false,
  );
  assert.deepEqual(sent, []);
});

test("the storm logo command is left for its dedicated handler", async () => {
  const sent = [];
  assert.equal(
    await designAssistant.tryHandle(
      context("شعار أسفل المنتصف", {
        messageReply: {
          attachments: [
            { type: "image", url: "https://fbcdn.net/image.jpg" },
          ],
        },
      }),
      messaging(sent),
    ),
    false,
  );
  assert.equal(
    designAssistant._internal.templates.some(
      (template) => template.id === "logo",
    ),
    false,
  );
  assert.doesNotMatch(designAssistant._internal.templatesText(), /شعار/);
});

test("design suggestions use Cloudflare chat completions", async () => {
  const originalFetch = global.fetch;
  const restoreEnv = configureCloudflare();
  const sent = [];
  let request;
  global.fetch = async (url, options) => {
    request = { url, options, body: JSON.parse(options.body) };
    return {
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "اقتراح بصري تجريبي" } }],
      }),
    };
  };
  try {
    await designAssistant.tryHandle(
      context("تصميم اقتراح بوستر لعبة تحقيق بالبنفسجي"),
      messaging(sent),
    );
    await designAssistant._internal.waitForIdle();
    assert.equal(sent.at(-1).text, "اقتراح بصري تجريبي");
    assert.match(request.url, /\/ai\/v1\/chat\/completions$/);
    assert.equal(
      request.options.headers.Authorization,
      "Bearer design-test-token",
    );
    assert.match(request.body.messages[1].content, /بوستر لعبة تحقيق/);
  } finally {
    global.fetch = originalFetch;
    restoreEnv();
  }
});

test("design text requests use the configured Cloudflare fallback model", async () => {
  const originalFetch = global.fetch;
  const restoreEnv = configureCloudflare();
  const previousModel = process.env.CLOUDFLARE_AI_MODEL;
  const previousFallback = process.env.CLOUDFLARE_AI_FALLBACK_MODEL;
  const requestedModels = [];
  process.env.CLOUDFLARE_AI_MODEL = "@cf/test/primary";
  process.env.CLOUDFLARE_AI_FALLBACK_MODEL = "@cf/test/fallback";
  global.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    requestedModels.push(body.model);
    if (body.model === "@cf/test/primary") {
      return {
        ok: false,
        status: 404,
        json: async () => ({ errors: [{ message: "model unavailable" }] }),
      };
    }
    return {
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "اقتراح من النموذج الاحتياطي" } }],
      }),
    };
  };
  try {
    const result = await designAssistant._internal.generateText("اقترح تصميماً");
    assert.equal(result, "اقتراح من النموذج الاحتياطي");
    assert.deepEqual(requestedModels, ["@cf/test/primary", "@cf/test/fallback"]);
  } finally {
    global.fetch = originalFetch;
    restoreEnv();
    if (previousModel === undefined) delete process.env.CLOUDFLARE_AI_MODEL;
    else process.env.CLOUDFLARE_AI_MODEL = previousModel;
    if (previousFallback === undefined)
      delete process.env.CLOUDFLARE_AI_FALLBACK_MODEL;
    else process.env.CLOUDFLARE_AI_FALLBACK_MODEL = previousFallback;
  }
});

test("slow design requests return control after sending an immediate acknowledgement", async () => {
  const originalFetch = global.fetch;
  const restoreEnv = configureCloudflare();
  const sent = [];
  let resolveResponse;
  global.fetch = () =>
    new Promise((resolve) => {
      resolveResponse = resolve;
    });
  try {
    await designAssistant.tryHandle(
      context("تصميم اقتراح بوستر لعبة"),
      messaging(sent),
    );
    assert.match(sent[0].text, /استلمت طلب التصميم/);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(typeof resolveResponse, "function");
    resolveResponse({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "اكتمل الاقتراح" } }],
      }),
    });
    await designAssistant._internal.waitForIdle();
    assert.equal(sent.at(-1).text, "اكتمل الاقتراح");
  } finally {
    global.fetch = originalFetch;
    restoreEnv();
  }
});

test("design improvement sends the reference image to Cloudflare vision", async () => {
  const originalFetch = global.fetch;
  const restoreEnv = configureCloudflare();
  const sent = [];
  let request;
  global.fetch = async (_url, options) => {
    request = JSON.parse(options.body);
    return {
      ok: true,
      json: async () => ({ result: { response: "وصف محسّن" } }),
    };
  };
  try {
    await designAssistant.tryHandle(
      context("تصميم تحسين اجعل العنوان أوضح", {
        designReference: { buffer: png, contentType: "image/png" },
      }),
      messaging(sent),
    );
    await designAssistant._internal.waitForIdle();
    assert.equal(sent.at(-1).text, "وصف محسّن");
    assert.match(request.messages[0].content[0].image_url.url, /^data:image\/png;base64,/);
    assert.equal(
      Buffer.from(
        request.messages[0].content[0].image_url.url.split(",")[1],
        "base64",
      ).toString("base64"),
      png.toString("base64"),
    );
  } finally {
    global.fetch = originalFetch;
    restoreEnv();
  }
});

test("design generation applies a template and passes a reference image", async () => {
  const originalGenerateImage = cloudflareDesign.generateImage;
  const restoreEnv = configureCloudflare();
  const sent = [];
  let generatedPrompt;
  let receivedReference;
  cloudflareDesign.generateImage = async (prompt, reference) => {
    generatedPrompt = prompt;
    receivedReference = reference;
    return {
      buffer: png,
      contentType: "image/png",
      model: "test-image-model",
    };
  };
  try {
    await designAssistant.tryHandle(
      context("/تصميم قالب بوستر بنفسجي لعبة تحقيق", {
        designReference: { buffer: png, contentType: "image/png" },
      }),
      messaging(sent),
    );
    await designAssistant._internal.waitForIdle();
    assert.equal(sent.at(-1).type, "image");
    assert.equal(receivedReference.contentType, "image/png");
    assert.match(generatedPrompt, /electric violet light/);
    assert.match(generatedPrompt, /لعبة تحقيق/);
    assert.match(generatedPrompt, /completely new original design/);
  } finally {
    cloudflareDesign.generateImage = originalGenerateImage;
    restoreEnv();
  }
});

test("image generation falls back to AI Horde when Cloudflare is rate limited", async () => {
  const originalGenerateImage = cloudflareDesign.generateImage;
  const originalHordeGenerateImage = aiHordeImage.generateImage;
  const originalWarn = console.warn;
  const restoreEnv = configureCloudflare();
  const sent = [];
  const webp = await sharp(png).webp().toBuffer();
  let fallbackCalls = 0;
  cloudflareDesign.generateImage = async () => {
    throw Object.assign(new Error("daily quota exceeded"), { status: 429 });
  };
  aiHordeImage.generateImage = async () => {
    fallbackCalls++;
    return {
      buffer: webp,
      contentType: "image/webp",
      model: "AI Horde — test-model",
    };
  };
  console.warn = () => {};
  try {
    await designAssistant.tryHandle(
      context("توليد بوستر خيالي"),
      messaging(sent),
    );
    await designAssistant._internal.waitForIdle();
    assert.equal(fallbackCalls, 1);
    assert.equal(sent.at(-1).type, "image");
    assert.equal(sent.at(-1).contentType, "image/webp");
    assert.match(sent.at(-1).caption, /AI Horde — test-model/);
  } finally {
    cloudflareDesign.generateImage = originalGenerateImage;
    aiHordeImage.generateImage = originalHordeGenerateImage;
    console.warn = originalWarn;
    restoreEnv();
  }
});

test("image generation does not use AI Horde for Cloudflare authorization errors", async () => {
  const originalGenerateImage = cloudflareDesign.generateImage;
  const originalHordeGenerateImage = aiHordeImage.generateImage;
  const restoreEnv = configureCloudflare();
  const sent = [];
  let fallbackCalls = 0;
  cloudflareDesign.generateImage = async () => {
    throw Object.assign(new Error("invalid credentials"), { status: 403 });
  };
  aiHordeImage.generateImage = async () => {
    fallbackCalls++;
    throw new Error("unexpected fallback");
  };
  try {
    await designAssistant.tryHandle(
      context("توليد بوستر خيالي"),
      messaging(sent),
    );
    await designAssistant._internal.waitForIdle();
    assert.equal(fallbackCalls, 0);
    assert.match(sent.at(-1).text, /invalid credentials/);
  } finally {
    cloudflareDesign.generateImage = originalGenerateImage;
    aiHordeImage.generateImage = originalHordeGenerateImage;
    restoreEnv();
  }
});

test("Facebook post requests return copy and create new reference-inspired artwork", async () => {
  const originalGenerateText = cloudflareDesign.generateText;
  const originalGenerateImage = cloudflareDesign.generateImage;
  const restoreEnv = configureCloudflare();
  const sent = [];
  let textReference;
  let imageRequest;
  cloudflareDesign.generateText = async (_prompt, reference) => {
    textReference = reference;
    return "افتتاحنا قريباً! تابعونا لمعرفة التفاصيل.";
  };
  cloudflareDesign.generateImage = async (prompt, reference) => {
    imageRequest = { prompt, reference };
    return {
      buffer: png,
      contentType: "image/png",
      model: "test-image-model",
    };
  };
  try {
    await designAssistant.tryHandle(
      context("منشور افتتاح مقهى جديد بألوان دافئة", {
        designReference: { buffer: png, contentType: "image/png" },
      }),
      messaging(sent),
    );
    await designAssistant._internal.waitForIdle();
    assert.equal(textReference.buffer, png);
    assert.equal(imageRequest.reference.buffer, png);
    assert.match(imageRequest.prompt, /square 1:1 Facebook post artwork/);
    assert.match(imageRequest.prompt, /new original image and composition/);
    assert.equal(
      sent.find((item) => item.type === "text" && item.text.includes("افتتاحنا"))
        .text,
      "📝 نص منشور فيسبوك مقترح:\nافتتاحنا قريباً! تابعونا لمعرفة التفاصيل.",
    );
    assert.equal(sent.at(-1).type, "image");
  } finally {
    cloudflareDesign.generateText = originalGenerateText;
    cloudflareDesign.generateImage = originalGenerateImage;
    restoreEnv();
  }
});

test("the old nested quality syntax points users to the standalone command", async () => {
  const sent = [];
  assert.equal(
    await designAssistant.tryHandle(
      context("/تصميم جودة", {
        designReference: { buffer: png, contentType: "image/png" },
      }),
      messaging(sent),
    ),
    true,
  );
  assert.match(sent.at(-1).text, /اكتب «جودة»/);
});

test("prompted design edits use the replied image", async () => {
  const originalGenerateImage = cloudflareDesign.generateImage;
  const restoreEnv = configureCloudflare();
  const sent = [];
  const prompts = [];
  cloudflareDesign.generateImage = async (prompt, reference) => {
    prompts.push({ prompt, reference });
    return { buffer: png, contentType: "image/png", model: "test-model" };
  };
  try {
    await designAssistant.tryHandle(
      context("تعديل غيّر الخلفية إلى سماء ليلية", {
        designReference: { buffer: png, contentType: "image/png" },
      }),
      messaging(sent),
    );
    await designAssistant._internal.waitForIdle();
    assert.equal(prompts.length, 1);
    assert.match(prompts[0].prompt, /سماء ليلية/);
    assert.equal(prompts[0].reference.buffer, png);
    assert.equal(sent.filter((item) => item.type === "image").length, 1);
  } finally {
    cloudflareDesign.generateImage = originalGenerateImage;
    restoreEnv();
  }
});

test("design reference downloads reject untrusted hosts", async () => {
  await assert.rejects(
    designAssistant._internal.getReference({
      attachments: [
        { type: "image", url: "http://127.0.0.1/private-image" },
      ],
    }),
    /رابط الصورة المرجعية غير مدعوم/,
  );
});
