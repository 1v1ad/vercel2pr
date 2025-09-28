// src/db.js
import crypto from 'crypto';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import { Pool } from 'pg';

const DATABASE_URL = (process.env.DATABASE_URL || '').trim();
const SQLITE_FILE = process.env.DB_FILE || './data.sqlite';

let mode = 'sqlite';
let sqliteDb = null;
let pool = null;
export let db = null;

function isPostgresUrl(url) {
  return /^postgres(ql)?:\/\//i.test(url || '');
}

export function isPostgres() {
  return mode === 'pg';
}

function normalizeSqliteParams(sql, params = []) {
  if (!/\$\d+/.test(sql)) {
    return { sql, params };
  }
  const ordered = [];
  const nextSql = sql.replace(/\$(\d+)/g, (_, raw) => {
    const index = Number(raw) - 1;
    ordered.push(params[index]);
    return '?';
  });
  return { sql: nextSql, params: ordered };
}

async function sqliteQuery(sql, params = []) {
  if (!sqliteDb) throw new Error('SQLite database not initialized');
  const trimmed = sql.trim();
  const { sql: prepared, params: values } = normalizeSqliteParams(sql, params);
  if (/^(select|with)\b/i.test(trimmed)) {
    const rows = await sqliteDb.all(prepared, values);
    return { rows, rowCount: rows.length };
  }
  const result = await sqliteDb.run(prepared, values);
  const rowCount = typeof result.changes === 'number' ? result.changes : 0;
  return { rows: [], rowCount, lastID: result.lastID };
}

export async function query(sql, params = []) {
  if (mode === 'pg') {
    return pool.query(sql, params);
  }
  return sqliteQuery(sql, params);
}

export async function tx(fn) {
  if (mode === 'pg') {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn({
        query: (text, params = []) => client.query(text, params),
        isPg: true,
      });
      await client.query('COMMIT');
      return result;
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {}
      throw err;
    } finally {
      client.release();
    }
  }

  if (!sqliteDb) throw new Error('SQLite database not initialized');
  await sqliteDb.exec('BEGIN IMMEDIATE TRANSACTION');
  try {
    const result = await fn({
      query: (text, params = []) => sqliteQuery(text, params),
      isPg: false,
    });
    await sqliteDb.exec('COMMIT');
    return result;
  } catch (err) {
    try {
      await sqliteDb.exec('ROLLBACK');
    } catch {}
    throw err;
  }
}

