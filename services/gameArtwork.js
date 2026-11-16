const fs = require("node:fs/promises");
const path = require("node:path");
const messenger = require("./messenger");
const imageStore = require("./imageStore");
const geminiImage = require("./geminiImage");

const gamesRoot = path.join(__dirname, "..", "games");
const imagePromises = new Map();
const supportedExtensions = [".png", ".jpg", ".jpeg", ".webp"];

function artworkDirectory(gameId) {
  if (!/^[a-z0-9_-]+$/i.test(gameId))
    throw new Error(`Invalid game id for artwork: ${gameId}`);
  return path.join(gamesRoot, gameId, "assets");
}

function contentTypeForExtension(extension) {
  if (extension === ".jpg" || extension === ".jpeg") return "image/jpeg";
  if (extension === ".webp") return "image/webp";
  return "image/png";
}

async function findCachedArtworkFile(gameId) {
  const directory = artworkDirectory(gameId);
  for (const extension of supportedExtensions) {
    const imagePath = path.join(directory, `opening${extension}`);
    try {
      await fs.access(imagePath);
      return imagePath;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  return null;
}

async function ensureArtwork(gameId, prompt) {
  const cached = await imageStore.getImage(gameId, "opening");
  if (cached) return cached;

  const pending = imagePromises.get(gameId);
  if (pending) return pending;

  const generation = (async () => {
    const cachedPath = await findCachedArtworkFile(gameId);
    if (cachedPath) {
      const extension = path.extname(cachedPath).toLowerCase();
      return imageStore.saveImage(
        gameId,
        "opening",
        contentTypeForExtension(extension),
        await fs.readFile(cachedPath),
      );
    }

    const generated = await geminiImage.generateImage(prompt);
    return imageStore.saveImage(
      gameId,
      "opening",
      generated.contentType,
      generated.buffer,
    );
  })();
  imagePromises.set(gameId, generation);
  try {
    return await generation;
  } finally {
    if (imagePromises.get(gameId) === generation)
      imagePromises.delete(gameId);
  }
}

async function sendOpening({ gameId, prompt, threadId, caption }) {
  let image = null;
  try {
    image = await ensureArtwork(gameId, prompt);
  } catch (error) {
    console.error(`[${gameId} artwork] generation failed:`, error.message);
  }

  if (image) {
    const messageId = await messenger.sendGroupImageBufferTracked(
      threadId,
      image.buffer,
      image.contentType,
      caption,
    );
    if (messageId) return messageId;
    console.error(
      `[${gameId} artwork] image send failed; sending the opening message as text`,
    );
  }
  return messenger.sendGroupTracked(threadId, caption);
}

module.exports = { sendOpening, ensureArtwork };
