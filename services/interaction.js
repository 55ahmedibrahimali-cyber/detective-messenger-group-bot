// services/interaction.js - قوالب رسائل تفاعلية موحّدة للألعاب (رسالة البداية والأرقام)
const NUMBER_EMOJI = ["0️⃣", "1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣", "6️⃣", "7️⃣", "8️⃣", "9️⃣"];
const pick = (list) => list[Math.floor(Math.random() * list.length)];

function numberEmoji(n) {
  return String(n)
    .split("")
    .map((digit) => NUMBER_EMOJI[Number(digit)] || digit)
    .join("");
}

/**
 * رسالة بداية/تسجيل اللعبة (موحّدة وتفاعلية).
 * { title, tagline, min, max, seconds, leaveCommand, extra[] }
 */
function lobbyMessage({
  title,
  tagline,
  min,
  max,
  seconds,
  leaveCommand,
  extra = [],
}) {
  if (!leaveCommand)
    throw new Error("Every lobby message must define its game-specific leaveCommand.");
  const lines = [`${title} | التسجيل مفتوح (${min}–${max} لاعباً، ينتهي بعد ${seconds} ثانية)`];
  if (tagline) lines.push(tagline);
  lines.push(`تفاعل للانضمام | راسل البوت في الخاص أولاً لاستلام رسائل اللعبة | للمغادرة: ${leaveCommand}`);
  for (const line of extra) lines.push(line);
  return lines.join("\n");
}

/** إعلان مرة عند بلوغ الحد الأدنى ومرة عند اكتمال العدد فقط */
function joinAnnouncement({ count, min, max }) {
  if (count !== min && count !== max) return null;
  return count >= max
    ? `اكتمل عدد اللاعبين (${count}/${max}).`
    : `وصل التسجيل للحد الأدنى (${count}/${max})؛ يستمر حتى انتهاء المؤقت.`;
}

module.exports = {
  pick,
  numberEmoji,
  lobbyMessage,
  joinAnnouncement,
};
