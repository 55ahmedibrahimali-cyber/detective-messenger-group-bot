const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

if (process.env.PRIVATE_MESSAGE_CHILD === "1") {
  const dir = process.env.PRIVATE_MESSAGE_DIR;
  const stub = path.join(dir, "fca-stub.js");
  fs.writeFileSync(
    stub,
    `module.exports = function login(creds, options, cb) {
      if (typeof options === "function") cb = options;
      cb(null, {
        setOptions() {},
        getCurrentUserID: () => "100000000000001",
        getAppState: () => [],
        sendMessage(body, threadID, callback, replyToMessage, isGroup) {
          global.__privateCalls.push({ body, threadID, isGroup });
          callback(null, { messageID: "private-message-id" });
        },
        listenMqtt() { return () => {}; },
      });
    };`,
  );
  fs.writeFileSync(
    path.join(dir, "appstate.json"),
    JSON.stringify([{ key: "c_user", value: "100000000000001" }]),
  );
  global.__privateCalls = [];
  process.env.FCA_MODULE = stub;
  process.env.APPSTATE_PATH = path.join(dir, "appstate.json");
  process.env.SAFETY_STATE_PATH = path.join(dir, "safety.json");
  process.env.BOT_PROCESS_LOCK_PATH = path.join(dir, "bot.lock");
  process.env.USER_AGENT = "test-browser-user-agent";
  process.env.LOGIN_MODE = "appstate";
  process.env.AUTO_ACCEPT_REQUESTS = "false";
  process.env.STRICT_PRIVATE = "1";
  process.env.SEND_DELAY_MIN_MS = "1";
  process.env.SEND_DELAY_MAX_MS = "1";
  process.env.HUMANIZE_ENABLED = "0";
  const safety = require("./safety");
  const messenger = require("./messengerFacebook");

  messenger.start(() => {}).then(async () => {
    try {
      const blocked = await messenger.sendPrivateWithResult("200", "blocked");
      safety.noteContact("300");
      const sent = await messenger.sendPrivate("300", "private text");
      const sentWithResult = await messenger.sendPrivateWithResult(
        "300",
        "private result",
      );
      process.stdout.write(
        `PRIVATE_RESULT=${JSON.stringify({
          blocked,
          sent,
          sentWithResult,
          calls: global.__privateCalls,
        })}\n`,
        () => process.exit(0),
      );
    } catch (error) {
      process.stderr.write(`${error.stack || error}\n`, () => process.exit(1));
    }
  }).catch((error) => {
    process.stderr.write(`${error.stack || error}\n`, () => process.exit(1));
  });
} else {
  test("private text is gated, routed as a DM, and reported as sent", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "private-message-"));
    try {
      const result = spawnSync(process.execPath, [__filename], {
        env: {
          ...process.env,
          PRIVATE_MESSAGE_CHILD: "1",
          PRIVATE_MESSAGE_DIR: dir,
        },
        encoding: "utf8",
        timeout: 15000,
      });
      assert.equal(result.status, 0, result.stdout + result.stderr);
      const line = result.stdout
        .split(/\r?\n/)
        .find((entry) => entry.startsWith("PRIVATE_RESULT="));
      assert.ok(line, result.stdout + result.stderr);
      const outcome = JSON.parse(line.slice("PRIVATE_RESULT=".length));

      assert.equal(outcome.blocked.ok, false);
      assert.equal(outcome.sent, true);
      assert.deepEqual(outcome.sentWithResult, { ok: true, reason: null });
      assert.deepEqual(outcome.calls, [
        {
          body: "private text",
          threadID: "300",
          isGroup: false,
        },
        {
          body: "private result",
          threadID: "300",
          isGroup: false,
        },
      ]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}
