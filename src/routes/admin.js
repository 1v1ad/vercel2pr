// VK OAuth + JWT через Prisma
// ENV: VK_CLIENT_ID, VK_CLIENT_SECRET, VK_REDIRECT_URI, FRONTEND_URL, JWT_SECRET
import express from 'express';
import axios from 'axios';
import jwt from 'jsonwebtoken';
import prisma from './db.js';

const router = express.Router();

function signAppToken(user) {
  return jwt.sign({ uid: user.id, vk_id: user.vk_id }, process.env.JWT_SECRET, { expiresIn: '30d' });
}
function bearer(req) {
  const h = req.headers.authorization || '';
  return h.startsWith('Bearer ') ? h.slice(7) : null;
}

/**
 * GET /api/auth/vk/start
 * Редиректит пользователя на VK OAuth c response_type=code
 */
router.get('/vk/start', (req, res) => {
  const { VK_CLIENT_ID, VK_REDIRECT_URI } = process.env;
  if (!VK_CLIENT_ID || !VK_REDIRECT_URI) return res.status(500).send('VK OAuth not configured');

  const url = new URL('https://oauth.vk.com/authorize');
  url.searchParams.set('client_id', VK_CLIENT_ID);
  url.searchParams.set('redirect_uri', VK_REDIRECT_URI);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('display', 'page');
  url.searchParams.set('scope', ''); // при необходимости: 'offline'
  url.searchParams.set('v', '5.199');

  return res.redirect(302, url.toString());
});

/**
 * GET /api/auth/vk/callback?code=...
 * Обмен кода на токен VK, апсерт пользователя, редирект на FRONTEND_URL?token=...
 */
router.get('/vk/callback', async (req, res) => {
  try {
    const code = req.query.code;
    if (!code) return res.status(400).send('Missing code');

    const { VK_CLIENT_ID, VK_CLIENT_SECRET, VK_REDIRECT_URI, FRONTEND_URL } = process.env;

    // 1) обмен кода на access_token
    const tokenResp = await axios.get('https://oauth.vk.com/access_token', {
      params: {
        client_id: VK_CLIENT_ID,
        client_secret: VK_CLIENT_SECRET,
        redirect_uri: VK_REDIRECT_URI,
        code,
      },
    });
    const { access_token, user_id } = tokenResp.data || {};
    if (!access_token || !user_id) return res.status(401).send('VK token exchange failed');

    // 2) базовая инфа
    const infoResp = await axios.get('https://api.vk.com/method/users.get', {
      params: { user_ids: user_id, fields: 'photo_200', v: '5.199', access_token },
    });
    const u = infoResp.data?.response?.[0];
    const firstName = u?.first_name || '';
    const lastName = u?.last_name || '';
    const avatar = u?.photo_200 || '';

    // 3) апсерт пользователя
    const user = await prisma.user.upsert({
      where: { vk_id: String(user_id) },
      update: { firstName, lastName, avatar },
      create: { vk_id: String(user_id), firstName, lastName, avatar, balance: 0 },
    });

    // 4) наш JWT и редирект на фронт
    const token = signAppToken(user);
    const redirectUrl = new URL(process.env.FRONTEND_URL || 'http://localhost:5173');
    // redirectUrl.pathname = '/lobby'; // если нужно строго в /lobby — раскомментируй
    redirectUrl.searchParams.set('token', token);
    return res.redirect(302, redirectUrl.toString());
  } catch (e) {
    console.error('VK callback error:', e?.response?.data || e?.message || e);
    return res.status(500).send('Auth failed');
  }
});

/**
 * GET /api/auth/me  — профиль по Bearer JWT
 */
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
