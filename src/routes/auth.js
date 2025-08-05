const express = require('express');
const router = express.Router();

// Тестовый endpoint для VK (для проверки работы API)
router.get('/vk', (req, res) => {
  res.send('VK Auth endpoint is alive!');
});

// ВАЖНО: Добавить POST /vk-callback для фронта!
router.post('/vk-callback', async (req, res) => {
  // Здесь логика обмена code/device_id на access_token у VK
  // и создание (или обновление) пользователя

  // Пока тестовая заглушка — чтобы проверить логику фронта
  res.json({
    token: "test.jwt.token",
    user: {
      vk_id: 12345,
      firstName: "Тест",
      lastName: "Пользователь",
      avatar: "https://vk.com/images/camera_200.png",
      balance: 0
    }
  });
});

module.exports = router;
