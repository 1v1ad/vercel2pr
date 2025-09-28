#!/usr/bin/env node
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { Pool } from 'pg';

const DATABASE_URL = process.env.DATABASE_URL || '';

if (!DATABASE_URL) {
  console.log('Postgres not configured, skipping migrate');
  process.exit(0);
}

if (!/^postgres(?:ql)?:\/\//i.test(DATABASE_URL)) {
  console.error('DATABASE_URL must point to Postgres (postgres:// or postgresql://)');
  process.exit(1);
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const migrationsDir = path.resolve(__dirname, '..', 'migrations', 'postgres');

async function main() {
  let files = [];
  try {
    files = await fs.readdir(migrationsDir);
  } catch (e) {
    if (e && e.code === 'ENOENT') {
      console.log('No migrations directory, nothing to do');
      return;
    }
    throw e;
  }

  const sqlFiles = files.filter((name) => name.endsWith('.sql')).sort();
  if (!sqlFiles.length) {
    console.log('No migrations found');
    return;
  }

  const ssl = DATABASE_URL.includes('sslmode=disable') ? undefined : { rejectUnauthorized: false };
  const pool = new Pool({ connectionString: DATABASE_URL, ssl });

  try {
    for (const file of sqlFiles) {
      const fullPath = path.join(migrationsDir, file);
      const sql = await fs.readFile(fullPath, 'utf8');
      const trimmed = sql.trim();
      if (!trimmed) continue;
      console.log(`[migrate] ${file}`);
      await pool.query(trimmed);
    }
  } finally {
    await pool.end();
  }
}

main()
  .then(() => {
    console.log('Migrations complete');
    process.exit(0);
  })
  .catch((err) => {
    console.error('Migration failed:', err);
    process.exit(1);
  });
