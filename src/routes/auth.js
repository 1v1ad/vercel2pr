const express = require('express');
const axios   = require('axios');
const jwt     = require('jsonwebtoken');
const { PrismaClient } = require('@prisma/client');

const router  = express.Router();
const prisma  = new PrismaClient();

// .env
const VK_CLIENT_ID     = process.env.VK_CLIENT_ID;
const VK_CLIENT_SECRET = process.env.VK_CLIENT_SECRET;
const JWT_SECRET       = process.env.JWT_SECRET;

/**
 * POST /api/auth/vk-callback
 * Принимает { code, deviceId | deviceid, codeVerifier | code_verifier }
 */
router.post('/vk-callback', async (req, res) => {
  try {
    // поддерживаем разные стили написания полей из фронта
    const {
      code,
      deviceId     = req.body.deviceid,
      codeVerifier = req.body.code_verifier,
    } = req.body;

    if (!code || !deviceId) {
      return res.status(400).json({ error: 'Missing code or deviceId' });
    }

    /** ───────────────────────────────────────────────────────────────
     *  1. Меняем code на access_token через OAuth-эндпоинт VK
     *     (device_id обязателен для One-Tap, code_verifier – только если есть)
     * ────────────────────────────────────────────────────────────── */
    const params = {
      client_id:     VK_CLIENT_ID,
      client_secret: VK_CLIENT_SECRET,
      code,
      device_id:     deviceId,
    };
    if (codeVerifier) params.code_verifier = codeVerifier;   // PKCE

    const tokenResp = await axios.get('https://oauth.vk.com/access_token', { params });
    const { access_token, user_id, expires_in, refresh_token, error, error_description } =
          tokenResp.data || {};

    if (error || !access_token || !user_id) {
      return res.status(401).json({ error: error || 'Failed to get access_token', error_description });
    }

    /** ───────────────────────────────────────────────────────────────
     *  2. Получаем данные профиля пользователя
     * ────────────────────────────────────────────────────────────── */
    const profileResp = await axios.get('https://api.vk.com/method/users.get', {
      params: {
        user_ids:     user_id,
        access_token,             // пользовательский access_token
        v: '5.236',
        fields: 'photo_200,first_name,last_name',
      },
    });

    const vkUser = profileResp.data?.response?.[0] || {};
    const { first_name, last_name, photo_200 } = vkUser;

    /** ───────────────────────────────────────────────────────────────
     *  3. Создаём / обновляем пользователя в БД
     * ────────────────────────────────────────────────────────────── */
    let user = await prisma.user.findUnique({ where: { vkId: user_id } });

    if (!user) {
      user = await prisma.user.create({
        data: {
          vkId:      user_id,
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

    /** ───────────────────────────────────────────────────────────────
     *  4. Генерируем JWT и отдаём клиенту
     * ────────────────────────────────────────────────────────────── */
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

  } catch (err) {
    // выводим тело ответа VK, если прилетела ошибка от их API
    console.error('[vk-callback error]', err?.response?.data || err);
    res.status(500).json({
      error:   'Internal error',
      details: err?.response?.data || err.message,
    });
  }
});

module.exports = router;
