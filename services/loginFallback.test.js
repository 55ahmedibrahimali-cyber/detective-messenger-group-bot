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
    `module.exports = function login(creds, cb) {
      global.__loginAttempts.push(creds.appState ? "appstate" : "password");
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
  process.env.LOGIN_MODE = "auto";
  process.env.FB_EMAIL = "bot@example.invalid";
  process.env.FB_PASSWORD = "test-password";
  process.env.AUTO_ACCEPT_REQUESTS = "false";

  const messenger = require("./messengerFacebook");
  const finish = (message) => {
    process.stdout.write(
      `${message}\nATTEMPTS=${JSON.stringify(global.__loginAttempts)}\nE2EE=${global.__e2eeConnections}\n`,
      () => process.exit(0),
    );
  };
  messenger.start(() => {}).then(
    () => finish("LOGIN_OK"),
    (error) => finish(`LOGIN_ERROR=${error.message}`),
  );
} else {
  function runLoginFailure(error) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "login-fallback-"));
    try {
      return spawnSync(process.execPath, [__filename], {
        env: {
          ...process.env,
          LOGIN_FALLBACK_CHILD: "1",
          LOGIN_FALLBACK_DIR: dir,
          LOGIN_FALLBACK_ERROR: error,
        },
        encoding: "utf8",
        timeout: 15000,
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  test("auto mode falls back once when the saved session is rejected", () => {
    const result = runLoginFailure("Not logged in");
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /LOGIN_OK/);
    assert.match(result.stdout, /ATTEMPTS=\["appstate","password"\]/);
    assert.match(result.stdout, /E2EE=1/);
  });

  test("auto mode does not fall back after an account checkpoint", () => {
    const result = runLoginFailure("checkpoint required");
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /LOGIN_ERROR=checkpoint required/);
    assert.match(result.stdout, /ATTEMPTS=\["appstate"\]/);
  });

  test("auto mode does not retry the password after a transient login error", () => {
    const result = runLoginFailure("network timeout");
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /LOGIN_ERROR=network timeout/);
    assert.match(result.stdout, /ATTEMPTS=\["appstate"\]/);
  });
}
