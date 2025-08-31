import crypto from 'crypto';

export function normalizePhoneE164(raw) {
  if (!raw) return null;
  const d = String(raw).replace(/[^0-9+]/g,'');
  const num = d.startsWith('+') ? d : ('+' + d);
  return (num.length >= 8 ? num : null);
}

export function phoneHash(e164, salt='') {
  if (!e164) return null;
  return crypto.createHash('sha256').update(`${e164}|${salt}`).digest('hex');
}
