import express from 'express';
import cookieParser from 'cookie-parser';
import cors from 'cors';

import adminRouter from './src/routes_admin.js';
import authRouter from './src/routes_auth.js';
import { ensureClusterId } from './src/merge.js';

const app = express();
app.set('trust proxy', 1);

// CORS
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
app.use(cookieParser());

// Health
app.get(['/','/health','/healthz','/health1'], (req, res) => res.json({ ok:true, ts: Date.now() }));

// Routers (compat mount)
app.use('/api', authRouter);
app.use(authRouter);

app.use('/admin', adminRouter);

const PORT = process.env.PORT || 10000;

async function bootstrap(){
  await ensureClusterId();
  app.listen(PORT, () => console.log('[BOOT] listening on', PORT));
}
bootstrap().catch(e => { console.error('[BOOT] fatal', e); process.exit(1); });
