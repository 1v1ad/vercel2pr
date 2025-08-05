const express = require('express');
const router = express.Router();

// Тестовый endpoint для VK (для проверки работы API)
router.get('/vk', (req, res) => {
  res.send('VK Auth endpoint is alive!');
});

// Здесь будут основные маршруты VK OAuth
// router.get('/vk/callback', ...)
// router.post('/vk/token', ...)

module.exports = router;
