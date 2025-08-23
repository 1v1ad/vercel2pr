// STEP 2: tiny events router you can mount without touching existing auth
import { Router } from 'express';
import geoip from 'geoip-lite';
import { logEvent } from './linker.js';

export default function makeEventsRouter() {
  const r = Router();
  r.post('/', async (req, res) => {
    try {
      const ip = (req.headers['x-forwarded-for'] || req.ip || '').toString().split(',')[0].trim();
      const geo = ip ? geoip.lookup(ip) : null;
      await logEvent({
        user_id: req.user?.id || null,
        event_type: String(req.body?.type || 'client_event'),
        payload: req.body?.payload || null,
        ip,
        ua: (req.headers['user-agent'] || '').slice(0, 256),
        country_code: geo?.country || null,
      });
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ ok: false });
    }
  });
  return r;
}
