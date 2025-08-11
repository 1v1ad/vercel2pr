// src/middleware_admin.js
export default function adminAuth(req, res, next) {
  const enabled = (process.env.FEATURE_ADMIN || '').toLowerCase() === 'true';
  if (!enabled) return res.status(403).json({ error: 'Admin feature disabled' });

  const pwd = req.get('X-Admin-Password');
  if (!pwd || pwd !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  return next();
}
