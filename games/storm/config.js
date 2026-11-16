const integerSetting = (name, fallback) => {
  const parsed = Number(process.env[name]);
  return Number.isInteger(parsed) ? parsed : fallback;
};
const MIN_PLAYERS = Math.max(
  4,
  Math.min(8, integerSetting("STORM_MIN_PLAYERS", 4)),
);
const MAX_PLAYERS = Math.max(
  MIN_PLAYERS,
  Math.max(4, Math.min(8, integerSetting("STORM_MAX_PLAYERS", 8))),
);

module.exports = {
  MIN_PLAYERS,
  MAX_PLAYERS,
  LOBBY_SECONDS: Number(process.env.STORM_LOBBY_SECONDS) || 60,
  NIGHT_SECONDS: Number(process.env.STORM_NIGHT_SECONDS) || 45,
  DISCUSSION_SECONDS: Number(process.env.STORM_DISCUSSION_SECONDS) || 90,
  VOTING_SECONDS: Number(process.env.STORM_VOTING_SECONDS) || 45,
};
