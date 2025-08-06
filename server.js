import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';

import authRouter from './routes/auth.js';
import userRouter from './routes/user.js';

const app = express();

// ───────── middlewares
app.use(helmet());
app.use(cors({
  origin: process.env.ALLOWED_ORIGIN,   // Netlify-домен
  credentials: true
}));
app.use(express.json());
app.use(morgan('tiny'));

// ───────── routes
app.use('/api/auth',  authRouter);
app.use('/api/user',  userRouter);

app.get('/', (_, res) => res.send('OK'));   // health-check

// ───────── start
const PORT = process.env.PORT || 10000;     // на Render = 10000
app.listen(PORT, () => console.log(`API ready on :${PORT}`));
