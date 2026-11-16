"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const imageToVideo = require("./imageToVideo");

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

test("يتعرف فقط على صيغ أمر الفيديو", () => {
  assert.equal(imageToVideo.isCommand("فيديو"), true);
  assert.equal(imageToVideo.isCommand("/فيديو"), true);
  assert.equal(imageToVideo.isCommand("حرك"), true);
  assert.equal(imageToVideo.isCommand("حرك الصورة"), true);
  assert.equal(imageToVideo.isCommand("video"), true);
  assert.equal(imageToVideo.isCommand("animate"), true);
  assert.equal(imageToVideo.isCommand("تصميم فيديو"), false);
  assert.equal(imageToVideo.isCommand("فيديو الآن"), false);
});

test("يستخرج رابط ملف الفيديو من مخرجات Gradio", () => {
  const { extractVideoUrl } = imageToVideo._internal;
  assert.equal(
    extractVideoUrl({ url: "/gradio_api/file=tmp/video.mp4" }),
    "/gradio_api/file=tmp/video.mp4",
  );
  assert.equal(
    extractVideoUrl([{ path: "/file=tmp/video.mp4" }, 123]),
    "/file=tmp/video.mp4",
  );
  assert.equal(extractVideoUrl({ data: [{ video: "/file=video.mp4" }] }), "/file=video.mp4");
  assert.equal(extractVideoUrl(null), null);
});

test("لا يقبل سوى روابط الفيديو على Hugging Face Space المحدد", () => {
  const restoreEnv = configureEnv({
    HF_IMAGE_TO_VIDEO_SPACE_URL: "https://test-video-space.hf.space",
  });
  try {
    const { allowedVideoUrl } = imageToVideo._internal;
    assert.equal(
      allowedVideoUrl("/gradio_api/file=video.mp4").origin,
      "https://test-video-space.hf.space",
    );
    assert.equal(
      allowedVideoUrl("https://evil.example/video.mp4"),
      null,
    );
    assert.equal(
      allowedVideoUrl("https://other.hf.space/video.mp4"),
      null,
    );
    assert.equal(
      allowedVideoUrl("http://test-video-space.hf.space/video.mp4"),
      null,
    );
    assert.equal(allowedVideoUrl(null), null);
    assert.equal(allowedVideoUrl(""), null);
  } finally {
    restoreEnv();
  }
});

test("يتحقق من إعداد Space ويتصل بواجهة Gradio دون طلب رمز إلزامي", async () => {
  const restoreEnv = configureEnv({
    HF_TOKEN: null,
    HF_IMAGE_TO_VIDEO_SPACE_URL: "https://test-video-space.hf.space",
  });
  let received;
  try {
    const url = await imageToVideo._internal.createVideo(reference, async () => ({
      Client: {
        connect: async (spaceUrl, options) => {
          received = { spaceUrl, options };
          return {
            predict: async (apiName, inputs) => {
              received.apiName = apiName;
              received.inputs = inputs;
              return { data: [{ url: "/gradio_api/file=tmp/video.mp4" }, 123] };
            },
          };
        },
      },
      handle_file: (file) => ({ name: file.name, type: file.type, size: file.size }),
    }));

    assert.equal(url, "https://test-video-space.hf.space/gradio_api/file=tmp/video.mp4");
    assert.equal(received.spaceUrl, "https://test-video-space.hf.space");
    assert.equal(received.options, undefined);
    assert.equal(received.apiName, "/generate_video");
    assert.deepEqual(received.inputs[0], {
      name: "reference.png",
      type: "image/png",
      size: referenceBuffer.length,
    });
    assert.match(received.inputs[1], /Animate the supplied still image/);
    assert.equal(received.inputs[2], 4);
    assert.equal(received.inputs[4], 3.5);
    assert.equal(received.inputs[9], null);
    assert.equal(received.inputs.length, 10);
  } finally {
    restoreEnv();
  }
});

