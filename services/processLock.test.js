const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { acquireProcessLock } = require("./processLock");

function withTempDirectory(callback) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bot-process-lock-"));
  try {
    callback(directory);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test("writes the owner PID and releases its lock", () => {
  withTempDirectory((directory) => {
    const lockPath = path.join(directory, "bot.lock");
    const release = acquireProcessLock(lockPath, { pid: 1234 });

    assert.equal(JSON.parse(fs.readFileSync(lockPath, "utf8")).pid, 1234);
    release();
    assert.equal(fs.existsSync(lockPath), false);
  });
});

test("refuses a lock whose PID is alive", () => {
  withTempDirectory((directory) => {
    const lockPath = path.join(directory, "bot.lock");
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 1234 }));

    assert.throws(
      () => acquireProcessLock(lockPath, { isAlive: () => true }),
      { code: "BOT_ALREADY_RUNNING" },
    );
    assert.equal(fs.existsSync(lockPath), true);
  });
});

test("reclaims a lock whose PID is no longer alive", () => {
  withTempDirectory((directory) => {
    const lockPath = path.join(directory, "bot.lock");
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 1234 }));

    const release = acquireProcessLock(lockPath, {
      pid: 5678,
      isAlive: () => false,
    });
    assert.equal(JSON.parse(fs.readFileSync(lockPath, "utf8")).pid, 5678);
    release();
  });
});
