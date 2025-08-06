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

const REDIRECT_URI = 'https://sweet-twilight-63a9b6.netlify.app/vk-callback.html';

/*** POST /api/auth/vk-callback **********************************************/
router.post('/vk-callback', async (req, res) => {
  try {
    const {
      code,
      deviceId     = req.body.deviceid,
      codeVerifier = req.body.code_verifier
    } = req.body;

    if (!code || !deviceId)
      return res.status(400).json({ error:'Missing code or deviceId' });

    /* 1. code → access_token через oauth/access_token */
    const tokenResp = await axios.get('https://oauth.vk.com/access_token', {
      params:{
        client_id:     VK_CLIENT_ID,
        client_secret: VK_CLIENT_SECRET,
        redirect_uri:  REDIRECT_URI,
        code,
        code_verifier: codeVerifier || undefined          // если есть PKCE
      }
    });

    const { access_token, user_id, error, error_description } = tokenResp.data;

    if (error || !access_token || !user_id)
      return res.status(400).json({ error, error_description });

    /* 2. получаем профиль */
    const profileResp = await axios.get('https://api.vk.com/method/users.get', {
      params:{
        v:'5.236',
        user_ids:     user_id,
        access_token,
        fields:'photo_200,first_name,last_name'
      }
    });
    const vkUser = profileResp.data?.response?.[0] || {};
    const { first_name, last_name, photo_200 } = vkUser;

    /* 3. записываем/обновляем юзера */
    let user = await prisma.user.findUnique({ where:{ vkId:user_id } });

    user = user
      ? await prisma.user.update({
          where:{ vkId:user_id },
          data :{ firstName:first_name, lastName:last_name, avatar:photo_200 }
        })
      : await prisma.user.create({
          data:{ vkId:user_id, firstName:first_name, lastName:last_name,
                 avatar:photo_200, balance:0 }
        });

    /* 4. JWT */
    const token = jwt.sign(
      { userId:user.id, vkId:user.vkId },
      JWT_SECRET,
      { expiresIn:'7d' }
    );

    res.json({
      token,
      user:{
        vk_id:user.vkId,
        firstName:user.firstName,
        lastName:user.lastName,
        avatar:user.avatar,
        balance:user.balance
      }
    });

  } catch (e) {
    console.error('[vk-callback error]', e?.response?.data || e);
    res.status(500).json({ error:'Internal error', details:e?.response?.data||e.message });
  }
});

module.exports = router;
