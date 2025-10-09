// server.js — корень репо, ESM
import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";

// ВАЖНО: без morgan — раньше деплой падал из-за ERR_MODULE_NOT_FOUND
// Сделаем простой логгер сами, чтобы не тащить зависимость.
function tinyLogger(req, _res, next) {
  console.log(`${new Date().toISOString()}  ${req.method} ${req.originalUrl}`);
  next();
}

// Роуты из src/
import routesAdmin from "./src/routes_admin.js";
import routesAuth  from "./src/routes_auth.js";   // ⬅️ новый файл (см. ниже)

const app = express();

// базовые миддлвары
app.use(tinyLogger);
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
app.use(cookieParser());

// ===== API =====

// health для кнопки «Проверка» в админке
app.get("/api/admin/health", (_req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});

// блок админ-роутов
app.use("/api/admin", routesAdmin);

// блок аутентификации VK/TG — ДОЛЖЕН быть подключён ДО catch-all 404
app.use("/api/auth", routesAuth);

// catch-all для остальных /api/*
app.use("/api", (req, res) => {
  res.status(404).json({ ok: false, error: "not_found", path: req.path });
});

// старт
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("API listening on :" + PORT);
});
