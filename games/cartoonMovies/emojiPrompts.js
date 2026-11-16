const { loadQuotes } = require("./quotes");

const cluesByTitle = new Map([
  ["الأسد الملك", "🦁 + 👑"],
  ["حكاية لعبة", "🤠 + 🚀 + 🧸"],
  ["شركة المرعبين المحدودة", "👹 + 🚪 + ⚡"],
  ["البحث عن نيمو", "🐠 + 🔎 + 🌊"],
  ["خلطة بيطة بالصلصة", "🐀 + 👨‍🍳 + 🍅"],
  ["كونغ فو باندا", "🐼 + 🥋"],
  ["مدغشقر", "🦁 + 🦓 + 🦒 + 🌴"],
  ["علاء الدين", "🧞 + 🪔"],
  ["أبطال خارقون", "🦸 + 🦸‍♀️"],
  ["شريك", "🧌 + 🧅"],
  ["حياة حشرة", "🐜 + 🐞 + 🌱"],
  ["فوق", "🏠 + 🎈"],
  ["مولان", "👩‍🦰 + 🐉 + 🏹"],
  ["ليلو وستيتش", "👧 + 🌺 + 👽"],
  ["سيارات", "🚗 + 🏁"],
  ["ملكة الثلج", "👸 + ❄️ + ⛄"],
  ["بامبي", "🦌 + 🌲"],
  ["حياة الإمبراطور الجديدة", "👑 + 🦙"],
  ["طرزان", "🧔 + 🌴 + 🦍"],
  ["هرقل", "💪 + ⚡ + 🏛️"],
  ["الجميلة والوحش", "🌹 + 👸 + 🐻"],
  ["حورية البحر", "🧜‍♀️ + 🐚 + 🌊"],
  ["سندريلا", "👠 + 🎃 + 🏰"],
  ["بينوكيو", "🤥 + 🪵 + 🧚"],
  ["بيتر بان", "🧚‍♂️ + 🏴‍☠️ + ⭐"],
  ["أليس في بلاد العجائب", "👧 + 🐇 + 🫖"],
  ["رابونزل", "👸 + 💇‍♀️ + 🗼"],
  ["قلباً وقالباً", "🧠 + ❤️ + 😊 + 😢"],
  ["زوتوبيا", "🐰 + 🦊 + 🏙️"],
  ["كوكو", "🎸 + 💀 + 🌼"],
  ["موانا", "🌊 + 🛶 + 🌺"],
  ["أسطورة مريدا", "👩‍🦰 + 🏹 + 🐻"],
  ["الأطلنطي: الإمبراطورية المفقودة", "🌊 + 🏛️ + 🔮"],
  ["كوكب الكنز", "🚀 + 🪐 + 💎"],
  ["أحدب نوتردام", "🔔 + ⛪"],
  ["بوكاهونتاس", "🪶 + 🌿 + 🛶"],
  ["العصر الجليدي", "🦣 + 🧊 + ❄️"],
]);

function normalizeTitle(value) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/[\u064B-\u065F\u0670\u0640]/g, "")
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/[^\p{L}\p{N}]+/gu, "")
    .toLowerCase();
}

const cluesByNormalizedTitle = new Map(
  [...cluesByTitle].map(([title, clue]) => [normalizeTitle(title), clue]),
);

function loadEmojiPrompts(titleAnswers = loadQuotes().map((prompt) => prompt.answers)) {
  const availableTitles = new Map();
  for (const answers of titleAnswers) {
    const [title, ...alternatives] = answers;
    const clue = cluesByNormalizedTitle.get(normalizeTitle(title));
    if (!clue) continue;
    const key = normalizeTitle(title);
    const current = availableTitles.get(key);
    if (current) {
      current.answers.push(...alternatives);
      continue;
    }
    availableTitles.set(key, { clue, answers: [title, ...alternatives] });
  }
  return [...availableTitles.values()];
}

module.exports = { loadEmojiPrompts };
