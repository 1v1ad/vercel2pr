// server.js
const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');

const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN;
const PORT = process.env.PORT || 3001;

const app = express();
app.set('trust proxy', 1);

app.use(cors({
  origin: [FRONTEND_ORIGIN],
  methods: ['GET','POST','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization'],
  credentials: true
}));
app.use(express.json());
app.use(cookieParser());

app.use('/api/auth', require('./src/routes/auth'));
app.use('/api/user', require('./src/routes/user'));

app.get('/api/health', (req,res)=>res.json({ok:true}));

app.listen(PORT, () => {
  console.log('API running on', PORT);
});
