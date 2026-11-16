const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_PATH = path.join(__dirname, "songs.json");
const MAX_LINE_LENGTH = 200;

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

// يقرأ ملف الأغاني ويحوّله إلى تحديات للعبة. الملف اختياري: لو غير موجود أو فارغ
// تبقى اللعبة محمّلة وتخبر اللاعبين أنه لا توجد أغانٍ بعد.
function loadSongs(filePath = process.env.SPACETOON_SONGS_PATH || DEFAULT_PATH) {
  let contents;
  try {
    contents = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw new Error(`Unable to read Spacetoon songs file: ${error.message}`, {
      cause: error,
    });
  }
  let parsed;
  try {
    parsed = JSON.parse(contents.replace(/^\uFEFF/, ""));
  } catch (error) {
    throw new Error("Spacetoon songs file is not valid JSON.", { cause: error });
  }
  if (!Array.isArray(parsed))
    throw new Error("Spacetoon songs file must contain a JSON array.");

  const prompts = [];
  parsed.forEach((entry, index) => {
    const line = text(entry?.line);
    const answer = text(entry?.answer);
    const alternatives = Array.isArray(entry?.alt)
      ? entry.alt.map(text).filter(Boolean)
      : [];
    const valid =
      line &&
      answer &&
      line.length <= MAX_LINE_LENGTH &&
      [answer, ...alternatives].every((item) => item.length <= MAX_LINE_LENGTH);
    if (!valid) {
      console.warn(`[spacetoon] skipped entry #${index + 1}: needs "line" and "answer" text (max ${MAX_LINE_LENGTH} chars).`);
      return;
    }
    prompts.push({
      line,
      show: text(entry.show).slice(0, 80),
      answers: [answer, ...alternatives],
    });
  });
  return prompts;
}

module.exports = { loadSongs };
