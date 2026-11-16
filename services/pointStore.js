const db = require("../database");

const MAX_PRICE = 1_000_000_000;

async function listProducts() {
  return db.query(
    `SELECT id, name, description, item_type, price
     FROM bot_shop_products
     WHERE active=1
     ORDER BY id`,
  );
}

async function createProduct({ name, description, itemType, price, createdBy }) {
  const cleanName = String(name || "").trim();
  const cleanDescription = String(description || "").trim();
  const cleanPrice = Number(price);
  if (!cleanName || cleanName.length > 100)
    throw new Error("اسم السلعة مطلوب، والحد الأقصى 100 حرف.");
  if (cleanDescription.length > 500)
    throw new Error("الوصف يجب ألا يتجاوز 500 حرف.");
  if (!["cosmetic", "perk"].includes(itemType))
    throw new Error("نوع السلعة يجب أن يكون لقباً أو ميزة.");
  if (!Number.isSafeInteger(cleanPrice) || cleanPrice < 1 || cleanPrice > MAX_PRICE)
    throw new Error(`السعر يجب أن يكون عدداً صحيحاً من 1 إلى ${MAX_PRICE}.`);

  const result = await db.query(
    `INSERT INTO bot_shop_products
       (name, description, item_type, price, created_by)
     VALUES (?, ?, ?, ?, ?)`,
    [cleanName, cleanDescription, itemType, cleanPrice, String(createdBy)],
  );
  return { id: result.insertId, name: cleanName, price: cleanPrice, itemType };
}

async function removeProduct(productId) {
  const result = await db.query(
    "UPDATE bot_shop_products SET active=0 WHERE id=? AND active=1",
    [productId],
  );
  return result.affectedRows > 0;
}

async function updateProductPrice(productId, price) {
  const cleanPrice = Number(price);
  if (!Number.isSafeInteger(cleanPrice) || cleanPrice < 1 || cleanPrice > MAX_PRICE)
    throw new Error(`السعر يجب أن يكون عدداً صحيحاً من 1 إلى ${MAX_PRICE}.`);
  const result = await db.query(
    "UPDATE bot_shop_products SET price=? WHERE id=? AND active=1",
    [cleanPrice, productId],
  );
  return result.affectedRows > 0;
}

async function updateProductDescription(productId, description) {
  const cleanDescription = String(description || "").trim();
  if (cleanDescription.length > 500)
    throw new Error("الوصف يجب ألا يتجاوز 500 حرف.");
  const result = await db.query(
    "UPDATE bot_shop_products SET description=? WHERE id=? AND active=1",
    [cleanDescription, productId],
  );
  return result.affectedRows > 0;
}

async function purchase(psid, productId) {
  const userId = String(psid);
  const id = Number(productId);
  if (!Number.isSafeInteger(id) || id < 1)
    throw new Error("معرّف السلعة غير صحيح.");

  return db.withTransaction(async (query) => {
    const products = await query(
      "SELECT id, name, description, item_type, price FROM bot_shop_products WHERE id=? AND active=1 FOR UPDATE",
      [id],
    );
    const product = products[0];
    if (!product) throw new Error("السلعة غير موجودة أو لم تعد متاحة.");

    const inventory = await query(
      "SELECT quantity FROM bot_shop_inventory WHERE psid=? AND product_id=? FOR UPDATE",
      [userId, id],
    );
    if (product.item_type === "cosmetic" && inventory.length)
      throw new Error("أنت تملك هذا اللقب بالفعل.");

    const balances = await query(
      "SELECT points FROM bot_player_scores WHERE psid=? FOR UPDATE",
      [userId],
    );
    const balance = Number(balances[0]?.points || 0);
    const price = Number(product.price);
    if (balance < price)
      throw new Error(`نقاطك غير كافية. رصيدك ${balance} وسعر السلعة ${price}.`);

    const updated = await query(
      "UPDATE bot_player_scores SET points=points-? WHERE psid=? AND points>=?",
      [price, userId, price],
    );
    if (!updated.affectedRows)
      throw new Error("تعذر إتمام الدفع؛ تحقق من رصيدك وحاول مجدداً.");
    await query(
      `INSERT INTO bot_shop_inventory (psid, product_id, quantity)
       VALUES (?, ?, 1)
       ON DUPLICATE KEY UPDATE quantity=quantity+1`,
      [userId, id],
    );
    await query(
      "INSERT INTO bot_shop_purchases (psid, product_id, price_paid) VALUES (?, ?, ?)",
      [userId, id, price],
    );
    await query(
      `INSERT INTO bot_point_transactions
         (psid, amount, transaction_type, description)
       VALUES (?, ?, 'shop_purchase', ?)`,
      [userId, -price, `شراء: ${product.name}`.slice(0, 255)],
    );

    return { product, balance: balance - price };
  });
}

async function inventoryFor(psid) {
  return db.query(
    `SELECT p.id, p.name, p.description, p.item_type,
            i.quantity, i.equipped
     FROM bot_shop_inventory i
     JOIN bot_shop_products p ON p.id=i.product_id
     WHERE i.psid=?
     ORDER BY i.purchased_at, p.id`,
    [String(psid)],
  );
}

async function equipTitle(psid, productId) {
  const userId = String(psid);
  const id = Number(productId);
  if (!Number.isSafeInteger(id) || id < 1)
    throw new Error("استخدم معرّف لقب صحيحاً.");

  return db.withTransaction(async (query) => {
    const owned = await query(
      `SELECT p.id, p.name
       FROM bot_shop_inventory i
       JOIN bot_shop_products p ON p.id=i.product_id
       WHERE i.psid=? AND i.product_id=? AND p.item_type='cosmetic'`,
      [userId, id],
    );
    if (!owned.length) throw new Error("لا تملك هذا اللقب.");

    await query(
      `UPDATE bot_shop_inventory i
       JOIN bot_shop_products p ON p.id=i.product_id
       SET i.equipped=0
       WHERE i.psid=? AND p.item_type='cosmetic'`,
      [userId],
    );
    await query(
      "UPDATE bot_shop_inventory SET equipped=1 WHERE psid=? AND product_id=?",
      [userId, id],
    );
    return owned[0];
  });
}

module.exports = {
  MAX_PRICE,
  listProducts,
  createProduct,
  removeProduct,
  updateProductPrice,
  updateProductDescription,
  purchase,
  inventoryFor,
  equipTitle,
};
