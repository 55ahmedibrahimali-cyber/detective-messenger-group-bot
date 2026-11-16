const db = require("../database");

async function setEnabled(gameId, enabled, changedBy) {
  return db.query(
    `INSERT INTO bot_game_controls (game_id, enabled, changed_by)
     VALUES (?,?,?)
     ON DUPLICATE KEY UPDATE
       enabled=VALUES(enabled),
       changed_by=VALUES(changed_by),
       changed_at=CURRENT_TIMESTAMP`,
    [gameId, enabled ? 1 : 0, String(changedBy)],
  );
}

async function isEnabled(gameId) {
  const row = await db.one(
    "SELECT enabled FROM bot_game_controls WHERE game_id=? LIMIT 1",
    [gameId],
  );
  return row ? Number(row.enabled) !== 0 : true;
}

async function list() {
  return db.query("SELECT game_id, enabled FROM bot_game_controls");
}

module.exports = { setEnabled, isEnabled, list };
