import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import { Pool } from 'pg';

const POSTGRES_RE = /^postgres(?:ql)?:\/\//i;

let mode = 'sqlite';
let pool = null;
let sqliteDb = null;

function usesPostgres() {
  return mode === 'postgres';
}

function convertPlaceholders(text, params = []) {
  if (!usesPostgres()) {
    return { text, params };
  }
  let index = 0;
  const sql = text.replace(/\?/g, () => `$${++index}`);
  return { text: sql, params };
}

async function sqliteQuery(db, text, params = []) {
  if (!db) throw new Error('SQLite database not initialized');
  const trimmed = text.trim().toLowerCase();
  const isSelect = trimmed.startsWith('select') || trimmed.startsWith('pragma') || trimmed.startsWith('with');
  if (isSelect) {
    const rows = await db.all(text, params);
    return { rows, rowCount: rows.length };
  }
  const result = await db.run(text, params);
  return {
    rows: [],
    rowCount: typeof result.changes === 'number' ? result.changes : 0,
    lastID: result.lastID,
  };
}

export async function initDB() {
  const url = process.env.DATABASE_URL || '';
  if (url && POSTGRES_RE.test(url)) {
    const ssl = url.includes('sslmode=disable')
      ? undefined
      : { rejectUnauthorized: false };
    pool = new Pool({ connectionString: url, ssl });
    await pool.query('select 1');
    mode = 'postgres';
    console.log('[DB] connected to Postgres');
    return;
  }

  mode = 'sqlite';
  sqliteDb = await open({
    filename: process.env.DB_FILE || './data.sqlite',
    driver: sqlite3.Database,
  });
  await sqliteDb.exec('PRAGMA journal_mode = WAL;');

  await sqliteDb.exec(`
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
  try {
    await sqliteDb.exec(`ALTER TABLE users ADD COLUMN cluster_id TEXT`);
  } catch {}
  try {
    await sqliteDb.exec(`ALTER TABLE users ADD COLUMN primary_user_id INTEGER`);
  } catch {}

  await sqliteDb.exec(`
    CREATE TABLE IF NOT EXISTS persons (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  await sqliteDb.exec(`
    CREATE TABLE IF NOT EXISTS person_links (
      person_id        INTEGER NOT NULL,
      provider         TEXT    NOT NULL,
      provider_user_id TEXT    NOT NULL,
      UNIQUE(provider, provider_user_id)
    );
  `);

  await sqliteDb.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id    INTEGER,
      type       TEXT    NOT NULL,
      meta       TEXT,
      created_at TEXT    NOT NULL DEFAULT (datetime('now'))
    );
  `);

  await sqliteDb.exec(`
    CREATE TABLE IF NOT EXISTS kv (
      key   TEXT PRIMARY KEY,
      value TEXT
    );
  `);

  await sqliteDb.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT
    );
  `);

  await sqliteDb.exec(`CREATE INDEX IF NOT EXISTS users_cluster_idx ON users (cluster_id);`);
  await sqliteDb.exec(`CREATE INDEX IF NOT EXISTS users_primary_idx ON users (primary_user_id);`);
  await sqliteDb.exec(`CREATE INDEX IF NOT EXISTS users_provider_user_idx ON users (provider, provider_user_id);`);

  console.log('[DB] using SQLite fallback at', process.env.DB_FILE || './data.sqlite');
}

export async function closeDB() {
  if (usesPostgres() && pool) {
    await pool.end();
    pool = null;
    return;
  }
  if (sqliteDb) {
    await sqliteDb.close();
    sqliteDb = null;
  }
}

function wrapResult(res) {
  if (!res) return { rows: [], rowCount: 0 };
  if (res.rows && typeof res.rowCount === 'number') return res;
  if (res.rows) return { rows: res.rows, rowCount: res.rows.length };
  return { rows: [], rowCount: typeof res.rowCount === 'number' ? res.rowCount : 0 };
}

export async function query(text, params = []) {
  if (usesPostgres()) {
    const { text: sql, params: values } = convertPlaceholders(text, params);
    const res = await pool.query(sql, values);
    return wrapResult(res);
  }
  return sqliteQuery(sqliteDb, text, params);
}

export async function tx(run) {
  if (usesPostgres()) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const executor = async (text, params = []) => {
        const { text: sql, params: values } = convertPlaceholders(text, params);
        const res = await client.query(sql, values);
        return wrapResult(res);
      };
      const result = await run(executor);
      await client.query('COMMIT');
      return result;
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      throw e;
    } finally {
      client.release();
    }
  }

  if (!sqliteDb) throw new Error('SQLite database not initialized');
  await sqliteDb.exec('BEGIN IMMEDIATE;');
  try {
    const executor = (text, params = []) => sqliteQuery(sqliteDb, text, params);
    const result = await run(executor);
    await sqliteDb.exec('COMMIT;');
    return result;
  } catch (e) {
    try { await sqliteDb.exec('ROLLBACK;'); } catch (_) {}
    throw e;
  }
}

export function isPostgres() {
  return usesPostgres();
}

export async function upsertUser({ provider, provider_user_id, name, avatar }) {
  if (!provider || !provider_user_id) {
    throw new Error('upsertUser: provider and provider_user_id are required');
  }

  const providerId = String(provider_user_id);
  await query(
    `
    INSERT INTO users (provider, provider_user_id, name, avatar)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(provider, provider_user_id) DO UPDATE SET
      name = excluded.name,
      avatar = excluded.avatar
    `,
    [provider, providerId, name || null, avatar || null]
  );

  const { rows } = await query(
    `SELECT * FROM users WHERE provider = ? AND provider_user_id = ?`,
    [provider, providerId]
  );
  return rows[0];
}

export async function logEvent(user_id, type, meta = {}) {
  const metaValue = typeof meta === 'string' ? meta : JSON.stringify(meta || {});
  await query(
    `INSERT INTO events (user_id, type, meta) VALUES (?, ?, ?)`,
    [user_id || null, String(type), metaValue]
  );
}

export async function getUserById(id) {
  const { rows } = await query(`SELECT * FROM users WHERE id = ?`, [id]);
  return rows[0] || null;
}

export async function linkAccounts({ left, right }) {
  if (!left?.provider || !left?.provider_user_id || !right?.provider || !right?.provider_user_id) {
    throw new Error('linkAccounts: provider and provider_user_id are required');
  }

  const providerL = String(left.provider_user_id);
  const providerR = String(right.provider_user_id);

  const { rows: leftRows } = await query(
    `SELECT person_id FROM person_links WHERE provider = ? AND provider_user_id = ?`,
    [left.provider, providerL]
  );
  const { rows: rightRows } = await query(
    `SELECT person_id FROM person_links WHERE provider = ? AND provider_user_id = ?`,
    [right.provider, providerR]
  );

  const leftPerson = leftRows[0]?.person_id;
  const rightPerson = rightRows[0]?.person_id;
  if (!leftPerson || !rightPerson) throw new Error('linkAccounts: one of links not found');
  if (leftPerson === rightPerson) return leftPerson;

  await query(`UPDATE person_links SET person_id = ? WHERE person_id = ?`, [leftPerson, rightPerson]);
  await query(`DELETE FROM persons WHERE id = ?`, [rightPerson]);
  return leftPerson;
}
