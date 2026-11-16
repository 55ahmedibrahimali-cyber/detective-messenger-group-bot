const engine = require("./engine");

module.exports = {
  id: "drawing",
  name: "لعبة الرسم والتخمين",
  startCommand: "رسم",
  helpCommand: "قواعد رسم",
  startAliases: ["رسم", "ارسم", "draw"],
  commandAliases: [
    "drawhelp",
    "قواعدرسم",
    "قواعد رسم",
    "drawstatus",
    "حالةرسم",
    "حالة رسم",
    "drawscores",
    "نتائجالرسم",
    "نتائج الرسم",
    "drawcancel",
    "إلغاءرسم",
    "إلغاء رسم",
  ],
  engine,
};
