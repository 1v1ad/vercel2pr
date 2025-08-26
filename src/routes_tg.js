import express from 'express';
const router = express.Router();
router.get('/tg/callback', (req, res) => { res.type('text/plain').send('tg ok'); });
export default router;
