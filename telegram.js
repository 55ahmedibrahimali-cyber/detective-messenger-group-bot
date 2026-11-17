// Standalone Telegram adapter for the existing games.
// Configure TELEGRAM_BOT_TOKEN and TELEGRAM_OWNER_ID in .env.telegram.
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const telegramEnvPath =
  process.env.TELEGRAM_ENV_PATH ||
  path.join(__dirname, ".env.telegram");
const telegramConfig = require("dotenv").config({
  path: telegramEnvPath,
  override: true,
});
if (telegramConfig.error && telegramConfig.error.code !== "ENOENT") {
  throw new Error(`Unable to load Telegram configuration: ${telegramConfig.error.message}`);
}
require("./services/logRedactor").install();

const TELEGRAM_DB_NAME =
  process.env.TELEGRAM_DB_NAME || "detective_bot_telegram";
if (!/^[A-Za-z0-9_$-]{1,64}$/.test(TELEGRAM_DB_NAME)) {
  throw new Error("TELEGRAM_DB_NAME must contain 1-64 letters, numbers, underscores, or hyphens.");
}
process.env.DB_NAME = TELEGRAM_DB_NAME;
process.env.DB_HOST = process.env.TELEGRAM_DB_HOST || "127.0.0.1";
process.env.DB_PORT = process.env.TELEGRAM_DB_PORT || "3306";
process.env.DB_USER = process.env.TELEGRAM_DB_USER || "root";
process.env.DB_PASSWORD = process.env.TELEGRAM_DB_PASSWORD || "";
process.env.DB_SSL = process.env.TELEGRAM_DB_SSL || process.env.DB_SSL || "0";
process.env.DB_SSL_CA =
  process.env.TELEGRAM_DB_SSL_CA || process.env.DB_SSL_CA || "";
process.env.DB_CREATE_DATABASE =
  process.env.TELEGRAM_DB_CREATE_DATABASE || process.env.DB_CREATE_DATABASE || "1";
process.env.SPY_IMAGE_PORT = process.env.TELEGRAM_DRAWING_PORT || "3101";
process.env.TAILSCALE_FUNNEL_PORT =
  process.env.TELEGRAM_FUNNEL_PORT || "8443";
process.env.AI_CHAT_STATE_PATH = path.join(
  __dirname,
  ".nexca",
  "telegram-ai-chat.json",
);
process.env.SPY_IMAGE_LINK_SECRET_PATH = path.join(
  __dirname,
  ".nexca",
  "telegram-spy-image-link-secret",
);
process.env.SAFETY_STATE_PATH =
  process.env.SAFETY_STATE_PATH ||
  path.join(__dirname, ".nexca", "telegram-safety-state.json");
process.env.BOT_PLATFORM = "telegram";
require("./services/configLoader").loadConfig();

const { redact } = require("./services/logRedactor");
const secureStore = require("./services/secureStore");
const safety = require("./services/safety");
const aiChat = require("./services/aiChat");
const designAssistant = require("./services/designAssistant");
const animeEdit = require("./services/animeEditFal");
const pinterest = require("./services/pinterest");
const deviantArt = require("./services/deviantArt");
const welcome = require("./services/welcome");
const adminAuth = require("./services/adminAuth");
const telegramTransport = require("./services/telegram/messenger");

function printUsage() {
  console.log(
    [
      "Telegram bot commands:",
      "  node telegram.js --setup-db  Create the separate Telegram database schema.",
      "  node telegram.js             Start the Telegram bot.",
      "",
      "Configure TELEGRAM_BOT_TOKEN and TELEGRAM_OWNER_ID in .env.telegram.",
      `Telegram environment file: ${path.basename(telegramEnvPath)}`,
      `Telegram database: ${TELEGRAM_DB_NAME}`,
    ].join("\n"),
  );
}

if (process.argv.includes("--help")) {
  printUsage();
  process.exit(0);
}

if (process.argv.includes("--setup-db")) {
  const result = spawnSync(process.execPath, [path.join(__dirname, "setupDatabase.js")], {
    cwd: __dirname,
    env: { ...process.env, DB_NAME: TELEGRAM_DB_NAME },
    stdio: "inherit",
  });
  if (result.error) {
    console.error("[telegram] database setup failed:", redact(result.error.message));
    process.exitCode = 1;
  } else {
    process.exitCode = result.status ?? 1;
  }
}

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN?.trim() || "";
const OWNER_ID = process.env.TELEGRAM_OWNER_ID?.trim() || "";
const API_BASE = BOT_TOKEN
  ? `https://api.telegram.org/bot${BOT_TOKEN}`
  : "";
