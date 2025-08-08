// backend/src/routes/auth.js
const router = require('express').Router();
const axios = require('axios');
const { PrismaClient } = require('@prisma/client');
const crypto = require('crypto');
const { sign, setSessionCookie } = require('../lib/jwt');

const prisma = new PrismaClient();

const {
  VK_CLIENT_ID,
  VK_CLIENT_SECRET,
  REDIRECT_URI, // https://sweet-twilight-63a9b6.netlify.app/vk-callback.html
} = process.env;

function fallbackDeviceId(ua = '') {
  return crypto.createHash('sha256').update(ua).digest('hex');
}

// POST /api/auth/vk/exchange
// body: { code, device_id? }
router.post('/vk/exchange', async (req, res) => {
  try {
    const { code, device_id } = req.body || {};
    if (!code) return res.status(400).json({ error: 'code is required' });

    const params = {
      client_id: VK_CLIENT_ID,
      client_secret: VK_CLIENT_SECRET,
      redirect_uri: REDIRECT_URI,
      code,
      // device_id желательно прокинуть, если его дал виджет
      device_id: device_id || fallbackDeviceId(req.headers['user-agent'] || '')
    };

    const tokenResp = await axios.get('https://oauth.vk.com/access_token', {
      params,
      timeout: 15000
    });

    const { access_token, user_id } = tokenResp.data || {};
    if (!access_token || !user_id) {
      return res.status(401).json({ error: 'access_token or user_id not received', detail: tokenResp.data });
    }

    const userResp = await axios.get('https://api.vk.com/method/users.get', {
      params: {
        user_ids: user_id,
        fields: 'photo_100,first_name,last_name',
        access_token,
        v: '5.199'
      },
      timeout: 15000
    });

    const info = userResp.data?.response?.[0];
    if (!info) {
      return res.status(502).json({ error: 'VK users.get failed', detail: userResp.data });
    }

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

    const token = sign({ uid: user.id, vk: user.vk_id });
    setSessionCookie(res, token); // HttpOnly; SameSite=None; Secure

    return res.json({ ok: true });
  } catch (e) {
    const detail = e?.response?.data || e.message || String(e);
    console.error('vk/exchange error:', detail);
    return res.status(500).json({ error: 'vk_exchange_failed', detail });
  }
});

module.exports = router;
