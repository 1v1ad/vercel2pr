#!/usr/bin/env node
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { Pool } from 'pg';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function isPostgresUrl(url) {
  return typeof url === 'string' && /^postgres(ql)?:\/\//i.test(url.trim());
}

function buildPoolConfig(url) {
  const config = { connectionString: url };
  if (!/sslmode=disable/i.test(url || '') && !/sslmode=allow/i.test(url || '')) {
    config.ssl = { rejectUnauthorized: false };
  }
  return config;
}

async function ensureMigrationsTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS migrations (
      id TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}

async function alreadyApplied(client, id) {
  const { rows } = await client.query('SELECT 1 FROM migrations WHERE id = $1', [id]);
  return rows.length > 0;
}

async function applyMigration(client, id, sql) {
  console.log(`[migrate] applying ${id}`);
  await client.query(sql);
  await client.query('INSERT INTO migrations (id) VALUES ($1) ON CONFLICT DO NOTHING', [id]);
}

async function main() {
  const url = process.env.DATABASE_URL || '';
  if (!isPostgresUrl(url)) {
    console.log('Postgres not configured, skipping migrate');
    return;
  }

  const dir = path.join(__dirname, '..', 'migrations', 'postgres');
  let files = [];
  try {
    files = (await fs.readdir(dir)).filter((name) => name.endsWith('.sql')).sort();
  } catch (e) {
    if (e && e.code === 'ENOENT') {
      console.log('[migrate] no migrations directory, nothing to do');
      return;
    }
    throw e;
  }

  if (!files.length) {
    console.log('[migrate] no migrations to apply');
    return;
  }

  const pool = new Pool(buildPoolConfig(url));
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await ensureMigrationsTable(client);

    for (const file of files) {
      const id = file.replace(/\.sql$/i, '');
      if (await alreadyApplied(client, id)) {
        continue;
      }
      const fullPath = path.join(dir, file);
      const sql = await fs.readFile(fullPath, 'utf8');
      await applyMigration(client, id, sql);
    }

    await client.query('COMMIT');
    console.log('[migrate] done');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[migrate] failed', err);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error('[migrate] fatal', err);
  process.exitCode = 1;
});
