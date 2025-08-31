// src/routes_link.js — hotfix: never 500
import { Router } from 'express';
import { autoMergeByDevice } from './merge.js';

const router = Router();

router.post('/link/background', async (req, res) => {
  try {
    const body = (req && req.body) || {};
    const device_id = (body.device_id || '').toString().trim();
    const provider = (body.provider || '').toString().trim();
    const provider_user_id = (body.provider_user_id || '').toString().trim();
    const tgId = provider === 'tg' ? provider_user_id : null;
    const merged = await autoMergeByDevice({ deviceId: device_id || null, tgId });
    res.json({ ok:true, merged });
  } catch (e) {
    res.json({ ok:false, error: String(e && e.message || e) });
  }
});

export default router;
