const engine = require("./engine");

module.exports = {
  id: "emoji-guess",
  name: "خمن الإيموجي من الوصف",
  startCommand: "خمن الإيموجي",
  helpCommand: "قواعد الإيموجي",
  startAliases: [
    "خمن الإيموجي",
    "خمنالإيموجي",
    "خمنالايموجي",
    "إيموجي",
    "ايموجي",
    "خمنإيموجي",
    "emojiguess",
  ],
  commandAliases: [
    "قواعدالإيموجي",
    "قواعد الإيموجي",
    "قواعدايموجي",
    "قواعدوصفالإيموجي",
    "emojiguesshelp",
  ],
  engine,
};
