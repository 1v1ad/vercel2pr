// server.js — GGRoom backend (Auth + Admin + Health)
// Node 18+
import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';

import authRouter from './src/routes/auth.js';
import adminRouter from './src/routes/admin.js';
import healthRouter from './src/routes/health.js';

const app = express();
const FRONT = process.env.FRONTEND_URL;

app.use(cookieParser());
app.use(express.json());

// CORS
app.use(cors({
  origin: [FRONT],
  credentials: true,
  methods: ['GET','POST','OPTIONS'],
  allowedHeaders: [
    'Content-Type','Authorization',
    'X-Admin-Password','X-Admin-Secret',
    'x-admin-password','x-admin-secret'
  ]
}));

// Routes
app.use('/api/health', healthRouter);
app.use('/api/auth', authRouter);
if (process.env.FEATURE_ADMIN === 'true') {
  app.use('/api/admin', adminRouter);
} else {
  console.log('FEATURE_ADMIN is not true — admin routes disabled');
}

// Ping
app.get('/', (_req, res) => res.json({ ok: true, ts: Date.now() }));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log('API on', PORT, 'FRONT=', FRONT, 'FEATURE_ADMIN=', process.env.FEATURE_ADMIN);
});
