const router = require('express').Router();
const axios = require('axios');
const { PrismaClient } = require('@prisma/client');
const crypto = require('crypto');
const { sign, setSessionCookie } = require('../lib/jwt');

const prisma = new PrismaClient();

const {
  VK_CLIENT_ID,
  VK_CLIENT_SECRET,
  REDIRECT_URI,
} = process.env;

// fallback device_id, если не пришёл с фронта
function fallbackDeviceId(ua = '') {
  return crypto.createHash('sha256').update(ua).digest('hex');
}

router.post('/vk/exchange', async (req, res) => {
  try {
    const { code, code_verifier, device_id } = req.body || {};
    if (!code) {
      return res.status(400).json({ error: 'code is required' });
    }

    const params = {
      client_id: VK_CLIENT_ID,
      client_secret: VK_CLIENT_SECRET,
      redirect_uri: REDIRECT_URI,
      code
    };

    // если фронт прислал PKCE — добавляем
    if (code_verifier) {
      params.code_verifier = code_verifier;
      params.device_id = device_id || fallbackDeviceId(req.headers['user-agent'] || '');
    }

    // запрос токена у VK
    const tokenResp = await axios.get('https://oauth.vk.com/access_token', {
      params,
      timeout: 12000
    });

    const { access_token, user_id } = tokenResp.data || {};
    if (!access_token || !user_id) {
      return res.status(401).json({ error: 'access_token or user_id not received' });
    }

    // запрос данных пользователя
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
      return res.status(500).json({ error: 'VK users.get failed' });
    }

    // апсерт в БД
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

    // установка cookie
    const token = sign({ uid: user.id, vk: user.vk_id });
    setSessionCookie(res, token);

    res.json({ ok: true });
  } catch (e) {
    console.error('vk/exchange error:', e?.response?.data || e.message);
    res.status(500).json({ error: 'vk_exchange_failed', detail: e?.response?.data || e.message });
  }
});

module.exports = router;
