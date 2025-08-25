import express from 'express';
const r = express.Router();

// forward literally everything under /api/auth/tg/* to /api/tg/*
r.use((req, res) => {
  const target = '/api/tg' + req.url;
  return res.redirect(302, target);
});

export default r;
