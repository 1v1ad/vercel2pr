// server.js
// ───────────────────────────────────────────────
// Backend: Express + CORS + JSON + Prisma + VK Auth + Admin panel
// ───────────────────────────────────────────────

require('dotenv').config();
const express = require('express');
const cors = require('cors');

const app = express();

/* ───────────  CORS ───────────
   FRONTEND_URL задаётся в ENV
   Разрешаем только нужный домен
────────────────────────────── */
app.use(cors({
  origin: process.env.FRONTEND_URL,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

// JSON-body parser
app.use(express.json());

// ─────────────────────
//  Роуты авторизации VK
// ─────────────────────
app.use('/api/auth', require('./src/routes/auth'));

// ─────────────────────
//  Роуты пользователя
// ─────────────────────
app.use('/api/user', require('./src/routes/user'));

// ─────────────────────
//  Роуты админки (новые)
// ─────────────────────
app.use('/api/admin', require('./src/routes/admin'));

// ─────────────────────
//  Healthcheck
// ─────────────────────
app.get('/api/health', (req, res) => {
  res.json({ ok: true, time: new Date() });
});

// ─────────────────────
//  Запуск сервера
// ─────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Backend started on port ${PORT}`);
});
