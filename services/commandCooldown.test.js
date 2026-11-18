"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createCommandCooldown,
  createIncomingCommandCooldown,
} = require("./commandCooldown");

test("command cooldowns are scoped by user and canonical command", () => {
  let now = 1000;
  const isCoolingDown = createCommandCooldown({ now: () => now });

  assert.equal(isCoolingDown("user-1", "help"), false);
  assert.equal(isCoolingDown("user-1", "help"), true);
  assert.equal(isCoolingDown("user-2", "help"), false);
  assert.equal(isCoolingDown("user-1", "games"), false);

  now += 3000;
  assert.equal(isCoolingDown("user-1", "help"), false);
});

test("per-command limits can be longer or disabled", () => {
  let now = 1000;
  const isCoolingDown = createCommandCooldown({
    now: () => now,
    cooldowns: new Map([
      ["image-quality", 15_000],
      ["resume-bot", 0],
    ]),
  });

  assert.equal(isCoolingDown("user-1", "image-quality"), false);
  now += 3000;
  assert.equal(isCoolingDown("user-1", "image-quality"), true);
  assert.equal(isCoolingDown("user-1", "resume-bot"), false);
  assert.equal(isCoolingDown("user-1", "resume-bot"), false);
});

test("incoming commands share a per-user cooldown across commands and chats", () => {
  let now = 1000;
  const isCoolingDown = createIncomingCommandCooldown({
    cooldownMs: 10_000,
    now: () => now,
    isCommand: (text) => /^[/!]/.test(String(text || "")),
    isExempt: (text) => String(text || "").includes("resume"),
  });

  assert.equal(
    isCoolingDown({ userId: "user-1", platform: "messenger", text: "/help" }),
    false,
  );
  assert.equal(
    isCoolingDown({ userId: "user-1", platform: "messenger", text: "/games" }),
    true,
  );
  assert.equal(
    isCoolingDown({ userId: "user-2", platform: "messenger", text: "/help" }),
    false,
  );
  assert.equal(
    isCoolingDown({ userId: "user-1", platform: "telegram", text: "/help" }),
    false,
  );
  assert.equal(
    isCoolingDown({ userId: "user-1", platform: "messenger", text: "answer" }),
    false,
  );
  assert.equal(
    isCoolingDown({ userId: "user-1", platform: "messenger", text: "/resume" }),
    false,
  );

  now += 10_000;
  assert.equal(
    isCoolingDown({ userId: "user-1", platform: "messenger", text: "/games" }),
    false,
  );
});
