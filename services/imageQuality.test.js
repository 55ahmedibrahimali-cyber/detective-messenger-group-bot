"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs/promises");
const path = require("node:path");
const { PassThrough } = require("node:stream");
const designAssistant = require("./designAssistant");
const imageQuality = require("./imageQuality");
const msg = require("./messenger");

test("quality command requires a replied image", async () => {
  const originalSendGroup = msg.sendGroup;
  let sent;
  msg.sendGroup = async (_threadId, text) => {
    sent = text;
  };
  try {
    await imageQuality.handle({
      isGroup: true,
      threadId: "quality-no-image",
      userId: "quality-user",
      messageReply: null,
    });
    assert.match(sent, /ردّ على الصورة/);
  } finally {
    msg.sendGroup = originalSendGroup;
  }
});

test("quality command runs Upscayl on the replied image and sends the result", async () => {
  const originalGetReplyImage = designAssistant.getReplyImage;
  const originalRunUpscayl = imageQuality._internal.runUpscayl;
  const originalSendGroup = msg.sendGroup;
  const originalSendGroupImage = msg.sendGroupImageBufferTracked;
  const reference = { buffer: Buffer.from("source"), contentType: "image/png" };
  const reply = { attachments: [{ type: "photo" }] };
  const texts = [];
  let receivedInput;
  let receivedModel;
  let sentImage;
  designAssistant.getReplyImage = async (messageReply) => {
    assert.equal(messageReply, reply);
    return reference;
  };
  imageQuality._internal.runUpscayl = async (inputPath, outputPath, model) => {
    assert.equal(path.extname(inputPath), ".png");
    receivedInput = await fs.readFile(inputPath);
    receivedModel = model;
    await fs.writeFile(
      outputPath,
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01]),
    );
  };
  msg.sendGroup = async (_threadId, text) => texts.push(text);
  msg.sendGroupImageBufferTracked = async (
    threadId,
    buffer,
    contentType,
    caption,
  ) => {
    sentImage = { threadId, buffer, contentType, caption };
    return "enhanced-image-id";
  };
  try {
    assert.equal(
      await imageQuality.handle({
        isGroup: true,
        threadId: "quality-thread",
        userId: "quality-user",
        messageReply: reply,
      }),
      true,
    );
    assert.match(texts[0], /جارٍ تحسينها بـUpscayl/);
    await imageQuality._internal.waitForIdle();
    assert.deepEqual(receivedInput, reference.buffer);
    assert.equal(path.basename(receivedModel), "realesrgan-x4plus");
    assert.equal(sentImage.threadId, "quality-thread");
    assert.equal(sentImage.contentType, "image/png");
    assert.match(sentImage.caption, /Upscayl \/ Real-ESRGAN 4×/);
  } finally {
    imageQuality._internal.reset();
    designAssistant.getReplyImage = originalGetReplyImage;
    imageQuality._internal.runUpscayl = originalRunUpscayl;
    msg.sendGroup = originalSendGroup;
    msg.sendGroupImageBufferTracked = originalSendGroupImage;
  }
});

test("quality command reports an unsupported Vulkan runtime", async () => {
  const originalGetReplyImage = designAssistant.getReplyImage;
  const originalRunUpscayl = imageQuality._internal.runUpscayl;
  const originalSendGroup = msg.sendGroup;
  const texts = [];
  designAssistant.getReplyImage = async () => ({
    buffer: Buffer.from("source"),
    contentType: "image/jpeg",
  });
  imageQuality._internal.runUpscayl = async () => {
    throw new Error("Vulkan device unavailable");
  };
  msg.sendGroup = async (_threadId, text) => texts.push(text);
  try {
    await imageQuality.handle({
      isGroup: true,
      threadId: "quality-vulkan-error",
      userId: "quality-user",
      messageReply: { attachments: [{ type: "photo" }] },
    });
    await imageQuality._internal.waitForIdle();
    assert.match(texts.at(-1), /Vulkan/);
    assert.match(texts.at(-1), /Vulkan device unavailable/);
  } finally {
    imageQuality._internal.reset();
    designAssistant.getReplyImage = originalGetReplyImage;
    imageQuality._internal.runUpscayl = originalRunUpscayl;
    msg.sendGroup = originalSendGroup;
  }
});

test("Upscayl runner stops a timed-out process", async () => {
  const processRunner = imageQuality._internal.processRunner;
  const originalSpawn = processRunner.spawn;
  processRunner.spawn = () => {
    const child = new EventEmitter();
    child.stderr = new PassThrough();
    child.kill = () => {
      child.emit("close", null, "SIGKILL");
      return true;
    };
    return child;
  };
  try {
    await assert.rejects(
      imageQuality._internal.runUpscayl(
        "input.png",
        "output.png",
        "C:\\models\\realesrgan-x4plus",
        1,
      ),
      /تجاوز Upscayl مهلة التنفيذ/,
    );
  } finally {
    processRunner.spawn = originalSpawn;
  }
});
