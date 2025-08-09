// server.js
import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { ensureTables, db, getUserByVkId, upsertUser } from './src/db.js';
import authRouter from './src/routes_auth.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// --- CORS ---
const FRONTEND_URL = process.env.FRONTEND_URL; // e.g. https://sweet-....netlify.app
app.use(cors({
  origin: FRONTEND_URL,
  credentials: true,
  methods: ['GET','POST','OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json());
app.use(cookieParser());

// --- health ---
app.get('/health', (_, res) => res.status(200).send('ok'));

// --- auth routes ---
app.use('/api/auth', authRouter);

// --- session info for frontend ---
app.get('/api/me', async (req, res) => {
  try {
    const token = req.cookies['sid'];
    if (!token) return res.status(401).json({ ok:false });
    // No server-side verification here (stateless). You can verify if needed.
    // For simplicity, we fetch by vk_id stored in token payload
    const base64 = token.split('.')[1];
    const payload = JSON.parse(Buffer.from(base64, 'base64url').toString('utf8'));
    const user = await getUserByVkId(payload.vk_id);
    if (!user) return res.status(401).json({ ok:false });
    res.json({ ok:true, user });
  } catch (e) {
    console.error('me error', e);
    res.status(401).json({ ok:false });
  }
});

// --- fallback ---
app.get('/', (_, res) => res.send('VK Auth backend up'));

const PORT = process.env.PORT || 3001;

ensureTables().then(() => {
  app.listen(PORT, () => console.log(`API on :${PORT}`));
}).catch((e) => {
  console.error('DB init failed', e);
  process.exit(1);
});
