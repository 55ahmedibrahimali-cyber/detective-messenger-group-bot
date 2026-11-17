const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

if (process.env.LOGIN_FALLBACK_CHILD === "1") {
  const dir = process.env.LOGIN_FALLBACK_DIR;
  const stub = path.join(dir, "fca-stub.js");
  fs.writeFileSync(
    stub,
    `module.exports = function login(creds, options, cb) {
      if (typeof options === "function") {
        cb = options;
        options = {};
      }
      global.__loginAttempts.push(creds.appState ? "appstate" : "password");
      global.__loginOptions = options;
      if (creds.appState) return cb(new Error(process.env.LOGIN_FALLBACK_ERROR));
      cb(null, {
        setOptions() {},
        getCurrentUserID: () => "100000000000001",
        getAppState: () => [{ key: "c_user", value: "100000000000001" }],
        connectE2EE: (callback) => {
          global.__e2eeConnections++;
          callback(null);
        },
        listenMqtt: () => () => {},
      });
    };`,
  );
  fs.writeFileSync(
    path.join(dir, "appstate.json"),
    JSON.stringify([{ key: "c_user", value: "100000000000001" }]),
  );
  global.__loginAttempts = [];
  global.__e2eeConnections = 0;
  process.env.FCA_MODULE = stub;
  process.env.APPSTATE_PATH = path.join(dir, "appstate.json");
  process.env.SAFETY_STATE_PATH = path.join(dir, "safety.json");
  process.env.LOGIN_LOCK_PATH = path.join(dir, "login-lock.json");
  process.env.BOT_PROCESS_LOCK_PATH = path.join(dir, "bot.lock");
  process.env.USER_AGENT =
    process.env.LOGIN_FALLBACK_USER_AGENT || "test-browser-user-agent";
  process.env.HTTPS_PROXY = process.env.LOGIN_FALLBACK_PROXY || "";
  process.env.LOGIN_MODE = process.env.LOGIN_FALLBACK_MODE || "auto";
  process.env.FB_EMAIL = "bot@example.invalid";
  process.env.FB_PASSWORD = "test-password";
  process.env.AUTO_ACCEPT_REQUESTS = "false";
  if (process.env.LOGIN_FALLBACK_PRELOCK === "1") {
    fs.writeFileSync(
      process.env.LOGIN_LOCK_PATH,
      JSON.stringify({
        ts: fs.statSync(process.env.APPSTATE_PATH).mtimeMs + 1000,
        blockedUntil: Date.now() + 60_000,
        reason: "checkpoint required",
      }),
    );
  }

  const messenger = require("./messengerFacebook");
  const finish = (message) => {
    let loginLock = null;
    try {
      loginLock = JSON.stringify(
        JSON.parse(fs.readFileSync(process.env.LOGIN_LOCK_PATH, "utf8")),
      );
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    process.stdout.write(
      `${message}\nATTEMPTS=${JSON.stringify(global.__loginAttempts)}\nOPTIONS=${JSON.stringify(global.__loginOptions)}\nLOGIN_LOCK=${loginLock}\nE2EE=${global.__e2eeConnections}\n`,
      () => process.exit(0),
    );
  };
  messenger.start(() => {}).then(
    () => finish("LOGIN_OK"),
    (error) => finish(`LOGIN_ERROR=${error.message}`),
  );
} else {
  function runLoginFailure(error, settings = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "login-fallback-"));
    try {
      return spawnSync(process.execPath, [__filename], {
        env: {
          ...process.env,
          LOGIN_FALLBACK_CHILD: "1",
          LOGIN_FALLBACK_DIR: dir,
          LOGIN_FALLBACK_ERROR: error,
          LOGIN_FALLBACK_MODE: settings.mode || "auto",
          LOGIN_FALLBACK_PRELOCK: settings.prelock ? "1" : "0",
          FORCE_LOGIN: settings.forceLogin ? "1" : "",
        },
        encoding: "utf8",
        timeout: 15000,
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  test("auto mode never falls back to a password when the saved session is rejected", () => {
    const result = runLoginFailure("Not logged in");
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /LOGIN_ERROR=Not logged in/);
    assert.match(result.stdout, /ATTEMPTS=\["appstate"\]/);
  });

  test("appstate mode is the default and does not attempt a password", () => {
    const result = runLoginFailure("Not logged in", { mode: "appstate" });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /LOGIN_ERROR=Not logged in/);
    assert.match(result.stdout, /ATTEMPTS=\["appstate"\]/);
  });

  test("FORCE_LOGIN cannot bypass the saved checkpoint lock", () => {
    const result = runLoginFailure("unused", {
      mode: "appstate",
      prelock: true,
      forceLogin: true,
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /LOGIN_ERROR=.*تم إيقاف محاولات الدخول/);
    assert.match(result.stdout, /ATTEMPTS=\[\]/);
  });

  test("a checkpoint records the existing login lock and never retries with a password", () => {
    const result = runLoginFailure("checkpoint required");
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /LOGIN_ERROR=checkpoint required/);
    assert.match(result.stdout, /ATTEMPTS=\["appstate"\]/);
    const lockMatch = result.stdout.match(/LOGIN_LOCK=(\{.*\})/);
    assert.ok(lockMatch, result.stdout);
    const lock = JSON.parse(lockMatch[1]);
    assert.match(lock.reason, /checkpoint required/);
    assert.ok(lock.blockedUntil > Date.now());
  });

  test("auto mode does not retry the password after a transient login error", () => {
    const result = runLoginFailure("network timeout");
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /LOGIN_ERROR=network timeout/);
    assert.match(result.stdout, /ATTEMPTS=\["appstate"\]/);
  });

  test("passes the configured browser user-agent and HTTPS proxy to FCA", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "login-options-"));
    try {
      const result = spawnSync(process.execPath, [__filename], {
        env: {
          ...process.env,
          LOGIN_FALLBACK_CHILD: "1",
          LOGIN_FALLBACK_DIR: dir,
          LOGIN_FALLBACK_ERROR: "network timeout",
          LOGIN_FALLBACK_USER_AGENT: "Example browser user agent",
          LOGIN_FALLBACK_PROXY: "http://127.0.0.1:8888",
        },
        encoding: "utf8",
        timeout: 15000,
      });
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.match(
        result.stdout,
        /OPTIONS=\{"userAgent":"Example browser user agent","proxy":"http:\/\/127\.0\.0\.1:8888"\}/,
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}
