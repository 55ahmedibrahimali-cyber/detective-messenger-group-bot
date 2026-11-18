const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { _internal } = require("./securityCheck");

function captureConsole(method, callback) {
  const original = console[method];
  const messages = [];
  console[method] = (...args) => messages.push(args.join(" "));
  try {
    callback();
  } finally {
    console[method] = original;
  }
  return messages;
}

test("warns when a sensitive file is readable by other Unix users", (t) => {
  if (process.platform === "win32") return t.skip("Unix file permissions only");

  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "security-check-"));
  const envPath = path.join(rootDir, ".env");
  const nexcaPath = path.join(rootDir, ".nexca");
  try {
    fs.writeFileSync(envPath, "TOKEN=test", { mode: 0o644 });
    fs.chmodSync(envPath, 0o644);
    fs.mkdirSync(nexcaPath, { mode: 0o755 });
    fs.chmodSync(nexcaPath, 0o755);
    const warnings = captureConsole("warn", () => _internal.checkFilePerms(rootDir));
    assert.ok(warnings.some((message) => message.includes(".env")));
    assert.ok(
      warnings.some(
        (message) => message.includes(".nexca") && message.includes("700"),
      ),
    );
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("strict mode refuses to run as root and restores process state", (t) => {
  if (process.platform === "win32" || typeof process.getuid !== "function")
    return t.skip("Unix user IDs only");

  const originalGetuid = process.getuid;
  const originalStrict = process.env.SECURITY_STRICT;
  process.getuid = () => 0;
  try {
    delete process.env.SECURITY_STRICT;
    const errors = captureConsole("error", () => {
      assert.doesNotThrow(() => _internal.checkRootUser());
      process.env.SECURITY_STRICT = "1";
      assert.throws(() => _internal.checkRootUser(), /SECURITY_STRICT/);
    });
    assert.equal(errors.length, 2);
  } finally {
    process.getuid = originalGetuid;
    if (originalStrict === undefined) delete process.env.SECURITY_STRICT;
    else process.env.SECURITY_STRICT = originalStrict;
  }
});

test("does not warn about a missing appstate or database password when configured", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "security-check-"));
  const appstatePath = path.join(rootDir, "appstate.json");
  const originalEnv = {
    appstatePath: process.env.APPSTATE_PATH,
    encryptionKey: process.env.APPSTATE_ENCRYPTION_KEY,
    dbPassword: process.env.DB_PASSWORD,
  };
  try {
    fs.writeFileSync(appstatePath, "[]");
    process.env.APPSTATE_PATH = appstatePath;
    process.env.APPSTATE_ENCRYPTION_KEY = "test-encryption-key";
    process.env.DB_PASSWORD = "test-password";
    const warnings = captureConsole("warn", () =>
      _internal.checkEncryption(rootDir),
    );
    assert.deepEqual(warnings, []);
  } finally {
    if (originalEnv.appstatePath === undefined) delete process.env.APPSTATE_PATH;
    else process.env.APPSTATE_PATH = originalEnv.appstatePath;
    if (originalEnv.encryptionKey === undefined)
      delete process.env.APPSTATE_ENCRYPTION_KEY;
    else process.env.APPSTATE_ENCRYPTION_KEY = originalEnv.encryptionKey;
    if (originalEnv.dbPassword === undefined) delete process.env.DB_PASSWORD;
    else process.env.DB_PASSWORD = originalEnv.dbPassword;
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});
