const test = require("node:test");
const assert = require("node:assert/strict");
const { databaseSslOptions } = require("./databaseSsl");

test("database TLS is disabled unless explicitly enabled", () => {
  assert.equal(databaseSslOptions({}), undefined);
  assert.equal(databaseSslOptions({ DB_SSL: "0" }), undefined);
});

test("database TLS verifies certificates and accepts an optional CA", () => {
  assert.deepEqual(databaseSslOptions({ DB_SSL: "1" }), {
    rejectUnauthorized: true,
  });
  assert.deepEqual(
    databaseSslOptions({ DB_SSL: "1", DB_SSL_CA: "line one\\nline two" }),
    { rejectUnauthorized: true, ca: "line one\nline two" },
  );
});
