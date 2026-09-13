const { Pool } = require('pg');
const crypto = require('crypto');

const connectionString = process.env.DATABASE_URL;
const isLocal = connectionString && /localhost|127\.0\.0\.1/.test(connectionString);

const pool = new Pool({
  connectionString,
  ssl: isLocal ? false : { rejectUnauthorized: false },
});

function query(text, params) {
  return pool.query(text, params);
}

function genId(prefix) {
  return prefix + '_' + crypto.randomBytes(10).toString('hex');
}

module.exports = { pool, query, genId };
