"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createIdlePause, IDLE_TIMEOUT_MS } = require("./idlePause");

test("idle pause starts after 15 minutes and only resume resets it", () => {
  let now = 1_000;
  let paused = false;
  let idleTransitions = 0;
  const idle = createIdlePause({
    now: () => now,
    isPaused: () => paused,
    onIdle: () => {
      paused = true;
      idleTransitions += 1;
    },
  });

  now += IDLE_TIMEOUT_MS - 1;
  assert.equal(idle.check(), false);
  assert.equal(idle.noteActivity(), true);
  now += IDLE_TIMEOUT_MS;
  assert.equal(idle.check(), true);
  assert.equal(idle.isIdle(), true);
  assert.equal(idle.noteActivity(), false);
  assert.equal(idleTransitions, 1);

  paused = false;
  idle.resume();
  assert.equal(idle.isIdle(), false);
  now += IDLE_TIMEOUT_MS - 1;
  assert.equal(idle.check(), false);
  now += 1;
  assert.equal(idle.check(), true);
  assert.equal(idleTransitions, 2);
});

test("manual pause does not trigger or reset the idle pause", () => {
  let now = 5_000;
  let paused = true;
  const idle = createIdlePause({
    now: () => now,
    isPaused: () => paused,
  });

  now += IDLE_TIMEOUT_MS * 2;
  assert.equal(idle.check(), false);
  assert.equal(idle.noteActivity(), false);
  assert.equal(idle.isIdle(), false);

  paused = false;
  idle.resume();
  now += IDLE_TIMEOUT_MS - 1;
  assert.equal(idle.check(), false);
});
