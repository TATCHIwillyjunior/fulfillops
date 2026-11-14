'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const lockId = 684731205;

async function applyMigrations() {
  const client = await pool.connect();
  let lockAcquired = false;
  try {
    await client.query('SELECT pg_advisory_lock($1)', [lockId]);
    lockAcquired = true;
    await client.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         version TEXT PRIMARY KEY,
         applied_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
       )`
    );

    const directory = path.join(__dirname, 'migrations');
    const files = fs.readdirSync(directory)
      .filter(file => /^\d+_.+\.sql$/.test(file))
      .sort();

    for (const version of files) {
      const { rowCount } = await client.query(
        'SELECT 1 FROM schema_migrations WHERE version = $1',
        [version]
      );
      if (rowCount) continue;

      await client.query('BEGIN');
      try {
        await client.query(fs.readFileSync(path.join(directory, version), 'utf8'));
        await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [version]);
        await client.query('COMMIT');
        console.log(`Applied migration ${version}`);
      } catch (error) {
        await client.query('ROLLBACK');
        throw new Error(`Failed migration ${version}: ${error.message}`, { cause: error });
      }
    }
  } finally {
    if (lockAcquired) await client.query('SELECT pg_advisory_unlock($1)', [lockId]);
    client.release();
  }
}

applyMigrations()
  .catch(error => {
    console.error('Database migration failed:', error.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
