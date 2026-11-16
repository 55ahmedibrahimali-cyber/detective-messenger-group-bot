module.exports = {
  MIN: Number(process.env.MIN_PLAYERS) || 4,
  MAX: Number(process.env.MAX_PLAYERS) || 8,
  LOBBY: Number(process.env.CRIME_LOBBY_SECONDS) || 60,
  DISCUSSION: Number(process.env.DISCUSSION_SECONDS) || 120,
  VOTING: Number(process.env.VOTING_SECONDS) || 60,
  SUSPECTS_DELAY: 30,
  ROUND_START_DELAY: 30,
  BETWEEN: 10,
};
