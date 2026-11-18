// فحص إعدادات الأمان الأساسية عند إقلاع البوت.
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");

function warn(message) {
  console.warn(`[security] ${message}`);
}

function critical(message) {
  console.error(`[security][حرج] ${message}`);
}

function configuredPath(value, rootDir, fallback) {
  if (!value) return path.join(rootDir, fallback);
  return path.isAbsolute(value) ? value : path.resolve(value);
}

function fileMode(filePath) {
  try {
    return fs.statSync(filePath).mode & 0o777;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function checkFilePerms(rootDir = ROOT) {
  const activeAdminPath =
    process.env.BOT_PLATFORM === "telegram"
      ? path.join(rootDir, ".nexca", "telegram-admin-ids.json")
      : path.join(rootDir, "admin-ids.json");
  const sensitiveFiles = [
    [".env", path.join(rootDir, ".env"), "600"],
    [".env.telegram", path.join(rootDir, ".env.telegram"), "600"],
    [".nexca", path.join(rootDir, ".nexca"), "700"],
    [
      "appstate",
      configuredPath(process.env.APPSTATE_PATH, rootDir, "appstate.json"),
      "600",
    ],
    ["admin IDs", activeAdminPath, "600"],
    [
      "spy image link secret",
      configuredPath(
        process.env.SPY_IMAGE_LINK_SECRET_PATH,
        rootDir,
        path.join(".nexca", "spy-image-link-secret"),
      ),
      "600",
    ],
  ];

  if (process.env.TELEGRAM_ENV_PATH) {
    sensitiveFiles.push([
      "Telegram environment file",
      configuredPath(process.env.TELEGRAM_ENV_PATH, rootDir, ".env.telegram"),
      "600",
    ]);
  }

  if (process.platform === "win32") return;

  const checkedPaths = new Set();
  for (const [label, filePath, secureMode] of sensitiveFiles) {
    if (checkedPaths.has(filePath)) continue;
    checkedPaths.add(filePath);

    let mode;
    try {
      mode = fileMode(filePath);
    } catch (error) {
      warn(`تعذّر فحص صلاحيات ${label}: ${error.message}`);
      continue;
    }
    if (mode === null || (mode & 0o077) === 0) continue;

    warn(
      `صلاحيات ${label} تسمح لمستخدمين آخرين بالوصول (${mode.toString(8)}). استخدم chmod ${secureMode} للمسار.`,
    );
  }
}

function checkRootUser() {
  if (
    process.platform === "win32" ||
    typeof process.getuid !== "function" ||
    process.getuid() !== 0
  )
    return;

  critical(
    "البوت يعمل بصلاحيات root؛ شغّله بمستخدم خدمة عادي لتقليل أثر اختراق العملية.",
  );
  if (process.env.SECURITY_STRICT === "1")
    throw new Error("SECURITY_STRICT: رفض التشغيل بصلاحيات root.");
}

function checkEncryption(rootDir = ROOT) {
  const appstatePath = configuredPath(
    process.env.APPSTATE_PATH,
    rootDir,
    "appstate.json",
  );
  const key = process.env.APPSTATE_ENCRYPTION_KEY || "";
  if (fs.existsSync(appstatePath) && !key) {
    warn(
      "ملف appstate موجود من دون تشفير؛ أضف APPSTATE_ENCRYPTION_KEY إلى البيئة.",
    );
  } else if (fs.existsSync(appstatePath) && key.length < 16) {
    warn("APPSTATE_ENCRYPTION_KEY أقصر من الحد الأدنى البالغ 16 حرفاً.");
  }

  if (!String(process.env.DB_PASSWORD || "").trim()) {
    warn("DB_PASSWORD فارغ؛ استخدم كلمة مرور لقاعدة البيانات.");
  }
}

function checkAdminConfig(rootDir = ROOT) {
  const telegram = process.env.BOT_PLATFORM === "telegram";
  const adminPath = telegram
    ? path.join(rootDir, ".nexca", "telegram-admin-ids.json")
    : path.join(rootDir, "admin-ids.json");
  if (fs.existsSync(adminPath)) return;

  warn(
    `${path.basename(adminPath)} غير موجود؛ سيبقى المالك وحده مخولاً بإدارة البوت.`,
  );
}

function checkEnvExposure() {
  if (
    process.env.SPY_IMAGE_PUBLIC_BASE_URL &&
    !process.env.SPY_IMAGE_LINK_SECRET
  ) {
    warn(
      "الروابط العامة للصور مفعّلة دون SPY_IMAGE_LINK_SECRET صريح؛ تأكد من حماية ملف السر المخزن محلياً.",
    );
  }
}

function checkDependenciesHygiene(rootDir = ROOT) {
  if (!fs.existsSync(path.join(rootDir, "package-lock.json"))) {
    warn(
      "package-lock.json غير موجود؛ ثبّت التبعيات في بيئة موثوقة واحتفظ بملف القفل.",
    );
  }
}

function run() {
  checkFilePerms();
  checkRootUser();
  checkEncryption();
  checkAdminConfig();
  checkEnvExposure();
  checkDependenciesHygiene();
  console.log("[security] اكتمل فحص الإعدادات الأساسية.");
}

module.exports = {
  run,
  _internal: {
    checkFilePerms,
    checkRootUser,
    checkEncryption,
    checkAdminConfig,
    checkEnvExposure,
    checkDependenciesHygiene,
  },
};
