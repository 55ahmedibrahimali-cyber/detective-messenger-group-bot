const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");

const SECRET_PATH =
  process.env.SPY_IMAGE_LINK_SECRET_PATH ||
  path.join(__dirname, "..", ".nexca", "spy-image-link-secret");
const MAX_TTL_SECONDS = 7 * 24 * 60 * 60;
let secretPromise;

function publicBaseUrl() {
  const railwayDomain = process.env.RAILWAY_PUBLIC_DOMAIN?.trim();
  const value =
    process.env.DRAWING_PUBLIC_BASE_URL?.trim() ||
    process.env.DRAWING_PUBLIC_URL?.trim() ||
    process.env.PUBLIC_URL?.trim() ||
    process.env.SPY_IMAGE_PUBLIC_BASE_URL?.trim() ||
    process.env.RENDER_EXTERNAL_URL?.trim() ||
    (railwayDomain
      ? /^[a-z][a-z\d+.-]*:\/\//i.test(railwayDomain)
        ? railwayDomain
        : `https://${railwayDomain}`
      : "");
  if (!value) return null;

  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("PUBLIC_URL / SPY_IMAGE_PUBLIC_BASE_URL must be an absolute URL.");
  }
  if (
    !["https:", "http:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      "PUBLIC_URL must be a valid HTTP or HTTPS URL (e.g. http://ip:port or https://domain.com).",
    );
  }
  if (url.pathname !== "/" && url.pathname !== "")
    throw new Error("PUBLIC_URL must not include a path.");
  return url.origin;
}

function isConfigured() {
  return Boolean(publicBaseUrl());
}

async function validateConfig() {
  if (!publicBaseUrl())
    throw new Error("SPY_IMAGE_PUBLIC_BASE_URL is not configured.");
  linkTtlSeconds();
  await secret();
}

async function loadSecret() {
  const configured = process.env.SPY_IMAGE_LINK_SECRET?.trim();
  if (configured) {
    if (Buffer.byteLength(configured, "utf8") < 32)
      throw new Error("SPY_IMAGE_LINK_SECRET must be at least 32 bytes.");
    return Buffer.from(configured, "utf8");
  }

  try {
    return await fs.readFile(SECRET_PATH);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  const generated = crypto.randomBytes(32);
  await fs.mkdir(path.dirname(SECRET_PATH), { recursive: true });
  try {
    await fs.writeFile(SECRET_PATH, generated, { flag: "wx", mode: 0o600 });
    return generated;
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    return fs.readFile(SECRET_PATH);
  }
}

function secret() {
  if (!secretPromise) secretPromise = loadSecret();
  return secretPromise;
}

function linkTtlSeconds() {
  const configured = process.env.SPY_IMAGE_LINK_TTL_SECONDS;
  const value = configured === undefined ? 7200 : Number(configured);
  if (
    !Number.isInteger(value) ||
    value < 60 ||
    value > MAX_TTL_SECONDS
  )
    throw new Error(
      `SPY_IMAGE_LINK_TTL_SECONDS must be an integer from 60 to ${MAX_TTL_SECONDS}.`,
    );
  return value;
}

function signaturePayload(gameId, imageKey, expiresAt) {
  return `v1\n${gameId}\n${imageKey}\n${expiresAt}`;
}

function validKey(value) {
  return /^[a-z0-9_-]+$/i.test(value);
}

async function createUrl(gameId, imageKey) {
  const baseUrl = publicBaseUrl();
  if (!baseUrl)
    throw new Error(
      "SPY_IMAGE_PUBLIC_BASE_URL is not configured; private image links cannot be delivered.",
    );
  if (!validKey(gameId) || !validKey(imageKey))
    throw new Error("Invalid game image link key.");

  const expiresAt = Math.floor(Date.now() / 1000) + linkTtlSeconds();
  const mac = crypto
    .createHmac("sha256", await secret())
    .update(signaturePayload(gameId, imageKey, expiresAt))
    .digest("hex");
  const url = new URL(
    `/game-images/${encodeURIComponent(gameId)}/${encodeURIComponent(imageKey)}`,
    baseUrl,
  );
  url.searchParams.set("expires", String(expiresAt));
  url.searchParams.set("signature", mac);
  return url.toString();
}

async function verify(gameId, imageKey, expiresValue, signature) {
  if (
    !validKey(gameId) ||
    !validKey(imageKey) ||
    !/^\d{1,12}$/.test(expiresValue || "") ||
    !/^[a-f0-9]{64}$/i.test(signature || "")
  )
    return false;

  const expiresAt = Number(expiresValue);
  const now = Math.floor(Date.now() / 1000);
  if (
    !Number.isSafeInteger(expiresAt) ||
    expiresAt <= now ||
    expiresAt > now + MAX_TTL_SECONDS
  )
    return false;

  const expected = crypto
    .createHmac("sha256", await secret())
    .update(signaturePayload(gameId, imageKey, expiresAt))
    .digest();
  const received = Buffer.from(signature, "hex");
  return (
    received.length === expected.length &&
    crypto.timingSafeEqual(received, expected)
  );
}

module.exports = {
  createUrl,
  isConfigured,
  validateConfig,
  verify,
  getPublicBaseUrl: publicBaseUrl,
};
