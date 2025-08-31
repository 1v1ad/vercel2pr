import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import authRoutes from './routes_auth.js';
import tgRoutes from './routes_telegram.js';
import { ensureTables } from './db.js';

const app = express();
app.set('trust proxy', true);

app.use(cookieParser());
app.use(cors({ origin: (o,cb)=>cb(null,true), credentials: true }));

app.get('/health', (req,res)=>res.type('text/plain').send('ok'));

app.use('/api/auth', authRoutes);
app.use('/api/auth', tgRoutes);

const PORT = process.env.PORT || 10000;

ensureTables().then(()=>{
  app.listen(PORT, () => console.log('[BOOT] listening on', PORT));
}).catch(err=>{
  console.error('DB init error', err);
  process.exit(1);
});
