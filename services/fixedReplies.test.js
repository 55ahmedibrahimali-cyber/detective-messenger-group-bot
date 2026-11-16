const test = require("node:test");
const assert = require("node:assert/strict");
const db = require("../database");
const fixedReplies = require("./fixedReplies");

test("saved replies normalize triggers, prefer the longest match, and can be removed", async () => {
  const originalQuery = db.query;
  const rows = [];
  db.query = async (sql, params = []) => {
    if (sql.includes("SELECT id, trigger_text, trigger_key")) return [...rows];
    if (sql.includes("SELECT trigger_text, response_text")) return [...rows].reverse();
    if (sql.startsWith("INSERT INTO bot_fixed_replies")) {
      if (rows.some((row) => row.trigger_key === params[1])) {
        const error = new Error("duplicate key");
        error.code = "ER_DUP_ENTRY";
        throw error;
      }
      rows.push({
        id: rows.length + 1,
        trigger_text: params[0],
        trigger_key: params[1],
        response_text: params[2],
      });
      return { affectedRows: 1 };
    }
    if (sql.startsWith("DELETE FROM bot_fixed_replies")) {
      const index = rows.findIndex((row) => row.trigger_key === params[0]);
      if (index < 0) return { affectedRows: 0 };
      rows.splice(index, 1);
      return { affectedRows: 1 };
    }
    throw new Error(`Unexpected query: ${sql}`);
  };
  try {
    await fixedReplies.add("يا هلا", "الرد الطويل", "admin");
    await fixedReplies.add("هلا", "الرد القصير", "admin");
    assert.equal(await fixedReplies.findMatch("يَا هلا يا صديقي!"), "الرد الطويل");
    assert.equal(await fixedReplies.findMatch("هلاوة"), null);
    assert.equal((await fixedReplies.list()).length, 2);
    await assert.rejects(fixedReplies.add("يا هلا", "رد مكرر", "admin"), {
      code: "ER_DUP_ENTRY",
    });
    assert.equal(await fixedReplies.remove("يا هلا"), true);
    assert.equal(await fixedReplies.findMatch("يا هلا"), "الرد القصير");
    assert.equal(await fixedReplies.remove("غير موجود"), false);
  } finally {
    db.query = originalQuery;
  }
});
