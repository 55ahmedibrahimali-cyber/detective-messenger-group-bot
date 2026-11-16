const fs = require("node:fs");
const fsPromises = require("node:fs/promises");
const path = require("node:path");

const configPath = path.join(__dirname, "..", "admin-ids.json");
const OWNER_ID = "61555344774852";
const OWNER_NAME = "لايت";
let adminIds = new Set();
let configError = null;
let persistQueue = Promise.resolve();

try {
  const parsed = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const ids = Array.isArray(parsed) ? parsed : parsed.adminIds;
  if (
    !Array.isArray(ids) ||
    ids.some((id) => typeof id !== "string" || !/^\d{1,64}$/.test(id))
  )
    throw new Error("admin-ids.json must contain an array of Messenger ID strings.");
  adminIds = new Set(ids);
} catch (error) {
  if (error.code !== "ENOENT") configError = error;
}

function isAdmin(userId) {
  return isOwner(userId) || adminIds.has(String(userId));
}

function isOwner(userId) {
  return String(userId) === OWNER_ID;
}

function assertConfig() {
  if (configError) throw configError;
  if (adminIds.size === 0)
    console.warn(
      "[admin] No additional admins configured. The bot owner retains owner privileges.",
    );
}

function addAdmin(userId) {
  const id = String(userId);
  if (!/^\d{1,64}$/.test(id))
    return Promise.reject(new Error("Admin ID must be a numeric Messenger ID."));
  if (isOwner(id)) return Promise.resolve(false);
  if (configError) return Promise.reject(configError);

  const operation = persistQueue.then(async () => {
    if (adminIds.has(id)) return false;
    const updatedIds = [...adminIds, id];
    const temporaryPath = `${configPath}.${process.pid}.tmp`;
    try {
      await fsPromises.writeFile(
        temporaryPath,
        `${JSON.stringify({ adminIds: updatedIds }, null, 2)}\n`,
        { encoding: "utf8", flag: "w" },
      );
      await fsPromises.rename(temporaryPath, configPath);
    } catch (error) {
      await fsPromises.rm(temporaryPath, { force: true });
      throw error;
    }
    adminIds = new Set(updatedIds);
    return true;
  });
  persistQueue = operation.catch(() => {});
  return operation;
}

function removeAdmin(userId) {
  const id = String(userId);
  if (!/^\d{1,64}$/.test(id))
    return Promise.reject(new Error("Admin ID must be a numeric Messenger ID."));
  if (isOwner(id)) return Promise.reject(new Error("The bot owner cannot be demoted."));
  if (configError) return Promise.reject(configError);

  const operation = persistQueue.then(async () => {
    if (!adminIds.has(id)) return false;
    const updatedIds = [...adminIds].filter((adminId) => adminId !== id);
    const temporaryPath = `${configPath}.${process.pid}.tmp`;
    try {
      await fsPromises.writeFile(
        temporaryPath,
        `${JSON.stringify({ adminIds: updatedIds }, null, 2)}\n`,
        { encoding: "utf8", flag: "w" },
      );
      await fsPromises.rename(temporaryPath, configPath);
    } catch (error) {
      await fsPromises.rm(temporaryPath, { force: true });
      throw error;
    }
    adminIds = new Set(updatedIds);
    return true;
  });
  persistQueue = operation.catch(() => {});
  return operation;
}

module.exports = {
  isAdmin,
  isOwner,
  ownerName: OWNER_NAME,
  addAdmin,
  removeAdmin,
  assertConfig,
};
