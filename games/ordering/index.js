const engine = require("./engine");

module.exports = {
  id: "ordering",
  name: "تحدي الترتيب",
  startCommand: "ترتيب",
  helpCommand: "قواعد الترتيب",
  startAliases: ["ترتيب", "ترتيبتحدي", "challenge-order"],
  commandAliases: ["قواعدالترتيب", "قواعد الترتيب", "ترتيبhelp", "orderhelp"],
  engine,
};
