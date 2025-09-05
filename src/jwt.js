// src/jwt.js
import jwt from 'jsonwebtoken';
const SECRET = process.env.JWT_SECRET || 'dev_secret_change_me';
export const COOKIE_NAME = process.env.SESSION_COOKIE || 'sid';

export function signSession(payload){
  return jwt.sign(payload, SECRET, { expiresIn: '30d' });
}
export function readSession(req){
  const token = (req.cookies && req.cookies[COOKIE_NAME]) || null;
  if (!token) return null;
  try {
    return jwt.verify(token, SECRET);
  } catch(e){
    return null;
  }
}
export function clearSession(res){
  res.clearCookie(COOKIE_NAME, cookieOpts());
}
export function cookieOpts(){
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: true,
    path: '/',
    domain: process.env.COOKIE_DOMAIN || undefined,
    maxAge: 30*24*3600*1000
  };
}
