const createPromptRaceEngine = require("../promptRaceEngine");
const { loadQuotes } = require("./quotes");

const prompts = loadQuotes();
if (!prompts.length) {
  console.warn(
    "[cartoon-movies] no quotes loaded. Add authorized excerpts to games/cartoonMovies/quotes.json.",
  );
}

module.exports = createPromptRaceEngine({
  id: "cartoon-film",
  name: "من أي فيلم كرتون؟",
  kind: "quote",
  startAliases: ["كرتون", "جملةكرتون", "فيلمكرتون", "cartoonmovies"],
  helpAliases: ["قواعدكرتون", "قواعدجملةكرتون", "قواعدفيلمكرتون", "cartoonmovieshelp"],
  prompts,
  allowEmpty: true,
  promptQuestion: "من أي فيلم كرتون قيلت العبارة؟",
  customHelpText:
    "من أي فيلم كرتون؟ اكتبوا كرتون لعرض العبارة، ثم خمّنوا اسم الفيلم. أول إجابة صحيحة تحصل على نقطة.",
  emptyMessage:
    "🎬 اللعبة جاهزة، لكن ما أُضيفت لها عبارات بعد. أضيفوا مقتطفات تملكون حق استخدامها في games/cartoonMovies/quotes.json.",
});
