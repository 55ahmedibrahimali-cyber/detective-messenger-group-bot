const test = require("node:test");
const assert = require("node:assert/strict");
const db = require("../database");
const pointStore = require("./pointStore");

test("purchasing a product deducts points and records the granted inventory item atomically", async () => {
  const originalWithTransaction = db.withTransaction;
  const queries = [];
  db.withTransaction = async (callback) =>
    callback(async (sql, params) => {
      queries.push({ sql, params });
      if (sql.includes("FROM bot_shop_products"))
        return [{ id: 8, name: "ميزة تجريبية", item_type: "perk", price: 25 }];
      if (sql.includes("FROM bot_shop_inventory")) return [];
      if (sql.includes("FROM bot_player_scores")) return [{ points: 50 }];
      return { affectedRows: 1, insertId: queries.length };
    });

  try {
    const result = await pointStore.purchase("player-1", "8");
    assert.equal(result.product.name, "ميزة تجريبية");
    assert.equal(result.balance, 25);
    assert.ok(queries.some(({ sql, params }) =>
      sql.includes("UPDATE bot_player_scores") && params[0] === 25,
    ));
    assert.ok(queries.some(({ sql }) => sql.includes("INSERT INTO bot_shop_inventory")));
    assert.ok(queries.some(({ sql }) => sql.includes("INSERT INTO bot_shop_purchases")));
    assert.ok(queries.some(({ sql, params }) =>
      sql.includes("INSERT INTO bot_point_transactions") && params[1] === -25,
    ));
  } finally {
    db.withTransaction = originalWithTransaction;
  }
});

test("purchasing with insufficient points performs no writes", async () => {
  const originalWithTransaction = db.withTransaction;
  const queries = [];
  db.withTransaction = async (callback) =>
    callback(async (sql) => {
      queries.push(sql);
      if (sql.includes("FROM bot_shop_products"))
        return [{ id: 8, name: "لقب", item_type: "cosmetic", price: 25 }];
      if (sql.includes("FROM bot_shop_inventory")) return [];
      if (sql.includes("FROM bot_player_scores")) return [{ points: 10 }];
      return { affectedRows: 1 };
    });

  try {
    await assert.rejects(pointStore.purchase("player-1", 8), /نقاطك غير كافية/);
    assert.equal(queries.some((sql) => /^(UPDATE|INSERT)/.test(sql.trim())), false);
  } finally {
    db.withTransaction = originalWithTransaction;
  }
});

test("cosmetic ownership prevents buying the same permanent item twice", async () => {
  const originalWithTransaction = db.withTransaction;
  const queries = [];
  db.withTransaction = async (callback) =>
    callback(async (sql) => {
      queries.push(sql);
      if (sql.includes("FROM bot_shop_products"))
        return [{ id: 8, name: "لقب", item_type: "cosmetic", price: 25 }];
      if (sql.includes("FROM bot_shop_inventory")) return [{ quantity: 1 }];
      return [{ points: 100 }];
    });

  try {
    await assert.rejects(pointStore.purchase("player-1", 8), /تملك هذا اللقب بالفعل/);
    assert.equal(queries.some((sql) => /^(UPDATE|INSERT)/.test(sql.trim())), false);
  } finally {
    db.withTransaction = originalWithTransaction;
  }
});
