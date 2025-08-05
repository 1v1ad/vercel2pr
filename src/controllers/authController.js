const axios = require('axios');
const jwt = require('jsonwebtoken');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const VK_CLIENT_ID = process.env.VK_CLIENT_ID;
const VK_CLIENT_SECRET = process.env.VK_CLIENT_SECRET;
const JWT_SECRET = process.env.JWT_SECRET || "supersecret";

async function vkLogin(req, res) {
  try {
    const { code, device_id } = req.body;

    // VK exchange code for access_token
    const url = `https://api.vkid.vk.com/account/exchange_code`;
    const params = {
      client_id: VK_CLIENT_ID,
      client_secret: VK_CLIENT_SECRET,
      code,
      device_id
    };

    const vkResp = await axios.post(url, params, { timeout: 10000 });
    const data = vkResp.data;

    if (!data.user) {
      return res.status(400).json({ error: "VK auth failed", details: data });
    }

    const vk_id = String(data.user.id);
    const firstName = data.user.first_name || "VK User";
    const lastName = data.user.last_name || "";
    const avatar = data.user.photo || "";

    // Create or update user in DB
    let user = await prisma.user.findUnique({ where: { vk_id } });

    if (!user) {
      user = await prisma.user.create({
        data: { vk_id, firstName, lastName, avatar }
      });
    } else {
      user = await prisma.user.update({
        where: { vk_id },
        data: { firstName, lastName, avatar }
      });
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
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "VK login error", details: err.message });
  }
}

module.exports = { vkLogin };
