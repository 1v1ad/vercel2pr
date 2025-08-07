// server.js
// ────────────────────────────────────────────────────────────
// Backend: Express + Prisma (SQLite) + VK OneTap (OAuth code)
// ────────────────────────────────────────────────────────────

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import axios from 'axios';
import jwt from 'jsonwebtoken';
import { PrismaClient } from '@prisma/client';

const {
  PORT = process.env.PORT || 8080,
  FRONTEND_ORIGIN,                 // e.g. https://sweet-twilight-63a9b6.netlify.app
  VK_CLIENT_ID,                    // 54008517
  VK_CLIENT_SECRET,                // из кабинета VK
  REDIRECT_URI,                    // https://<service>.onrender.com/api/auth/vk/callback
  JWT_SECRET
} = process.env;

if (!FRONTEND_ORIGIN || !VK_CLIENT_ID || !VK_CLIENT_SECRET || !REDIRECT_URI || !JWT_SECRET) {
  console.warn('[WARN] Missing some env vars. Check FRONTEND_ORIGIN, VK_CLIENT_ID, VK_CLIENT_SECRET, REDIRECT_URI, JWT_SECRET');
}

const prisma = new PrismaClient();
const app = express();

// Если когда-нибудь будете опираться на req.secure, это пригодится за прокси
app.set('trust proxy', 1);

// ─────────────────── Middleware ───────────────────
app.use(express.json());
app.use(cookieParser());

// Разрешаем фронт (Netlify) и куки
const allowlist = (FRONTEND_ORIGIN || '').split(',').map(s => s.trim()).filter(Boolean);
app.use(cors({
  origin(origin, cb) {
    // Разрешаем запросы с allowlist или от тех клиентов, которые не присылают Origin (например, curl/health)
    if (!origin || allowlist.includes(origin)) return cb(null, true);
    return cb(new Error('Not allowed by CORS'), false);
  },
  credentials: true,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

// ─────────────────── Helpers ───────────────────
const signJWT = payload => jwt.sign(payload, JWT_SECRET, { expiresIn: '30d' });

function auth(req, res, next) {
  const bearer = req.headers.authorization?.split(' ')[1];
  const token = req.cookies.token || bearer;
  if (!token) return res.sendStatus(401);
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    return next();
  } catch {
    return res.sendStatus(401);
  }
}

// ─────────────────── Routes ───────────────────

// Healthcheck
app.get('/health', (_req, res) => res.json({ ok: true }));

// Заглушка для VK redirect (чтобы не было 404)
// SDK OneTap всё равно отдаёт code через JS-callback, но VK любит валидный redirect_uri.
app.get('/api/auth/vk/callback', (_req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>OK</title><p>OK</p>');
});

// Основной обмен: code → access_token → профиль → upsert пользователя → JWT-кука
app.post('/api/auth/vk', async (req, res) => {
  const { code } = req.body || {};
  if (!code) return res.status(400).json({ error: 'no_code' });

  try {
    // 1) Меняем code на токен
    const tokenURL =
      `https://oauth.vk.com/access_token` +
      `?client_id=${encodeURIComponent(VK_CLIENT_ID)}` +
      `&client_secret=${encodeURIComponent(VK_CLIENT_SECRET)}` +
      `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
      `&code=${encodeURIComponent(code)}`;

    const { data: t } = await axios.get(tokenURL); // { access_token, user_id, email?, expires_in }
    if (!t?.access_token || !t?.user_id) {
      console.error('VK access_token error:', t);
      return res.status(502).json({ error: 'vk_access_token_failed' });
    }

    // 2) Берём профиль
    const infoURL =
      `https://api.vk.com/method/users.get` +
      `?user_ids=${t.user_id}` +
      `&fields=photo_100` +
      `&v=5.199` +
      `&access_token=${encodeURIComponent(t.access_token)}`;

    const { data: info } = await axios.get(infoURL);
    const user = info?.response?.[0];
    if (!user) {
      console.error('VK users.get error:', info);
      return res.status(502).json({ error: 'vk_userinfo_failed' });
    }

    // 3) Upsert в БД
    await prisma.user.upsert({
      where: { vk_id: user.id },
      update: {
        first_name: user.first_name,
        last_name:  user.last_name,
        avatar:     user.photo_100,
        email:      t.email || null
      },
      create: {
        vk_id:      user.id,
        first_name: user.first_name,
        last_name:  user.last_name,
        avatar:     user.photo_100,
        email:      t.email || null
      }
    });

    // 4) Ставим httpOnly cookie (кросс-домен: SameSite=None + Secure)
    res.cookie('token', signJWT({ id: user.id }), {
      httpOnly: true,
      sameSite: 'none',
      secure: true,
      maxAge: 30 * 24 * 3600 * 1000 // 30 дней
    });

    return res.json({ ok: true });
  } catch (e) {
    // Логируем, но наружу отдаём нейтральную ошибку
    console.error('VK auth error:', e?.response?.data || e.message || e);
    return res.status(500).json({ error: 'vk_exchange_failed' });
  }
});

// Текущий пользователь (для lobby.html)
app.get('/api/me', auth, async (req, res) => {
  const me = await prisma.user.findUnique({
    where: { vk_id: req.user.id },
    select: { vk_id: true, first_name: true, last_name: true, avatar: true, email: true, created_at: true }
  });
  if (!me) return res.sendStatus(404);
  res.json(me);
});

// Выход
app.post('/api/logout', (_req, res) => {
  // Для корректного удаления кук в кросс-домене используем те же атрибуты
  res.clearCookie('token', { httpOnly: true, sameSite: 'none', secure: true });
  res.json({ ok: true });
});

// ─────────────────── Start ───────────────────
app.listen(PORT, () => {
  console.log(`API started on :${PORT}`);
  console.log(`CORS allow: ${allowlist.join(', ') || '<none>'}`);
  console.log(`VK app: ${VK_CLIENT_ID} | Redirect: ${REDIRECT_URI}`);
});
