cimport express from 'express';
import { PrismaClient } from '@prisma/client';
import authRequired from '../middleware/authRequired.js';

const router = express.Router();
const prisma = new PrismaClient();

/** GET /api/user/profile */
router.get('/profile', authRequired, async (req, res) => {
  const user = await prisma.user.findUnique({ where: { id: req.jwt.userId } });
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({
    vk_id: user.vkId,
    firstName: user.firstName,
    lastName: user.lastName,
    avatar: user.avatar,
    balance: user.balance
  });
});

export default router;
