// src/routes_link.js — helper endpoints + background link + auto-merge hook
import { Router } from 'express';
import { autoMergeByDevice } from './merge.js';

const router = Router();

router.get('/alive', (_req, res) => res.json({ ok:true }));

router.get('/whoami', (req, res) => {
  const ip = (req.headers['x-forwarded-for'] || req.ip || '').toString().split(',')[0].trim();
  res.json({ ok:true, ip, ua: req.headers['user-agent'] || '' });
});

router.post('/link/background', async (req, res) => {
  try {
    const { provider, provider_user_id, username, device_id } = req.body || {};
    const merged = await autoMergeByDevice({ deviceId: device_id || null, tgId: provider==='tg' ? provider_user_id : null });
    res.json({ ok:true, merged });
  } catch (e) {
    res.status(500).json({ ok:false, error: e.message });
  }
});

export default router;
