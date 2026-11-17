"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createCommandCooldown } = require("./commandCooldown");

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
