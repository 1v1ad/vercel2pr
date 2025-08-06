const express = require('express');
const axios = require('axios');
const jwt = require('jsonwebtoken');
const { PrismaClient } = require('@prisma/client');
const router = express.Router();

const prisma = new PrismaClient();

const VK_CLIENT_ID = process.env.VK_CLIENT_ID;
const VK_CLIENT_SECRET = process.env.VK_CLIENT_SECRET;
const JWT_SECRET = process.env.JWT_SECRET;

router.get('/vk', (req, res) => {
  res.send('VK Auth endpoint is alive!');
});

router.post('/vk-callback', async (req, res) => {
  try {
    // Получаем данные из body
    // (и device_id, и code_verifier обязательны)
    const { code, deviceId = req.body.device_id, codeVerifier = req.body.code_verifier } = req.body;

    if (!code || !deviceId || !codeVerifier) {
      return res.status(400).json({ error: 'Missing code, deviceId or codeVerifier' });
    }

    // Обмениваем code на access_token через VK OAuth endpoint
    const tokenResp = await axios.get('https://oauth.vk.com/access_token', {
      params: {
        client_id: VK_CLIENT_ID,
        client_secret: VK_CLIENT_SECRET,
        code,
        device_id: deviceId,
        code_verifier: codeVerifier,
      }
    });

    const { access_token, user_id, refresh_token } = tokenResp.data || {};
    if (!access_token || !user_id) {
      return res.status(401).json({ error: 'Failed to get access_token' });
    }

    // Получаем инфу о пользователе
    const vkResp = await axios.get('https://api.vk.com/method/users.get', {
      params: {
        user_ids: user_id,
        fields: 'photo_200,first_name,last_name',
        access_token,
        v: '5.131',
      }
    });

    const vkUser = vkResp.data?.response?.[0];
    if (!vkUser) return res.status(401).json({ error: 'Failed to get VK user info' });

    // Сохраняем или обновляем пользователя в базе
    let user = await prisma.user.upsert({
      where: { vkId: String(user_id) },
      update: {
        firstName: vkUser.first_name,
        lastName: vkUser.last_name,
        avatar: vkUser.photo_200,
      },
      create: {
        vkId: String(user_id),
        firstName: vkUser.first_name,
        lastName: vkUser.last_name,
        avatar: vkUser.photo_200,
        balance: 0,
      }
    });

    // Генерируем JWT
    const token = jwt.sign({ userId: user.id, vkId: user.vkId }, JWT_SECRET, { expiresIn: '7d' });

    res.json({
      token,
      user: {
        vk_id: user.vkId,
        firstName: user.firstName,
        lastName: user.lastName,
        avatar: user.avatar,
        balance: user.balance
      }
    });
  } catch (err) {
    // Выводим ошибку VK (если есть)
    if (err.response?.data) {
      return res.status(401).json(err.response.data);
    }
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
