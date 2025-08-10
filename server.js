import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import dotenv from 'dotenv';

import { ensureTables, getUserById, logEvent } from './src/db.js';
import authRouter from './src/routes_auth.js';

dotenv.config();

const app = express();

const FRONTEND_URL = process.env.FRONTEND_URL;
app.use(cors({
  origin: FRONTEND_URL,
  credentials: true,
  methods: ['GET','POST','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization']
}));

app.use(express.json());
app.use(cookieParser());

app.get('/health', (_, res) => res.status(200).send('ok'));
app.use('/api/auth', authRouter);

app.get('/api/me', async (req, res) => {
  try {
    const token = req.cookies['sid'];
    if (!token) return res.status(401).json({ ok:false });
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    const user = await getUserById(payload.uid);
    if (!user) return res.status(401).json({ ok:false });
    res.json({
      ok: true,
      user: {
        id: user.id,
        vk_id: user.vk_id,
        first_name: user.first_name,
        last_name: user.last_name,
        avatar: user.avatar,
        balance: user.balance ?? 0
      }
    });
  } catch {
    res.status(401).json({ ok:false });
  }
});

app.post('/api/events', async (req, res) => {
  try {
    const { type, payload } = req.body || {};
    if (!type) return res.status(400).json({ ok:false, error: 'type required' });
    let userId = null;
    const token = req.cookies['sid'];
    if (token) {
      try {
        const p = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
        userId = p.uid || null;
      } catch {}
    }
    await logEvent({
      user_id: userId,
      event_type: String(type).slice(0,64),
      payload: payload || null,
      ip: (req.headers['x-forwarded-for'] || req.ip || '').toString().slice(0,64),
      ua: (req.headers['user-agent'] || '').slice(0,256),
    });
    res.json({ ok:true });
  } catch (e) {
    console.error('events error', e);
    res.status(500).json({ ok:false });
  }
});

app.get('/', (_, res) => res.send('VK Auth backend up'));

const PORT = process.env.PORT || 3001;
ensureTables().then(()=>{
  app.listen(PORT, ()=>console.log('API on :' + PORT));
}).catch((e)=>{
  console.error('DB init failed', e);
  process.exit(1);
});
