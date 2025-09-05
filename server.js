import express from 'express';
import cookieParser from 'cookie-parser';
import cors from 'cors';

import adminRouter from './src/routes_admin.js';
import authRouter from './src/routes_auth.js';
import { ensureClusterId } from './src/merge.js';

const app = express();

// CORS: доверяем фронту (динамически), куки/заголовки пропускаем
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
app.use(cookieParser());

// --- Health endpoints, чтобы фронт не ругался ---
app.get(['/health','/healthz','/health1'], (req,res)=> res.json({ ok:true, ts:Date.now() }));

// --- Роуты ---
// Совместимость: некоторые сборки объявляют пути как '/auth/*', другие — как '/api/auth/*'.
// Чтобы не ловить 404, монтируем и так, и так.
app.use('/api', authRouter); // если внутри роутера пути '/auth/*' → тут получится '/api/auth/*'
app.use(authRouter);         // если внутри роутера пути уже '/api/auth/*' → совпадёт тут

app.use('/admin', adminRouter);

const PORT = process.env.PORT || 10000;

async function bootstrap(){
  await ensureClusterId();
  app.listen(PORT, () => console.log('[BOOT] listening on', PORT));
}

bootstrap().catch(err => {
  console.error('[BOOT] fatal:', err);
  process.exit(1);
});
