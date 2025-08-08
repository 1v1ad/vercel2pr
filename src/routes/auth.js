const router = require('express').Router();
const axios = require('axios');
const { PrismaClient } = require('@prisma/client');
const crypto = require('crypto');
const { sign, setSessionCookie } = require('../lib/jwt');

const prisma = new PrismaClient();

const {
  VK_CLIENT_ID,
  VK_CLIENT_SECRET,
  FRONTEND_ORIGIN,            // https://sweet-twilight-63a9b6.netlify.app
  REDIRECT_URI_BACKEND        // https://vercel2pr.onrender.com/api/auth/vk/callback
} = process.env;

function randomState() {
  return crypto.randomBytes(16).toString('hex');
}

// 1) Старт авторизации: редиректим пользователя на VK OAuth
//    GET /api/auth/vk/start
router.get('/vk/start', async (req, res) => {
  try {
    const state = randomState();
    // Можно сохранять state в сессию/куку и сверять в callback (anti-CSRF)
    const params = new URLSearchParams({
      client_id: VK_CLIENT_ID,
      redirect_uri: REDIRECT_URI_BACKEND,
      response_type: 'code',
      scope: 'offline',
      state
    });
    const url = `https://oauth.vk.com/authorize?${params.toString()}`;
    return res.redirect(url);
  } catch (e) {
    console.error('vk/start error:', e);
    return res.status(500).send('vk_start_failed');
  }
});

// 2) Callback от VK: приходят ?code=...
//    GET /api/auth/vk/callback
router.get('/vk/callback', async (req, res) => {
  try {
    const { code /*, state*/ } = req.query;
    if (!code) return res.status(400).send('missing code');

    // Меняем code → access_token
    const tokenResp = await axios.get('https://oauth.vk.com/access_token', {
      params: {
        client_id: VK_CLIENT_ID,
        client_secret: VK_CLIENT_SECRET,
        redirect_uri: REDIRECT_URI_BACKEND,
        code
      },
      timeout: 12000
    });

    const { access_token, user_id } = tokenResp.data || {};
    if (!access_token || !user_id) {
      console.error('vk/callback token resp:', tokenResp.data);
      return res.redirect(`${FRONTEND_ORIGIN}/?err=invalid_token`);
    }

    // Берём профиль
    const userResp = await axios.get('https://api.vk.com/method/users.get', {
      params: {
        user_ids: user_id,
        fields: 'photo_100,first_name,last_name',
        access_token,
        v: '5.199'
      },
      timeout: 12000
    });

    const info = userResp.data?.response?.[0];
    if (!info) {
      console.error('vk users.get failed:', userResp.data);
      return res.redirect(`${FRONTEND_ORIGIN}/?err=users_get_failed`);
    }

    // upsert в БД
    const user = await prisma.user.upsert({
      where: { vk_id: String(user_id) },
      update: {
        firstName: info.first_name || '',
        lastName: info.last_name || '',
        avatar: info.photo_100 || ''
      },
      create: {
        vk_id: String(user_id),
        firstName: info.first_name || '',
        lastName: info.last_name || '',
        avatar: info.photo_100 || ''
      }
    });

    // Ставим сессионную куку
    const token = sign({ uid: user.id, vk: user.vk_id });
    setSessionCookie(res, token); // HttpOnly; SameSite=None; Secure внутри

    // В лобби
    return res.redirect(`${FRONTEND_ORIGIN}/lobby.html`);
  } catch (e) {
    const detail = e?.response?.data || e.message || String(e);
    console.error('vk/callback error:', detail);
    return res.redirect(`${FRONTEND_ORIGIN}/?err=vk_exchange_failed`);
  }
});

// 3) Health для «пробуждения» инстанса
router.get('/health', (req, res) => res.json({ ok: true, t: Date.now() }));

module.exports = router;
