const engine = require("./engine");

module.exports = {
  id: "cartoon-film",
  name: "من أي فيلم كرتون؟",
  startCommand: "كرتون",
  helpCommand: "قواعد كرتون",
  startAliases: ["كرتون", "جملةكرتون", "فيلمكرتون", "cartoonmovies"],
  commandAliases: [
    "قواعدكرتون",
    "قواعد كرتون",
    "قواعدجملةكرتون",
    "قواعدفيلمكرتون",
    "cartoonmovieshelp",
  ],
  engine,
};
