const createPromptRaceEngine = require("../promptRaceEngine");
const { loadSongs } = require("./songs");

const prompts = loadSongs();
if (!prompts.length) {
  console.warn(
    "[spacetoon] no songs loaded. Add entries to games/spacetoon/songs.json (see songs.sample.json).",
  );
}

module.exports = createPromptRaceEngine({
  id: "spacetoon",
  name: "أكمل الأغنية",
  kind: "lyric",
  startAliases: ["أغنية", "اغنية", "سبيستون", "spacetoon"],
  helpAliases: ["قواعدالأغنية", "قواعداغنية", "قواعدسبيستون", "spacetoonhelp"],
  prompts,
  allowEmpty: true,
  emptyMessage:
    "🎤 لعبة أكمل الأغنية جاهزة، لكن ما أُضيفت لها أغانٍ بعد. يمكن للأدمن إضافتها في games/spacetoon/songs.json.",
});
