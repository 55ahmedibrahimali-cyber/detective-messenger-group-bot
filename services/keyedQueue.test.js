const test = require("node:test");
const assert = require("node:assert/strict");
const { createKeyedQueue } = require("./keyedQueue");

test("keyed queue serializes events, caps backlog, and recovers after failure", async () => {
  const overflows = [];
  const errors = [];
  const enqueue = createKeyedQueue({
    maxPending: 2,
    onOverflow: (key, pending) => overflows.push({ key, pending }),
    onError: (error) => errors.push(error.message),
  });
  let releaseFirst;
  let markSecondDone;
  let markOtherDone;
  const firstGate = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  const secondDone = new Promise((resolve) => {
    markSecondDone = resolve;
  });
  let markRecoveredDone;
  const recoveredDone = new Promise((resolve) => {
    markRecoveredDone = resolve;
  });
  const otherDone = new Promise((resolve) => {
    markOtherDone = resolve;
  });
  const order = [];

  assert.equal(
    enqueue("group", async () => {
      order.push("first-start");
      await firstGate;
      order.push("first-end");
    }),
    true,
  );
  assert.equal(
    enqueue("group", () => {
      order.push("second");
      markSecondDone();
    }),
    true,
  );
  assert.equal(enqueue("group", () => {}), false);
  assert.equal(enqueue("group", () => {}), false);
  assert.deepEqual(overflows, [{ key: "group", pending: 2 }]);

  assert.equal(
    enqueue("other", () => {
      order.push("other");
      markOtherDone();
    }),
    true,
  );
  await otherDone;
  assert.deepEqual(order, ["first-start", "other"]);

  releaseFirst();
  await secondDone;
  assert.deepEqual(order, ["first-start", "other", "first-end", "second"]);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(
    enqueue("group", () => {
      throw new Error("expected");
    }),
    true,
  );
  assert.equal(
    enqueue("group", () => {
      markRecoveredDone();
    }),
    true,
  );
  await recoveredDone;
  assert.deepEqual(errors, ["expected"]);
});