const ADMIN_IDS_PATH = path.join(__dirname, ".nexca", "telegram-admin-ids.json");
const MAX_UPDATE_QUEUE = 500;
const SEND_INTERVAL_MS = 3050;
const GLOBAL_SEND_INTERVAL_MS = 50;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let botInfo = null;
let manager = null;
let polling = false;
let offset = 0;
let lastGlobalSend = 0;
let sendChain = Promise.resolve();
const lastSendByChat = new Map();
const pendingByChat = new Map();
const migratedChatIds = new Map();
const knownUsers = new Map();
const lobbyMembers = new Map();
const updateQueues = new Map();
const updateIds = new Set();
const userHits = new Map();
let telegramAdmins = new Set();

function numericId(value, label) {
  const id = String(value || "").trim();
  if (!/^\d{1,20}$/.test(id)) throw new Error(`${label} must be a numeric Telegram ID.`);
  return id;
}

function loadTelegramAdmins() {
  let contents;
  try {
    contents = require("node:fs").readFileSync(ADMIN_IDS_PATH, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return new Set();
    throw new Error(`Unable to read Telegram admin list: ${error.message}`, {
      cause: error,
    });
  }
  let parsed;
  try {
    parsed = JSON.parse(contents);
  } catch (error) {
    throw new Error("Telegram admin list is invalid JSON.", { cause: error });
  }
  const ids = Array.isArray(parsed) ? parsed : parsed?.adminIds;
  if (
    !Array.isArray(ids) ||
    ids.some((id) => typeof id !== "string" || !/^\d{1,20}$/.test(id))
  ) {
    throw new Error("telegram-admin-ids.json must contain numeric Telegram IDs.");
  }
  return new Set(ids);
}

function saveTelegramAdmins(ids) {
  secureStore.writePrivateFile(
    ADMIN_IDS_PATH,
    `${JSON.stringify({ adminIds: [...ids] }, null, 2)}\n`,
  );
}

function configureTelegramAdmins() {
  const auth = require("./services/adminAuth");
  telegramAdmins = loadTelegramAdmins();
  auth.ownerName = process.env.TELEGRAM_OWNER_NAME || "مالك البوت";
  auth.isOwner = (userId) => String(userId) === OWNER_ID;
  auth.isAdmin = (userId) =>
    auth.isOwner(userId) || telegramAdmins.has(String(userId));
  auth.assertConfig = () => {
    numericId(OWNER_ID, "TELEGRAM_OWNER_ID");
  };
  auth.addAdmin = async (userId) => {
    const id = numericId(userId, "Admin ID");
    if (auth.isOwner(id) || telegramAdmins.has(id)) return false;
    const next = new Set(telegramAdmins);
    next.add(id);
    saveTelegramAdmins(next);
    telegramAdmins = next;
    return true;
  };
  auth.removeAdmin = async (userId) => {
    const id = numericId(userId, "Admin ID");
    if (auth.isOwner(id)) throw new Error("The Telegram bot owner cannot be demoted.");
    if (!telegramAdmins.has(id)) return false;
    const next = new Set(telegramAdmins);
    next.delete(id);
    saveTelegramAdmins(next);
    telegramAdmins = next;
    return true;
  };
  return auth;
}

function safeErrorMessage(error) {
  const message = String(error?.message || error || "Telegram API error");
  return (BOT_TOKEN ? message.split(BOT_TOKEN).join("[hidden]") : message).slice(
    0,
    300,
  );
}

function groupSendHint(error) {
  const message = String(error?.message || error || "");
  if (/bot was kicked|bot is not a member|chat not found/i.test(message)) {
    return "تأكد أن البوت ما زال عضواً في المجموعة.";
  }
  if (/not enough rights|have no rights|can't send messages|forbidden/i.test(message)) {
    return "تحقق من صلاحية البوت لإرسال الرسائل في إعدادات المجموعة.";
  }
  return null;
}

async function telegramCall(method, params = {}, file) {
  if (!BOT_TOKEN)
    throw new Error(`Set TELEGRAM_BOT_TOKEN in ${path.basename(telegramEnvPath)}.`);
  const endpoint = `${API_BASE}/${method}`;
  let body;
  const headers = {};
  if (file) {
    const form = new FormData();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null) {
        form.append(
          key,
          typeof value === "object" ? JSON.stringify(value) : String(value),
        );
      }
    }
    const files = Array.isArray(file) ? file : [file];
    for (const upload of files) {
      form.append(
        upload.field,
        new Blob([upload.buffer], { type: upload.contentType }),
        upload.filename,
      );
    }
    body = form;
  } else {
    headers["content-type"] = "application/json";
    body = JSON.stringify(params);
  }

  let response;
  try {
    response = await fetch(endpoint, { method: "POST", headers, body });
  } catch (error) {
    throw new Error(`Telegram ${method} request failed: ${safeErrorMessage(error)}`, {
      cause: error,
    });
  }

  let result;
  try {
    result = await response.json();
  } catch (error) {
    throw new Error(`Telegram ${method} returned invalid JSON.`, { cause: error });
  }
  if (!response.ok || !result.ok) {
    const description = String(result.description || response.statusText || "request failed");
    const error = new Error(
      `Telegram ${method} failed (${response.status}): ${safeErrorMessage({ message: description })}`,
    );
    error.telegramCode = Number(result.error_code || response.status);
    error.retryAfter = Number(result.parameters?.retry_after) || 0;
    if (result.parameters?.migrate_to_chat_id !== undefined) {
      error.migrateToChatId = String(result.parameters.migrate_to_chat_id);
    }
    throw error;
  }
  return result.result;
}

