const engine = require("./engine");

module.exports = {
  id: "culture",
  name: "ثقافة عامة",
  startCommand: "ثقافة",
  helpCommand: "قواعد ثقافة",
  startAliases: ["ثقافة", "culture", "general-culture"],
  commandAliases: [
    "qculture",
    "قواعدثقافة",
    "قواعد ثقافة",
    "ثقافةhelp",
    "معلومة",
    "معلومات",
    "culturehelp",
    "ثقافه",
  ],
  engine,
};
