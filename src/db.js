// src/db.js
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import { Pool } from 'pg';

let sqliteDb = null;
let pool = null;
let mode = null; // 'pg' | 'sqlite'

function postgresUrl() {
  const url = process.env.DATABASE_URL || '';
  return /^postgres(ql)?:\/\//i.test(url) ? url : '';
}

function buildPgConfig(url) {
  const cfg = { connectionString: url };
  if (!/sslmode=disable/i.test(url) && !/sslmode=allow/i.test(url)) {
    cfg.ssl = { rejectUnauthorized: false };
  }
  return cfg;
}

async function ensureSQLiteSchema(db) {
  await db.exec('PRAGMA journal_mode = WAL;');
  await db.exec('PRAGMA foreign_keys = ON;');

  await db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      provider          TEXT    NOT NULL,
      provider_user_id  TEXT    NOT NULL,
      name              TEXT,
      avatar            TEXT,
      balance           INTEGER NOT NULL DEFAULT 0,
      cluster_id        TEXT,
      primary_user_id   INTEGER,
      created_at        TEXT    NOT NULL DEFAULT (datetime('now')),
      updated_at        TEXT    NOT NULL DEFAULT (datetime('now')),
      UNIQUE(provider, provider_user_id)
    );
  `);
  await db.exec('CREATE INDEX IF NOT EXISTS users_provider_user_idx ON users(provider, provider_user_id);');
  await db.exec('CREATE INDEX IF NOT EXISTS users_cluster_idx ON users(cluster_id);');
  await db.exec('CREATE INDEX IF NOT EXISTS users_primary_idx ON users(primary_user_id);');

  await db.exec(`
    CREATE TABLE IF NOT EXISTS persons (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS person_links (
      person_id        INTEGER NOT NULL,
      provider         TEXT    NOT NULL,
      provider_user_id TEXT    NOT NULL,
      UNIQUE(provider, provider_user_id),
      FOREIGN KEY(person_id) REFERENCES persons(id) ON DELETE CASCADE
    );
  `);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id    INTEGER,
      type       TEXT    NOT NULL,
      meta       TEXT,
      created_at TEXT    NOT NULL DEFAULT (datetime('now'))
    );
  `);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS kv (
      key   TEXT PRIMARY KEY,
      value TEXT
    );
  `);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT
    );
  `);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS auth_accounts (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id          INTEGER,
      provider         TEXT    NOT NULL,
      provider_user_id TEXT    NOT NULL,
      username         TEXT,
      phone_hash       TEXT,
      meta             TEXT,
      created_at       TEXT    NOT NULL DEFAULT (datetime('now')),
      updated_at       TEXT    NOT NULL DEFAULT (datetime('now')),
      UNIQUE(provider, provider_user_id)
    );
  `);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS link_audit (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      primary_id  INTEGER,
      merged_id   INTEGER,
      method      TEXT    NOT NULL,
      source      TEXT,
      ip          TEXT,
      ua          TEXT,
      details     TEXT,
      created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
    );
  `);
  await db.exec('CREATE INDEX IF NOT EXISTS link_audit_primary_idx ON link_audit(primary_id);');
  await db.exec('CREATE INDEX IF NOT EXISTS link_audit_merged_idx ON link_audit(merged_id);');
}

export async function initDB() {
  if (mode) return;
  const url = postgresUrl();
  if (url) {
    pool = new Pool(buildPgConfig(url));
    await pool.query('SELECT 1');
    mode = 'pg';
    return;
  }

  sqliteDb = await open({
    filename: process.env.DB_FILE || './data.sqlite',
    driver: sqlite3.Database,
  });
  await ensureSQLiteSchema(sqliteDb);
  mode = 'sqlite';
}

function normalizeParam(value) {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') return JSON.stringify(value);
  return value;
}

function convertPlaceholders(sql) {
  return sql.replace(/\$(\d+)/g, '?');
}

function sqliteRunner(db) {
  return {
    async query(text, params = []) {
      const lower = text.trim().toLowerCase();
      const sql = convertPlaceholders(text);
      const prepared = params.map((p) => normalizeParam(p));
      if (lower.startsWith('begin')) {
        await db.exec('BEGIN');
        return { rows: [], rowCount: 0 };
      }
      if (lower.startsWith('commit')) {
        await db.exec('COMMIT');
        return { rows: [], rowCount: 0 };
      }
      if (lower.startsWith('rollback')) {
        await db.exec('ROLLBACK');
        return { rows: [], rowCount: 0 };
      }
      const hasRows = lower.startsWith('select') || lower.startsWith('with') || /\breturning\b/i.test(sql) || lower.startsWith('pragma');
      if (hasRows) {
        const rows = await db.all(sql, prepared);
        return { rows, rowCount: rows.length };
      }
      const result = await db.run(sql, prepared);
      return { rows: [], rowCount: result.changes || 0, lastID: result.lastID };
    },
  };
}

