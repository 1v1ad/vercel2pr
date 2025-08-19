import crypto from 'crypto';

/** Verify Telegram Login Widget payload.
 * @param {Object} data - widget payload incl. `hash`
 * @param {string} botToken
 * @returns {boolean}
 */
export function verifyTelegramLogin(data, botToken) {
  const { hash, ...rest } = data || {};
  if (!hash) return false;
  const pairs = Object.entries(rest)
    .sort(([a],[b]) => a.localeCompare(b))
    .map(([k,v]) => `${k}=${v}`);
  const dataCheckString = pairs.join('\n');
  const secretKey = crypto.createHash('sha256').update(botToken).digest(); // Buffer
  const hmac = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
  return hmac === hash;
}
