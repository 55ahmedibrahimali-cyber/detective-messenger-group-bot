const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

function buildSchema(schema, databaseName, createDatabase) {
  if (!/^[A-Za-z0-9_$-]{1,64}$/.test(databaseName)) {
    throw new Error('DB_NAME must be 1-64 letters, numbers, underscores, or hyphens.');
  }
  const databaseDirectives =
    /CREATE DATABASE IF NOT EXISTS detective_bot\s+CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;\s*USE detective_bot;\s*/i;
  if (!databaseDirectives.test(schema)) {
    throw new Error('The base schema is missing its database directives.');
  }
  if (!createDatabase) return schema.replace(databaseDirectives, '');
  return schema.replace(
    databaseDirectives,
    `CREATE DATABASE IF NOT EXISTS \`${databaseName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;\nUSE \`${databaseName}\`;\n`,
  );
}

async function setup() {
  const databaseName = process.env.DB_NAME || 'detective_bot';
  const createDatabase = process.env.DB_CREATE_DATABASE !== '0';
  const schemaPath = path.join(__dirname, 'schema.sql');
  const schema = buildSchema(
    fs.readFileSync(schemaPath, 'utf8'),
    databaseName,
    createDatabase,
  );
  const connectionOptions = {
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    multipleStatements: true,
    charset: 'utf8mb4',
  };
  if (!createDatabase) connectionOptions.database = databaseName;
  const connection = await mysql.createConnection(connectionOptions);

  try {
    await connection.query(schema);
    const gamesPath = path.join(__dirname, 'games');
    if (fs.existsSync(gamesPath)) {
      for (const entry of fs.readdirSync(gamesPath, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const gameSchemaPath = path.join(gamesPath, entry.name, 'schema.sql');
        if (!fs.existsSync(gameSchemaPath)) continue;
        await connection.query(fs.readFileSync(gameSchemaPath, 'utf8'));
        console.log(`Game schema is ready: ${entry.name}`);
      }
    }
    console.log(`Database schema is ready: ${databaseName}`);
  } finally {
    await connection.end();
  }
}

if (require.main === module) {
  require('dotenv').config({ path: path.join(__dirname, '.env') });
  setup().catch((error) => {
    console.error('Database setup failed:', error.message);
    process.exitCode = 1;
  });
}

module.exports = { buildSchema };