test("يرفض روابط Space غير الموثوقة", () => {
  const restoreEnv = configureEnv({
    HF_IMAGE_TO_VIDEO_SPACE_URL: "https://example.com",
  });
  try {
    assert.throws(
      () => imageToVideo._internal.getSpaceUrl(),
      /\.hf\.space/,
    );
  } finally {
    restoreEnv();
  }
});

test("ينزّل ملف MP4 من Space بعد التحقق من الصيغة والحجم", async () => {
  const restoreEnv = configureEnv({
    HF_TOKEN: null,
    HF_IMAGE_TO_VIDEO_SPACE_URL: "https://test-video-space.hf.space",
  });
  const originalFetch = global.fetch;
  let receivedUrl;
  global.fetch = async (url) => {
    receivedUrl = String(url);
    return new Response(mp4, {
      headers: { "content-type": "video/mp4" },
    });
  };
  try {
    const result = await imageToVideo._internal.downloadVideo(
      "/gradio_api/file=tmp/video.mp4",
    );
    assert.equal(receivedUrl, "https://test-video-space.hf.space/gradio_api/file=tmp/video.mp4");
    assert.deepEqual(result, { buffer: mp4, contentType: "video/mp4" });
  } finally {
    global.fetch = originalFetch;
    restoreEnv();
  }
});

test("يرد بطلب صورة إذا لم تكن هناك صورة مرفقة أو مجاب عليها", async () => {
  imageToVideo._internal.reset();
  const restoreEnv = configureEnv({ HF_TOKEN: null });
  const texts = [];
  try {
    await imageToVideo.tryHandle(
      context("فيديو", {
        designReference: null,
        messageReply: { body: "no image" },
      }),
      {
        sendText: async (_threadId, text) => texts.push(text),
        sendVideo: async () => assert.fail("video must not be sent"),
      },
    );
    assert.match(texts[0], /ردّ على صورة/);
  } finally {
    restoreEnv();
    imageToVideo._internal.reset();
  }
});

test("ينجح التحويل من صورة إلى فيديو عند توفر الخدمة", async () => {
  imageToVideo._internal.reset();
  const restoreEnv = configureEnv({ HF_TOKEN: null });
  const videos = [];
  try {
    await imageToVideo.tryHandle(context("حرك"), {
      sendText: async () => {},
      sendVideo: async (_threadId, buffer, contentType, caption) => {
        videos.push({ buffer, contentType, caption });
        return true;
      },
      getReference: async () => reference,
      generateVideo: async () => ({ buffer: mp4, contentType: "video/mp4" }),
    });
    await imageToVideo.idle();
    assert.equal(videos.length, 1);
    assert.equal(videos[0].contentType, "video/mp4");
  } finally {
    restoreEnv();
    imageToVideo._internal.reset();
  }
});

test("يمنع طلباً ثانياً من نفس المستخدم وهو مشغول", async () => {
  imageToVideo._internal.reset();
  const restoreEnv = configureEnv({ HF_TOKEN: null });
  const userId = "busy-user";
  let resolveGenerate;
  const texts = [];
  try {
    const deps = {
      sendText: async (_threadId, text) => texts.push(text),
      sendVideo: async () => true,
      getReference: async () => reference,
      generateVideo: () =>
        new Promise((resolve) => {
          resolveGenerate = () => resolve({ buffer: mp4, contentType: "video/mp4" });
        }),
    };
    const first = imageToVideo.tryHandle(
      context("فيديو", { userId }),
      deps,
    );
    await new Promise((resolve) => setImmediate(resolve));
    await imageToVideo.tryHandle(context("فيديو", { userId }), deps);
    assert.match(texts[texts.length - 1], /قيد التنفيذ/);
    resolveGenerate();
    await first;
    await imageToVideo.idle();
  } finally {
    restoreEnv();
    imageToVideo._internal.reset();
  }
});
