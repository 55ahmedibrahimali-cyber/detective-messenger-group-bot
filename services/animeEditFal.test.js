"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const animeEdit = require("./animeEditFal");

const referenceBuffer = Buffer.alloc(24);
Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(referenceBuffer);
const reference = { buffer: referenceBuffer, contentType: "image/png" };
const mp4 = Buffer.alloc(16);
mp4.write("ftyp", 4, "ascii");

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
    userId: `user-${Math.random()}`,
    threadId: `thread-${Math.random()}`,
    isGroup: true,
    text,
    designReference: reference,
    ...overrides,
  };
}

test("recognizes the standalone Arabic edit command only", () => {
  assert.equal(animeEdit.isCommand("ايديت"), true);
  assert.equal(animeEdit.isCommand("/إيديت"), true);
  assert.equal(animeEdit.isCommand("edit"), true);
  assert.equal(animeEdit.isCommand("فيديو"), false);
  assert.equal(animeEdit.isCommand("/video"), false);
  assert.equal(animeEdit.isCommand("تصميم ايديت"), false);
  assert.equal(animeEdit.isCommand("ايديت الآن"), false);
  assert.equal(animeEdit.isCommand("فيديو الآن"), false);
});

test("requires Fal credentials and a replied-to image", async () => {
  animeEdit._internal.reset();
  const restoreEnv = configureEnv({ FAL_KEY: null });
  const texts = [];
  try {
    await animeEdit.tryHandle(context("ايديت"), {
      sendText: async (_threadId, text) => texts.push(text),
      sendVideo: async () => assert.fail("video must not be sent"),
    });
    assert.match(texts[0], /FAL_KEY/);
  } finally {
    restoreEnv();
    animeEdit._internal.reset();
  }

  const restoreKey = configureEnv({ FAL_KEY: "test-key" });
  const noImageTexts = [];
  try {
    await animeEdit.tryHandle(
      context("ايديت", {
        designReference: null,
        messageReply: { body: "no image" },
      }),
      {
        sendText: async (_threadId, text) => noImageTexts.push(text),
        sendVideo: async () => assert.fail("video must not be sent"),
      },
    );
    assert.match(noImageTexts[0], /ردّ على صورة/);
  } finally {
    restoreKey();
    animeEdit._internal.reset();
  }
});

test("animates the replied image and sends the generated MP4", async () => {
  animeEdit._internal.reset();
  const restoreEnv = configureEnv({ FAL_KEY: "test-key" });
  const texts = [];
  const videos = [];
  let receivedReference;
  try {
    assert.equal(
      await animeEdit.tryHandle(context("ايديت"), {
        sendText: async (_threadId, text) => texts.push(text),
        getReference: async () => reference,
        generateVideo: async (image) => {
          receivedReference = image;
          return { buffer: mp4, contentType: "video/mp4" };
        },
        sendVideo: async (_threadId, buffer, contentType, caption, isGroup) => {
          videos.push({ buffer, contentType, caption, isGroup });
          return true;
        },
      }),
      true,
    );
    await animeEdit.idle();
    assert.equal(receivedReference, reference);
    assert.equal(videos.length, 1);
    assert.equal(videos[0].buffer, mp4);
    assert.equal(videos[0].contentType, "video/mp4");
    assert.equal(videos[0].isGroup, true);
    assert.match(videos[0].caption, /AMV/);
    assert.match(texts[0], /بضع دقائق/);
  } finally {
    restoreEnv();
    animeEdit._internal.reset();
  }
});

test("downloads the Messenger reply image before calling the video model", async () => {
  animeEdit._internal.reset();
  const restoreEnv = configureEnv({ FAL_KEY: "test-key" });
  const originalFetch = global.fetch;
  const source = context("ايديت", {
    designReference: null,
    messageReply: {
      attachments: [
        { type: "photo", url: "https://cdn.fbcdn.net/replied-image.png" },
      ],
    },
  });
  let receivedReference;
  global.fetch = async () =>
    new Response(referenceBuffer, {
      headers: { "content-type": "image/png" },
    });
  try {
    await animeEdit.tryHandle(source, {
      sendText: async () => true,
      generateVideo: async (image) => {
        receivedReference = image;
        return { buffer: mp4, contentType: "video/mp4" };
      },
      sendVideo: async () => true,
    });
    await animeEdit.idle();
    assert.deepEqual(receivedReference, reference);
  } finally {
    global.fetch = originalFetch;
    restoreEnv();
    animeEdit._internal.reset();
  }
});

