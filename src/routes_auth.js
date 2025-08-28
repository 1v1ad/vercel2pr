// src/routes_auth.js
import fetch from "node-fetch";
import crypto from "crypto";
import express from "express";

const router = express.Router();

const {
  FRONTEND_URL,
  VK_CLIENT_ID,
  VK_CLIENT_SECRET,
  VK_REDIRECT_URI,
  TELEGRAM_BOT_TOKEN,
} = process.env;

// ========== VK AUTH (oauth.vk.com) ==========

// Запуск авторизации VK
router.get("/auth/vk/start", (req, res) => {
  // Генерируем state для защиты от CSRF
  const state = crypto.randomBytes(16).toString("hex");
  res.cookie("vk_state", state, {
    httpOnly: true,
    sameSite: "none",
    secure: true,
    path: "/",
  });

  const params = new URLSearchParams({
    client_id: VK_CLIENT_ID,
    redirect_uri: VK_REDIRECT_URI,
    response_type: "code",
    scope: "email",
    state,
    v: "5.199",
  });

  const url = `https://oauth.vk.com/authorize?${params.toString()}`;
  return res.redirect(url);
});

// Callback VK → обмен code на токен и получение профиля
router.get("/auth/vk/callback", async (req, res) => {
  try {
    const { code, state } = req.query;
    const cookieState = req.cookies?.vk_state;
    if (!code || !state || state !== cookieState) {
      return res.redirect(`${FRONTEND_URL}/?error=vk_state`);
    }

    // Обмениваем code на access_token
    const tokenParams = new URLSearchParams({
      client_id: VK_CLIENT_ID,
      client_secret: VK_CLIENT_SECRET,
      redirect_uri: VK_REDIRECT_URI,
      code: String(code),
    });

    const tokenResp = await fetch(
      `https://oauth.vk.com/access_token?${tokenParams.toString()}`
    );

    const text = await tokenResp.text();
    let tokenJson;
    try {
      tokenJson = JSON.parse(text);
    } catch {
      // Пробрасываем текст ошибки как есть для отладки
      console.error("[VK token HTML error]", text.slice(0, 300));
      return res.redirect(`${FRONTEND_URL}/?error=vk_token_html`);
    }

    if (!tokenResp.ok || tokenJson.error) {
      console.error("[VK token error]", tokenJson);
      return res.redirect(`${FRONTEND_URL}/?error=vk_token`);
    }

    const { access_token, user_id } = tokenJson;

    // Получаем профиль
    const meParams = new URLSearchParams({
      access_token,
      user_ids: String(user_id),
      fields: "photo_100,first_name,last_name",
      v: "5.199",
    });

    const meResp = await fetch(
      `https://api.vk.com/method/users.get?${meParams.toString()}`
    );
    const meJson = await meResp.json();

    if (!meResp.ok || meJson.error) {
      console.error("[VK users.get error]", meJson);
      return res.redirect(`${FRONTEND_URL}/?error=vk_me`);
    }

    const u = meJson.response?.[0];
    const user = {
      id: String(user_id),
      first_name: u?.first_name || "",
      last_name: u?.last_name || "",
      photo: u?.photo_100 || "",
      provider: "vk",
    };

    // Сохраняем сессию (HTTP-only кука)
    res.cookie("sid", Buffer.from(JSON.stringify(user)).toString("base64"), {
      httpOnly: true,
      sameSite: "none",
      secure: true,
      path: "/",
      maxAge: 30 * 24 * 3600 * 1000,
    });

    return res.redirect(`${FRONTEND_URL}/lobby`);
  } catch (e) {
    console.error("[VK callback fatal]", e);
    return res.redirect(`${FRONTEND_URL}/?error=vk_fatal`);
  }
});

// ========== Telegram AUTH ==========

function checkTelegramAuth(data) {
  const { hash, ...rest } = data;
  const payload = Object.keys(rest)
    .sort()
    .map((k) => `${k}=${rest[k]}`)
    .join("\n");

  const secret = crypto
    .createHash("sha256")
    .update(TELEGRAM_BOT_TOKEN)
    .digest();

  const signature = crypto
    .createHmac("sha256", secret)
    .update(payload)
    .digest("hex");

  return signature === hash;
}

// Принимаем данные из TG виджета
router.post("/auth/telegram", express.json(), async (req, res) => {
  try {
    const data = req.body || {};
    if (!checkTelegramAuth(data)) {
      return res.status(401).json({ ok: false, error: "bad_signature" });
    }

    const user = {
      id: String(data.id),
      first_name: data.first_name || "",
      last_name: data.last_name || "",
      username: data.username || "",
      photo: data.photo_url || "",
      provider: "telegram",
    };

    res.cookie("sid", Buffer.from(JSON.stringify(user)).toString("base64"), {
      httpOnly: true,
      sameSite: "none",
      secure: true,
      path: "/",
      maxAge: 30 * 24 * 3600 * 1000,
    });

    return res.json({ ok: true });
  } catch (e) {
    console.error("[TG auth fatal]", e);
    return res.status(500).json({ ok: false });
  }
});

export default router;
