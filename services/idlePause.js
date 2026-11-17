"use strict";

const IDLE_TIMEOUT_MS = 15 * 60 * 1000;

function createIdlePause({
  timeoutMs = IDLE_TIMEOUT_MS,
  now = Date.now,
  isPaused = () => false,
  onIdle = () => {},
} = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1)
    throw new TypeError("Idle timeout must be a positive integer.");
  if (typeof now !== "function")
    throw new TypeError("Idle clock must be a function.");
  if (typeof isPaused !== "function")
    throw new TypeError("Idle pause state must be a function.");
  if (typeof onIdle !== "function")
    throw new TypeError("Idle callback must be a function.");

  let lastActivityAt = now();
  let idle = false;

  function check() {
    if (idle || isPaused() || now() - lastActivityAt < timeoutMs) return false;
    idle = true;
    onIdle();
    return true;
  }

  function noteActivity() {
    check();
    if (idle || isPaused()) return false;
    lastActivityAt = now();
    return true;
  }

  function resume() {
    idle = false;
    lastActivityAt = now();
  }

  return {
    check,
    noteActivity,
    resume,
    isIdle: () => idle,
  };
}

module.exports = { createIdlePause, IDLE_TIMEOUT_MS };
