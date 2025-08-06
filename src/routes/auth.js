const express = require('express');
const axios = require('axios');
const jwt = require('jsonwebtoken');
const router = express.Router();

const VK_CLIENT_ID = process.env.VK_CLIENT_ID;
const VK_CLIENT_SECRET = process.env.VK_CLIENT_SECRET;
const JWT_SECRET = process.env.JWT_SECRET;
const API_VERSION = '5.236'; // Самая свежая

router.post('/vk-callback', async (req, res) => {
  try {
    // Обеспечиваем поддержку всех возможных кейсов передачи поля
    const { code, deviceId = req.body.deviceid, codeVerifier = req.body.code_verifier } = req.body;

    if (!code || !deviceId) {
      return res.status(400).json({ error: 'Missing code or device_id' });
    }

    // Меняем на новый эндпоинт + правильные параметры
    const tokenResp = await axios.get('https://api.vk.com/method/auth.exchangeCode', {
      params: {
        v: API_VERSION,
        client_id: VK_CLIENT_ID,
        client_secret: VK_CLIENT_SECRET,
        code,
        device_id: deviceId,
        code_verifier: codeVerifier // обычно фронт VKID OneTap это делает сам, но явно не помешает
      }
    });

    // VK всегда возвращает вложенный объект response
    const { response, error, error_description } = tokenResp.data;
    if (error) {
      return res.status(401).json({ error, error_description });
    }
    const { access_token, user_id, refresh_token } = response || {};
    if (!access_token || !user_id) {
      return res.status(401).json({ error: 'Failed to get access_token' });
    }

    // Далее — логика поиска/создания пользователя в БД + выдача JWT
    // Тут просто "заглушка"
    const user = {
      vk_id: user_id,
      firstName: "Имя",
      lastName: "Фамилия",
      avatar: "https://vk.com/images/camera_200.png",
      balance: 0
    };
    const token = jwt.sign({ userId: user.vk_id }, JWT_SECRET, { expiresIn: '7d' });

    res.json({ token, user });

  } catch (e) {
    // Логируем ошибку для дебага
    console.error('[vk-callback error]', e?.response?.data || e.message);
    res.status(500).json({ error: 'Internal error', details: e?.response?.data || e.message });
  }
});

module.exports = router;
