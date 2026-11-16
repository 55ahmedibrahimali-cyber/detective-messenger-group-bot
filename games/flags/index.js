const engine = require("./engine");

module.exports = {
  id: "flags",
  name: "أعلام الدول",
  startCommand: "أعلام",
  helpCommand: "قواعد أعلام",
  startAliases: ["أعلام", "اعلام", "flags", "countries"],
  commandAliases: [
    "qflags",
    "قواعدأعلام",
    "قواعد أعلام",
    "اعلامhelp",
    "flagshelp",
    "البلدان",
  ],
  engine,
};
