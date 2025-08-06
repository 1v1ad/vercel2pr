const express       = require('express');
const axios         = require('axios');
const jwt           = require('jsonwebtoken');
const { PrismaClient } = require('@prisma/client');

const router  = express.Router();
const prisma  = new PrismaClient();

// ─── dotenv ───────────────────────────────────────────────────────
const VK_CLIENT_ID     = process.env.VK_CLIENT_ID;
const VK_CLIENT_SECRET = process.env.VK_CLIENT_SECRET;
const JWT_SECRET       = process.env.JWT_SECRET;
// ──────────────────────────────────────────────────────────────────

/**
 * POST /api/auth/vk-callback
 * Body: { code, deviceId|deviceid, codeVerifier|code_verifier }
 */
router.post('/vk-callback', async (req, res) => {
  try {
    // разные стили написания ключей
    const {
      code,
      deviceId     = req.body.deviceid,
      codeVerifier = req.body.code_verifier,
    } = req.body;

    if (!code || !deviceId) {
      return res.status(400).json({ error: 'Missing code or deviceId' });
    }

    /** 1. меняем code → access_token */
    const params = {
      client_id:     VK_CLIENT_ID,
      client_secret: VK_CLIENT_SECRET,
      code,
      device_id:     deviceId,
    };
    if (codeVerifier) params.code_verifier = codeVerifier; // PKCE, если есть

    const tokenResp = await axios.get('https://oauth.vk.com/access_token', { params });
    const {
      access_token,
      user_id,
      expires_in,
      refresh_token,
      error,
      error_description,
    } = tokenResp.data || {};

    if (error || !access_token || !user_id) {
      return res
        .status(400)
        .json({ error: error || 'invalid_grant', error_description });
    }

    /** 2. берём профиль VK */
    const profileResp = await axios.get('https://api.vk.com/method/users.get', {
      params: {
        user_ids:     user_id,
        access_token,      // user-token
        v: '5.236',
        fields: 'photo_200,first_name,last_name',
      },
    });

    const vkUser = profileResp.data?.response?.[0] || {};
    const { first_name, last_name, photo_200 } = vkUser;

    /** 3. создаём/обновляем в БД */
    let user = await prisma.user.findUnique({ where: { vkId: user_id } });

    if (!user) {
      user = await prisma.user.create({
        data: {
          vkId: user_id,
          firstName: first_name,
          lastName:  last_name,
          avatar:    photo_200,
          balance:   0,
        },
      });
    } else {
      user = await prisma.user.update({
        where: { vkId: user_id },
        data:  {
          firstName: first_name,
          lastName:  last_name,
          avatar:    photo_200,
        },
      });
    }

    /** 4. JWT и ответ клиенту */
    const token = jwt.sign(
      { userId: user.id, vkId: user.vkId },
      JWT_SECRET,
      { expiresIn: '7d' },
    );

    res.json({
      token,
      user: {
        vk_id:    user.vkId,
        firstName:user.firstName,
        lastName: user.lastName,
        avatar:   user.avatar,
        balance:  user.balance,
      },
    });
  } catch (e) {
    console.error('[vk-callback error]', e?.response?.data || e);
    res.status(500).json({ error: 'Internal error', details: e?.response?.data || e.message });
  }
});

module.exports = router;
