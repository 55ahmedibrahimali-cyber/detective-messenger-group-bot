const { randomInt } = require("node:crypto");
const imageStore = require("../../services/imageStore");
const pixabayImageSearch = require("../../services/pixabayImageSearch");
const CFG = require("./config");

function hasPixabay() {
  return Boolean(process.env.PIXABAY_API_KEY?.trim());
}

function hasGemini() {
  return Boolean(process.env.GEMINI_API_KEY?.trim());
}

/** يكفي مفتاح واحد: Pixabay (صور حقيقية) أو Gemini (صور مولّدة كبديل) */
function assertConfigured() {
  if (!hasPixabay() && !hasGemini())
    throw new Error("PIXABAY_API_KEY (أو GEMINI_API_KEY كبديل) غير مضبوط في .env");
}

/** مصدر الصورة يُستنتج من مفتاحها المحفوظ: pixabay-<id> أو gemini-<scene> */
function isPixabayKey(imageKey) {
  return String(imageKey || "").startsWith("pixabay-");
}

async function fromPixabay(scene) {
  const image = await pixabayImageSearch.searchImage(scene.searchTerm);
  const imageKey = `pixabay-${image.id}`;
  const saved = await imageStore.saveImage(
    "spy",
    imageKey,
    image.contentType,
    image.buffer,
  );
  return { imageKey, image: saved };
}

async function fromGemini(scene) {
  const imageKey = `gemini-${scene.imageKey}`;
  const cached = await imageStore.getImage("spy", imageKey);
  if (cached) return { imageKey, image: cached };
  // تحميل متأخر: لا حاجة لخدمة Gemini إلا عند الاحتياج
  const geminiImage = require("../../services/geminiImage");
  const generated = await geminiImage.generateImage(scene.imagePrompt);
  const saved = await imageStore.saveImage(
    "spy",
    imageKey,
    generated.contentType,
    generated.buffer,
  );
  return { imageKey, image: saved };
}

async function getRandomSceneImage() {
  const selected = CFG.SCENES[randomInt(CFG.SCENES.length)];
  const scene = {
    ...selected,
    // الكلمات الممنوعة: كلمة البحث ومقابلها العربي (الصيغ مثل «المنارة» تُطابَق تلقائياً في المحرك)
    forbiddenWords: [selected.searchTerm, selected.forbiddenWord],
  };

  let prepared = null;
  const errors = [];
  if (hasPixabay()) {
    try {
      prepared = await fromPixabay(scene);
    } catch (error) {
      errors.push(`Pixabay: ${error.message}`);
      console.error("[spy] Pixabay failed:", error.message);
    }
  }
  if (!prepared && hasGemini()) {
    try {
      prepared = await fromGemini(scene);
    } catch (error) {
      errors.push(`Gemini: ${error.message}`);
      console.error("[spy] Gemini image fallback failed:", error.message);
    }
  }
  if (!prepared)
    throw new Error(`Could not prepare a spy image. ${errors.join(" | ")}`);

  scene.imageKey = prepared.imageKey;
  pruneOldImages().catch(() => {});
  return { scene, image: prepared.image };
}

async function getSceneImageByKey(imageKey) {
  return imageStore.getImage("spy", imageKey);
}

// يمنع تضخم قاعدة البيانات: نحتفظ بآخر 100 صورة جاسوس فقط
async function pruneOldImages() {
  const db = require("../../database");
  await db.query(
    `DELETE FROM game_image_cache
     WHERE game_id='spy' AND image_key NOT IN (
       SELECT image_key FROM (
         SELECT image_key FROM game_image_cache
         WHERE game_id='spy' ORDER BY created_at DESC LIMIT 100
       ) keep
     )`,
  );
}

module.exports = {
  assertConfigured,
  getRandomSceneImage,
  getSceneImageByKey,
  isPixabayKey,
};