test("video transport adapter preserves caption and private/group routing", async () => {
  const calls = [];
  const deps = animeEdit.createDeps({
    sendGroupVideoBufferTracked: async (...args) => {
      calls.push({ type: "group", args });
      return "group-message";
    },
    sendPrivateVideoBufferWithResult: async (...args) => {
      calls.push({ type: "private", args });
      return { ok: true };
    },
  });
  assert.equal(
    await deps.sendVideo("group-1", mp4, "video/mp4", "caption", true),
    true,
  );
  assert.equal(
    await deps.sendVideo("user-1", mp4, "video/mp4", "private caption", false),
    true,
  );
  assert.deepEqual(calls, [
    {
      type: "group",
      args: ["group-1", mp4, "video/mp4", "caption"],
    },
    {
      type: "private",
      args: ["user-1", mp4, "video/mp4", "private caption"],
    },
  ]);
});

test("Fal request uploads the image and keeps safety checks enabled", async () => {
  const requests = [];
  const fal = {
    storage: {
      upload: async (file) => {
        requests.push({ type: "upload", file });
        return "https://fal.media/reference.png";
      },
    },
    subscribe: async (model, options) => {
      requests.push({ type: "generate", model, options });
      return { data: { video: { url: "https://fal.media/result.mp4" } } };
    },
  };
  const url = await animeEdit._internal.createVideo(reference, fal);
  assert.equal(url, "https://fal.media/result.mp4");
  assert.equal(requests[0].file.type, "image/png");
  assert.equal(requests[1].model, animeEdit._internal.defaultModel);
  assert.equal(requests[1].options.input.image_url, "https://fal.media/reference.png");
  assert.equal(requests[1].options.input.duration, "5");
  assert.equal(requests[1].options.input.enable_safety_checker, true);
  assert.match(requests[1].options.input.prompt, /do not imitate any specific creator/i);
});

test("Fal 403 errors identify whether image upload or model execution was denied", async () => {
  const restoreEnv = configureEnv({ FAL_KEY: "test-secret-key" });
  try {
    const uploadFailure = Object.assign(new Error("Forbidden test-secret-key"), {
      status: 403,
      requestId: "upload-request",
    });
    await assert.rejects(
      animeEdit._internal.createVideo(reference, {
        storage: {
          upload: async () => {
            throw new Error("multipart upload failed", { cause: uploadFailure });
          },
        },
        subscribe: async () => assert.fail("model must not run after upload fails"),
      }),
      error => {
        assert.match(error.message, /رفض Fal\.ai رفع الصورة \(HTTP 403\)/);
        assert.match(error.message, /لم يصل الطلب إلى نموذج الفيديو/);
        assert.match(error.message, /Forbidden/);
        assert.doesNotMatch(error.message, /test-secret-key/);
        assert.equal(error.requestId, "upload-request");
        return true;
      },
    );

    const modelFailure = Object.assign(new Error("Forbidden"), {
      status: 403,
      requestId: "model-request",
    });
    await assert.rejects(
      animeEdit._internal.createVideo(reference, {
        storage: { upload: async () => "https://fal.media/reference.png" },
        subscribe: async () => { throw modelFailure; },
      }),
      error => {
        assert.match(error.message, /رفض Fal\.ai تشغيل نموذج الفيديو \(HTTP 403\)/);
        assert.match(error.message, /إمكانية الوصول إلى نموذج الفيديو/);
        assert.equal(error.requestId, "model-request");
        return true;
      },
    );
  } finally {
    restoreEnv();
  }
});

test("download validates Fal video hosts, MP4 content, and size", async () => {
  assert.equal(
    animeEdit._internal.allowedVideoUrl("https://fal.media/video.mp4").hostname,
    "fal.media",
  );
  assert.equal(
    animeEdit._internal.allowedVideoUrl("https://evil.example/video.mp4"),
    null,
  );
  assert.equal(animeEdit._internal.isMp4(mp4), true);

  const originalFetch = global.fetch;
  global.fetch = async () =>
    new Response(mp4, { headers: { "content-type": "video/mp4" } });
  try {
    const result = await animeEdit._internal.downloadVideo(
      "https://v3.fal.media/video.mp4",
    );
    assert.equal(result.contentType, "video/mp4");
    assert.deepEqual(result.buffer, mp4);
  } finally {
    global.fetch = originalFetch;
  }
});
