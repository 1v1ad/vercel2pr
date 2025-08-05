const express = require('express');
const cors = require('cors');
const routes = require('./routes'); // Теперь путь к routes!

const app = express();

app.use(cors({
  origin: [
    "https://sweet-twilight-63a9b6.netlify.app"
  ],
  credentials: true
}));

app.use(express.json());
app.use('/api', routes);

// Тестовый корневой endpoint (по желанию)
app.get('/', (req, res) => {
  res.send('Backend API is running!');
});

// Тестовый endpoint для проверки API
app.get('/api/ping', (req, res) => {
  res.send('pong');
});

module.exports = app;
