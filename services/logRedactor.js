// services/logRedactor.js - يخفي الأسرار (كلمة المرور، الكوكيز، المفاتيح) من كل ما يُطبع في السجل.
// يجب تحميله أول شيء في server.js قبل أي مكتبة أخرى (حتى تمر سجلات مكتبات FCA منه أيضاً).
const util = require("node:util");

const SECRET_ENV_NAMES = [
  "FB_PASSWORD",
  "GEMINI_API_KEY",
  "GROQ_API_KEY",
  "CLOUDFLARE_API_TOKEN",
  "PIXABAY_API_KEY",
  "SPY_IMAGE_LINK_SECRET",
  "APPSTATE_ENCRYPTION_KEY",
  "DB_PASSWORD",
];

function secretValues() {
  const values = [];
  for (const name of SECRET_ENV_NAMES) {
    const value = process.env[name];
    if (value && value.length >= 6) values.push(value);
  }
  return values;
}

function redact(input) {
  let text = typeof input === "string" ? input : util.format(input);
  for (const secret of secretValues()) text = text.split(secret).join("[hidden]");
  const email = process.env.FB_EMAIL;
  if (email && email.length >= 5) text = text.split(email).join("[hidden-email]");
  return text
    // قيم الكوكيز الحساسة بصيغة JSON أو key=value
    .replace(
      /("?\b(?:xs|c_user|i_user|fr|datr|sb|presence|wd|m_pixel_ratio|fbl_st|dpr)"?\s*[:=]\s*"?)([^"\s,;}]{6,})/gi,
      "$1[hidden]",
    )
    .replace(
      /("?\b(?:value|password|passwd|pass|token|access_token|fb_dtsg|jazoest|authorization|cookie|api[_-]?key|key)"?\s*[:=]\s*"?)([^"\s,;}&]{6,})/gi,
      "$1[hidden]",
    )
    .replace(/(key=)[A-Za-z0-9_\-]{16,}/g, "$1[hidden]")
    .replace(/AIza[0-9A-Za-z_\-]{20,}/g, "[hidden-google-key]");
}

let installed = false;
function install() {
  if (installed) return;
  installed = true;
  for (const level of ["log", "info", "warn", "error", "debug"]) {
    const original = console[level].bind(console);
    console[level] = (...args) => {
      try {
        original(redact(util.format(...args)));
      } catch {
        original("[log redaction failed]");
      }
    };
  }
}

module.exports = { install, redact };
