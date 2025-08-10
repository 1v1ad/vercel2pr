// server.js (ESM)
import 'dotenv/config';
import express from 'express';
import cors from 'cors';

import authRouter from './src/routes/auth.js';
import userRouter from './src/routes/user.js';
import adminRouter from './src/routes/admin.js';

const app = express();

app.use(cors({
  origin: process.env.FRONTEND_URL,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json());

// Роуты
app.use('/api/auth', authRouter);
app.use('/api/user', userRouter);
app.use('/api/admin', adminRouter);

// Healthcheck
app.get('/api/health', (_req, res) => {
  res.json({ ok: true, time: new Date() });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Backend started on port ${PORT}`);
});
