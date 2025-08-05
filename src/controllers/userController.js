const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function getProfile(req, res) {
  try {
    const userId = req.user.userId;
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) return res.status(404).json({ error: "User not found" });

    res.json({
      vk_id: user.vk_id,
      firstName: user.firstName,
      lastName: user.lastName,
      avatar: user.avatar,
      balance: user.balance
    });
  } catch (err) {
    res.status(500).json({ error: "Profile error", details: err.message });
  }
}

module.exports = { getProfile };
