// server.js — mounts auth + admin + health
import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import adminRouter from './src/routes_admin.js';
import healthRouter from './src/routes_health.js';
import authRouter from './src/routes_auth.js';

const app = express();

app.use(cookieParser());
app.use(express.json());

const FRONT = process.env.FRONTEND_URL;

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

app.use('/api/health', healthRouter);
app.use('/api/auth', authRouter);
if (process.env.FEATURE_ADMIN === 'true') {
  app.use('/api/admin', adminRouter);
}

app.get('/', (_req,res)=>res.json({ok:true, ts:Date.now()}));

const PORT = process.env.PORT || 3001;
app.listen(PORT, ()=>console.log('API on', PORT));
