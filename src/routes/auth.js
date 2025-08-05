const express = require('express');
const jwt = require('jsonwebtoken');
const axios = require('axios');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const router = express.Router();

const VK_CLIENT_ID = process.env.VK_CLIENT_ID;
const VK_CLIENT_SECRET = process.env.VK_CLIENT_SECRET;
const JWT_SECRET = process.env.JWT_SECRET;

router.get('/vk', (req, res) => {
  res.send('VK Auth endpoint is alive!');
});

router.post('/vk-callback', async (req, res) => {
  try {
    const { code, deviceId } = req.body;
    if (!code || !deviceId) {
      return res.status(400).json({ error: 'Missing code or device_id' });
    }

    // Обмен code на access_token через VK API
    const tokenResp = await axios.get('https://oauth.vk.com/access_token', {
      params: {
        client_id: VK_CLIENT_ID,
        client_secret: VK_CLIENT_SECRET,
        redirect_uri: 'https://sweet-twilight-63a9b6.netlify.app/vk-callback.html',
        code
      }
    });

    const { access_token, user_id } = tokenResp.data;
    if (!access_token || !user_id) {
      return res.status(401).json({ error: 'Failed to get access_token' });
    }

    // Получаем профиль пользователя из VK
    const userResp = await axios.get('https://api.vk.com/method/users.get', {
      params: {
        user_ids: user_id,
        fields: 'photo_200,first_name,last_name',
        access_token,
        v: '5.131'
      }
    });

    const vkUser = userResp.data.response && userResp.data.response[0];
    if (!vkUser) {
      return res.status(401).json({ error: 'Failed to get VK profile' });
    }

    // Находим пользователя или создаём нового в базе
    let user = await prisma.user.findUnique({ where: { vk_id: String(user_id) } });
    if (!user) {
      user = await prisma.user.create({
        data: {
          vk_id: String(user_id),
          firstName: vkUser.first_name,
          lastName: vkUser.last_name,
          avatar: vkUser.photo_200,
          balance: 0
        }
      });
    } else {
      // Обновляем имя/аватар, если поменялись
      if (user.firstName !== vkUser.first_name || user.lastName !== vkUser.last_name || user.avatar !== vkUser.photo_200) {
        user = await prisma.user.update({
          where: { vk_id: String(user_id) },
          data: {
            firstName: vkUser.first_name,
            lastName: vkUser.last_name,
            avatar: vkUser.photo_200
          }
        });
      }
    }

    // Генерируем JWT
    const token = jwt.sign(
      { userId: user.id, vk_id: user.vk_id },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.json({
      token,
      user: {
        vk_id: user.vk_id,
        firstName: user.firstName,
        lastName: user.lastName,
        avatar: user.avatar,
        balance: user.balance
      }
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'VK Auth failed', details: e.message });
  }
});

module.exports = router;
