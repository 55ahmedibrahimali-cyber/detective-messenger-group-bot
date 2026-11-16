const integerSetting = (name, fallback) => {
  const parsed = Number(process.env[name]);
  return Number.isInteger(parsed) ? parsed : fallback;
};

const boundedSetting = (name, fallback, min, max) =>
  Math.max(min, Math.min(max, integerSetting(name, fallback)));

const TOKEN_TTL_MINUTES = boundedSetting(
  "DRAWING_TOKEN_TTL_MINUTES",
  180,
  1,
  1440,
);
const IMAGE_MAX_BYTES = boundedSetting(
  "DRAWING_IMAGE_MAX_BYTES",
  2 * 1024 * 1024,
  64 * 1024,
  5 * 1024 * 1024,
);
const PUBLISH_INTERVAL_SECONDS = boundedSetting(
  "DRAWING_PUBLISH_INTERVAL_SECONDS",
  30,
  5,
  600,
);
const ROUND_DURATION_SECONDS = boundedSetting(
  "DRAWING_ROUND_DURATION_SECONDS",
  5 * 60,
  60,
  1800,
);
module.exports = {
  TOKEN_TTL_MINUTES,
  IMAGE_MAX_BYTES,
  PUBLISH_INTERVAL_SECONDS,
  ROUND_DURATION_SECONDS,
};
