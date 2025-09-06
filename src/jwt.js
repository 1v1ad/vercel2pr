// src/jwt.js
import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || process.env.SESSION_SECRET || 'dev-secret';
const MAX_AGE_SEC = 60 * 60 * 24 * 30; // 30 дней

export function signSession(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: MAX_AGE_SEC });
}

export function verifySession(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch {
    return null;
  }
}
