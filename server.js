import 'dotenv/config';
import express from 'express';
import cors from 'cors';

// авторизация VK
import authRouter from './src/routes_auth.js';
// админка (Prisma)
import adminRouter from './src/routes/admin.js';

const app = express();

app.use(cors({
  origin: process.env.FRONTEND_URL, // https://sweet-twilight-63a9b6.netlify.app
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

app.use(express.json());

// VK OAuth
app.use('/api/auth', authRouter);

// Admin
app.use('/api/admin', adminRouter);

// Health
app.get('/api/health', (_req, res) => res.json({ ok: true, time: new Date() }));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Backend started on port ${PORT}`));
