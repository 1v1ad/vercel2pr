// server.js
// ────────────────────────────────────────────────────────────
// HTTP-сервер бекенда: Express + CORS + JSON-парсер + роуты
// ────────────────────────────────────────────────────────────

const express = require('express');
const cors    = require('cors');

const app = express();

/* ─────────────────────────  C O R S  ─────────────────────────
   Разрешаем запросы только от фронта Netlify.
   При необходимости добавьте другие домены в массив.
----------------------------------------------------------------*/
app.use(cors({
  origin: [
    'https://sweet-twilight-63a9b6.netlify.app'
    // , 'https://другой-домен.com'
  ],
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

/* JSON-body парсер (обязательно выше роутов) */
app.use(express.json());

/* ───────────────  Р о у т ы  ─────────────── */
app.use('/api/auth', require('./src/routes/auth'));
app.use('/api/user', require('./src/routes/user'));

/* ───────────────  З а п у с к  ───────────── */
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
