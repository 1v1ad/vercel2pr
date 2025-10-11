// src/routes_link.js — persist device_id + PROOF linking entrypoint
import { Router } from 'express';
import crypto from 'crypto';
import { db, logEvent } from './db.js';           // logEvent уже есть в проекте
import { decodeSid } from './routes_auth.js';     // decodeSid есть в routes_auth.js
import { autoMergeByDevice, ensureMetaColumns } from './merge.js';

const router = Router();

// ----- helpers for link state cookie -----
function readLinkState(req) {
  try {
    const raw = req.cookies?.link_state;
    if (!raw) return null;
    const s = JSON.parse(raw);
    if (!s?.nonce || !s?.target) return null;
    return s;
  } catch { return null; }
}
function clearLinkState(res) {
  res.clearCookie('link_state', { path: '/', sameSite: 'lax', secure: true });
}

// NEW: hard link flow entry
router.get('/link/start', async (req, res) => {
  try {
    const target = req.query.vk ? 'vk' : (req.query.tg ? 'tg' : null);
    if (!target) return res.status(400).json({ ok:false, error:'target_required' });

    const userId = decodeSid(req); // текущий HUM из сессии
    if (!userId) {
      await logEvent(req, 'link_error', { reason:'no_session', target });
      return res.redirect('/index.html?link=need_login');
    }

    const nonce = crypto.randomBytes(12).toString('hex');
    const ret = (req.query.return || req.get('referer') || '/lobby.html');

    // сохраняем короткий state в httpOnly cookie
    res.cookie('link_state', JSON.stringify({ target, nonce, return: ret }), {
      httpOnly: true, sameSite: 'lax', secure: true, path: '/', maxAge: 5 * 60 * 1000,
    });

    await logEvent(req, 'link_request', { target, user_id: userId });

    // уходим в старт нужного провайдера (обычные ваши маршруты)
    return res.redirect(`/api/auth/${target}/start`);
  } catch (e) {
    await logEvent(req, 'link_error', { error: String(e && e.message || e) });
    return res.status(500).json({ ok:false, error:'server_error' });
  }
});

// оставляем ваш фоновый soft-link по device_id как есть
router.post('/link/background', async (req, res) => {
  try {
    const body = (req && req.body) || {};
    const provider = (body.provider || '').toString().trim();           // 'vk' | 'tg'
    const provider_user_id = (body.provider_user_id || '').toString().trim();
    const device_id = (body.device_id || '').toString().trim();
    const username = (body.username || '').toString().trim();

    await ensureMetaColumns();

    let updated = 0;
    try {
      const upd = await db.query(
        "update auth_accounts set meta = jsonb_set(coalesce(meta,'{}'::jsonb), '{device_id}', to_jsonb($3::text), true), updated_at=now() where provider=$1 and provider_user_id=$2",
        [provider, provider_user_id, device_id || null]
      );
      updated = upd.rowCount || 0;
    } catch {}

    if (!updated && provider && provider_user_id) {
      try {
        await db.query(
          "insert into auth_accounts (provider, provider_user_id, username, meta) values ($1,$2,$3, jsonb_build_object('device_id',$4)) on conflict do nothing",
          [provider, provider_user_id, username || null, device_id || null]
        );
      } catch {}
    }

    const merged = await autoMergeByDevice({ deviceId: device_id || null, tgId: provider === 'tg' ? provider_user_id : null });
    res.json({ ok:true, merged });
  } catch (e) {
    res.json({ ok:false, error: String(e && e.message || e) });
  }
});

export default router;
export { readLinkState, clearLinkState };
