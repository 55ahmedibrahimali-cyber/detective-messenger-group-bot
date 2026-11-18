"use strict";

function createCommandCooldown({
  defaultCooldownMs = 3000,
  cooldowns = new Map(),
  now = Date.now,
  maxEntries = 10000,
} = {}) {
  if (!Number.isSafeInteger(defaultCooldownMs) || defaultCooldownMs < 0)
    throw new TypeError("Default command cooldown must be a non-negative integer.");
  if (typeof now !== "function")
    throw new TypeError("Command cooldown clock must be a function.");
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1)
    throw new TypeError("Command cooldown entry limit must be a positive integer.");

  const lastUsed = new Map();

  const isCommandCoolingDown = function (userId, command) {
    const id = String(userId || "").trim();
    const name = String(command || "").trim();
    if (!id || !name) throw new TypeError("Command cooldown requires user and command IDs.");

    const configured = cooldowns instanceof Map
      ? cooldowns.get(name)
      : cooldowns[name];
    const cooldownMs =
      configured === undefined ? defaultCooldownMs : configured;
    if (!Number.isSafeInteger(cooldownMs) || cooldownMs < 0)
      throw new TypeError(`Invalid cooldown for command "${name}".`);
    if (cooldownMs === 0) return false;

    const key = `${id}\0${name}`;
    const timestamp = now();
    const previous = lastUsed.get(key);
    if (previous !== undefined && timestamp - previous < cooldownMs)
      return true;

    lastUsed.set(key, timestamp);
    while (lastUsed.size > maxEntries)
      lastUsed.delete(lastUsed.keys().next().value);
    return false;
  };
  isCommandCoolingDown.reset = () => lastUsed.clear();
  return isCommandCoolingDown;
}

function createIncomingCommandCooldown({
  cooldownMs = 10_000,
  isCommand,
  isExempt = () => false,
  now = Date.now,
} = {}) {
  if (typeof isCommand !== "function")
    throw new TypeError("Incoming command cooldown requires a command detector.");
  if (typeof isExempt !== "function")
    throw new TypeError("Incoming command cooldown exemption must be a function.");

  const isCoolingDown = createCommandCooldown({
    defaultCooldownMs: cooldownMs,
    now,
  });
  return function isIncomingCommandCoolingDown({ userId, platform, text } = {}) {
    if (!userId || !isCommand(text) || isExempt(text)) return false;
    return isCoolingDown(
      `${String(platform || "messenger")}:${String(userId)}`,
      "all-commands",
    );
  };
}

module.exports = { createCommandCooldown, createIncomingCommandCooldown };