async function enqueueSend(chatId, task) {
  const key = String(chatId);
  const queued = pendingByChat.get(key) || 0;
  if (queued >= MAX_UPDATE_QUEUE) {
    throw new Error("Telegram send queue is full.");
  }
  pendingByChat.set(key, queued + 1);
  const operation = sendChain.then(async () => {
    const now = Date.now();
    const wait = Math.max(
      SEND_INTERVAL_MS - (now - (lastSendByChat.get(key) || 0)),
      GLOBAL_SEND_INTERVAL_MS - (now - lastGlobalSend),
      0,
    );
    if (wait) await sleep(wait);
    safety.assertCanSend();
    try {
      const result = await task();
      safety.onSendOk();
      lastSendByChat.set(key, Date.now());
      lastGlobalSend = Date.now();
      return result;
    } catch (error) {
      if (error.retryAfter) {
        await sleep(error.retryAfter * 1000);
        try {
          const retry = await task();
          safety.onSendOk();
          lastSendByChat.set(key, Date.now());
          lastGlobalSend = Date.now();
          return retry;
        } catch (retryError) {
          safety.onSendError(safeErrorMessage(retryError));
          throw retryError;
        }
      }
      if (error.migrateToChatId) {
        rememberChatMigration(key, error.migrateToChatId);
        try {
          const retry = await task();
          safety.onSendOk();
          lastSendByChat.set(key, Date.now());
          lastGlobalSend = Date.now();
          return retry;
        } catch (retryError) {
          safety.onSendError(safeErrorMessage(retryError));
          throw retryError;
        }
      }
      safety.onSendError(safeErrorMessage(error));
      throw error;
    }
  });
  sendChain = operation.catch(() => {});
  try {
    return await operation;
  } finally {
    const remaining = (pendingByChat.get(key) || 1) - 1;
    if (remaining) pendingByChat.set(key, remaining);
    else pendingByChat.delete(key);
  }
}

function actualChatId(platformId) {
  const value = String(platformId);
  if (!/^-?\d{1,20}$/.test(value)) {
    throw new Error("Invalid Telegram chat ID.");
  }
  return resolveMigratedChatId(value);
}

function resolveMigratedChatId(chatId) {
  let value = String(chatId);
  const visited = new Set();
  while (migratedChatIds.has(value) && !visited.has(value)) {
    visited.add(value);
    value = migratedChatIds.get(value);
  }
  for (const previous of visited) migratedChatIds.set(previous, value);
  return value;
}

function rememberChatMigration(previousChatId, nextChatId) {
  const previous = String(previousChatId);
  const next = String(nextChatId);
  if (!/^-?\d{1,20}$/.test(previous) || !/^-?\d{1,20}$/.test(next)) {
    throw new Error("Telegram returned an invalid migrated chat ID.");
  }
  migratedChatIds.set(previous, next);
}

function rememberUser(user) {
  if (!user?.id) return;
  const first = String(user.first_name || "").trim();
  const last = String(user.last_name || "").trim();
  const name = `${first} ${last}`.trim() || user.username || `لاعب${user.id}`;
  knownUsers.set(String(user.id), name.replace(/[\r\n\u0000-\u001f]/g, " ").slice(0, 100));
  if (knownUsers.size > 5000) knownUsers.delete(knownUsers.keys().next().value);
}

function rememberLobbyMember(threadId, messageId, userId) {
  const key = `${threadId}:${messageId}`;
  if (!lobbyMembers.has(key)) lobbyMembers.set(key, new Set());
  lobbyMembers.get(key).add(String(userId));
  if (lobbyMembers.size > 5000) lobbyMembers.delete(lobbyMembers.keys().next().value);
}

function replyMarkup() {
  return {
    inline_keyboard: [[{ text: "انضمام إلى اللعبة", callback_data: "game:join" }]],
  };
}

function plainText(text) {
  return String(text ?? "");
}

function splitText(text, limit = 4000) {
  if (!Number.isSafeInteger(limit) || limit < 2) {
    throw new RangeError("Telegram text chunk size must be an integer of at least two.");
  }
  const value = plainText(text);
  if (!value) return [""];
  const chunks = [];
  for (let start = 0; start < value.length;) {
    let end = Math.min(start + limit, value.length);
    if (end < value.length && /[\uD800-\uDBFF]/.test(value[end - 1])) end--;
    chunks.push(value.slice(start, end));
    start = end;
  }
  return chunks;
}

