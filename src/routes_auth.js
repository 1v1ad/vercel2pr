// src/routes_auth.js
import { Router } from 'express';
const router = Router();

// Плейсхолдер. Твой реальный файл авторизации можно оставить поверх.
router.get('/auth/health', (req, res) => res.json({ ok: true }));

export default router;
