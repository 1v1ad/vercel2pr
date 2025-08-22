import jwt from 'jsonwebtoken';
const SECRET = process.env.JWT_SECRET || 'dev_secret_change_me';
export function signSession(payload, opts = {}) {
  return jwt.sign(payload, SECRET, { algorithm: 'HS256', expiresIn: opts.expiresIn || '30d' });
}
export function verifySession(token) {
  try { return jwt.verify(token, SECRET, { algorithms: ['HS256'] }); } catch { return null; }
}