function platformText(text) {
  return plainText(text)
    .replace(/تفاعل للانضمام/g, "اضغط «انضمام إلى اللعبة» للانضمام")
    .replace(/تفاعل مع رسالة بدء التسجيل/g, "اضغط «انضمام إلى اللعبة» في رسالة التسجيل")
    .replace(/الأدوار في الخاص/g, "ابدأ البوت في الخاص لاستلام الأدوار")
    .replace(
      /راجعوا طلبات الرسائل(?: وأعيدوا المحاولة)?/g,
      "افتحوا الخاص مع البوت واضغطوا /start ثم أعيدوا المحاولة",
    )
    .replace(
      /راجع طلبات الرسائل(?: وإعدادات الخصوصية)?/g,
      "افتح الخاص مع البوت واضغط /start ثم أعد المحاولة",
    );
}

async function sendMessage(chatId, text, withJoinButton = false) {
  const chunks = splitText(platformText(text));
  let result;
  for (let index = 0; index < chunks.length; index++) {
    result = await enqueueSend(chatId, () =>
      telegramCall("sendMessage", {
        chat_id: actualChatId(chatId),
        text: chunks[index],
        ...(withJoinButton && index === chunks.length - 1
          ? { reply_markup: replyMarkup() }
          : {}),
        disable_web_page_preview: true,
      }),
    );
  }
  return result;
}

async function sendPhoto(chatId, buffer, contentType, caption = "") {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new TypeError("Telegram photo must be a non-empty Buffer.");
  }
  if (buffer.length > 10 * 1024 * 1024) {
    throw new Error("Telegram photo exceeds the 10 MB limit.");
  }
  const mime = contentType === "image/jpeg" || contentType === "image/webp"
    ? contentType
    : "image/png";
  const extension = mime === "image/jpeg" ? "jpg" : mime === "image/webp" ? "webp" : "png";
  const method = mime === "image/webp" ? "sendDocument" : "sendPhoto";
  const field = mime === "image/webp" ? "document" : "photo";
  return enqueueSend(chatId, () =>
    telegramCall(
      method,
      {
        chat_id: actualChatId(chatId),
        caption: splitText(platformText(caption), 1024)[0],
      },
      { field, buffer, contentType: mime, filename: `game.${extension}` },
    ),
  );
}

function isMp4Buffer(buffer) {
  return (
    Buffer.isBuffer(buffer) &&
    buffer.length >= 12 &&
    buffer.toString("ascii", 4, 8) === "ftyp"
  );
}

async function sendVideo(chatId, buffer, caption = "") {
  if (!isMp4Buffer(buffer))
    throw new TypeError("Telegram video must be a valid MP4 Buffer.");
  if (buffer.length > 50 * 1024 * 1024)
    throw new Error("Telegram video exceeds the 50 MB limit.");
  return enqueueSend(chatId, () =>
    telegramCall(
      "sendVideo",
      {
        chat_id: actualChatId(chatId),
        caption: splitText(platformText(caption), 1024)[0],
        supports_streaming: true,
      },
      {
        field: "video",
        buffer,
        contentType: "video/mp4",
        filename: "anime-edit.mp4",
      },
    ),
  );
}

async function sendMediaGroup(chatId, images) {
  if (!Array.isArray(images) || images.length < 2 || images.length > 10) {
    throw new RangeError("Telegram media groups require 2 to 10 images.");
  }
  for (const image of images) {
    if (!Buffer.isBuffer(image?.buffer) || image.buffer.length === 0)
      throw new TypeError("Telegram album images must be non-empty Buffers.");
    if (image.buffer.length > 10 * 1024 * 1024)
      throw new Error("Telegram album image exceeds the 10 MB limit.");
  }

  const asDocuments = images.some((image) => image.contentType === "image/webp");
  const type = asDocuments ? "document" : "photo";
  const files = images.map((image, index) => {
    const contentType =
      image.contentType === "image/jpeg" ||
      image.contentType === "image/png" ||
      image.contentType === "image/webp"
        ? image.contentType
        : null;
    if (!contentType)
      throw new TypeError("Telegram album image has an unsupported content type.");
    const extension =
      contentType === "image/jpeg"
        ? "jpg"
        : contentType === "image/webp"
          ? "webp"
          : "png";
    return {
      field: `album_file_${index}`,
      buffer: image.buffer,
      contentType,
      filename: `pinterest-${index + 1}.${extension}`,
    };
  });
  const media = images.map((image, index) => ({
    type,
    media: `attach://album_file_${index}`,
    caption: splitText(platformText(image.caption || ""), 1024)[0],
  }));
  return enqueueSend(chatId, () =>
    telegramCall(
      "sendMediaGroup",
      { chat_id: actualChatId(chatId), media },
      files,
    ),
  );
}

