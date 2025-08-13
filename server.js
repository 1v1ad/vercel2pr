// server.js — минималка с рабочей VK PKCE авторизацией (куки, CORS, cookie-parser)
import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import authRoutes from './src/routes_auth.js';

const app = express();
app.use(cookieParser());
app.use(express.json());

const FRONT = process.env.FRONTEND_URL;

app.use(cors({
  origin: [FRONT],
  credentials: true,
}));

app.get('/', (_,res)=>res.send('ok'));
app.use('/api/auth', authRoutes);

const PORT = process.env.PORT || 3001;
app.listen(PORT, ()=>console.log('API started on', PORT));
