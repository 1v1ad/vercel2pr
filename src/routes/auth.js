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

/* -------- POST /api/auth/vk-callback -------- */
router.post('/vk-callback', async (req, res) => {
  try {
    const { code, codeVerifier } = req.body;
    if (!code) return res.status(400).json({ error:'Missing code' });

    /* 1. обмениваем code на access_token через id.vk.com */
    const form = new URLSearchParams({
      client_id    : VK_CLIENT_ID,
      client_secret: VK_CLIENT_SECRET,
      grant_type   : 'authorization_code',
      code,
      redirect_uri : 'https://sweet-twilight-63a9b6.netlify.app/vk-callback.html'
    });
    if (codeVerifier) form.append('code_verifier', codeVerifier);

    const tk = await axios.post(
      'https://id.vk.com/oauth2/token',
      form.toString(),
      { headers:{'Content-Type':'application/x-www-form-urlencoded'} }
    ).then(r => r.data);

    const { access_token, user_id } = tk;
    if (!access_token) return res.status(401).json(tk);

    /* 2. берём профиль */
    const p = await axios.get('https://api.vk.com/method/users.get', {
      params:{
        user_ids:user_id, access_token, v:'5.131', fields:'photo_200'
      }
    }).then(r=>r.data.response[0]);

    /* 3. upsert в БД */
    const user = await prisma.user.upsert({
      where : { vkId:user_id },
      update: { firstName:p.first_name,lastName:p.last_name,avatar:p.photo_200 },
      create: { vkId:user_id,firstName:p.first_name,lastName:p.last_name,
                avatar:p.photo_200,balance:0 }
    });

    /* 4. свой JWT */
    const token = jwt.sign({ userId:user.id,vkId:user.vkId }, JWT_SECRET,{expiresIn:'7d'});
    res.json({ token, user:{
      vk_id:user.vkId,firstName:user.firstName,lastName:user.lastName,
      avatar:user.avatar,balance:user.balance
    }});
  } catch(e){
    console.error('[vk-callback]', e?.response?.data || e);
    res.status(500).json({ error:'Internal', details:e?.response?.data||e.message });
  }
});

module.exports = router;
