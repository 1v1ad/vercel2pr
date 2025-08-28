// server.js
import express from "express";
import cookieParser from "cookie-parser";
import cors from "cors";
import routes from "./src/routes_auth.js";

const app = express();

const FRONTEND_URL = process.env.FRONTEND_URL; // https://sweet-twilight-63a9b6.netlify.app

app.use(cookieParser());
app.use(
  cors({
    origin: FRONTEND_URL,
    credentials: true, // <-- обязательно
  })
);

// health
app.get("/api/health", (_req, res) => res.json({ ok: true }));

// текущий пользователь (из куки sid)
app.get("/api/me", (req, res) => {
  const b64 = req.cookies?.sid;
  if (!b64) return res.status(401).json({ ok: false });
  try {
    const user = JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
    return res.json({ ok: true, user });
  } catch {
    return res.status(401).json({ ok: false });
  }
});

// роуты авторизации
app.use("/api", routes);

// порт Render игнорирует; слушаем 10000 или любой
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`[BOOT] listening on :${PORT}`);
});