export function isPg() {
  return mode === 'pg';
}

export async function query(text, params = [], client = null) {
  if (!mode) await initDB();
  if (mode === 'pg') {
    const runner = client || pool;
    if (!runner) throw new Error('Postgres pool not initialized');
    return runner.query(text, params);
  }
  const db = client || sqliteDb;
  if (!db) throw new Error('SQLite database not initialized');
  return sqliteRunner(db).query(text, params);
}

export async function tx(fn) {
  if (!mode) await initDB();
  if (mode === 'pg') {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn({ query: (text, params) => client.query(text, params) });
      await client.query('COMMIT');
      return result;
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch {}
      throw err;
    } finally {
      client.release();
    }
  }

  const db = sqliteDb;
  if (!db) throw new Error('SQLite database not initialized');
  const runner = sqliteRunner(db);
  try {
    await db.exec('BEGIN IMMEDIATE');
    const result = await fn({ query: (text, params) => runner.query(text, params) });
    await db.exec('COMMIT');
    return result;
  } catch (err) {
    try { await db.exec('ROLLBACK'); } catch {}
    throw err;
  }
}

export const db = {
  query: (text, params) => query(text, params),
  tx,
  async connect() {
    if (!mode) await initDB();
    if (mode === 'pg') {
      return pool.connect();
    }
    const sqlite = sqliteDb;
    const runner = sqliteRunner(sqlite);
    return {
      query: (text, params) => runner.query(text, params),
      release() {},
    };
  },
  isPg,
};

export async function upsertUser({ provider, provider_user_id, name, avatar }) {
  if (!provider || !provider_user_id) {
    throw new Error('upsertUser: provider and provider_user_id are required');
  }

  const params = [provider, String(provider_user_id), name || null, avatar || null];

  if (isPg()) {
    const { rows } = await query(
      `
        INSERT INTO users (provider, provider_user_id, name, avatar)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (provider, provider_user_id) DO UPDATE SET
          name = excluded.name,
          avatar = excluded.avatar,
          updated_at = now()
        RETURNING *;
      `,
      params
    );
    if (rows.length) return rows[0];
  } else {
    await query(
      `
        INSERT INTO users (provider, provider_user_id, name, avatar)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (provider, provider_user_id) DO UPDATE SET
          name = excluded.name,
          avatar = excluded.avatar,
          updated_at = datetime('now')
      `,
      params
    );
  }

  const fetched = await query(
    'SELECT * FROM users WHERE provider = $1 AND provider_user_id = $2 LIMIT 1',
    [provider, String(provider_user_id)]
  );
  return fetched.rows[0];
}

export async function logEvent(user_id, type, meta = {}) {
  await query(
    'INSERT INTO events (user_id, type, meta) VALUES ($1, $2, $3)',
    [user_id || null, String(type), meta || {}]
  );
}

export async function linkAccounts({ left, right }) {
  if (!left?.provider || !left?.provider_user_id || !right?.provider || !right?.provider_user_id) {
    throw new Error('linkAccounts: provider and provider_user_id are required');
  }

  return tx(async (client) => {
    const leftRow = await client.query(
      'SELECT person_id FROM person_links WHERE provider = $1 AND provider_user_id = $2',
      [left.provider, String(left.provider_user_id)]
    );
    const rightRow = await client.query(
      'SELECT person_id FROM person_links WHERE provider = $1 AND provider_user_id = $2',
      [right.provider, String(right.provider_user_id)]
    );
    const l = leftRow.rows[0];
    const r = rightRow.rows[0];
    if (!l || !r) throw new Error('linkAccounts: one of links not found');
    if (l.person_id === r.person_id) return l.person_id;

    await client.query(
      'UPDATE person_links SET person_id = $1 WHERE person_id = $2',
      [l.person_id, r.person_id]
    );
    await client.query('DELETE FROM persons WHERE id = $1', [r.person_id]);
    return l.person_id;
  });
}

export async function getUserById(id) {
  const { rows } = await query('SELECT * FROM users WHERE id = $1 LIMIT 1', [id]);
  return rows[0] || null;
}

export function getDb() {
  if (!mode || mode === 'sqlite') {
    if (!sqliteDb) throw new Error('db not initialized');
    return sqliteDb;
  }
  return pool;
}
