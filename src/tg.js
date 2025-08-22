import crypto from 'crypto';
export function verifyTelegramLogin(rawData, botToken) {
  const checkHash = rawData.hash;
  if (!checkHash) return false;
  const allowedKeys = new Set(['id','first_name','last_name','username','photo_url','auth_date']);
  const data = {};
  for (const [k, v] of Object.entries(rawData)) {
    if (k === 'hash') continue;
    if (allowedKeys.has(k)) data[k] = v;
  }
  const secret = crypto.createHash('sha256').update(botToken).digest();
  const dataCheckString = Object.keys(data).sort().map(k => `${k}=${data[k]}`).join('\n');
  const hmac = crypto.createHmac('sha256', secret).update(dataCheckString).digest('hex');
  return hmac === checkHash;
}