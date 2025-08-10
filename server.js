import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import dotenv from 'dotenv';
import { ensureTables, getUserByVkId } from './src/db.js';
import authRouter from './src/routes_auth.js';

dotenv.config();
const app = express();

const FRONTEND_URL = process.env.FRONTEND_URL;
app.use(cors({ origin: FRONTEND_URL, credentials: true, methods: ['GET','POST','OPTIONS'], allowedHeaders: ['Content-Type','Authorization'] }));
app.use(express.json());
app.use(cookieParser());

app.get('/health', (_,res)=>res.status(200).send('ok'));
app.use('/api/auth', authRouter);

app.get('/api/me', async (req, res) => {
  try {
    const token = req.cookies['sid'];
    if (!token) return res.status(401).json({ ok:false });
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    const user = await getUserByVkId(payload.vk_id);
    if (!user) return res.status(401).json({ ok:false });
    res.json({ ok:true, user });
  } catch (e) { res.status(401).json({ ok:false }); }
});

app.get('/', (_,res)=>res.send('VK Auth backend up'));

const PORT = process.env.PORT || 3001;
ensureTables().then(()=> app.listen(PORT, ()=>console.log('API on :' + PORT))).catch(e=>{ console.error('DB init failed', e); process.exit(1); });
