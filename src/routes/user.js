const router = require('express').Router();
const { PrismaClient } = require('@prisma/client');
const { verify, clearSessionCookie, COOKIE_NAME } = require('../lib/jwt');

const prisma = new PrismaClient();

function authMiddleware(req, res, next) {
  const token = req.cookies?.[COOKIE_NAME];
  if (!token) return res.status(401).json({ error: 'no_session' });
  try {
    req.session = verify(token);
    next();
  } catch {
    return res.status(401).json({ error: 'bad_session' });
  }
}

router.get('/me', authMiddleware, async (req, res) => {
  const user = await prisma.user.findUnique({
    where: { id: req.session.uid },
    select: { id: true, vk_id: true, firstName: true, lastName: true, avatar: true, balance: true, createdAt: true }
  });
  res.json({ user });
});

router.post('/logout', (req, res) => {
  clearSessionCookie(res);
  res.json({ ok: true });
});

module.exports = router;
