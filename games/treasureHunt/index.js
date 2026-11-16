const engine = require("./engine");

module.exports = {
  id: "treasure-hunt",
  name: "البحث عن الكنز",
  startCommand: "البحث عن الكنز",
  helpCommand: "قواعد الكنز",
  startAliases: ["البحث عن الكنز", "كنز", "البحثعنالكنز", "البحث_عن_الكنز", "صيدالكنز", "treasurehunt"],
  commandAliases: [
    "قواعدالكنز",
    "قواعد الكنز",
    "treasurehunthelp",
    "حالةالكنز",
    "حالة الكنز",
    "treasurehuntstatus",
    "خروجالكنز",
    "خروج الكنز",
    "leavetreasurehunt",
    "إلغاءالكنز",
    "إلغاء الكنز",
    "الغاءالكنز",
    "الغاء الكنز",
    "canceltreasurehunt",
    "تلميحكنز",
    "تلميح كنز",
    "treasurehunthint",
  ],
  engine,
};
