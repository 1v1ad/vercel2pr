import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import dotenv from 'dotenv';
import jwt from 'jsonwebtoken';
import { ensureTables, getUserByVkId, logEvent } from './src/db.js';
import authRouter from './src/routes_auth.js';

dotenv.config();

const app = express();

const FRONTEND_URL = process.env.FRONTEND_URL; // https://sweet-twilight-63a9b6.netlify.app
app.use(cors({
  origin: FRONTEND_URL,
  credentials: true,
  methods: ['GET','POST','OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json());
app.use(cookieParser());

// health
app.get('/health', (_, res) => res.status(200).send('ok'));

// auth
app.use('/api/auth', authRouter);

// helper: verify sid and return user
async function getUserFromCookie(req) {
  const token = req.cookies['sid'];
  if (!token) return null;
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET || 'dev_secret_change_me', { algorithms: ['HS256']});
    const user = await getUserByVkId(payload.vk_id);
    return user || null;
  } catch {
    return null;
  }
}

// session info
app.get('/api/me', async (req, res) => {
  const user = await getUserFromCookie(req);
  if (!user) return res.status(401).json({ ok:false });
  res.json({
    ok: true,
    user: {
      id: user.id,
      vk_id: user.vk_id,
      first_name: user.first_name || '',
      last_name: user.last_name || '',
      avatar: user.avatar || '',
      balance: user.balance ?? 0
    }
  });
});

// generic tracker endpoint
app.post('/api/track', async (req, res) => {
  try {
    const user = await getUserFromCookie(req); // может быть null для анонимов
    const { event, meta } = req.body || {};
    if (!event) return res.status(400).json({ ok:false, error:'event required' });
    await logEvent(user?.id || null, event, meta || {}, req.ip, req.headers['user-agent'] || '');
    res.json({ ok:true });
  } catch (e) {
    console.error('track error', e);
    res.status(500).json({ ok:false });
  }
});

app.get('/', (_, res) => res.send('VK Auth backend up'));

const PORT = process.env.PORT || 3001;
ensureTables().then(() => {
  app.listen(PORT, () => console.log(`API on :${PORT}`));
}).catch((e) => {
  console.error('DB init failed', e);
  process.exit(1);
});