function messageIdOf(result) {
  return result?.message_id === undefined ? null : String(result.message_id);
}

function privateMessageUserHint(reason, error) {
  const reasonText = String(reason || "");
  const errorText = String(error?.message || error || "");
  if (/لم يبدأ محادثة خاصة/.test(reasonText)) {
    return "افتح محادثة خاصة مع البوت واضغط /start، ثم أعد محاولة الرسم.";
  }
  if (
    error?.telegramCode === 403 ||
    /chat not found|bot can't initiate|user is deactivated|blocked by the user/i.test(
      errorText,
    )
  ) {
    return "لم يستطع البوت مراسلتك في الخاص. افتح محادثة البوت واضغط /start، ثم أعد محاولة الرسم.";
  }
  return null;
}

function telegramMessenger() {
  const messenger = telegramTransport;
  messenger.sendGroup = async (threadId, text) => {
    try {
      await sendMessage(threadId, text);
      return true;
    } catch (error) {
      const hint = groupSendHint(error);
      console.error(
        `[telegram] group message failed${hint ? `; ${hint}` : ""}:`,
        safeErrorMessage(error),
      );
      return false;
    }
  };
  messenger.sendGroupTracked = async (threadId, text) => {
    try {
      const result = await sendMessage(threadId, text, true);
      return messageIdOf(result);
    } catch (error) {
      console.error("[telegram] lobby message failed:", safeErrorMessage(error));
      return null;
    }
  };
  messenger.sendGroupImageBufferTracked = async (
    threadId,
    buffer,
    contentType,
    caption,
  ) => {
    try {
      const result = await sendPhoto(threadId, buffer, contentType, caption);
      return messageIdOf(result);
    } catch (error) {
      console.error("[telegram] group photo failed:", safeErrorMessage(error));
      return null;
    }
  };
  messenger.sendGroupVideoBufferTracked = async (
    threadId,
    buffer,
    _contentType,
    caption,
  ) => {
    try {
      const result = await sendVideo(threadId, buffer, caption);
      return messageIdOf(result);
    } catch (error) {
      console.error("[telegram] group video failed:", safeErrorMessage(error));
      return null;
    }
  };
  messenger.sendGroupImageBuffersTracked = async (threadId, images) => {
    try {
      const results = await sendMediaGroup(threadId, images);
      return messageIdOf(results?.[0]);
    } catch (error) {
      console.error("[telegram] group image album failed:", safeErrorMessage(error));
      return null;
    }
  };
  messenger.sendGroupImageTracked = async (threadId, filePath, caption) => {
    const fs = require("node:fs/promises");
    const ext = path.extname(filePath).toLowerCase();
    const mime = ext === ".jpg" || ext === ".jpeg"
      ? "image/jpeg"
      : ext === ".webp"
        ? "image/webp"
        : "image/png";
    return messenger.sendGroupImageBufferTracked(
      threadId,
      await fs.readFile(filePath),
      mime,
      caption,
    );
  };

  async function sendPrivateResult(userId, text, allowOptOut = false) {
    const reason = safety.privateBlockReason(userId, {
      allowOptOut,
      requireContact: false,
    });
    if (reason) {
      return {
        ok: false,
        reason,
        userMessage: privateMessageUserHint(reason),
        messageId: null,
      };
    }
    try {
      const result = await sendMessage(userId, text);
      return { ok: true, reason: null, messageId: messageIdOf(result) };
    } catch (error) {
      return {
        ok: false,
        reason: safeErrorMessage(error),
        userMessage: privateMessageUserHint(null, error),
        messageId: null,
      };
    }
  }

  messenger.sendPrivateWithResult = (userId, text) =>
    sendPrivateResult(userId, text);
  messenger.sendPrivateNotice = (userId, text) =>
    sendPrivateResult(userId, text, true).then((result) => result.ok);
  messenger.sendPrivate = async (userId, text) =>
    (await messenger.sendPrivateWithResult(userId, text)).ok;
  messenger.sendPrivateImageBufferWithResult = async (
    userId,
    buffer,
    contentType,
    caption,
  ) => {
    const reason = safety.privateBlockReason(userId, { requireContact: false });
    if (reason) return { ok: false, reason, messageId: null };
    try {
      const result = await sendPhoto(userId, buffer, contentType, caption);
      return { ok: true, reason: null, messageId: messageIdOf(result) };
    } catch (error) {
      return { ok: false, reason: safeErrorMessage(error), messageId: null };
    }
  };
  messenger.sendPrivateVideoBufferWithResult = async (
    userId,
    buffer,
    _contentType,
    caption,
  ) => {
    const reason = safety.privateBlockReason(userId, { requireContact: false });
    if (reason) return { ok: false, reason, messageId: null };
    try {
      const result = await sendVideo(userId, buffer, caption);
      return { ok: true, reason: null, messageId: messageIdOf(result) };
    } catch (error) {
      return { ok: false, reason: safeErrorMessage(error), messageId: null };
    }
  };
  messenger.sendPrivateImageBuffersWithResult = async (userId, images) => {
    const reason = safety.privateBlockReason(userId, { requireContact: false });
    if (reason) return { ok: false, reason, messageId: null };
    try {
      const results = await sendMediaGroup(userId, images);
      return {
        ok: true,
        reason: null,
        messageId: messageIdOf(results?.[0]),
      };
    } catch (error) {
      return { ok: false, reason: safeErrorMessage(error), messageId: null };
    }
  };
  messenger.sendPrivateImageWithResult = async (userId, filePath, caption) => {
    const fs = require("node:fs/promises");
    const ext = path.extname(filePath).toLowerCase();
    const mime = ext === ".jpg" || ext === ".jpeg"
      ? "image/jpeg"
      : ext === ".webp"
        ? "image/webp"
        : "image/png";
    return messenger.sendPrivateImageBufferWithResult(
      userId,
      await fs.readFile(filePath),
      mime,
      caption,
    );
  };
  messenger.getReactors = async (threadId, messageId) =>
    [...(lobbyMembers.get(`${threadId}:${messageId}`) || [])];
  messenger.getUserName = async (userId) => {
    const id = String(userId);
    if (knownUsers.has(id)) return knownUsers.get(id);
    try {
      const chat = await telegramCall("getChat", { chat_id: actualChatId(id) });
      rememberUser(chat);
      return knownUsers.get(id) || `لاعب${id}`;
    } catch (error) {
      console.warn(
        "[telegram] could not fetch player name:",
        safeErrorMessage(error),
      );
      return `لاعب${id}`;
    }
  };
  messenger.removeUserFromGroup = async (userId, threadId) =>
    telegramCall("banChatMember", {
      chat_id: actualChatId(threadId),
      user_id: numericId(userId, "Telegram user ID"),
    });
  messenger.getConnectionStatus = () => ({
    loggedIn: true,
    listenerHealthy: polling,
    e2eeSupported: false,
    e2eeConnected: false,
  });
  messenger.selfId = () => (botInfo ? String(botInfo.id) : "");
  messenger.start = async () => {};
  return messenger;
}

