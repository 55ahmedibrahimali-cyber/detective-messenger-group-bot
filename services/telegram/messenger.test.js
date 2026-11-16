const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

test("Telegram selects its own messenger transport without loading FCA", () => {
  const projectRoot = path.resolve(__dirname, "../..");
  const script = [
    'process.env.BOT_PLATFORM = "telegram";',
    'const selected = require("./services/messenger");',
    'const telegram = require("./services/telegram/messenger");',
    'if (selected !== telegram) process.exit(1);',
    'if (require.cache[require.resolve("./services/messengerFacebook")]) process.exit(2);',
    'require("./services/gameManager");',
    'if (require.cache[require.resolve("./services/messengerFacebook")]) process.exit(3);',
    'console.log("Telegram transport is isolated.");',
  ].join("\n");
  const result = spawnSync(process.execPath, ["-e", script], {
    cwd: projectRoot,
    encoding: "utf8",
    timeout: 10000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /Telegram transport is isolated/);
  assert.doesNotMatch(result.stdout, /\[messenger\] FCA:/);
});

test("Telegram sends multiple Pinterest images in one media-group request", () => {
  const projectRoot = path.resolve(__dirname, "../..");
  const script = [
    'const fs = require("node:fs");',
    'const os = require("node:os");',
    'const path = require("node:path");',
    'process.env.TELEGRAM_BOT_TOKEN = "123456:TEST";',
    'process.env.TELEGRAM_ENV_PATH = path.join(os.tmpdir(), "missing-pinterest-album-env");',
    'const safetyPath = path.join(os.tmpdir(), `pinterest-album-${process.pid}.json`);',
    'process.env.SAFETY_STATE_PATH = safetyPath;',
    'const telegram = require("./telegram");',
    'let request;',
    'global.fetch = async (url, options) => {',
    '  request = { url, options };',
    '  return { ok: true, status: 200, json: async () => ({ ok: true, result: [{ message_id: 7 }, { message_id: 8 }] }) };',
    '};',
    '(async () => {',
    '  try {',
    '    const result = await telegram._internal.sendMediaGroup("12345", [',
    '      { buffer: Buffer.from("first"), contentType: "image/jpeg", caption: "صورة 1/2" },',
    '      { buffer: Buffer.from("second"), contentType: "image/png", caption: "صورة 2/2" },',
    '    ]);',
    '    const media = JSON.parse(request.options.body.get("media"));',
    '    if (!request.url.endsWith("/sendMediaGroup")) throw new Error("expected one sendMediaGroup call");',
    '    if (media.length !== 2 || media.some((item) => item.type !== "photo")) throw new Error("album media was not encoded");',
    '    if (!request.options.body.get("album_file_0") || !request.options.body.get("album_file_1")) throw new Error("album files were not attached");',
    '    if (result.length !== 2) throw new Error("expected both message results");',
    '    console.log("Pinterest images were sent as one Telegram album.");',
    '  } finally {',
    '    fs.rmSync(safetyPath, { force: true });',
    '  }',
    '})().catch((error) => { console.error(error.message); process.exitCode = 1; });',
  ].join("\n");
  const result = spawnSync(process.execPath, ["-e", script], {
    cwd: projectRoot,
    encoding: "utf8",
    timeout: 10000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /one Telegram album/);
});
