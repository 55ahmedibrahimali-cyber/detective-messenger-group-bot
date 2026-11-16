const createPromptRaceEngine = require("../promptRaceEngine");

module.exports = createPromptRaceEngine({
  id: "wordmarket",
  name: "سوق الكلمات",
  kind: "wordmarket",
  startAliases: ["سوق الكلمات", "سوق", "سوقالكلمات", "wordmarket"],
  helpAliases: ["قواعدالسوق", "قواعدسوق", "wordmarkethelp"],
  prompts: [
    { category: "دولة", letter: "م", answers: ["مصر", "مدغشقر", "موريتانيا", "ماليزيا", "منغوليا"] },
    { category: "حيوان", letter: "ف", answers: ["فيل", "فهد", "فراشة", "فقمة", "فأر"] },
    { category: "مدينة", letter: "ب", answers: ["بغداد", "بيروت", "برلين", "بكين", "بصرة"] },
    { category: "طعام", letter: "ك", answers: ["كبة", "كشري", "كنافة", "كباب", "كيوي"] },
    { category: "شيء في المنزل", letter: "م", answers: ["مفتاح", "مقعد", "مرآة", "مصباح", "مروحة"] },
    { category: "مهنة", letter: "ط", answers: ["طبيب", "طيار", "طباخ", "طباع"] },
    { category: "نبات", letter: "ز", answers: ["زعتر", "زيتون", "زنجبيل", "زنبق"] },
    { category: "شيء في المدرسة", letter: "ق", answers: ["قلم", "قرطاس", "قاموس", "قاعة"] },
    { category: "رياضة", letter: "س", answers: ["سباحة", "سلة", "سكواش", "سباق"] },
    { category: "شيء يلبس", letter: "ق", answers: ["قميص", "قبعة", "قفاز", "قلادة"] },
    { category: "وسيلة نقل", letter: "ق", answers: ["قطار", "قارب", "قاطرة"] },
    { category: "صفة", letter: "ش", answers: ["شجاع", "شريف", "شديد", "شهم"] },
    { category: "دولة", letter: "ت", answers: ["تركيا", "تونس", "تايلاند", "تنزانيا"] },
    { category: "حيوان", letter: "أ", answers: ["أسد", "أرنب", "أخطبوط", "أيل"] },
    { category: "شيء في الطبيعة", letter: "ج", answers: ["جبل", "جدول", "جزيرة", "جرف"] },
    { category: "اسم طائر", letter: "ب", answers: ["بومة", "ببغاء", "بطريق", "بلبل"] },
  ],
});
