// src/routes/auth.js
const express = require('express');
const axios = require('axios');
const jwt = require('jsonwebtoken');
const { PrismaClient } = require('@prisma/client');

const router = express.Router();
const prisma = new PrismaClient();

// Используй свои переменные среды
const VK_CLIENT_ID = process.env.VK_CLIENT_ID;
const VK_CLIENT_SECRET = process.env.VK_CLIENT_SECRET;
const JWT_SECRET = process.env.JWT_SECRET;

// Проверка работы эндпоинта
router.get('/vk', (req, res) => {
  res.send('VK Auth endpoint is alive!');
});

// Основной endpoint для VK One Tap — принимает code и device_id
router.post('/vk-callback', async (req, res) => {
  try {
    const { code, deviceId } = req.body;
    if (!code || !deviceId) {
      return res.status(400).json({ error: 'code and deviceId are required' });
    }

    // Новый эндпоинт VK API (One Tap)
    const tokenResp = await axios.get('https://api.vk.com/method/auth.exchangeCode', {
      params: {
        v: '5.131',
        client_id: VK_CLIENT_ID,
        client_secret: VK_CLIENT_SECRET,
        code,
        device_id: deviceId,
      },
    });

    const { access_token, user_id } = (tokenResp.data.response || {});

    if (!access_token || !user_id) {
      return res.status(401).json({ error: 'VK authorization failed', details: tokenResp.data });
    }

    // Получаем профиль пользователя из VK API
    const profileResp = await axios.get('https://api.vk.com/method/users.get', {
      params: {
        user_ids: user_id,
        access_token,
        v: '5.131',
        fields: 'photo_200,first_name,last_name',
      },
    });

    const vkUser = (profileResp.data.response && profileResp.data.response[0]) || {};
    const { first_name, last_name, photo_200 } = vkUser;

    // Сохраняем/обновляем пользователя в базе (по VK user_id)
    let user = await prisma.user.findUnique({ where: { vkId: user_id } });
    if (!user) {
      user = await prisma.user.create({
        data: {
          vkId: user_id,
          firstName: first_name,
          lastName: last_name,
          avatar: photo_200,
          balance: 0,
        },
      });
    } else {
      user = await prisma.user.update({
        where: { vkId: user_id },
        data: {
          firstName: first_name,
          lastName: last_name,
          avatar: photo_200,
        },
      });
    }

    // Генерируем JWT
    const token = jwt.sign(
      { userId: user.id, vkId: user.vkId },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    // Отправляем профиль + токен
    res.json({
      token,
      user: {
        vk_id: user.vkId,
        firstName: user.firstName,
        lastName: user.lastName,
        avatar: user.avatar,
        balance: user.balance,
      },
    });

  } catch (err) {
    // Логируем ошибку и возвращаем 500
    console.error('VK Auth error:', err?.response?.data || err);
    res.status(500).json({ error: 'Internal Server Error', details: err?.response?.data || err.message });
  }
});

module.exports = router;
