const { randomInt } = require("node:crypto");

const WORDS = [
  { word: "قطة", aliases: ["قط", "القط", "القطه"] },
  { word: "كلب", aliases: ["الكلب"] },
  { word: "فيل", aliases: ["الفيل"] },
  { word: "زرافة", aliases: ["زرافه", "الزرافة"] },
  { word: "أسد", aliases: ["اسد", "الأسد", "الاسد"] },
  { word: "أرنب", aliases: ["ارنب", "الأرنب", "الارنب"] },
  { word: "سمكة", aliases: ["سمكه", "سمك", "السمكة"] },
  { word: "فراشة", aliases: ["فراشه", "الفراشة"] },
  { word: "سلحفاة", aliases: ["سلحفاه", "السلحفاة"] },
  { word: "بطريق", aliases: ["البطريق"] },
  { word: "تفاحة", aliases: ["تفاحه", "التفاحة"] },
  { word: "موز", aliases: ["موزة", "موزه", "الموز"] },
  { word: "بطيخ", aliases: ["البطيخ"] },
  { word: "بيت", aliases: ["منزل", "البيت"] },
  { word: "مدرسة", aliases: ["مدرسه", "المدرسة"] },
  { word: "مستشفى", aliases: ["المستشفى"] },
  { word: "قلعة", aliases: ["قلعه", "القصر", "القلعة"] },
  { word: "جسر", aliases: ["الجسر"] },
  { word: "برج", aliases: ["البرج"] },
  { word: "مسجد", aliases: ["المسجد"] },
  { word: "سيارة", aliases: ["سياره", "السيارة"] },
  { word: "دراجة", aliases: ["دراجه", "دراجة هوائية"] },
  { word: "طائرة", aliases: ["طيارة", "طياره", "الطائرة"] },
  { word: "قطار", aliases: ["القطار"] },
  { word: "سفينة", aliases: ["سفينه", "السفينة"] },
  { word: "صاروخ", aliases: ["الصاروخ"] },
  { word: "ساعة", aliases: ["ساعه", "الساعة"] },
  { word: "مظلة", aliases: ["مظله", "الشمسية"] },
  { word: "مفتاح", aliases: ["المفتاح"] },
  { word: "كتاب", aliases: ["الكتاب"] },
  { word: "هاتف", aliases: ["جوال", "موبايل", "الهاتف"] },
  { word: "حاسوب", aliases: ["كمبيوتر", "حاسب آلي"] },
  { word: "نظارة", aliases: ["نظاره", "النظارة"] },
  { word: "حذاء", aliases: ["جزمة", "جزمه", "الحذاء"] },
  { word: "قبعة", aliases: ["قبعه", "القبعة"] },
  { word: "كرة قدم", aliases: ["كرة", "كورة", "كورة قدم"] },
  { word: "تاج", aliases: ["التاج"] },
  { word: "شمعة", aliases: ["شمعه", "الشمعة"] },
  { word: "ساعة رملية", aliases: ["الساعة الرملية"] },
  { word: "قلب", aliases: ["القلب"] },
  { word: "شمس", aliases: ["الشمس"] },
  { word: "قمر", aliases: ["الهلال", "القمر"] },
  { word: "نجمة", aliases: ["نجمه", "النجمة"] },
  { word: "سحابة", aliases: ["سحابه", "غيمة", "غيمه"] },
  { word: "مطر", aliases: ["المطر"] },
  { word: "قوس قزح", aliases: ["قزح", "قوس المطر"] },
  { word: "بركان", aliases: ["البركان"] },
  { word: "شجرة", aliases: ["شجره", "الشجرة"] },
  { word: "زهرة", aliases: ["زهره", "وردة", "ورده"] },
  { word: "نخلة", aliases: ["نخله", "النخلة"] },
  { word: "ثلج", aliases: ["الثلج"] },
  { word: "صحراء", aliases: ["الصحراء"] },
  { word: "بحر", aliases: ["البحر"] },
  { word: "جبل", aliases: ["الجبل"] },
  { word: "موجة", aliases: ["موجه", "موج", "الموجة"] },
  { word: "سلم", aliases: ["الدرج", "السلم"] },
  { word: "مطرقة", aliases: ["مطرقه", "المطرقة"] },
  { word: "فرشاة أسنان", aliases: ["فرشة أسنان", "فرشه اسنان"] },
  { word: "مكعب", aliases: ["مكعب روبيك", "روبيك"] },
  { word: "بالون", aliases: ["البالون"] },
  { word: "طبل", aliases: ["الطبل"] },
  { word: "بيانو", aliases: ["البيانو"] },
  { word: "مروحة", aliases: ["مروحه", "المروحة"] },
  { word: "مصباح", aliases: ["لمبة", "لمبه", "المصباح"] },
  { word: "مرآة", aliases: ["مراة", "مرايه", "مرآه"] },
  { word: "سلمون", aliases: ["سمك السلمون"] },
  { word: "روبوت", aliases: ["الروبوت"] },
  { word: "تلفاز", aliases: ["تلفزيون", "التلفاز"] },
  { word: "مطبخ", aliases: ["المطبخ"] },
  { word: "مكتبة", aliases: ["مكتبه", "المكتبة"] },
  { word: "إشارة مرور", aliases: ["اشارة مرور", "إشارة"] },
  { word: "ساعة يد", aliases: ["ساعة", "ساعة اليد"] },
  { word: "رجل الثلج", aliases: ["رجل جليد", "رجل الثلجية"] },
];

function normalizeAnswer(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\u064b-\u065f\u0670\u0640]/g, "")
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function chooseWord(random = randomInt) {
  return WORDS[random(WORDS.length)];
}

function matchesAnswer(guess, word) {
  const normalizedGuess = normalizeAnswer(guess);
  if (!normalizedGuess) return false;
  return [word.word, ...word.aliases].some(
    (answer) => normalizeAnswer(answer) === normalizedGuess,
  );
}

module.exports = { WORDS, chooseWord, normalizeAnswer, matchesAnswer };
