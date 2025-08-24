import jwt from 'jsonwebtoken';

const secret = process.env.JWT_SECRET || process.env.JMT_SECRET;
if (!secret) {
  throw new Error('Missing env JWT_SECRET');
}

export function signSession(payload) {
  // 30 days
  return jwt.sign(payload, secret, { algorithm: 'HS256', expiresIn: '30d' });
}

export function verifySession(token) {
  try {
    return jwt.verify(token, secret, { algorithms: ['HS256'] });
  } catch {
    return null;
  }
}
