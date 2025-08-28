
import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { ensureTables, getUserById, logEvent } from './src/db.js';
import { signSession } from './src/jwt.js';
import authRoutes from './src/routes_auth.js';
import tgRoutes from './src/routes_tg.js';

const app = express();

const FRONTEND = process.env.FRONTEND_URL || process.env.FRONTEND_RETURN_URL || 'http://localhost:5173';
const CORS_ORIGINS = (process.env.CORS_ORIGINS || FRONTEND).split(',').map(s => s.trim());

app.use(cors({
  origin: (origin, cb)=> cb(null, true),
  credentials: true,
}));
app.use(express.json());
app.use(cookieParser());

// Health
app.get('/', (req,res)=> res.type('text/plain').send('Backend up'));
app.get('/health', (req,res)=> res.json({ok:true}));

// API
app.get('/api/me', async (req,res)=>{
  try {
    const sid = req.cookies.sid;
    if(!sid) return res.status(401).json({ ok:false, reason:'no-cookie' });
    const user = await getUserById(sid);
    if(!user) return res.status(401).json({ ok:false, reason:'no-user' });
    res.json({ ok:true, user });
  } catch(err){
    console.error('[ME]', err);
    res.status(500).json({ ok:false, error: String(err) });
  }
});

app.post('/api/events', async (req,res)=>{
  const { type, data } = req.body || {};
  const sid = req.cookies.sid || null;
  try{
    await logEvent(sid, type || 'event', data || {});
    res.json({ ok:true });
  }catch(err){
    res.status(500).json({ ok:false, error:String(err)});
  }
});

app.use(authRoutes);
app.use(tgRoutes);

const start = async ()=>{
  await ensureTables();
  const port = process.env.PORT || 3001;
  app.listen(port, ()=> console.log(`[BOOT] listening on :${port}`));
};
start();
