const engine = require("./engine");

module.exports = {
  id: "emoji-film",
  name: "خمن فيلم كرتون من الإيموجي",
  startCommand: "فيلم إيموجي",
  helpCommand: "قواعد فيلم إيموجي",
  startAliases: ["فيلم إيموجي", "افلام", "أفلام", "فيلمإيموجي", "كرتونإيموجي", "emojifilm"],
  commandAliases: ["قواعدفيلمإيموجي", "قواعد فيلم إيموجي", "قواعدكرتونإيموجي", "emojifilmhelp"],
  engine,
};
