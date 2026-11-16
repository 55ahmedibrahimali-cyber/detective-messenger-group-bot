const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const secureStore = require("./secureStore");

const originalKey = process.env.APPSTATE_ENCRYPTION_KEY;

function withTempFile(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "secure-store-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, "appstate.json");
}

test.afterEach(() => {
  if (originalKey === undefined) delete process.env.APPSTATE_ENCRYPTION_KEY;
  else process.env.APPSTATE_ENCRYPTION_KEY = originalKey;
});

test("missing appstate is distinct from an unreadable or malformed file", (t) => {
  const file = withTempFile(t);
  assert.equal(secureStore.readAppState(file), null);

  fs.writeFileSync(file, "{broken");
  assert.throws(secureStore.readAppState.bind(null, file), /not valid JSON/);

  fs.writeFileSync(file, "[]");
  assert.throws(secureStore.readAppState.bind(null, file), /non-empty cookie array/);
});

test("plain appstate round-trips and preserves a backup on replacement", (t) => {
  delete process.env.APPSTATE_ENCRYPTION_KEY;
  const file = withTempFile(t);
  const first = [{ name: "session", value: "secret" }];
  const second = [{ name: "session", value: "new-secret" }];

  assert.equal(secureStore.saveAppState(file, first), false);
  assert.deepEqual(secureStore.readAppState(file), first);
  secureStore.saveAppState(file, second);

  assert.deepEqual(secureStore.readAppState(file), second);
  assert.deepEqual(JSON.parse(fs.readFileSync(`${file}.bak`, "utf8")), first);
});

test("encrypted appstate round-trips and rejects missing or incorrect keys", (t) => {
  const file = withTempFile(t);
  const appstate = [{ name: "session", value: "secret" }];
  process.env.APPSTATE_ENCRYPTION_KEY = "test-key-with-at-least-16-chars";

  assert.equal(secureStore.saveAppState(file, appstate), true);
  assert.deepEqual(secureStore.readAppState(file), appstate);

  delete process.env.APPSTATE_ENCRYPTION_KEY;
  assert.throws(secureStore.readAppState.bind(null, file), /requires APPSTATE_ENCRYPTION_KEY/);

  process.env.APPSTATE_ENCRYPTION_KEY = "incorrect-key-with-16-chars";
  assert.throws(secureStore.readAppState.bind(null, file), /Unable to decrypt appstate/);
});

test("short configured encryption keys never fall back to plaintext", (t) => {
  const file = withTempFile(t);
  process.env.APPSTATE_ENCRYPTION_KEY = "too-short";

  assert.throws(
    () => secureStore.saveAppState(file, [{ name: "session", value: "secret" }]),
    /at least 16 characters/,
  );
  assert.equal(fs.existsSync(file), false);
});

test("encrypted appstate rejects tampered authentication data", () => {
  const envelope = JSON.parse(
    secureStore.encrypt("[]", "test-key-with-at-least-16-chars"),
  );
  envelope.tag = crypto.randomBytes(16).toString("base64");
  assert.throws(
    () => secureStore.decrypt(envelope, "test-key-with-at-least-16-chars"),
  );
});
