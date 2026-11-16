const engine = require("./engine");

module.exports = {
  id: "football-auction",
  name: "مزاد كرة القدم",
  startCommand: "مزاد",
  helpCommand: "قواعد المزاد",
  startAliases: ["مزاد", "auction"],
  commandAliases: ["انضمام", "دخول", "رشح", "ترشيح", "زايد", "مرر", "قائمة", "اللاعبون", "قواعدالمزاد", "قواعد المزاد", "مزادhelp", "auctionhelp"],
  engine,
};
