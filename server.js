// server.js
import express from 'express';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import vkAuthRouter from './src/routes_auth.js';
import tgAuthRouter from './src/routes_tg.js';
import { verifySession } from './src/jwt.js';

const app = express();
app.use(express.json());
app.use(cookieParser());

// CORS: allow your front if set
const FRONTEND_URL = (process.env.FRONTEND_URL || '').replace(/\/$/, '');
if (FRONTEND_URL) {
  app.use(cors({
    origin: FRONTEND_URL,
    credentials: true,
  }));
}

// Boot env check (doesn't print secrets)
console.log('[BOOT] env check:', {
  JWT_SECRET: !!(process.env.JWT_SECRET && process.env.JWT_SECRET.trim()),
  VK_CLIENT_ID: !!process.env.VK_CLIENT_ID,
  VK_CLIENT_SECRET: !!process.env.VK_CLIENT_SECRET,
  VK_REDIRECT_URI: !!process.env.VK_REDIRECT_URI,
  FRONTEND_URL: !!process.env.FRONTEND_URL,
});

app.use('/api/auth/vk', vkAuthRouter);
app.use('/api/auth/tg', tgAuthRouter);

// Minimal /api/me to test cookie session
app.get('/api/me', (req, res) => {
  const token = req.cookies?.sid;
  if (!token) return res.status(401).json({ ok:false, reason:'no sid' });
  try {
    const data = verifySession(token);
    return res.json({ ok:true, user: data });
  } catch (e) {
    return res.status(401).json({ ok:false, reason:'bad sid' });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log('API on :' + PORT);
  console.log('==> Your service is live ✨');
});
