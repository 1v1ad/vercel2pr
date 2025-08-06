/*  src/routes/auth.js  */
const express = require('express');
const axios   = require('axios');
const jwt     = require('jsonwebtoken');
const { PrismaClient } = require('@prisma/client');

const router = express.Router();
const prisma = new PrismaClient();

const {
  VK_CLIENT_ID,
  VK_CLIENT_SECRET,
  JWT_SECRET
} = process.env;

/* ---------- POST /api/auth/vk-callback ---------- */
router.post('/vk-callback', async (req, res) => {
  try {
    const { code, deviceId, codeVerifier } = req.body;
    if (!code) return res.status(400).json({ error:'Missing code' });

    /* ---------- 1. пытаемся новый auth.exchangeCode ---------- */
    let tokenData;
    try {
      const r = await axios.get(
        'https://api.vk.com/method/auth.exchangeCode',
        { params:{
            v            :'5.236',
            client_id    : VK_CLIENT_ID,
            client_secret: VK_CLIENT_SECRET,
            code,
            device_id    : deviceId,
            code_verifier: codeVerifier
        }});
      /* если ошибка – будет r.data.error */
      if (!r.data.error) tokenData = r.data.response;
    } catch(e){ /* сеть / 4xx */ }

    /* ---------- 2. fallback: классический access_token ---------- */
    if (!tokenData) {
      const r = await axios.get(
        'https://oauth.vk.com/access_token',
        { params:{
            client_id    : VK_CLIENT_ID,
            client_secret: VK_CLIENT_SECRET,
            redirect_uri : 'https://sweet-twilight-63a9b6.netlify.app/vk-callback.html',
            code
        }});
      /* => { access_token, user_id, ... } */
      if (r.data.error) {
        const { error, error_description } = r.data;
        return res.status(401).json({ error, error_description });
      }
      tokenData = r.data;
    }

    const { access_token, user_id } = tokenData;
    if (!access_token || !user_id)
      return res.status(401).json({ error:'Failed to get access_token' });

    /* ---------- профиль пользователя ---------- */
    const prof = await axios.get('https://api.vk.com/method/users.get',{
      params:{ user_ids:user_id, fields:'photo_200', access_token, v:'5.131' }
    });
    const p    = prof.data.response[0];
    const user = await prisma.user.upsert({
      where : { vkId:user_id },
      update: {
        firstName: p.first_name,
        lastName : p.last_name,
        avatar   : p.photo_200
      },
      create: {
        vkId   : user_id,
        firstName: p.first_name,
        lastName : p.last_name,
        avatar   : p.photo_200,
        balance  : 0
      }
    });

    const jwtToken = jwt.sign(
      { userId:user.id, vkId:user.vkId },
      JWT_SECRET,
      { expiresIn:'7d' }
    );

    res.json({
      token: jwtToken,
      user : {
        vk_id   : user.vkId,
        firstName:user.firstName,
        lastName :user.lastName,
        avatar   :user.avatar,
        balance  :user.balance
      }
    });

  } catch (e) {
    console.error('[vk-callback error]', e?.response?.data || e);
    res.status(500).json({ error:'Internal', details:e?.response?.data||e.message });
  }
});

module.exports = router;
