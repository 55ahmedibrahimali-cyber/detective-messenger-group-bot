"use strict";

const DAILY_SEARCH_LIMIT = 10;

function isValidUtcDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value))
    return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return (
    Number.isFinite(date.getTime()) &&
    date.toISOString().slice(0, 10) === value
  );
}

async function reservePinterestDailySearch(execute, principalId, usageDate) {
  if (typeof execute !== "function")
    throw new TypeError("A database query function is required.");
  const id = String(principalId || "").trim();
  if (!id || id.length > 96)
    throw new TypeError("A valid Pinterest user ID is required.");
  if (!isValidUtcDate(usageDate))
    throw new TypeError("Pinterest usage date must be a valid UTC date.");

  await execute(
    `INSERT INTO bot_pinterest_daily_usage
       (principal_id, usage_date, search_count)
     VALUES (?, ?, 0)
     ON DUPLICATE KEY UPDATE principal_id=VALUES(principal_id)`,
    [id, usageDate],
  );
  const result = await execute(
    `UPDATE bot_pinterest_daily_usage
     SET search_count=search_count+1
     WHERE principal_id=? AND usage_date=? AND search_count < ?`,
    [id, usageDate, DAILY_SEARCH_LIMIT],
  );
  return result.affectedRows === 1;
}

module.exports = {
  DAILY_SEARCH_LIMIT,
  reservePinterestDailySearch,
};
