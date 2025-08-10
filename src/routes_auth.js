// src/routes_auth.js
// VK OAuth + JWT, хранение пользователей через Prisma.
// Требуемые ENV:
// - VK_CLIENT_ID
// - VK_CLIENT_SECRET
// - VK_REDIRECT_URI        (пример: https://vercel2pr.onrender.com/api/auth/vk/callback)
// - FRONTEND_URL           (пример: https://sweet-twilight-63a9b6.netlify.app)
// - JWT_SECRET
//
// Зависимости: axios, jsonwebtoken, @prisma/client
//
// Маршруты:
//   GET  /api/auth/vk/callback   — обмен кода на токен VK, апсерт пользователя, редирект на фронт с token
//   GET  /api/auth/me            — вернуть профиль по Bearer JWT (для фронта)
//

import express from 'express';
import axios from 'axios';
import jwt from 'jsonwebtoken';
import prisma from './db.js';

const router = express.Router();

function signAppToken(user) {
  // payload максимально простой: без личных данных
  return jwt.sign(
    { uid: user.id, vk_id: user.vk_id },
    process.env.JWT_SECRET,
    { expiresIn: '30d' }
  );
}

function bearer(req) {
  const h = req.headers.authorization || '';
  return h.startsWith('Bearer ') ? h.slice(7) : null;
}

// ============ VK CALLBACK ============
// VK перенаправляет сюда после логина с параметром ?code=...
router.get('/vk/callback', async (req, res) => {
  try {
    const code = req.query.code;
    if (!code) {
      return res.status(400).send('Missing code');
    }

    const {
      VK_CLIENT_ID,
      VK_CLIENT_SECRET,
      VK_REDIRECT_URI,
      FRONTEND_URL,
    } = process.env;

    // 1) меняем code на access_token
    const tokenResp = await axios.get('https://oauth.vk.com/access_token', {
      params: {
        client_id: VK_CLIENT_ID,
        client_secret: VK_CLIENT_SECRET,
        redirect_uri: VK_REDIRECT_URI,
        code,
      },
    });

    // ожидаем user_id и access_token
    const { access_token, user_id } = tokenResp.data || {};
    if (!access_token || !user_id) {
      return res.status(401).send('VK token exchange failed');
    }

    // 2) подтягиваем базовую инфу о пользователе
    const infoResp = await axios.get('https://api.vk.com/method/users.get', {
      params: {
        user_ids: user_id,
        fields: 'photo_200',
        v: '5.199',
        access_token,
      },
    });

    const u = infoResp.data?.response?.[0];
    const firstName = u?.first_name || '';
    const lastName = u?.last_name || '';
    const avatar = u?.photo_200 || '';

    // 3) апсерт пользователя в БД
    const user = await prisma.user.upsert({
      where: { vk_id: String(user_id) },
      update: {
        firstName,
        lastName,
        avatar,
      },
      create: {
        vk_id: String(user_id),
        firstName,
        lastName,
        avatar,
        balance: 0, // копейки
      },
    });

    // 4) выдаём наш JWT и редиректим на фронт
    const token = signAppToken(user);

    // редиректим в лобби (как ты и просил раньше), токен — в query
    const redirectUrl = new URL(FRONTEND_URL || 'http://localhost:5173');
    // если хочешь строго в /lobby — раскомментируй:
    // redirectUrl.pathname = '/lobby';
    redirectUrl.searchParams.set('token', token);

    return res.redirect(302, redirectUrl.toString());
  } catch (e) {
    console.error('VK callback error:', e?.response?.data || e?.message || e);
    return res.status(500).send('Auth failed');
  }
});

// ============ ME ============
router.get('/me', async (req, res) => {
  try {
    const t = bearer(req);
    if (!t) return res.status(401).json({ error: 'No token' });

    let decoded;
    try {
      decoded = jwt.verify(t, process.env.JWT_SECRET);
    } catch {
      return res.status(401).json({ error: 'Invalid token' });
    }

    const user = await prisma.user.findUnique({
      where: { id: decoded.uid },
      select: { id: true, vk_id: true, firstName: true, lastName: true, avatar: true, balance: true, createdAt: true, updatedAt: true },
    });

    if (!user) return res.status(404).json({ error: 'User not found' });

    res.json({ user });
  } catch (e) {
    console.error('ME error:', e);
    res.status(500).json({ error: 'Internal error' });
  }
});

export default router;