function normalizeText(message) {
  let text = String(message.text || message.caption || "").trim();
  if (botInfo?.username) {
    text = text.replace(
      new RegExp(`^(\\/[A-Za-z0-9_]+)@${botInfo.username}(?=\\s|$)`, "i"),
      "$1",
    );
  }
  return text;
}

function isGroupChat(chat) {
  return chat?.type === "group" || chat?.type === "supergroup";
}

function contextFromMessage(message) {
  const chatId = String(message.chat.id);
  const userId = String(message.from.id);
  const isGroup = isGroupChat(message.chat);
  const replyTo = message.reply_to_message;
  return {
    userId,
    threadId: isGroup ? chatId : userId,
    messageId: String(message.message_id),
    isGroup,
    userName:
      [message.from.first_name, message.from.last_name]
        .filter(Boolean)
        .join(" ")
        .trim() || message.from.username || "",
    text: normalizeText(message),
    messageReply: replyTo?.from?.id
      ? { senderID: String(replyTo.from.id), body: replyTo.text || "" }
      : null,
  };
}

async function downloadTelegramDesignReference(photoSizes) {
  const photo = Array.isArray(photoSizes) ? photoSizes.at(-1) : null;
  if (!photo?.file_id) throw new Error("Telegram photo is missing its file ID.");
  if (Number(photo.file_size) > 5 * 1024 * 1024)
    throw new Error("Telegram design reference exceeds the 5 MB limit.");
  const file = await telegramCall("getFile", { file_id: photo.file_id });
  if (!file?.file_path || file.file_path.includes(".."))
    throw new Error("Telegram returned an invalid photo path.");

  let response;
  try {
    response = await fetch(
      `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`,
      { redirect: "error", signal: AbortSignal.timeout(15000) },
    );
  } catch (error) {
    throw new Error(`Unable to download Telegram design reference: ${safeErrorMessage(error)}`, {
      cause: error,
    });
  }
  if (!response.ok)
    throw new Error(`Telegram photo download failed (${response.status}).`);
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > 5 * 1024 * 1024)
    throw new Error("Telegram design reference exceeds the 5 MB limit.");
  if (!response.body) throw new Error("Telegram photo download returned no data.");
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > 5 * 1024 * 1024) {
      await reader.cancel();
      throw new Error("Telegram design reference exceeds the 5 MB limit.");
    }
    chunks.push(Buffer.from(value));
  }
  const buffer = Buffer.concat(chunks, total);
  if (!buffer.length) throw new Error("Telegram design reference is empty.");
  return { buffer, contentType: "image/jpeg" };
}

