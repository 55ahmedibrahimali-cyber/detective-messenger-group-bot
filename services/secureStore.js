// services/secureStore.js - تخزين آمن لجلسة فيسبوك (appstate)
//  - كتابة ذرّية (ملف مؤقت ثم rename) بصلاحيات 0600 (للمالك فقط على Linux/macOS)
//  - تشفير اختياري AES-256-GCM عبر APPSTATE_ENCRYPTION_KEY (يُنصح به بشدة)
//  - نسخة احتياطية .bak بنفس الحماية
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const MAGIC = "nexca-appstate-v1";

function encryptionKey() {
  const secret = process.env.APPSTATE_ENCRYPTION_KEY || "";
  if (!secret) return null;
  if (secret.length < 16) {
    throw new Error("APPSTATE_ENCRYPTION_KEY must be at least 16 characters.");
  }
  return secret;
}

function deriveKey(secret, salt) {
  return crypto.scryptSync(secret, salt, 32);
}

function encrypt(plainText, secret) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", deriveKey(secret, salt), iv);
  const data = Buffer.concat([cipher.update(plainText, "utf8"), cipher.final()]);
  return JSON.stringify({
    format: MAGIC,
    salt: salt.toString("base64"),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: data.toString("base64"),
  });
}

function decrypt(envelope, secret) {
  if (
    !envelope ||
    envelope.format !== MAGIC ||
    typeof envelope.salt !== "string" ||
    typeof envelope.iv !== "string" ||
    typeof envelope.tag !== "string" ||
    typeof envelope.data !== "string"
  ) {
    throw new Error("Invalid encrypted appstate format.");
  }
  const salt = Buffer.from(envelope.salt, "base64");
  const iv = Buffer.from(envelope.iv, "base64");
  const tag = Buffer.from(envelope.tag, "base64");
  if (salt.length !== 16 || iv.length !== 12 || tag.length !== 16) {
    throw new Error("Invalid encrypted appstate parameters.");
  }
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    deriveKey(secret, salt),
    iv,
  );
  decipher.setAuthTag(tag);
  return Buffer.concat([
    decipher.update(Buffer.from(envelope.data, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

/** يقرأ ملف الجلسة (عادي أو مشفّر). يعيد مصفوفة كوكيز أو null. */
function readAppState(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw new Error(`Unable to read appstate file: ${error.message}`, {
      cause: error,
    });
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error("Appstate file is not valid JSON.", { cause: error });
  }
  if (parsed && parsed.format === MAGIC) {
    const secret = encryptionKey();
    if (!secret) {
      throw new Error(
        "Encrypted appstate requires APPSTATE_ENCRYPTION_KEY.",
      );
    }
    try {
      parsed = JSON.parse(decrypt(parsed, secret));
    } catch (error) {
      throw new Error(
        "Unable to decrypt appstate; check APPSTATE_ENCRYPTION_KEY and file integrity.",
        { cause: error },
      );
    }
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error("Appstate file must contain a non-empty cookie array.");
  }
  return parsed;
}

function writePrivateFile(filePath, content) {
  if (typeof content !== "string") {
    throw new TypeError("Private file content must be a string.");
  }
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${filePath}.${process.pid}.${crypto.randomBytes(8).toString("hex")}.tmp`;
  let fd;
  try {
    fd = fs.openSync(tmp, "wx", 0o600);
    fs.writeFileSync(fd, content, "utf8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(tmp, filePath);
    if (process.platform !== "win32") fs.chmodSync(filePath, 0o600);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try {
      fs.unlinkSync(tmp);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
}

/** يحفظ الكوكيز (مشفّرة إن وُجد مفتاح) مع نسخة احتياطية للملف السابق. */
function saveAppState(filePath, appState) {
  if (!Array.isArray(appState) || appState.length === 0)
    throw new Error("Refusing to save an empty appstate.");
  const plain = JSON.stringify(appState);
  const secret = encryptionKey();
  const content = secret ? encrypt(plain, secret) : JSON.stringify(appState, null, 2);
  let previous;
  try {
    previous = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw new Error(`Unable to back up appstate file: ${error.message}`, {
        cause: error,
      });
    }
  }
  if (previous !== undefined) {
    try {
      writePrivateFile(`${filePath}.bak`, previous);
    } catch (error) {
      throw new Error(`Unable to write appstate backup: ${error.message}`, {
        cause: error,
      });
    }
  }
  writePrivateFile(filePath, content);
  return Boolean(secret);
}

/** تحذير إذا كان ملف سري قابلاً للقراءة من مستخدمين آخرين (Linux/macOS فقط) */
function warnIfLoose(filePath) {
  if (process.platform === "win32") return;
  try {
    const mode = fs.statSync(filePath).mode & 0o777;
    if (mode & 0o077) {
      console.warn(
        `[security] الملف ${path.basename(filePath)} صلاحياته ${mode.toString(8)}؛ نفّذ: chmod 600 "${filePath}"`,
      );
    }
  } catch (error) {
    if (error.code !== "ENOENT") {
      console.warn(
        `[security] تعذّر فحص صلاحيات ${path.basename(filePath)}: ${error.message}`,
      );
    }
  }
}

module.exports = {
  readAppState,
  saveAppState,
  writePrivateFile,
  warnIfLoose,
  encrypt,
  decrypt,
  encryptionKey,
};
