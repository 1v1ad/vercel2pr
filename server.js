// server.js
import 'dotenv/config';
import express from 'express';
import cors from 'cors';

// ВАЖНО: у тебя файл авторизации называется routes_auth.js и лежит в /src
import authRouter from './src/routes_auth.js';

// Админ-роут из /src/routes/admin.js
import adminRouter from './src/routes/admin.js';

const app = express();

app.use(cors({
  origin: process.env.FRONTEND_URL,           // https://sweet-twilight-63a9b6.netlify.app
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

app.use(express.json());

// Авторизация пользователей (как было)
app.use('/api/auth', authRouter);

// Админка (новое)
app.use('/api/admin', adminRouter);

// Healthcheck
app.get('/api/health', (_req, res) => {
  res.json({ ok: true, time: new Date() });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Backend started on port ${PORT}`);
});
