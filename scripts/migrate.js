require('dotenv').config();
const fs = require('fs');
const path = require('path');
const db = require('../src/db');

async function main() {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
  await db.query(sql);
  console.log('Migration complete: all tables are up to date.');
  await db.pool.end();
}
main().catch((e) => { console.error('Migration failed:', e.message); process.exit(1); });
