const express = require('express');
const router = express.Router();
const { vkLogin } = require('../controllers/authController');

router.post('/vk-callback', vkLogin);

module.exports = router;
