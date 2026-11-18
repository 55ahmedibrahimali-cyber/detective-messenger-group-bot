const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const adminAuth = require("./adminAuth");
const db = require("../database");

const OWNER_ID = "61555344774852";

test("the configured owner has permanent owner and admin privileges", async () => {
  assert.equal(adminAuth.isOwner(OWNER_ID), true);
  assert.equal(adminAuth.isAdmin(OWNER_ID), true);
  assert.equal(adminAuth.ownerName, "لايت");
  assert.equal(await adminAuth.addAdmin(OWNER_ID), false);
  await assert.rejects(adminAuth.removeAdmin(OWNER_ID), /cannot be demoted/);
});

test("the owner cannot be blocked, even if a ban record exists", async () => {
  const originalOne = db.one;
  const originalQuery = db.query;
  let queriedBan = false;
  db.one = async () => {
    queriedBan = true;
    return { psid: OWNER_ID };
  };
  db.query = async () => {
    queriedBan = true;
    return { affectedRows: 1 };
  };
  try {
    assert.equal(await db.isUserBanned(OWNER_ID), false);
    assert.equal(queriedBan, false);
    await assert.rejects(
      db.banUser(OWNER_ID, "another-user", "test"),
      /cannot be banned/,
    );
    assert.equal(queriedBan, false);
  } finally {
    db.one = originalOne;
    db.query = originalQuery;
  }
});

test("admin ID files are written with owner-only permissions", async (t) => {
  if (process.platform === "win32") return t.skip("Unix file permissions only");

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "admin-auth-"));
  const destination = path.join(directory, "admin-ids.json");
  try {
    await adminAuth._internal.persistAdminIds(["123456789"], destination);
    assert.equal(fs.statSync(destination).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(fs.readFileSync(destination, "utf8")), {
      adminIds: ["123456789"],
    });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
