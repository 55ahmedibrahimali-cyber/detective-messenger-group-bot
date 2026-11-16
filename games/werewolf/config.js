const integerSetting = (name, fallback) => {
  const parsed = Number(process.env[name]);
  return Number.isInteger(parsed) ? parsed : fallback;
};

const MIN_PLAYERS = 4;
const MAX_PLAYERS = 8;

module.exports = {
  MIN_PLAYERS,
  MAX_PLAYERS,
  LOBBY_SECONDS: integerSetting("WEREWOLF_LOBBY_SECONDS", 60),
  NIGHT_SECONDS: integerSetting("WEREWOLF_NIGHT_SECONDS", 60),
  DISCUSSION_SECONDS: integerSetting("WEREWOLF_DISCUSSION_SECONDS", 120),
  VOTING_SECONDS: integerSetting("WEREWOLF_VOTING_SECONDS", 60),
  HUNTER_SECONDS: integerSetting("WEREWOLF_HUNTER_SECONDS", 30),
};