async function ensureSqliteSchema() {
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
      UNIQUE(provider, provider_user_id)
    );
  `);
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
      UNIQUE(provider, provider_user_id),
      FOREIGN KEY(person_id) REFERENCES persons(id) ON DELETE CASCADE
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

  try {
    await sqliteDb.exec('ALTER TABLE users ADD COLUMN cluster_id TEXT');
  } catch {}
  try {
    await sqliteDb.exec('ALTER TABLE users ADD COLUMN primary_user_id INTEGER');
  } catch {}
}

export async function initDB() {
  if (DATABASE_URL && isPostgresUrl(DATABASE_URL)) {
    mode = 'pg';
    const sslRequired = /[?&]sslmode=require/i.test(DATABASE_URL);
    pool = new Pool({
      connectionString: DATABASE_URL,
      ssl: sslRequired ? { rejectUnauthorized: false } : undefined,
    });
    await pool.query('SELECT 1');
    db = pool;
    return;
  }

  mode = 'sqlite';
  sqliteDb = await open({
    filename: SQLITE_FILE,
    driver: sqlite3.Database,
  });
  db = sqliteDb;
  await ensureSqliteSchema();
}

export async function upsertUser({ provider, provider_user_id, name, avatar }) {
  if (!provider || !provider_user_id) {
    throw new Error('upsertUser: provider and provider_user_id are required');
  }

  if (isPostgres()) {
    const result = await tx(async ({ query }) => {
      const inserted = await query(
        `
        INSERT INTO users (provider, provider_user_id, name, avatar)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (provider, provider_user_id) DO UPDATE SET
          name = excluded.name,
          avatar = excluded.avatar
        RETURNING *;
      `,
        [provider, String(provider_user_id), name || null, avatar || null]
      );
      let user = inserted.rows[0];

      let clusterId = user.cluster_id;
      let primaryId = user.primary_user_id;
      if (!clusterId) clusterId = crypto.randomUUID();
      if (!primaryId) primaryId = user.id;
      if (!user.cluster_id || !user.primary_user_id) {
        const updated = await query(
          'UPDATE users SET cluster_id = $1, primary_user_id = $2 WHERE id = $3 RETURNING *',
          [clusterId, primaryId, user.id]
        );
        user = updated.rows[0];
      }

      const link = await query(
        'SELECT person_id FROM person_links WHERE provider = $1 AND provider_user_id = $2 LIMIT 1',
        [provider, String(provider_user_id)]
      );
      let personId = link.rows[0]?.person_id;
      if (!personId) {
        const created = await query('INSERT INTO persons DEFAULT VALUES RETURNING id');
        personId = created.rows[0].id;
        await query('INSERT INTO person_links (person_id, provider, provider_user_id) VALUES ($1, $2, $3)', [
          personId,
          provider,
          String(provider_user_id),
        ]);
      }

      return { ...user, person_id: personId };
    });

    return result;
  }

  await sqliteDb.run(
    `
    INSERT INTO users (provider, provider_user_id, name, avatar)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(provider, provider_user_id) DO UPDATE SET
      name=excluded.name,
      avatar=excluded.avatar
  `,
    [provider, String(provider_user_id), name || null, avatar || null]
  );

  let user = await sqliteDb.get(
    `SELECT * FROM users WHERE provider = ? AND provider_user_id = ?`,
    [provider, String(provider_user_id)]
  );

  if (!user.cluster_id) {
    const clusterId = crypto.randomUUID();
    await sqliteDb.run(`UPDATE users SET cluster_id = ? WHERE id = ?`, [clusterId, user.id]);
    user.cluster_id = clusterId;
  }
  if (!user.primary_user_id) {
    await sqliteDb.run(`UPDATE users SET primary_user_id = ? WHERE id = ?`, [user.id, user.id]);
    user.primary_user_id = user.id;
  }

  let link = await sqliteDb.get(
    `SELECT person_id FROM person_links WHERE provider = ? AND provider_user_id = ?`,
    [provider, String(provider_user_id)]
  );

  if (!link) {
    const ins = await sqliteDb.run(`INSERT INTO persons DEFAULT VALUES`);
    const person_id = ins.lastID;
    await sqliteDb.run(
      `INSERT INTO person_links (person_id, provider, provider_user_id) VALUES (?, ?, ?)`,
      [person_id, provider, String(provider_user_id)]
    );
    link = { person_id };
  }

  return { ...user, person_id: link.person_id };
}

export async function logEvent(user_id, type, meta = {}) {
  await query('INSERT INTO events (user_id, type, meta) VALUES ($1, $2, $3)', [
    user_id ?? null,
    String(type),
    JSON.stringify(meta),
  ]);
}

export async function linkAccounts({ left, right }) {
  const [l, r] = await Promise.all([
    query('SELECT person_id FROM person_links WHERE provider = $1 AND provider_user_id = $2', [
      left.provider,
      String(left.provider_user_id),
    ]),
    query('SELECT person_id FROM person_links WHERE provider = $1 AND provider_user_id = $2', [
      right.provider,
      String(right.provider_user_id),
    ]),
  ]);

  const leftRow = l.rows[0];
  const rightRow = r.rows[0];
  if (!leftRow || !rightRow) throw new Error('linkAccounts: one of links not found');
  if (leftRow.person_id === rightRow.person_id) return leftRow.person_id;

  await query('UPDATE person_links SET person_id = $1 WHERE person_id = $2', [
    leftRow.person_id,
    rightRow.person_id,
  ]);
  await query('DELETE FROM persons WHERE id = $1', [rightRow.person_id]);
  return leftRow.person_id;
}

export async function getUserById(id) {
  const { rows } = await query('SELECT * FROM users WHERE id = $1', [id]);
  return rows[0] || null;
}

export async function resolvePrimaryUserId(userId, queryFn = query) {
  const id = Number(userId);
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error('user_not_found');
  }
  const { rows } = await queryFn('SELECT id, primary_user_id FROM users WHERE id = $1', [id]);
  if (!rows.length) throw new Error('user_not_found');
  const row = rows[0];
  return Number(row.primary_user_id || row.id);
}

export function getDb() {
  if (!db) throw new Error('db not initialized');
  return db;
}
