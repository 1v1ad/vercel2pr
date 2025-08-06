const express       = require('express');
const jwt           = require('jsonwebtoken');
const { PrismaClient } = require('@prisma/client');

const router   = express.Router();
const prisma   = new PrismaClient();
const JWT_SECRET = process.env.JWT_SECRET;

router.get('/profile', async (req, res) => {
  try {
    const token = (req.headers['authorization'] || '').split(' ')[1];
    if (!token) return res.status(401).json({ error: 'No token provided' });

    const decoded = jwt.verify(token, JWT_SECRET);
    const user    = await prisma.user.findUnique({ where: { id: decoded.userId } });
    if (!user)    return res.status(404).json({ error: 'User not found' });

    res.json({
      vk_id: user.vkId,
      firstName: user.firstName,
      lastName:  user.lastName,
      avatar:    user.avatar,
      balance:   user.balance,
    });
  } catch (e) {
    res.status(401).json({ error: 'Invalid token', details: e.message });
  }
});

module.exports = router;
