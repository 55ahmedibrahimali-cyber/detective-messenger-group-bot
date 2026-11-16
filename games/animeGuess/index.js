const engine = require("./engine");

module.exports = {
  id: "anime-guess",
  name: "احزر الشخصية (أنمي)",
  startCommand: "احزر الشخصية",
  helpCommand: "قواعد احزر الشخصية",
  startAliases: ["احزر الشخصية", "احزرالشخصية", "خمنانمي", "animeguess"],
  commandAliases: [
    "قواعداحزرالشخصية",
    "قواعد احزر الشخصية",
    "قواعدالانمي",
    "animeguesshelp",
  ],
  engine,
};
