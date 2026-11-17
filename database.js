const mysql = require('mysql2/promise');
const adminAuth = require('./services/adminAuth');
const {
  reservePinterestDailySearch: reserveDailySearch,
} = require('./services/dailyQuota');
const { databaseSslOptions } = require('./services/databaseSsl');

const pool = mysql.createPool({
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT) || 3306,
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'detective_bot',
  waitForConnections: true,
  connectionLimit: Number(process.env.DB_CONNECTION_LIMIT) || 10,
  charset: 'utf8mb4',
  ssl: databaseSslOptions(),
});

async function query(sql, params = []) {
  const [result] = await pool.execute(sql, params);
  return result;
}

async function one(sql, params = []) {
  const rows = await query(sql, params);
  return rows[0] || null;
}

async function ensureFixedRepliesIdColumn(columns, executeQuery = query) {
  if (columns.some((column) => column.COLUMN_NAME === 'id')) return false;

  const hasPrimaryKey = columns.some((column) => column.COLUMN_KEY === 'PRI');
  const keyDefinition = hasPrimaryKey
    ? 'UNIQUE'
    : 'PRIMARY KEY';
  await executeQuery(
    `ALTER TABLE bot_fixed_replies ADD COLUMN id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT ${keyDefinition} FIRST`,
  );
  return true;
}

