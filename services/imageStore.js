const db = require("../database");

function validKey(value) {
  return /^[a-z0-9_-]+$/i.test(value);
}

async function getImage(gameId, imageKey) {
  if (!validKey(gameId) || !validKey(imageKey))
    throw new Error("Invalid game image cache key.");
  const row = await db.one(
    "SELECT content_type, image_data FROM game_image_cache WHERE game_id=? AND image_key=?",
    [gameId, imageKey],
  );
  if (!row) return null;
  return {
    contentType: row.content_type,
    buffer: Buffer.from(row.image_data),
  };
}

async function saveImage(gameId, imageKey, contentType, buffer) {
  if (!validKey(gameId) || !validKey(imageKey))
    throw new Error("Invalid game image cache key.");
  if (!/^image\/(?:png|jpeg|webp)$/.test(contentType))
    throw new Error(`Unsupported game image content type: ${contentType}`);
  if (!Buffer.isBuffer(buffer) || buffer.length === 0)
    throw new Error("Cannot save an empty game image.");

  await db.query(
    `INSERT INTO game_image_cache (game_id, image_key, content_type, image_data)
     VALUES (?,?,?,?) ON DUPLICATE KEY UPDATE image_key=VALUES(image_key)`,
    [gameId, imageKey, contentType, buffer],
  );
  return getImage(gameId, imageKey);
}

module.exports = { getImage, saveImage };
