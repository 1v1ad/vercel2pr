// src/middleware/admin.js
export default function adminAuth(req, res, next) {
  if (process.env.FEATURE_ADMIN !== 'true') {
    return res.status(404).json({ ok:false, error:'admin_disabled' });
  }
  const pass = req.get('X-Admin-Password') || req.get('x-admin-password') || req.get('X-Admin-Secret') || req.get('x-admin-secret');
  if (!pass || pass !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ ok:false, error:'unauthorized' });
  }
  next();
}
