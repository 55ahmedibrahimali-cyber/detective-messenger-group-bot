const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_PATH = path.join(__dirname, "quotes.json");
const MAX_QUOTE_LENGTH = 280;
const MAX_FILM_LENGTH = 100;

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

function loadQuotes(filePath = process.env.CARTOON_MOVIE_QUOTES_PATH || DEFAULT_PATH) {
  let contents;
  try {
    contents = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw new Error(`Unable to read cartoon movie quotes file: ${error.message}`, {
      cause: error,
    });
  }

  let parsed;
  try {
    parsed = JSON.parse(contents.replace(/^\uFEFF/, ""));
  } catch (error) {
    throw new Error("Cartoon movie quotes file is not valid JSON.", {
      cause: error,
    });
  }
  if (!Array.isArray(parsed))
    throw new Error("Cartoon movie quotes file must contain a JSON array.");

  const prompts = [];
  parsed.forEach((entry, index) => {
    const quote = text(entry?.quote);
    const film = text(entry?.film);
    const alternatives = Array.isArray(entry?.alt)
      ? entry.alt.map(text).filter(Boolean)
      : [];
    const valid =
      quote &&
      film &&
      quote.length <= MAX_QUOTE_LENGTH &&
      [film, ...alternatives].every((title) => title.length <= MAX_FILM_LENGTH);
    if (!valid) {
      console.warn(
        `[cartoon-movies] skipped entry #${index + 1}: needs "quote" and "film" text within the configured length limits.`,
      );
      return;
    }
    prompts.push({ quote, answers: [film, ...alternatives] });
  });
  return prompts;
}

module.exports = { loadQuotes };
