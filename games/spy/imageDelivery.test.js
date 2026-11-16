const test = require("node:test");
const assert = require("node:assert/strict");
const engine = require("./engine");
const messenger = require("../../services/messenger");
const imageHost = require("../../services/imageHost");

test("both spy image routes keep the hosted link when E2EE attachment fails", async () => {
  const originalMode = process.env.SPY_IMAGE_DELIVERY;
  const originalLinkSender = messenger.sendPrivateWithResult;
  const originalImageSender = messenger.sendPrivateImageBufferWithResult;
  const originalGetUrl = imageHost.getUrl;
  let linkSent = false;
  let attachmentAttempted = false;

  process.env.SPY_IMAGE_DELIVERY = "both";
  messenger.sendPrivateWithResult = async () => {
    linkSent = true;
    return { ok: true, messageId: "hosted-link" };
  };
  messenger.sendPrivateImageBufferWithResult = async () => {
    attachmentAttempted = true;
    return { ok: false, reason: "E2EE attachment failed" };
  };
  imageHost.getUrl = async () => "https://litter.catbox.moe/test-image.jpg";

  try {
    assert.equal(engine.deliveryMode(), "both");
    const result = await engine.deliverRoundImage({
      userId: "player",
      imageKey: "pixabay-test",
      image: { buffer: Buffer.from("sample"), contentType: "image/jpeg" },
      caption: "Spy image test",
      fallbackText: "Image unavailable",
      label: "test",
      requireImage: true,
    });

    assert.equal(linkSent, true);
    assert.equal(attachmentAttempted, true);
    assert.equal(result.ok, true);
    assert.equal(result.delivery, "link");
    assert.equal(result.messageId, "hosted-link");
  } finally {
    messenger.sendPrivateWithResult = originalLinkSender;
    messenger.sendPrivateImageBufferWithResult = originalImageSender;
    imageHost.getUrl = originalGetUrl;
    if (originalMode === undefined) delete process.env.SPY_IMAGE_DELIVERY;
    else process.env.SPY_IMAGE_DELIVERY = originalMode;
  }
});

test("both spy image routes report success when the link and direct attachment work", async () => {
  const originalMode = process.env.SPY_IMAGE_DELIVERY;
  const originalLinkSender = messenger.sendPrivateWithResult;
  const originalImageSender = messenger.sendPrivateImageBufferWithResult;
  const originalGetUrl = imageHost.getUrl;

  process.env.SPY_IMAGE_DELIVERY = "both";
  messenger.sendPrivateWithResult = async () => ({
    ok: true,
    messageId: "hosted-link",
  });
  messenger.sendPrivateImageBufferWithResult = async () => ({
    ok: true,
    messageId: "encrypted-attachment",
  });
  imageHost.getUrl = async () => "https://litter.catbox.moe/test-image.jpg";

  try {
    const result = await engine.deliverRoundImage({
      userId: "player",
      imageKey: "pixabay-test",
      image: { buffer: Buffer.from("sample"), contentType: "image/jpeg" },
      caption: "Spy image test",
      fallbackText: "Image unavailable",
      label: "test",
      requireImage: true,
    });

    assert.equal(result.ok, true);
    assert.equal(result.delivery, "both");
    assert.equal(result.messageId, "encrypted-attachment");
  } finally {
    messenger.sendPrivateWithResult = originalLinkSender;
    messenger.sendPrivateImageBufferWithResult = originalImageSender;
    imageHost.getUrl = originalGetUrl;
    if (originalMode === undefined) delete process.env.SPY_IMAGE_DELIVERY;
    else process.env.SPY_IMAGE_DELIVERY = originalMode;
  }
});