function isDesignCommand(text) {
  return /^\s*[/!]?\s*(?:تصميم|design)(?:\s|$)/i.test(String(text || ""));
}

function isQualityCommand(text) {
  return /^\s*[/!]?\s*(?:جودة|quality|رفع_الجودة)(?:\s|$)/i.test(
    String(text || ""),
  );
}

function enqueueUpdate(chatId, handler) {
  const previous = updateQueues.get(chatId) || Promise.resolve();
  const next = previous
    .then(handler)
    .catch((error) =>
      console.error("[telegram] update handler failed:", redact(error.message || error)),
    );
  updateQueues.set(chatId, next);
  next.finally(() => {
    if (updateQueues.get(chatId) === next) updateQueues.delete(chatId);
  });
}

function rateLimited(userId) {
  const now = Date.now();
  const recent = (userHits.get(userId) || []).filter(
    (timestamp) => now - timestamp < 10000,
  );
  recent.push(now);
  userHits.set(userId, recent);
  if (userHits.size > 5000) userHits.delete(userHits.keys().next().value);
  return recent.length > 8;
}

function fatalPollingError(error) {
  if (error?.telegramCode === 401) {
    return new Error("Telegram rejected the bot token; verify TELEGRAM_BOT_TOKEN.");
  }
  if (error?.telegramCode === 409) {
    return new Error(
      "Telegram polling conflict: stop other bot instances and remove any configured webhook.",
    );
  }
  return null;
}

async function handleMessage(message) {
  if (!message?.chat) return;
  const joinNotice = welcome.telegramMemberAdded(message, botInfo?.id);
  if (joinNotice) {
    enqueueUpdate(joinNotice.threadId, () =>
      telegramMessenger().sendGroup(joinNotice.threadId, joinNotice.text),
    );
    return;
  }
  if (!message.from || (!message.text && !message.caption)) return;
  rememberUser(message.from);
  const context = contextFromMessage(message);
  if (!context.text) return;

  if (!context.isGroup) {
    safety.noteContact(context.userId);
    if (safety.isStopCommand(context.text)) {
      safety.setOptOut(context.userId, true);
      const sent = await telegramMessenger().sendPrivateNotice(
        context.userId,
        'تم إيقاف الرسائل الخاصة عنك. اكتب "ابدأ" لتفعيلها مرة أخرى.',
      );
      if (!sent) console.warn("[telegram] failed to confirm private opt-out");
      return;
    }
    if (safety.isOptOut(context.userId)) {
      if (safety.isStartCommand(context.text)) {
        safety.setOptOut(context.userId, false);
        await telegramMessenger().sendPrivate(
          context.userId,
          "تم تفعيل الرسائل الخاصة.",
        );
      }
      return;
    }
  }

  if (rateLimited(context.userId)) {
    console.warn("[telegram] rate-limited incoming user:", context.userId);
    return;
  }
  if (context.text.length > 1000) {
    context.text = context.text.slice(0, 1000);
  }
  if (
    isDesignCommand(context.text) ||
    isQualityCommand(context.text) ||
    animeEdit.isCommand(context.text)
  ) {
    const referencePhoto =
      message.photo || message.reply_to_message?.photo || null;
    if (referencePhoto) {
      try {
        context.designReference =
          await downloadTelegramDesignReference(referencePhoto);
      } catch (error) {
        console.error(
          "[image command] Telegram reference download failed:",
          safeErrorMessage(error),
        );
        const transport = telegramMessenger();
        const errorText = "تعذر قراءة الصورة؛ أرسل PNG أو JPEG أصغر من 5 ميغابايت.";
        if (context.isGroup)
          await transport.sendGroup(context.threadId, errorText);
        else await transport.sendPrivate(context.userId, errorText);
        return;
      }
    }
  }
  if (!context.isGroup && /^\/start(?:@\w+)?(?:\s|$)/i.test(context.text)) {
    await telegramMessenger().sendPrivate(
      context.userId,
      "أهلاً بك! اكتب العاب لعرض الألعاب، ثم أرسل أمر اللعبة في مجموعة.",
    );
    return;
  }
  enqueueUpdate(context.threadId, async () => {
    const transport = telegramMessenger();
    const pinterestHandled = await pinterest.tryHandle(
      { ...context, platform: "telegram" },
      pinterest.createDeps(transport),
    );
    if (pinterestHandled) return;
    const deviantArtHandled = await deviantArt.tryHandle(
      { ...context, platform: "telegram" },
      deviantArt.createDeps(transport),
    );
    if (deviantArtHandled) return;
    const animeEditHandled = await animeEdit.tryHandle(
      { ...context, platform: "telegram" },
      animeEdit.createDeps(transport),
    );
    if (animeEditHandled) return;
    const designHandled = await designAssistant.tryHandle(context, {
      sendText: (threadId, text, isGroup) =>
        isGroup
          ? transport.sendGroup(threadId, text)
          : transport.sendPrivate(threadId, text),
      sendImage: async (threadId, buffer, contentType, caption, isGroup) => {
        if (isGroup)
          return Boolean(
            await transport.sendGroupImageBufferTracked(
              threadId,
              buffer,
              contentType,
              caption,
            ),
          );
        const result = await transport.sendPrivateImageBufferWithResult(
          threadId,
          buffer,
          contentType,
          caption,
        );
        return Boolean(result?.ok);
      },
    });
    if (designHandled) return;
    const handled = await aiChat.tryHandle(
      { ...context, platform: "telegram" },
      {
        send: (threadId, text, isGroup) =>
          isGroup
            ? telegramMessenger().sendGroup(threadId, text)
            : telegramMessenger().sendPrivate(threadId, text),
        selfId: () => telegramMessenger().selfId(),
        hasActiveGame: (messageContext) =>
          manager.hasActiveGame(messageContext),
        isAdmin: (userId) => adminAuth.isAdmin(userId),
      },
    );
    if (handled) return;
    return manager.handleMessage(context);
  });
}

