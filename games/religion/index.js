const engine = require("./engine");

module.exports = {
  id: "religion",
  name: "أسئلة دينية",
  startCommand: "دين",
  helpCommand: "قواعد دين",
  startAliases: ["دين", "ديني", "religion", "islam", "اسلام"],
  commandAliases: [
    "qdin",
    "قواعددين",
    "قواعد دين",
    "دينhelp",
    "دينيhelp",
    "religionhelp",
  ],
  engine,
};
