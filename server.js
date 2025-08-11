// server.js
import 'dotenv/config';
import express from 'express';
import cors from 'cors';

const app = express();

// CORS: добавь сюда домены фронта
app.use(cors({
  origin: [
    process.env.CORS_ORIGIN || '*'
  ],
  methods: ['GET','POST','PUT','PATCH','DELETE','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization','X-Admin-Password']
}));

app.use(express.json());

// Health
app.get('/healthz', (_req, res) => res.json({ ok: true }));

// Фича-флаг для админки
if ((process.env.FEATURE_ADMIN || '').toLowerCase() === 'true') {
  const { default: adminRouter } = await import('./src/modules/admin/router.js');
  app.use('/api/admin', adminRouter);
} else {
  console.log('FEATURE_ADMIN is disabled');
}

// Глобальная обработка ошибок
app.use((err, _req, res, _next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal Server Error' });
});

const port = process.env.PORT || 3001;
app.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});
