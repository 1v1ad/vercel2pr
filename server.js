
const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const crypto = require('crypto');
const fetch = (...args) => import('node-fetch').then(({default: f}) => f(...args));
require('dotenv').config();
const app = express();
app.use(express.json());
app.use(cookieParser());
const FRONTEND = process.env.FRONTEND_URL || '*';
app.use(cors({ origin: (origin, cb) => cb(null, true), credentials: true }));
const PORT = process.env.PORT || 10000;
const VK_CLIENT_ID = process.env.VK_CLIENT_ID;
const VK_CLIENT_SECRET = process.env.VK_CLIENT_SECRET;
const VK_REDIRECT_URI = process.env.VK_REDIRECT_URI;
const VK_AUTH_BASE = process.env.VK_AUTH_BASE || 'https://oauth.vk.com/authorize';
const VK_TOKEN_URL = process.env.VK_TOKEN_URL || 'https://oauth.vk.com/access_token';
const VK_API_VERSION = process.env.VK_API_VERSION || '5.199';
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const states = new Set();
app.get(['/','/api/health'], (req, res) => { res.type('text/plain').send('Backend up'); });
app.post('/api/log-visit', (req, res) => res.status(204).end());
app.post('/api/log-auth', (req, res) => res.status(204).end());
function verifyTelegramAuth(data) {
  if (!data || !data.hash || !TELEGRAM_BOT_TOKEN) return false;
  const secret = crypto.createHash('sha256').update(TELEGRAM_BOT_TOKEN).digest();
  const checkData = Object.keys(data).filter(k => k !== 'hash' && data[k] !== undefined && data[k] !== null).sort().map(k => `${k}=${data[k]}`).join('\n');
  const hmac = crypto.createHmac('sha256', secret).update(checkData).digest('hex');
  return hmac === String(data.hash).toLowerCase();
}
app.post(['/api/auth/telegram','/api/auth/tg'], async (req, res) => {
  try {
    const user = req.body && (req.body.user || req.body);
    if (!verifyTelegramAuth(user)) return res.status(400).json({ ok: false, error: 'bad_telegram_signature' });
    res.json({ ok: true, provider: 'telegram', user: { id: String(user.id), first_name: user.first_name, last_name: user.last_name || '', username: user.username || '', photo_url: user.photo_url || '' } });
  } catch (e) { console.error('tg auth error', e); res.status(500).json({ ok: false, error: 'server_error' }); }
});
app.get('/api/auth/vk/start', async (req, res) => {
  try {
    const state = crypto.randomBytes(12).toString('hex'); states.add(state);
    const url = new URL(VK_AUTH_BASE);
    url.searchParams.set('client_id', VK_CLIENT_ID);
    url.searchParams.set('redirect_uri', VK_REDIRECT_URI);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('state', state);
    url.searchParams.set('v', VK_API_VERSION);
    return res.redirect(url.toString());
  } catch (e) { console.error('vk start error', e); res.redirect((FRONTEND || '/') + '/?error=vk_start'); }
});
app.get('/api/auth/vk/callback', async (req, res) => {
  const { code, state } = req.query;
  try {
    if (!code) return res.redirect((FRONTEND || '/') + '/?vk=error');
    if (state && states.has(state)) states.delete(state);
    const tokenUrl = new URL(VK_TOKEN_URL);
    tokenUrl.searchParams.set('client_id', VK_CLIENT_ID);
    tokenUrl.searchParams.set('client_secret', VK_CLIENT_SECRET);
    tokenUrl.searchParams.set('redirect_uri', VK_REDIRECT_URI);
    tokenUrl.searchParams.set('code', code);
    tokenUrl.searchParams.set('v', VK_API_VERSION);
    const r = await fetch(tokenUrl.toString(), { method: 'GET' });
    const json = await r.json().catch(()=>null);
    if (!r.ok || !json || (!json.access_token && !json.user_id)) {
      console.error('vk token error', r.status, json); return res.redirect((FRONTEND || '/') + '/?vk=error');
    }
    return res.redirect((FRONTEND || '/') + '/?vk=ok');
  } catch (e) { console.error('vk cb error', e); res.redirect((FRONTEND || '/') + '/?vk=error'); }
});
app.listen(PORT, () => { console.log(`[BOOT] listening on :${PORT}`); });
