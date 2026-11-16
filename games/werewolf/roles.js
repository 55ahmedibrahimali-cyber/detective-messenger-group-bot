const ROLES = {
  werewolf: {
    name: "المستذئب",
    team: "wolves",
    description: "تختارون ضحية سراً كل ليلة. يتعرف المستذئبون بعضهم على بعض.",
  },
  villager: {
    name: "القروي",
    team: "village",
    description: "ناقشوا الأدلة وصوّتوا لإخراج جميع المستذئبين.",
  },
  seer: {
    name: "العرّاف",
    team: "village",
    description: "اختر لاعباً كل ليلة لتعرف هل هو من المستذئبين.",
  },
  witch: {
    name: "الساحرة",
    team: "village",
    description:
      "لديك جرعة إنقاذ واحدة توقف ضحية الذئاب، وجرعة سم واحدة لقتل لاعب.",
  },
  hunter: {
    name: "الصياد",
    team: "village",
    description: "إذا خرجت من اللعبة، تحصل على طلقة أخيرة ضد لاعب حي.",
  },
  cupid: {
    name: "كيوبيد",
    team: "village",
    description: "في الليلة الأولى، اربط لاعبين بعلاقة حب سرية؛ إذا مات أحدهما يموت الآخر حزناً.",
  },
};

function shuffle(items, random = Math.random) {
  const result = [...items];
  for (let index = result.length - 1; index > 0; index--) {
    const swap = Math.floor(random() * (index + 1));
    [result[index], result[swap]] = [result[swap], result[index]];
  }
  return result;
}

function createRoleSet(playerCount, random = Math.random) {
  if (!Number.isInteger(playerCount) || playerCount < 4 || playerCount > 8)
    throw new RangeError("Werewolf supports 4 to 8 players.");

  const werewolfCount = Math.floor(playerCount / 4);
  const roles = [
    ...Array.from({ length: werewolfCount }, () => "werewolf"),
    "seer",
    "witch",
    "hunter",
    ...(playerCount >= 8 ? ["cupid"] : []),
    ...Array.from(
      {
        length:
          playerCount -
          werewolfCount -
          3 -
          (playerCount >= 8 ? 1 : 0),
      },
      () => "villager",
    ),
  ];
  return shuffle(roles, random).map((key) => ({
    key,
    team: ROLES[key].team,
  }));
}

module.exports = { ROLES, createRoleSet, shuffle };
