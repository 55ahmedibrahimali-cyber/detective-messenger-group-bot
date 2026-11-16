function firstAnswer(answers) {
  const candidate = Array.isArray(answers) ? answers[0] : answers;
  const value = Array.isArray(candidate) ? candidate[0] : candidate;
  return String(value || "").trim();
}

function answerText(answers) {
  if (!Array.isArray(answers)) return String(answers || "").trim();
  if (Array.isArray(answers[0]))
    return answers.map((options) => String(options[0] || "").trim()).join("، ");
  return String(answers[0] || "").trim();
}

function answerHint(item) {
  const hint = typeof item?.hint === "string" ? item.hint.trim() : "";
  if (hint) return hint;

  const words = firstAnswer(item?.answers).match(/[\p{L}\p{N}]+/gu) || [];
  if (!words.length)
    return "فكّر في تفاصيل السؤال واربطها بالإجابة المناسبة.";

  const lastWord = words[words.length - 1].replace(/^ال(?=.{2,}$)/u, "");
  const firstLetter = Array.from(lastWord)[0];
  if (words.length === 1)
    return `تلميح: تبدأ الإجابة بحرف «${firstLetter}».`;
  return `تلميح: تبدأ آخر كلمة في الإجابة بحرف «${firstLetter}»، والإجابة من ${words.length} كلمات.`;
}

module.exports = { answerText, answerHint };
