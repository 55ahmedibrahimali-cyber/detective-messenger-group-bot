const engine = require("./engine");

module.exports = {
  id: "wordmarket",
  name: "سوق الكلمات",
  startCommand: "سوق الكلمات",
  helpCommand: "قواعد السوق",
  startAliases: ["سوق الكلمات", "سوق", "سوقالكلمات", "wordmarket"],
  commandAliases: ["قواعدالسوق", "قواعد السوق", "قواعدسوق", "wordmarkethelp"],
  engine,
};
