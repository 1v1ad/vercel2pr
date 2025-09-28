import fs from 'fs';
import path from 'path';
import process from 'process';
import { fileURLToPath } from 'url';
import { Pool } from 'pg';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const databaseUrl = (process.env.DATABASE_URL || '').trim();

if (!databaseUrl) {
  console.log('Postgres not configured, skipping migrate');
  process.exit(0);
}

if (!/^postgres(ql)?:\/\//i.test(databaseUrl)) {
  console.error('DATABASE_URL must start with postgres:// or postgresql://');
  process.exit(1);
}

const sslRequired = /[?&]sslmode=require/i.test(databaseUrl);
const pool = new Pool({
  connectionString: databaseUrl,
  ssl: sslRequired ? { rejectUnauthorized: false } : undefined,
});

async function run() {
  const dir = path.resolve(__dirname, '../migrations/postgres');
  if (!fs.existsSync(dir)) {
    console.log('No migrations directory found, skipping');
    await pool.end();
    return;
  }

  const files = fs
    .readdirSync(dir)
    .filter((name) => name.endsWith('.sql'))
    .sort();

  const client = await pool.connect();
  try {
    for (const file of files) {
      const fullPath = path.join(dir, file);
      const sql = fs.readFileSync(fullPath, 'utf8');
      const trimmed = sql.trim();
      if (!trimmed) continue;
      console.log(`[migrate] running ${file}`);
      await client.query('BEGIN');
      try {
        await client.query(trimmed);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw Object.assign(new Error(`Failed on ${file}: ${err.message}`), { cause: err });
      }
    }
    console.log('[migrate] done');
  } finally {
    client.release();
    await pool.end();
  }
}

run().catch((err) => {
  console.error(err?.message || err);
  if (err?.cause) console.error(err.cause);
  process.exit(1);
});
