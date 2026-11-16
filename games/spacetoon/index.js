const engine = require("./engine");

module.exports = {
  id: "spacetoon",
  name: "أكمل الأغنية",
  startCommand: "أغنية",
  helpCommand: "قواعد الأغنية",
  startAliases: ["أغنية", "اغنية", "سبيستون", "spacetoon"],
  commandAliases: ["قواعدالأغنية", "قواعد الأغنية", "قواعداغنية", "قواعدسبيستون", "spacetoonhelp"],
  engine,
};
