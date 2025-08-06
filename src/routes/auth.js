const express = require('express');
const axios = require('axios');
const jwt = require('jsonwebtoken');
const { PrismaClient } = require('@prisma/client');

const router = express.Router();
const prisma = new PrismaClient();

const VK_CLIENT_ID = process.env.VK_CLIENT_ID;
const VK_CLIENT_SECRET = process.env.VK_CLIENT_SECRET;
const JWT_SECRET = process.env.JWT_SECRET;

// Проверка "живости" endpoint
router.get('/vk', (req, res) => {
  res.send('VK Auth endpoint is alive!');
});

// Авторизация VK One Tap
router.post('/vk-callback', async (req, res) => {
  try {
    console.log('vk-callback BODY:', req.body); // <--- выводим всё что пришло
    // deviceId может называться deviceid (нижнее подчеркивание) - поддерживаем оба варианта!
    const { code, deviceId = req.body.deviceid } = req.body;
    console.log('Parsed code:', code, 'deviceId:', deviceId); // <---

    if (!code || !deviceId) {
      return res.status(400).json({ error: 'code and deviceId are required' });
    }

    // Запрашиваем access_token через exchangeCode
    const tokenResp = await axios.get('https://api.vk.com/method/auth.exchangeCode', {
      params: {
        v: '5.131',
        client_id: VK_CLIENT_ID,
        client_secret: VK_CLIENT_SECRET,
        code,
        device_id: deviceId, // <-- snake_case обязательно!
      }
    });
    console.log('VK tokenResp:', tokenResp.data); // <---

    const { response, error, error_description } = tokenResp.data;
    if (error) {
      return res.status(401).json({ error, error_description });
    }
    const { access_token, user_id } = response || {};
    if (!access_token || !user_id) {
      return res.status(401).json({ error: 'Failed to get access_token' });
    }

    // Получаем профиль пользователя VK
    const profileResp = await axios.get('https://api.vk.com/method/users.get', {
      params: {
        user_ids: user_id,
        access_token,
        v: '5.131',
        fields: 'photo_200,first_name,last_name',
      }
    });
    console.log('VK profileResp:', profileResp.data); // <---

    const vkUser = (profileResp.data.response && profileResp.data.response[0]) || {};
    const { first_name, last_name, photo_200 } = vkUser;

    // Работаем с БД
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
    // Детальный вывод ошибок VK
    console.error('VK Auth error:', err?.response?.data || err);
    res.status(500).json({ error: 'Internal Server Error', details: err?.response?.data || err.message });
  }
});

module.exports = router;
