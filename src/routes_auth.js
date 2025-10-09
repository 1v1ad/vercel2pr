// src/routes_auth.js — минимальные эндпоинты, чтобы /api/auth/* не били в 404.
// Сюда потом вернём реальную логику OAuth/видифкации TG.
import express from "express";
const router = express.Router();

// VK: старт авторизации
// GET /api/auth/vk/start
router.get("/vk/start", async (req, res) => {
  // TODO: собрать redirectUrl на VK OAuth и сделать res.redirect(redirectUrl)
  return res.json({ ok: true, flow: "vk_start_ready" });
});

// VK: callback
// GET /api/auth/vk/callback
router.get("/vk/callback", async (req, res) => {
  // TODO: обмен кода на токен, получение профиля, установка сессии
  return res.json({ ok: true, flow: "vk_callback_ready", query: req.query });
});

// TG: callback (Login Widget / WebApp initData)
// GET /api/auth/tg/callback
router.get("/tg/callback", async (req, res) => {
  // TODO: верификация подписи Telegram, апсерт пользователя, сессия
  return res.json({ ok: true, flow: "tg_callback_ready", query: req.query });
});

export default router;
