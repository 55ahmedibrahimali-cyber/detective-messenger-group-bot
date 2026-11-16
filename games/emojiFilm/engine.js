const createPromptRaceEngine = require("../promptRaceEngine");
const { loadEmojiPrompts } = require("../cartoonMovies/emojiPrompts");

const prompts = loadEmojiPrompts();
if (!prompts.length) {
  console.warn(
    "[cartoon-emoji] no matching film titles loaded from games/cartoonMovies/quotes.json.",
  );
}

module.exports = createPromptRaceEngine({
  id: "emoji-film",
  name: "خمن فيلم كرتون من الإيموجي",
  kind: "emoji",
  startAliases: ["فيلم إيموجي", "فيلمإيموجي", "افلام", "أفلام", "كرتونإيموجي", "emojifilm"],
  helpAliases: ["قواعدفيلمإيموجي", "قواعدكرتونإيموجي", "emojifilmhelp"],
  prompts,
  allowEmpty: true,
  emptyMessage:
    "🎬 لا توجد أسماء أفلام مدعومة في ملف لعبة أفلام الكرتون الحالي.",
});
