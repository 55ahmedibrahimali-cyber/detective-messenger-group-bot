const engine = require("./engine");

module.exports = {
  id: "storm",
  name: "إمبراطورية STORM",
  startCommand: "ستورم",
  helpCommand: "قواعد ستورم",
  startAliases: ["ستورم"],
  commandAliases: [
    "stormhelp",
    "قواعدستورم",
    "قواعد ستورم",
    "stormplayers",
    "لاعبينستورم",
    "لاعبين ستورم",
    "stormcancel",
    "إلغاءستورم",
    "إلغاء ستورم",
    "stormleave",
    "خروجستورم",
    "خروج ستورم",
  ],
  engine,
};
