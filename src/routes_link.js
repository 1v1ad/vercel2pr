import { Router } from 'express';

const router = Router();

/**
 * Небольшой "сервисный" роутер под /api
 * Ничего лишнего не импортируем, чтобы не ломать деплой.
 * Если понадобится — добавим сюда реальные endpoints.
 */

// Простой health для /api
router.get('/alive', (_req, res) => {
  res.json({ ok: true });
});

// Можно посмотреть ip клиента (удобно для отладки)
router.get('/whoami', (req, res) => {
  const ip = (req.headers['x-forwarded-for'] || req.ip || '').toString().split(',')[0].trim();
  res.json({
    ok: true,
    ip,
    ua: req.headers['user-agent'] || '',
  });
});


// --- Background account linking ---
// POST /api/link/background
// Body: { provider: 'vk'|'tg', provider_user_id: string, username?: string, phone_hash?: string, device_id?: string }
import { getDeviceId, decodeSid, upsertAuthAccount, linkPendingsToUser } from './linking.js';

router.post('/link/background', async (req, res) => {
  try{
    const provider = String(req.body?.provider || '').trim().toLowerCase();
    const provider_user_id = String(req.body?.provider_user_id || '').trim();
    if(!provider || !provider_user_id) {
      return res.status(400).json({ ok:false, error:'bad_request' });
    }
    const device_id = String(req.body?.device_id || getDeviceId(req) || '').trim();
    const username  = req.body?.username ? String(req.body.username) : null;
    const phone_hash = req.body?.phone_hash ? String(req.body.phone_hash) : null;

    // If user already logged in (VK), attach to that user immediately
    const currentUserId = decodeSid(req);

    // Ensure meta has device_id
    const meta = { ...(req.body?.meta || {}), device_id };

    // Upsert this auth_account (no-op if exists)
    const acc = await upsertAuthAccount({
      userId: currentUserId || null,
      provider,
      providerUserId: provider_user_id,
      username,
      phoneHash: phone_hash || null,
      meta
    });

    // Try to link any pending accounts (same device or phone_hash) to the current user
    let linked = 0;
    if (currentUserId) {
      const ip = (req.headers['x-forwarded-for'] || req.ip || '').toString().split(',')[0].trim();
      const ua = req.headers['user-agent'] || '';
      const r  = await linkPendingsToUser({ userId: currentUserId, provider, deviceId: device_id || null, phoneHash: phone_hash || null, ip, ua });
      linked = r.linked;
    }

    return res.json({ ok:true, linked });
  }catch(e){
    console.error('link/background error:', e);
    return res.status(500).json({ ok:false, error:'server_error' });
  }
});


export default router;
