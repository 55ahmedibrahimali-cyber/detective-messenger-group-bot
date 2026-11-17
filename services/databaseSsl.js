function databaseSslOptions(env = process.env) {
  if (env.DB_SSL !== "1") return undefined;

  const options = { rejectUnauthorized: true };
  const ca = env.DB_SSL_CA;
  if (typeof ca === "string" && ca.trim()) {
    options.ca = ca.replace(/\\n/g, "\n");
  }
  return options;
}

module.exports = { databaseSslOptions };
