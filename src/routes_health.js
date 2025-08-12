// src/routes_health.js
import { Router } from 'express';
const r = Router();
r.get('/', (_req, res) => {
  res.json({
    ok: true,
    ts: Date.now(),
    env: {
      FEATURE_ADMIN: process.env.FEATURE_ADMIN || null,
      FRONTEND_URL: process.env.FRONTEND_URL || null,
      HAS_ADMIN_PASSWORD: !!process.env.ADMIN_PASSWORD,
      NODE_ENV: process.env.NODE_ENV || null
    }
  });
});
export default r;