async function handleCallback(callback) {
  const message = callback.message;
  const user = callback.from;
  if (!message?.chat || !user || callback.data !== "game:join") {
    await telegramCall("answerCallbackQuery", {
      callback_query_id: callback.id,
      text: "هذا الزر غير متاح.",
      show_alert: false,
    });
    return;
  }

  rememberUser(user);
  const threadId = String(message.chat.id);
  const messageId = String(message.message_id);
  const userId = String(user.id);
  rememberLobbyMember(threadId, messageId, userId);
  await telegramCall("answerCallbackQuery", {
    callback_query_id: callback.id,
    text: "تم تسجيل طلب الانضمام.",
    show_alert: false,
  });
  enqueueUpdate(threadId, () =>
    manager.handleReaction({ userId, threadId, messageId }),
  );
}

async function handleUpdate(update) {
  if (!update || updateIds.has(update.update_id)) return;
  updateIds.add(update.update_id);
  if (updateIds.size > 5000) updateIds.delete(updateIds.values().next().value);
  if (update.message) return handleMessage(update.message);
  if (update.callback_query) return handleCallback(update.callback_query);
}

async function poll() {
  let backoff = 1000;
  while (polling) {
    try {
      const updates = await telegramCall("getUpdates", {
        offset,
        timeout: 50,
        allowed_updates: ["message", "callback_query"],
      });
      backoff = 1000;
      for (const update of updates) {
        offset = update.update_id + 1;
        try {
          await handleUpdate(update);
        } catch (error) {
          console.error("[telegram] update failed:", redact(error.message || error));
        }
      }
    } catch (error) {
      const fatalError = fatalPollingError(error);
      if (fatalError) {
        polling = false;
        throw fatalError;
      }
      console.error("[telegram] polling failed:", safeErrorMessage(error));
      await sleep(backoff);
      backoff = Math.min(backoff * 2, 30000);
    }
  }
}

async function run() {
  if (!BOT_TOKEN) throw new Error("Set TELEGRAM_BOT_TOKEN in .env.");
  numericId(OWNER_ID, "TELEGRAM_OWNER_ID");
  secureStore.warnIfLoose(telegramEnvPath);
  const auth = configureTelegramAdmins();
  auth.assertConfig();

  botInfo = await telegramCall("getMe");
  const messenger = telegramMessenger();
  manager = require("./services/gameManager");
  const db = require("./database");

  console.log(`[telegram] bot @${botInfo.username || botInfo.id}`);
  console.log(`[telegram] using database ${TELEGRAM_DB_NAME}`);
  console.log(
    "[telegram] group games use an inline join button. For games that need free-text group messages, disable BotFather group privacy or make the bot a group admin.",
  );

  await db.assertSchema();
  await manager.assertSchemas();
  await require("./services/spyImageServer").start();
  manager.startTickers();
  polling = true;
  await poll();
}

module.exports = {
  contextFromMessage,
  isGroupChat,
  isQualityCommand,
  normalizeText,
  downloadTelegramDesignReference,
  privateMessageUserHint,
  splitText,
  platformText,
  fatalPollingError,
  groupSendHint,
  resolveMigratedChatId,
  rememberChatMigration,
  _internal: { sendMediaGroup, isMp4Buffer },
};

if (
  require.main === module &&
  !process.argv.includes("--setup-db") &&
  !process.argv.includes("--help")
) {
  run().catch((error) => {
    console.error("[telegram] startup failed:", redact(error.message || error));
    process.exit(1);
  });
}
