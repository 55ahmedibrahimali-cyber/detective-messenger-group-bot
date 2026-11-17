const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    if (error.code === "EPERM") return true;
    throw error;
  }
}

function acquireProcessLock(lockPath, options = {}) {
  const pid = options.pid || process.pid;
  const processIsAlive = options.isAlive || isProcessAlive;
  const token = crypto.randomUUID();
  fs.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });

  for (let attempt = 0; attempt < 2; attempt++) {
    let fd;
    try {
      fd = fs.openSync(lockPath, "wx", 0o600);
      fs.writeFileSync(fd, JSON.stringify({ pid, token }));
      fs.closeSync(fd);
      fd = undefined;
      break;
    } catch (error) {
      if (fd !== undefined) fs.closeSync(fd);
      if (error.code !== "EEXIST") throw error;

      let existing;
      try {
        existing = JSON.parse(fs.readFileSync(lockPath, "utf8"));
      } catch {
        throw new Error(
          `Bot lock ${lockPath} is unreadable; verify no bot is running before removing it.`,
        );
      }

      if (!Number.isSafeInteger(existing.pid) || existing.pid < 1) {
        throw new Error(
          `Bot lock ${lockPath} has no valid PID; verify no bot is running before removing it.`,
        );
      }
      if (processIsAlive(existing.pid)) {
        throw Object.assign(
          new Error(`Another bot instance is already running (PID ${existing.pid}).`),
          { code: "BOT_ALREADY_RUNNING" },
        );
      }

      fs.unlinkSync(lockPath);
      if (attempt === 1) {
        throw new Error(`Could not acquire bot lock ${lockPath}; retry startup.`);
      }
    }
  }

  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    try {
      const current = JSON.parse(fs.readFileSync(lockPath, "utf8"));
      if (current.pid === pid && current.token === token) {
        fs.unlinkSync(lockPath);
      }
    } catch (error) {
      if (error.code !== "ENOENT") {
        console.error(`Could not release bot lock ${lockPath}: ${error.message}`);
      }
    }
    process.removeListener("exit", release);
  };
  process.once("exit", release);
  return release;
}

module.exports = { acquireProcessLock };