async function assertSchema() {
  await query(
    `CREATE TABLE IF NOT EXISTS bot_user_bans (
      psid VARCHAR(64) NOT NULL PRIMARY KEY,
      banned_by VARCHAR(64) NOT NULL,
      reason VARCHAR(500) NULL,
      banned_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB`,
  );
  await query(
    `CREATE TABLE IF NOT EXISTS bot_player_scores (
      psid VARCHAR(64) NOT NULL PRIMARY KEY,
      display_name VARCHAR(100) NOT NULL,
      points BIGINT UNSIGNED NOT NULL DEFAULT 0,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB`,
  );
  await query(
    `CREATE TABLE IF NOT EXISTS bot_point_awards (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      room_id INT UNSIGNED NOT NULL,
      game_id VARCHAR(40) NOT NULL,
      psid VARCHAR(64) NOT NULL,
      display_name VARCHAR(100) NOT NULL,
      points TINYINT UNSIGNED NOT NULL DEFAULT 1,
      awarded_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_room_point_award (room_id, psid),
      KEY idx_point_awards_psid (psid)
    ) ENGINE=InnoDB`,
  );
  await query(
    `CREATE TABLE IF NOT EXISTS bot_point_transactions (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      psid VARCHAR(64) NOT NULL,
      amount BIGINT NOT NULL,
      transaction_type VARCHAR(32) NOT NULL,
      description VARCHAR(255) NULL,
      created_by VARCHAR(64) NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      KEY idx_point_transactions_psid (psid)
    ) ENGINE=InnoDB`,
  );
  await query(
    `CREATE TABLE IF NOT EXISTS bot_game_prompt_usage (
      game_id VARCHAR(40) NOT NULL,
      thread_id VARCHAR(64) NOT NULL,
      prompt_index INT UNSIGNED NOT NULL,
      used_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (game_id, thread_id, prompt_index),
      KEY idx_prompt_usage_thread (thread_id, game_id)
    ) ENGINE=InnoDB`,
  );
  await query(
    `CREATE TABLE IF NOT EXISTS bot_shop_products (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(100) NOT NULL,
      description VARCHAR(500) NOT NULL DEFAULT '',
      item_type ENUM('cosmetic','perk') NOT NULL,
      price BIGINT UNSIGNED NOT NULL,
      active TINYINT(1) NOT NULL DEFAULT 1,
      created_by VARCHAR(64) NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      KEY idx_shop_products_active (active, id)
    ) ENGINE=InnoDB`,
  );
  await query(
    `CREATE TABLE IF NOT EXISTS bot_shop_inventory (
      psid VARCHAR(64) NOT NULL,
      product_id BIGINT UNSIGNED NOT NULL,
      quantity INT UNSIGNED NOT NULL DEFAULT 1,
      equipped TINYINT(1) NOT NULL DEFAULT 0,
      purchased_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (psid, product_id),
      KEY idx_shop_inventory_product (product_id)
    ) ENGINE=InnoDB`,
  );
  await query(
    `CREATE TABLE IF NOT EXISTS bot_shop_purchases (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      psid VARCHAR(64) NOT NULL,
      product_id BIGINT UNSIGNED NOT NULL,
      price_paid BIGINT UNSIGNED NOT NULL,
      purchased_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      KEY idx_shop_purchases_psid (psid),
      KEY idx_shop_purchases_product (product_id)
    ) ENGINE=InnoDB`,
  );
  await query(
    `CREATE TABLE IF NOT EXISTS bot_game_controls (
      game_id VARCHAR(40) NOT NULL PRIMARY KEY,
      enabled TINYINT(1) NOT NULL DEFAULT 1,
      changed_by VARCHAR(64) NOT NULL,
      changed_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB`,
  );
  await query(
    `CREATE TABLE IF NOT EXISTS bot_pinterest_daily_usage (
      principal_id VARCHAR(96) NOT NULL,
      usage_date DATE NOT NULL,
      search_count TINYINT UNSIGNED NOT NULL DEFAULT 0,
      PRIMARY KEY (principal_id, usage_date),
      KEY idx_pinterest_daily_usage_date (usage_date)
    ) ENGINE=InnoDB`,
  );
  await query(
    "DELETE FROM bot_pinterest_daily_usage WHERE usage_date < UTC_DATE() - INTERVAL 31 DAY",
  );
  await query(
    `CREATE TABLE IF NOT EXISTS bot_fixed_replies (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      trigger_text VARCHAR(100) NOT NULL,
      trigger_key VARCHAR(100) NOT NULL,
      response_text VARCHAR(1000) NOT NULL,
      created_by VARCHAR(64) NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_fixed_reply_trigger (trigger_key)
    ) ENGINE=InnoDB`,
  );
  const fixedReplyColumns = await query(
    'SELECT COLUMN_NAME, COLUMN_KEY FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=? AND TABLE_NAME=?',
    [process.env.DB_NAME || 'detective_bot', 'bot_fixed_replies']
  );
  await ensureFixedRepliesIdColumn(fixedReplyColumns);
  await query(
    `CREATE TABLE IF NOT EXISTS game_image_cache (
      game_id VARCHAR(40) NOT NULL,
      image_key VARCHAR(120) NOT NULL,
      content_type VARCHAR(32) NOT NULL,
      image_data MEDIUMBLOB NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (game_id, image_key)
    ) ENGINE=InnoDB`,
  );
  const requiredTables = ['cases_pool', 'case_clues', 'game_rooms', 'room_players', 'votes', 'game_image_cache'];
  const rows = await query(
    'SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA=?',
    [process.env.DB_NAME || 'detective_bot']
  );
  const existing = new Set(rows.map((row) => row.TABLE_NAME));
  const missing = requiredTables.filter((table) => !existing.has(table));
  if (missing.length) {
    throw new Error(`قاعدة البيانات ناقصة الجداول الأساسية التالية: ${missing.join(', ')}. شغّل npm run db:setup أولاً.`);
  }

  const columns = await query(
    'SELECT COLUMN_NAME, COLUMN_TYPE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=? AND TABLE_NAME=?',
    [process.env.DB_NAME || 'detective_bot', 'game_rooms']
  );
  const roomColumnNames = new Set(columns.map((column) => column.COLUMN_NAME));
  if (!roomColumnNames.has('game_id')) {
    await query("ALTER TABLE game_rooms ADD COLUMN game_id VARCHAR(40) NOT NULL DEFAULT 'crime' AFTER id");
  }
  const roomIndexes = await query(
    'SELECT INDEX_NAME FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=? AND TABLE_NAME=?',
    [process.env.DB_NAME || 'detective_bot', 'game_rooms']
  );
  if (!roomIndexes.some((index) => index.INDEX_NAME === 'idx_game_phase_tick')) {
    await query('ALTER TABLE game_rooms ADD KEY idx_game_phase_tick (game_id, status, phase, phase_ends_at)');
  }
  if (!roomColumnNames.has('lobby_message_id')) {
    await query('ALTER TABLE game_rooms ADD COLUMN lobby_message_id VARCHAR(128) NULL AFTER killer_player_id');
  }
  if (!roomColumnNames.has('case_assigned_at')) {
    await query('ALTER TABLE game_rooms ADD COLUMN case_assigned_at DATETIME(6) NULL AFTER case_id');
  }
  const phaseColumn = columns.find((column) => column.COLUMN_NAME === 'phase');
  if (
    phaseColumn &&
    (!phaseColumn.COLUMN_TYPE.includes("'final_voting'") ||
      !phaseColumn.COLUMN_TYPE.includes("'night'") ||
      !phaseColumn.COLUMN_TYPE.includes("'spy_guess'") ||
      !phaseColumn.COLUMN_TYPE.includes("'hunter'"))
  ) {
    await query(
      "ALTER TABLE game_rooms MODIFY phase ENUM('lobby','assigning','intro','discussion','voting','tallying','between','final_voting','final_tallying','night','spy_guess','hunter','finished') NOT NULL DEFAULT 'lobby'"
    );
  }

  const playerColumns = await query(
    'SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=? AND TABLE_NAME=?',
    [process.env.DB_NAME || 'detective_bot', 'room_players']
  );
  if (!playerColumns.some((column) => column.COLUMN_NAME === 'bio_revealed_at')) {
    await query('ALTER TABLE room_players ADD COLUMN bio_revealed_at DATETIME NULL AFTER character_bio');
  }
  if (!playerColumns.some((column) => column.COLUMN_NAME === 'welcome_sent_at')) {
    await query('ALTER TABLE room_players ADD COLUMN welcome_sent_at DATETIME NULL AFTER display_name');
  }
}

