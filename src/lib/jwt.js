const jwt = require('jsonwebtoken');
const JWT_SECRET = process.env.JWT_SECRET;
const COOKIE_NAME = 'session';

const sign = (payload) => jwt.sign(payload, JWT_SECRET, { expiresIn: '7d' });
const verify = (token) => jwt.verify(token, JWT_SECRET);

const setSessionCookie = (res, token) => {
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    secure: true,
    sameSite: 'none',
    path: '/',
    maxAge: 7*24*60*60*1000
  });
};
const clearSessionCookie = (res) => {
  res.clearCookie(COOKIE_NAME, {
    httpOnly: true,
    secure: true,
    sameSite: 'none',
    path: '/'
  });
};

module.exports = { sign, verify, setSessionCookie, clearSessionCookie, COOKIE_NAME };
