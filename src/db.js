// src/db.js
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';

sqlite3.verbose();
const dbFile = (process.env.DATABASE_URL && process.env.DATABASE_URL.startsWith('file:'))
  ? process.env.DATABASE_URL.replace('file:', '')
  : (process.env.DB_FILE || './dev.db');

export const db = await open({ filename: dbFile, driver: sqlite3.Database });

await db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  vk_id TEXT UNIQUE,
  tg_id TEXT UNIQUE,
  firstName TEXT,
  lastName TEXT,
  avatar TEXT,
  balance INTEGER DEFAULT 0,
  cluster_id INTEGER,
  createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
  updatedAt DATETIME
);
CREATE TABLE IF NOT EXISTS transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  userId INTEGER,
  type TEXT,
  amount INTEGER,
  meta TEXT,
  createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  userId INTEGER,
  event TEXT,
  meta TEXT,
  createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_users_cluster ON users(cluster_id);
`);

export async function getUserById(id){
  return db.get('SELECT * FROM users WHERE id = ?', [id]);
}

export async function upsertVK(vk_id, profile){
  const exist = await db.get('SELECT * FROM users WHERE vk_id = ?', [vk_id]);
  const now = new Date().toISOString();
  if (exist){
    await db.run('UPDATE users SET firstName=?, lastName=?, avatar=?, updatedAt=? WHERE id=?', [
      profile.firstName || exist.firstName,
      profile.lastName || exist.lastName,
      profile.avatar || exist.avatar,
      now, exist.id
    ]);
    return await getUserById(exist.id);
  } else {
    const res = await db.run('INSERT INTO users (vk_id, firstName, lastName, avatar, createdAt) VALUES (?,?,?,?,?)',
      [vk_id, profile.firstName||'', profile.lastName||'', profile.avatar||'', now]);
    return await getUserById(res.lastID);
  }
}

export async function upsertTG(tg_id, profile){
  const exist = await db.get('SELECT * FROM users WHERE tg_id = ?', [tg_id]);
  const now = new Date().toISOString();
  if (exist){
    await db.run('UPDATE users SET firstName=?, lastName=?, avatar=?, updatedAt=? WHERE id=?', [
      profile.firstName || exist.firstName,
      profile.lastName || exist.lastName,
      profile.avatar || exist.avatar,
      now, exist.id
    ]);
    return await getUserById(exist.id);
  } else {
    const res = await db.run('INSERT INTO users (tg_id, firstName, lastName, avatar, createdAt) VALUES (?,?,?,?,?)',
      [tg_id, profile.firstName||'', profile.lastName||'', profile.avatar||'', now]);
    return await getUserById(res.lastID);
  }
}

export async function logEvent(userId, event, meta=null){
  return db.run('INSERT INTO events (userId, event, meta) VALUES (?,?,?)',[userId, event, meta && JSON.stringify(meta)]);
}