async function isUserBanned(psid) {
  if (adminAuth.isOwner(psid)) return false;
  return Boolean(
    await one("SELECT psid FROM bot_user_bans WHERE psid=? LIMIT 1", [psid]),
  );
}

async function banUser(psid, bannedBy, reason) {
  if (adminAuth.isOwner(psid))
    throw new Error("The bot owner cannot be banned.");
  return query(
    `INSERT INTO bot_user_bans (psid, banned_by, reason)
     VALUES (?,?,?)
     ON DUPLICATE KEY UPDATE banned_by=VALUES(banned_by), reason=VALUES(reason), banned_at=CURRENT_TIMESTAMP`,
    [psid, bannedBy, reason || null],
  );
}

async function unbanUser(psid) {
  return query("DELETE FROM bot_user_bans WHERE psid=?", [psid]);
}

async function listBannedUsers() {
  return query(
    "SELECT psid, banned_by, reason, banned_at FROM bot_user_bans ORDER BY banned_at DESC",
  );
}

async function reservePinterestDailySearch(
  principalId,
  usageDate = new Date().toISOString().slice(0, 10),
) {
  return reserveDailySearch(query, principalId, usageDate);
}

async function withTransaction(callback) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const result = await callback(async (sql, params = []) => {
      const [queryResult] = await connection.execute(sql, params);
      return queryResult;
    });
    await connection.commit();
    return result;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

module.exports = {
  query,
  one,
  isUserBanned,
  banUser,
  unbanUser,
  listBannedUsers,
  reservePinterestDailySearch,
  withTransaction,
  assertSchema,
  _internal: { ensureFixedRepliesIdColumn },
};
