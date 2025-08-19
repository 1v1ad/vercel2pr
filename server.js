import express from 'express';
import cors from 'cors';
import tgRouter from './src/routes_tg.js';

const app = express();

// базовые мидлвары
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const FRONTEND_URL =
  process.env.FRONTEND_URL || 'https://sweet-twilight-63a9b6.netlify.app';

app.use(
  cors({
    origin: [FRONTEND_URL],
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'x-device-id'],
  })
);

// health-check для «прогрева»
app.get('/health', (_req, res) => res.status(200).send('ok'));

// Telegram callback
app.use('/api/auth/tg', tgRouter);

// опциональные роуты — подключаем, только если реально существуют
try {
  const { default: authRouter } = await import('./src/routes/auth.js');
  app.use('/api/auth', authRouter);
} catch (e) {
  console.warn('routes/auth.js not found — skip');
}
try {
  const { default: userRouter } = await import('./src/routes/user.js');
  app.use('/api/user', userRouter);
} catch (e) {
  console.warn('routes/user.js not found — skip');
}

// запуск
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`API listening on :${PORT}`);
});
