import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import axios from 'axios';
import jwt from 'jsonwebtoken';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';

const {
  PORT               = 8080,
  FRONTEND_ORIGIN,
  VK_CLIENT_ID,
  VK_CLIENT_SECRET,
  REDIRECT_URI,
  JWT_SECRET
} = process.env;

const app = express();
app.use(express.json());
app.use(cookieParser());
app.use(cors({ origin: FRONTEND_ORIGIN, credentials: true }));

// ─────────────────── SQLite ───────────────────
let db;
(async () => {
  db = await open({ filename: 'database.sqlite', driver: sqlite3.Database });
  await db.run(`
    CREATE TABLE IF NOT EXISTS users (
      vk_id       INTEGER PRIMARY KEY,
      first_name  TEXT,
      last_name   TEXT,
      avatar      TEXT,
      email       TEXT,
      created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
})();

// ────────────── Вспомогательные функции ─────────────
const sign = payload => jwt.sign(payload, JWT_SECRET, { expiresIn: '30d' });
const auth = (req, res, next) => {
  const token = req.cookies.token || req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'unauthorized' });
  try { req.user = jwt.verify(token, JWT_SECRET); next(); }
  catch { return res.status(401).json({ error: 'unauthorized' }); }
};

// ───────────────────  Маршруты  ────────────────────

// 1. Обмен code → access_token, запись пользователя, установка cookie
app.post('/api/auth/vk', async (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: 'no_code' });

  try {
    // a) меняем code на access_token
    const url = `https://oauth.vk.com/access_token?client_id=${VK_CLIENT_ID}&client_secret=${VK_CLIENT_SECRET}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&code=${code}`;
    const { data: tokenData } = await axios.get(url); // access_token, user_id, email, expires_in
    const { access_token, user_id, email } = tokenData;

    // b) достаём профиль
    const infoUrl = `https://api.vk.com/method/users.get?user_ids=${user_id}&v=5.199&access_token=${access_token}&fields=photo_100`;
    const { data: { response: [u] } } = await axios.get(infoUrl);

    // c) upsert в БД
    await db.run(`
      INSERT INTO users(vk_id, first_name, last_name, avatar, email)
      VALUES(?,?,?,?,?)
      ON CONFLICT(vk_id) DO UPDATE SET
        first_name=excluded.first_name,
        last_name =excluded.last_name,
        avatar   =excluded.avatar,
        email    =excluded.email
    `, [u.id, u.first_name, u.last_name, u.photo_100, email]);

    // d) JWT-cookie
    res.cookie('token', sign({ id: u.id }), {
      httpOnly: true,
      sameSite: 'lax',
      maxAge: 30 * 24 * 3600 * 1000
    });

    res.json({ ok: true });
  } catch (err) {
    console.error(err.response?.data || err);
    res.status(500).json({ error: 'vk_exchange_failed' });
  }
});

// текущий пользователь
app.get('/api/me', auth, async (req, res) => {
  const me = await db.get('SELECT vk_id, first_name, last_name, avatar, email FROM users WHERE vk_id = ?', [req.user.id]);
  res.json(me);
});

// logout
app.post('/api/logout', (_req, res) => {
  res.clearCookie('token');
  res.json({ ok: true });
});

app.listen(PORT, () => console.log(`API started on :${PORT}`));
