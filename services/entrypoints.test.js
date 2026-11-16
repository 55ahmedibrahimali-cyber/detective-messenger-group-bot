const test = require("node:test");
const assert = require("node:assert/strict");

test("legacy root entrypoints resolve to the integrated service modules", () => {
  assert.equal(require("../messenger"), require("./messenger"));
  assert.equal(require("../safety"), require("./safety"));
});
