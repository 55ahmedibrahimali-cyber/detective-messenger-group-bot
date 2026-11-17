const fs = require("node:fs");
const path = require("node:path");

const CONFIG_FILES = [
  "config/general.json",
  "games/crime/config.json",
  "games/storm/config.json",
  "games/spy/config.json",
  "games/drawing/config.json",
  "games/feign/config.json",
  "games/werewolf/config.json",
];
const SECRET_NAME =
  /PASSWORD|_TOKEN$|_API_KEY$|_ENCRYPTION_KEY$|^FAL_KEY$|_SECRET(?:$|_)|(?:^|_)EMAIL(?:$|_)/i;

function applyConfig(config, env = process.env) {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new TypeError("Application config must be a JSON object.");
  }

  for (const [name, value] of Object.entries(config)) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(name)) {
      throw new Error(`Invalid application config key: ${name}`);
    }
    if (SECRET_NAME.test(name)) {
      throw new Error(`Secret ${name} must be provided through the environment.`);
    }
    if (!["string", "number", "boolean"].includes(typeof value)) {
      throw new TypeError(`Invalid value for application config key ${name}.`);
    }
    if (env[name] === undefined) env[name] = String(value);
  }
}

function loadConfig(rootDir = path.resolve(__dirname, ".."), env = process.env) {
  for (const relativePath of CONFIG_FILES) {
    const configPath = path.join(rootDir, relativePath);
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    applyConfig(config, env);
  }
}

module.exports = { applyConfig, loadConfig };
