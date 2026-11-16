const ROLES = {
  doctor: {
    name: "الطبيب",
    faction: "town",
    action: "protect",
    description: "يحمي لاعباً واحداً من هجمات هذه الليلة.",
  },
  insane: {
    name: "المجنون",
    faction: "town",
    action: "mad",
    description: "يظن أنه دور بريء آخر، لكن قدرته لا تؤثر في اللعبة.",
  },
  imposter_killer: {
    name: "القاتل الأساسي",
    faction: "impostor",
    action: "mafia_kill",
    description: "يختار ضحية الأشرار كل ليلة.",
  },
  cleaner: {
    name: "المنظف",
    faction: "impostor",
    action: "clean",
    description: "يخفي دور ضحية الليل إذا ماتت.",
  },
  blamer: {
    name: "المزور",
    faction: "impostor",
    action: "blame",
    description: "يجعل دور ضحية الليل يظهر في التقرير كدور من الأشرار.",
  },
  police: {
    name: "الشرطي",
    faction: "dual",
    action: "block",
    description: "يمنع لاعباً من تنفيذ قدرته هذه الليلة.",
  },
  lookout: {
    name: "المراقب",
    faction: "dual",
    action: "lookout",
    description: "يعرف عدد زوار اللاعب الذي يراقبه.",
  },
  investigator: {
    name: "المحقق",
    faction: "dual",
    action: "investigate",
    description: "يرى احتمالين لدور اللاعب؛ أحدهما دوره الحقيقي.",
  },
  tracker: {
    name: "المتتبع",
    faction: "dual",
    action: "track",
    description: "يعرف إلى من ذهب اللاعب الذي يتعقبه.",
  },
  trapper: {
    name: "صاحب الفخ",
    faction: "dual",
    action: "trap",
    description: "يعطّل أول قدرة تستهدف منزلاً يختاره.",
  },
  snitch: {
    name: "الوشاش",
    faction: "dual",
    action: "snitch",
    oneUse: true,
    description: "يكشف لك وحدك دور لاعب صباحاً؛ تعود قدرتك إذا مات هدفك ليلاً.",
  },
  provoker: {
    name: "المستفز",
    faction: "dual",
    action: "provoke",
    oneUse: true,
    description: "يبدأ هدفك تصويت النهار بصوتين ضده؛ تسترد قدرتك إذا مات الهدف ليلاً.",
  },
  haunter: {
    name: "المطارد",
    faction: "neutral",
    action: "haunt",
    description: "إذا طُرد بالتصويت، ينتقم من هدفه الموسوم؛ لا يوقفه الطبيب أو درع الناجي.",
  },
  survivor: {
    name: "الناجي",
    faction: "neutral",
    action: "armor",
    description: "يحمي نفسه ليلاً حتى ثلاث مرات، وينضم إلى الفريق الفائز إذا ظل حياً.",
  },
  serial_killer: {
    name: "السفاح المتسلسل",
    faction: "neutral",
    action: "serial_kill",
    description: "يقتل لاعباً ليلياً ويفوز إذا بقي آخر لاعب.",
  },
  bomber: {
    name: "المفجر",
    faction: "neutral",
    action: "bomb",
    description: "يزرع قنبلة كل ليلة، ثم يستطيع تفجير كل قنابله دفعة واحدة.",
  },
  thief: {
    name: "الحرامي",
    faction: "neutral",
    action: "steal_kill",
    oneUse: true,
    description: "يقتل هدفاً ويسرق دوره؛ يصبح من فصيلته إذا كان بريئاً أو من الأشرار.",
  },
  sorcerer: {
    name: "الساحر",
    faction: "neutral",
    action: "sorcerer",
    description: "يضرب هدفه بصاعقة إذا خمّن دوره بدقة؛ إذا أخطأ يموت هو. لا توقفه الحماية.",
  },
};

const DUAL_ROLE_KEYS = [
  "police",
  "lookout",
  "investigator",
  "tracker",
  "trapper",
  "snitch",
  "provoker",
];

const EVIL_SUPPORT_KEYS = ["cleaner", "blamer"];
const NEUTRAL_ROLE_KEYS = [
  "survivor",
  "serial_killer",
  "bomber",
  "thief",
  "haunter",
  "sorcerer",
];

function shuffle(items, random = Math.random) {
  const shuffled = [...items];
  for (let index = shuffled.length - 1; index > 0; index--) {
    const swap = Math.floor(random() * (index + 1));
    [shuffled[index], shuffled[swap]] = [shuffled[swap], shuffled[index]];
  }
  return shuffled;
}

function createRoleSet(playerCount, random = Math.random) {
  if (!Number.isInteger(playerCount) || playerCount < 4 || playerCount > 12)
    throw new RangeError("Feign supports 4 to 12 players.");

  const impostorCount = playerCount >= 10 ? 3 : playerCount >= 6 ? 2 : 1;
  const neutralCount = playerCount >= 10 ? 2 : playerCount >= 7 ? 1 : 0;
  const townCount = playerCount - impostorCount - neutralCount;
  const roles = [
    { key: "imposter_killer", team: "impostor" },
  ];

  const dualEvilCount = Math.min(
    impostorCount - 1,
    Math.floor(random() * (Math.min(2, impostorCount - 1) + 1)),
  );
  const supportCount = impostorCount - 1 - dualEvilCount;
  const evilDuals = shuffle(DUAL_ROLE_KEYS, random).slice(0, dualEvilCount);
  for (const key of shuffle(EVIL_SUPPORT_KEYS, random).slice(0, supportCount))
    roles.push({ key, team: "impostor" });
  for (const key of evilDuals)
    roles.push({ key, team: "impostor" });

  roles.push({ key: "doctor", team: "town" });
  let remainingTown = townCount - 1;
  if (remainingTown > 0) {
    roles.push({ key: "insane", team: "town" });
    remainingTown--;
  }
  const townDuals = shuffle(
    DUAL_ROLE_KEYS.filter((key) => !evilDuals.includes(key)),
    random,
  ).slice(0, remainingTown);
  for (const key of townDuals)
    roles.push({ key, team: "town" });

  for (const key of shuffle(NEUTRAL_ROLE_KEYS, random).slice(0, neutralCount))
    roles.push({ key, team: "neutral" });

  return shuffle(roles, random);
}

module.exports = {
  ROLES,
  DUAL_ROLE_KEYS,
  NEUTRAL_ROLE_KEYS,
  createRoleSet,
  shuffle,
};
