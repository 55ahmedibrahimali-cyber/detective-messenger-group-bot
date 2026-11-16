const integerSetting = (name, fallback) => {
  const parsed = Number(process.env[name]);
  return Number.isInteger(parsed) ? parsed : fallback;
};

const MIN_PLAYERS = Math.max(
  4,
  Math.min(12, integerSetting("FEIGN_MIN_PLAYERS", 4)),
);
const MAX_PLAYERS = Math.max(
  MIN_PLAYERS,
  Math.max(4, Math.min(12, integerSetting("FEIGN_MAX_PLAYERS", 12))),
);

module.exports = {
  MIN_PLAYERS,
  MAX_PLAYERS,
  LOBBY_SECONDS: Number(process.env.FEIGN_LOBBY_SECONDS) || 60,
  NIGHT_SECONDS: Number(process.env.FEIGN_NIGHT_SECONDS) || 45,
  DISCUSSION_SECONDS: Number(process.env.FEIGN_DISCUSSION_SECONDS) || 90,
  VOTING_SECONDS: Number(process.env.FEIGN_VOTING_SECONDS) || 45,
};
