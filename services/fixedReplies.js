const db = require("../database");

const CACHE_TTL_MS = 30_000;
const MAX_TRIGGER_LENGTH = 100;
const MAX_RESPONSE_LENGTH = 1000;
let cachedReplies = null;
let cachedAt = 0;
let cacheLoad = null;

function normalize(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\u064B-\u065F\u0670\u0640\u200c\u200d]/g, "")
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function validate(trigger, response) {
  const cleanTrigger = String(trigger || "").trim();
  const cleanResponse = String(response || "").trim();
  const triggerKey = normalize(cleanTrigger);
  if (!triggerKey || cleanTrigger.length > MAX_TRIGGER_LENGTH)
    throw new Error("المحفز مطلوب، ويجب ألا يتجاوز 100 حرف.");
  if (!cleanResponse || cleanResponse.length > MAX_RESPONSE_LENGTH)
    throw new Error("الرد مطلوب، ويجب ألا يتجاوز 1000 حرف.");
  return { cleanTrigger, cleanResponse, triggerKey };
}

async function loadReplies(force = false) {
  if (force && cacheLoad) await cacheLoad;
  if (
    !force &&
    cachedReplies &&
    Date.now() - cachedAt < CACHE_TTL_MS
  )
    return cachedReplies;
  if (cacheLoad) return cacheLoad;

  cacheLoad = db
    .query(
      "SELECT id, trigger_text, trigger_key, response_text FROM bot_fixed_replies ORDER BY id ASC",
    )
    .then((rows) => {
      cachedReplies = rows;
      cachedAt = Date.now();
      return rows;
    })
    .finally(() => {
      cacheLoad = null;
    });
  return cacheLoad;
}

async function findMatch(text) {
  const normalizedText = normalize(text);
  if (!normalizedText) return null;
  const paddedText = ` ${normalizedText} `;
  const replies = await loadReplies();
  const match = replies
    .filter((entry) => paddedText.includes(` ${entry.trigger_key} `))
    .sort((left, right) => right.trigger_key.length - left.trigger_key.length)[0];
  return match ? match.response_text : null;
}

async function add(trigger, response, createdBy) {
  const values = validate(trigger, response);
  await db.query(
    "INSERT INTO bot_fixed_replies (trigger_text, trigger_key, response_text, created_by) VALUES (?,?,?,?)",
    [values.cleanTrigger, values.triggerKey, values.cleanResponse, String(createdBy)],
  );
  await loadReplies(true);
}

async function remove(trigger) {
  const cleanTrigger = String(trigger || "").trim();
  const triggerKey = normalize(cleanTrigger);
  if (!triggerKey || cleanTrigger.length > MAX_TRIGGER_LENGTH)
    throw new Error("المحفز مطلوب، ويجب ألا يتجاوز 100 حرف.");
  const result = await db.query(
    "DELETE FROM bot_fixed_replies WHERE trigger_key=?",
    [triggerKey],
  );
  if (result.affectedRows) await loadReplies(true);
  return Boolean(result.affectedRows);
}

async function list() {
  return db.query(
    "SELECT trigger_text, response_text FROM bot_fixed_replies ORDER BY id DESC LIMIT 20",
  );
}

module.exports = { add, remove, list, findMatch };
