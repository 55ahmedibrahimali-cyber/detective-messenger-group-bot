const engine = require("./engine");

module.exports = {
  id: "quote",
  name: "من صاحب العبارة",
  startCommand: "عبارة",
  helpCommand: "قواعد العبارة",
  startAliases: ["عبارة", "مينقال", "quote"],
  commandAliases: ["قواعدالعبارة", "قواعد العبارة", "قواعدعبارة", "quotehelp"],
  engine,
};
