// backend/src/routes_auth.js
const express = require('express');
const axios = require('axios');
const jwt = require('jsonwebtoken');
const db = require('./db');
const router = express.Router();

// Функция чтения ENV с подстраховкой названий
function getenv() {
    const env = process.env;
    const clientId     = env.VK_CLIENT_ID;
    const clientSecret = env.VK_CLIENT_SECRET;
    const redirectUri  = env.VK_REDIRECT_URI || env.REDIRECT_URI;
    const frontendUrl  = env.FRONTEND_URL || env.CLIENT_URL;

    for (const [k, v] of Object.entries({
        VK_CLIENT_ID: clientId,
        VK_CLIENT_SECRET: clientSecret,
        VK_REDIRECT_URI: redirectUri,
        FRONTEND_URL: frontendUrl,
    })) {
        if (!v) throw new Error(`Missing env ${k}`);
    }

    return { clientId, clientSecret, redirectUri, frontendUrl };
}

// ====== 1. Старт авторизации ======
router.get('/vk/start', async (req, res) => {
    try {
        const { clientId, redirectUri } = getenv();

        // Генерим случайные state + PKCE verifier
        const state = Math.random().toString(36).substring(2);
        const codeVerifier = Math.random().toString(36).substring(2) + Math.random().toString(36).substring(2);

        // Сохраняем временные куки для коллбэка
        res.cookie('vk_state', state, { httpOnly: true, sameSite: 'lax', secure: true, path: '/', maxAge: 300000 });
        res.cookie('vk_code_verifier', codeVerifier, { httpOnly: true, sameSite: 'lax', secure: true, path: '/', maxAge: 300000 });

        // Собираем URL авторизации VK One Tap
        const authUrl = `https://id.vk.com/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}&code_challenge=${codeVerifier}&code_challenge_method=plain&scope=openid,profile`;

        res.redirect(authUrl);
    } catch (err) {
        console.error('vk/start Error:', err.message);
        res.status(500).send('auth start failed');
    }
});

// ====== 2. Callback ======
router.get('/vk/callback', async (req, res) => {
    try {
        const { clientId, clientSecret, redirectUri, frontendUrl } = getenv();
        const { code, state } = req.query;
        const cookieState = req.cookies.vk_state;
        const codeVerifier = req.cookies.vk_code_verifier;

        if (!code || !state || state !== cookieState) {
            return res.status(400).send('Invalid state or code');
        }

        // Обмениваем код на токен
        const tokenResp = await axios.get('https://id.vk.com/oauth2/auth', {
            params: {
                grant_type: 'authorization_code',
                code,
                client_id: clientId,
                client_secret: clientSecret,
                redirect_uri: redirectUri,
                code_verifier: codeVerifier
            }
        });

        const accessToken = tokenResp.data.access_token;
        const userInfo = tokenResp.data.user;

        if (!accessToken || !userInfo) {
            return res.status(400).send('Token exchange failed');
        }

        // Сохраняем/обновляем пользователя
        let user = await db.user.findUnique({ where: { vk_id: String(userInfo.id) } });
        if (!user) {
            user = await db.user.create({
                data: {
                    vk_id: String(userInfo.id),
                    firstName: userInfo.first_name || '',
                    lastName: userInfo.last_name || '',
                    avatar: userInfo.avatar || ''
                }
            });
        }

        // Генерим сессию
        const sessionJwt = jwt.sign({ uid: user.id }, process.env.JWT_SECRET, { expiresIn: '30d' });

        // Кука для фронта (FIX: SameSite none)
        res.cookie('sid', sessionJwt, {
            httpOnly: true,
            sameSite: 'none',  // <--- ключевая правка для кросс-доменной работы
            secure: true,
            path: '/',
            maxAge: 30 * 24 * 3600 * 1000
        });

        // Чистим временные куки
        res.clearCookie('vk_state');
        res.clearCookie('vk_code_verifier');

        // Редиректим на фронт
        res.redirect(`${frontendUrl}/lobby.html`);
    } catch (err) {
        console.error('vk/callback Error:', err.response?.data || err.message);
        res.status(500).send('auth callback failed');
    }
});

module.exports = router;
