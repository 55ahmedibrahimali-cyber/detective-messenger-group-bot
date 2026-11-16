const { randomInt } = require("node:crypto");

const ROLE_DEFINITIONS = {
  shadow_leader: {
    name: "زعيم الظلال",
    team: "shadow",
    special: true,
    description: "يقود الظلال ويشارك في اختيار ضحية الليل.",
  },
  shadow_assassin: {
    name: "السفاح",
    team: "shadow",
    special: true,
    description: "من الظلال، ويمكنه تنفيذ اغتيال إضافي مرة واحدة في اللعبة.",
  },
  investigator: {
    name: "المحقق الملكي",
    team: "kingdom",
    special: true,
    description: "يفحص لاعباً كل ليلة ليعرف هل هو من الظلال.",
  },
  doctor: {
    name: "الطبيب الملكي",
    team: "kingdom",
    special: true,
    description: "يحمي لاعباً واحداً كل ليلة من الاغتيال.",
  },
  sniper: {
    name: "القناص",
    team: "kingdom",
    special: true,
    description: "يستطيع إطلاق رصاصة واحدة طوال اللعبة.",
  },
  oracle: {
    name: "العرّاف",
    team: "kingdom",
    special: true,
    description: "يكشف هل يمتلك لاعب قدرة خاصة، دون معرفة طبيعتها.",
  },
  bodyguard: {
    name: "الحارس الشخصي",
    team: "kingdom",
    special: true,
    description: "يحمي لاعباً؛ وإذا تعرض المحمي لاغتيال يموت الحارس بدلاً منه.",
  },
  trickster: {
    name: "المخادع",
    team: "independent",
    special: true,
    description: "يفوز مستقلاً إذا بقي حياً حتى نهاية اللعبة.",
  },
  citizen: {
    name: "المواطن النبيل",
    team: "kingdom",
    special: false,
    description: "لا يملك قدرة ليلية؛ يعتمد على التحليل والنقاش والتصويت.",
  },
};

function shuffle(items) {
  const shuffled = [...items];
  for (let index = shuffled.length - 1; index > 0; index--) {
    const swapIndex = randomInt(index + 1);
    [shuffled[index], shuffled[swapIndex]] = [
      shuffled[swapIndex],
      shuffled[index],
    ];
  }
  return shuffled;
}

function rolesForPlayerCount(count) {
  if (!Number.isInteger(count) || count < 4 || count > 8)
    throw new RangeError(`STORM supports 4-8 players; received ${count}.`);

  const roleKeys = ["shadow_leader"];
  if (count >= 7) roleKeys.push("shadow_assassin");
  roleKeys.push("investigator", "doctor");

  const optionalCount = count - roleKeys.length;
  const optionalRoles = shuffle([
    "citizen",
    "sniper",
    "oracle",
    "bodyguard",
    ...(count >= 6 ? ["trickster"] : []),
  ]);
  roleKeys.push(...optionalRoles.slice(0, optionalCount));
  return roleKeys.map((key) => ({ key, ...ROLE_DEFINITIONS[key] }));
}

function winnerForPlayers(players) {
  const alive = players.filter((player) => player.is_alive);
  const shadows = alive.filter((player) => player.team === "shadow").length;
  const kingdom = alive.filter((player) => player.team === "kingdom").length;
  if (shadows === 0 && kingdom > 0) return "kingdom";
  if (shadows === 0 && kingdom === 0) {
    if (alive.some((player) => player.team === "independent"))
      return "independent";
    return "draw";
  }
  if (shadows >= kingdom) return "shadow";
  return null;
}

module.exports = { ROLE_DEFINITIONS, rolesForPlayerCount, winnerForPlayers };
