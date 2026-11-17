// يتحقق أن خطأ MQTT العابر يعيد الاستماع على نفس الجلسة بدون login جديد.
// يعمل في عملية فرعية لأن مؤقتات طبقة الإرسال تُبقي العملية حيّة.
const test = require("node:test");
const assert = require("node:assert");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

if (process.env.RECONNECT_CHILD === "1") {
  const dir = process.env.RECONNECT_DIR;
  const nativeSetTimeout = global.setTimeout;
  global.setTimeout = (callback, delay, ...args) =>
    nativeSetTimeout(
      callback,
      delay >= 5000 && delay < 45000 ? 1 : delay,
      ...args,
    );
  const stub = path.join(dir, "fca-stub.js");
  fs.writeFileSync(
    stub,
    `module.exports = function login(creds, options, cb) {
      if (typeof options === "function") cb = options;
      global.__logins++;
      cb(null, {
        setOptions() {}, getCurrentUserID: () => "100000000000001",
        getAppState: () => [], sendMessage() {},
        listenMqtt(handler) {
          global.__listens++;
          if (global.__listens === 1) setTimeout(() => handler(new Error("ECONNRESET temporary")), 10);
          if (global.__listens >= 2 && global.__listens <= 4) handler(new Error("ECONNRESET temporary"));
          if (global.__listens === 5) setImmediate(global.__finishReconnectTest);
          return () => {};
        },
      });
    };`,
  );
  fs.writeFileSync(
    path.join(dir, "appstate.json"),
    JSON.stringify([{ key: "c_user", value: "100000000000001" }]),
  );
  global.__logins = 0;
  global.__listens = 0;
  process.env.MQTT_SOFT_RETRIES = "3";
  process.env.FCA_MODULE = stub;
  process.env.APPSTATE_PATH = path.join(dir, "appstate.json");
  process.env.SAFETY_STATE_PATH = path.join(dir, "safety.json");
  process.env.BOT_PROCESS_LOCK_PATH = path.join(dir, "bot.lock");
  process.env.USER_AGENT = "test-browser-user-agent";
  process.env.LOGIN_MODE = "appstate";
  process.env.AUTO_ACCEPT_REQUESTS = "false";
  const messenger = require("./messengerFacebook");
  let timeout;
  global.__finishReconnectTest = () => {
    if (timeout) clearTimeout(timeout);
    const ok = global.__logins === 2 && global.__listens === 5;
    console.log(JSON.stringify({ logins: global.__logins, listens: global.__listens }));
    process.exit(ok ? 0 : 3);
  };
  timeout = nativeSetTimeout(() => global.__finishReconnectTest(), 10000);
  messenger.start(() => {}).catch(() => global.__finishReconnectTest());
} else {
  test("rapid MQTT errors retry the same session without losing a reconnect request", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reconnect-"));
    const res = spawnSync(process.execPath, [__filename], {
      env: { ...process.env, RECONNECT_CHILD: "1", RECONNECT_DIR: dir },
      encoding: "utf8",
      timeout: 30000,
    });
    assert.strictEqual(res.status, 0, res.stdout + res.stderr);
  });
}
