// ESM-версия
import express from 'express';
import cors from 'cors';

// Если эти роуты у тебя есть — оставляем.
// Если нет, можно временно закомментировать.
import authRouter from './src/routes/auth.js';
import userRouter from './src/routes/user.js';

// Новый роут для Telegram
import tgRouter from './src/routes_tg.js';

const app = express();

// ────────────────────────────────────────────────────────────
// Базовые middleware
// ────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true })); // нужно для form-urlencoded (на случай POST от виджета)

const FRONTEND_URL = process.env.FRONTEND_URL || 'https://sweet-twilight-63a9b6.netlify.app';

app.use(
  cors({
    origin: [FRONTEND_URL],
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'x-device-id'],
    credentials: false,
  })
);

// ────────────────────────────────────────────────────────────
// Health-check (удобно для «прогрева»)
// ────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => res.status(200).send('ok'));

// ────────────────────────────────────────────────────────────
// Роуты API
// ────────────────────────────────────────────────────────────
app.use('/api/auth/tg', tgRouter); // ← Telegram callback
app.use('/api/auth', authRouter);
app.use('/api/user', userRouter);

// ────────────────────────────────────────────────────────────
// Запуск
// Render сам прокидывает PORT в env. Не хардкодим!
// ────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`API listening on :${PORT}`);
});
