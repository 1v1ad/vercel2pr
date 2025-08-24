// src/jwt.js
import jwt from 'jsonwebtoken';

function pickSecret() {
  const s = (process.env.JWT_SECRET || '').trim();
  return s;
}

export function signSession(payload) {
  const secret = pickSecret();
  if (!secret) {
    console.error('[JWT] missing JWT_SECRET');
    throw new Error('JWT_SECRET missing');
  }
  return jwt.sign(payload, secret, { algorithm: 'HS256', expiresIn: '30d' });
}

export function verifySession(token) {
  const secret = pickSecret();
  if (!secret) throw new Error('JWT_SECRET missing');
  return jwt.verify(token, secret);
}
