// src/verifyTelegram.js
// Robust verification for Telegram Login Widget init data.
// Key fix: ignore *non-Telegram* params (e.g., device_id) when computing the signature.
// Docs: https://core.telegram.org/widgets/login#checking-authorization
import crypto from 'crypto';

/**
 * Verify Telegram init data from req.query (GET) or req.body (POST).
 * We strictly include only Telegram-signed keys in the data_check_string.
 */
export function verifyTelegramInitData(initDataObj, botToken) {
  if (!botToken) return { ok: false, reason: 'bot_token_missing' };

  // Shallow copy to avoid accidental mutation
  const src = { ...initDataObj };
  const hash = String(src.hash || '');
  delete src.hash;

  // Only use keys that Telegram signs. Extra params like device_id MUST be ignored.
  const TELEGRAM_KEYS = [
    'id',
    'first_name',
    'last_name',
    'username',
    'photo_url',
    'auth_date',
    'allows_write_to_pm',
    // Telegram WebApp may also pass 'query_id' — safe to include if present:
    'query_id'
  ];

  const filtered = {};
  for (const k of TELEGRAM_KEYS) {
    if (src[k] !== undefined && src[k] !== null && src[k] !== '') filtered[k] = src[k];
  }

  // Build data_check_string
  const data_check_string = Object.keys(filtered)
    .sort()
    .map(k => `${k}=${filtered[k]}`)
    .join('\n');

  // Compute HMAC SHA256 with secret key SHA256(botToken)
  const secret_key = crypto.createHash('sha256').update(botToken).digest();
  const computed_hex = crypto.createHmac('sha256', secret_key).update(data_check_string).digest('hex');

  // Constant-time compare
  const a = Buffer.from(computed_hex, 'hex');
  const b = Buffer.from((hash || ''), 'hex');
  const safeEqual = a.length === b.length && crypto.timingSafeEqual(a, b);

  // Age check (7 days window) to avoid replay
  const now = Math.floor(Date.now() / 1000);
  const ageOk = src.auth_date ? (now - Number(src.auth_date)) < (60 * 60 * 24 * 7) : true;

  return (safeEqual && ageOk)
    ? { ok: true, data: filtered }
    : { ok: false, reason: 'hash_or_age_invalid', computed_hex, data_check_string };
}
