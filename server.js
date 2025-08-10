// server.js
// ───────────────────────────────────────────────
// Express + CORS + JSON + Prisma + VK Auth + Admin
// ───────────────────────────────────────────────
require('dotenv').config();
const express = require('express');
const cors = require('cors');

const app = express();

// CORS — разрешаем фронт с Netlify (ENV FRONTEND_URL)
app.use(cors({
  origin: process.env.FRONTEND_URL,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

// JSON
app.use(express.json());

// Роуты авторизации и пользователя (как у тебя было)
app.use('/api/auth', require('./src/routes/auth'));
app.use('/api/user', require('./src/routes/user'));

// >>> ДОБАВЛЕНО: роуты админки
app.use('/api/admin', require('./src/routes/admin'));

// Healthcheck
app.get('/api/health', (req, res) => {
  res.json({ ok: true, time: new Date() });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Backend started on port ${PORT}`));
