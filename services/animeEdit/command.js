// أمر «ايديت»: يُكتب كرد على صورة. الصيغة: ايديت [اسم الشخصية] [المدة بالثواني] [افقي]
const TRIGGER = /^\s*([/!.]?)\s*(ايديت|إيديت|اديت|edit)(?=\s|$)\s*([\s\S]*)$/i;
const ARABIC_DIGITS = "٠١٢٣٤٥٦٧٨٩";
const MIN_SECONDS = 6;
const MAX_NAME = 60;

const normalizeDigits = (s) => String(s).replace(/[٠-٩]/g, (d) => String(ARABIC_DIGITS.indexOf(d)));

/** يعيد null إن لم يكن أمراً، وإلا { name, seconds|null, landscape } */
function parseCommand(text) {
  const m = TRIGGER.exec(String(text || ""));
  if (!m) return null;
  const [, prefix, word, restRaw] = m;
  if (word.toLowerCase() === "edit" && !prefix) return null; // الكلمة اللاتينية وحدها تحتاج بادئة

  let rest = normalizeDigits(restRaw).replace(/[\u0000-\u001f\u007f]/g, " ");
  let landscape = false;
  rest = rest.replace(/(^|\s)(افقي|أفقي|عرضي|landscape|16:9)(?=\s|$)/gi, () => {
    landscape = true;
    return " ";
  });
  rest = rest.replace(/(^|\s)(عمودي|portrait|9:16)(?=\s|$)/gi, " ");

  let seconds = null;
  rest = rest.replace(/(^|\s)(\d{1,2})\s*(?:ث|ثانية|ثواني|ثوان|s|sec|secs|seconds?)?(?=\s|$)/i, (all, sp, n) => {
    const v = Number(n);
    if (seconds !== null || v < MIN_SECONDS) return all; // أرقام صغيرة تبقى جزءاً من الاسم
    seconds = v;
    return " ";
  });

  const name = rest.replace(/["'`<>\\|;$&]/g, " ").replace(/\s+/g, " ").trim().slice(0, MAX_NAME);
  return { name, seconds, landscape };
}

module.exports = { parseCommand, MIN_SECONDS };
