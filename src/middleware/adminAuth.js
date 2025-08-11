// Простая проверка секретного пароля администратора.
// 1) Фича-флаг должен быть включён
// 2) В заголовке X-Admin-Password должен прийти пароль, равный ADMIN_PASSWORD
export default function adminAuth(req, res, next) {
  const feature = (process.env.FEATURE_ADMIN || '').toLowerCase() === 'true';
  if (!feature) return res.status(403).json({ error: 'Admin feature disabled' });

  const header = req.get('X-Admin-Password');
  if (!header || header !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  return next();
}
