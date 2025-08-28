// src/routes_auth.js — VK + TG маршруты, PKCE, линковка
import express from 'express';
import cookieParser from 'cookie-parser'; // на всякий случай, если сервер не подключил
import { createCodeVerifier, createCodeChallenge } from './pkce.js';

const router = express.Router();

// Если сервер не сделал app.use(cookieParser()), подключим локально.
// (Повторное подключение безвредно.)
router.use(cookieParser());

// ENV
const {
  FRONTEND_URL,
  VK_CLIENT_ID,
  VK_CLIENT_SECRET,
  VK_REDIRECT_URI,
} = process.env;

// Константы VK ID (именно id.vk.com, не oauth.vk.com)
const VK_AUTH_URL  = 'https://id.vk.com/oauth2/auth';
const VK_TOKEN_URL = 'https://id.vk.com/oauth2/token';

// Утилита: безопасно читаем JSON, иначе возвращаем текст
async function readJsonSafe(resp) {
  const text = await resp.text();
  try {
    return { json: JSON.parse(text), raw: text };
  } catch {
    return { json: null, raw: text };
  }
}

// Утилита: редирект на фронт с параметром ?error=vk|tg и опциональным msg
function redirectError(res, code, msg) {
  const u = new URL(FRONTEND_URL);
  u.searchParams.set('error', code);
  if (msg) u.searchParams.set('msg', msg.toString().slice(0, 200));
  return res.redirect(302, u.toString());
}

// Утилита: редирект на фронт с флагом успеха
function redirectOk(res, provider) {
  const u = new URL(FRONTEND_URL);
  u.searchParams.set(provider, 'ok');
  return res.redirect(302, u.toString());
}

/**
 * GET /api/auth/vk/start
 * 1) генерим PKCE verifier/challenge и state
 * 2) кладём их в httpOnly cookies
 * 3) редиректим на VK ID /oauth2/auth
 */
router.get('/api/auth/vk/start', async (req, res) => {
  try {
    const verifier = createCodeVerifier(64);
    const challenge = await createCodeChallenge(verifier);
    const state = crypto.randomUUID();

    // Куки живут 10 минут, только для пути callback.
    const cookieOpts = {
      httpOnly: true,
      sameSite: 'lax',
      secure: true,
      maxAge: 10 * 60 * 1000,
      path: '/api/auth/vk',
    };

    res.cookie('vk_verifier', verifier, cookieOpts);
    res.cookie('vk_state', state, cookieOpts);

    const authUrl = new URL(VK_AUTH_URL);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('client_id', VK_CLIENT_ID);
    authUrl.searchParams.set('redirect_uri', VK_REDIRECT_URI);
    authUrl.searchParams.set('state', state);
    // Если нужны доп.разрешения — добавь:
    // authUrl.searchParams.set('scope', 'email,offline');

    // PKCE
    authUrl.searchParams.set('code_challenge', challenge);
    authUrl.searchParams.set('code_challenge_method', 'S256');

    return res.redirect(302, authUrl.toString());
  } catch (e) {
    console.error('[vk/start] error', e);
    return redirectError(res, 'vk', 'start_failed');
  }
});

/**
 * GET /api/auth/vk/callback?code=...&state=...
 * 1) проверяем state из куки
 * 2) обмениваем code на access_token с помощью x-www-form-urlencoded + code_verifier
 * 3) создаём/находим пользователя, шьём сессии, линковка с TG (если была pending)
 * 4) редиректим на фронт
 */
router.get('/api/auth/vk/callback', async (req, res) => {
  const { code, state } = req.query ?? {};

  try {
    const cookieState = req.cookies?.vk_state;
    const verifier = req.cookies?.vk_verifier;

    if (!code || !state || !cookieState || !verifier || state !== cookieState) {
      return redirectError(res, 'vk', 'bad_state_or_no_verifier');
    }

    // Обмен кода на токен — ТОЛЬКО urlencoded-формат!
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: VK_CLIENT_ID,
      client_secret: VK_CLIENT_SECRET,
      redirect_uri: VK_REDIRECT_URI,
      code: code.toString(),
      code_verifier: verifier,
    });

    const tokenResp = await fetch(VK_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json',
      },
      body,
    });

    const { json: token, raw: tokenRaw } = await readJsonSafe(tokenResp);

    if (process.env.DEBUG_VK) {
      console.log('[vk/callback] token status=', tokenResp.status, 'json=', token, 'raw=', tokenRaw?.slice(0, 300));
    }

    if (!tokenResp.ok || !token || !token.access_token) {
      console.error('[vk/callback] token exchange failed', tokenResp.status, token || tokenRaw);
      return redirectError(res, 'vk', 'token_exchange_failed');
    }

    // Получим профиль (минимально). Токен VK ID обычно подходит к vk api:
    const infoResp = await fetch('https://api.vk.com/method/users.get?v=5.199&fields=photo_200', {
      headers: { Authorization: `Bearer ${token.access_token}` },
    });
    const { json: info, raw: infoRaw } = await readJsonSafe(infoResp);

    if (process.env.DEBUG_VK) {
      console.log('[vk/callback] userinfo status=', infoResp.status, 'json=', info, 'raw=', infoRaw?.slice(0, 300));
    }

    let vkUserId = token.user_id || info?.response?.[0]?.id;
    if (!vkUserId) {
      console.warn('[vk/callback] no user id in token/info, continue anyway');
    }

    // === Ваши действия: создать/найти пользователя, зашить сессию и, если есть pending_TG, склеить ===
    // Ниже — простая заготовка «выдать сессионную куку sid».
    // В вашей сборке здесь, вероятно, идёт запись в БД и генерация собственных sid/jwt.
    const sid = `vk:${vkUserId ?? 'unknown'}`;
    res.cookie('sid', sid, {
      httpOnly: true,
      sameSite: 'lax',
      secure: true,
      path: '/',
      maxAge: 30 * 24 * 3600 * 1000,
    });

    // почистим служебные куки PKCE
    res.clearCookie('vk_verifier', { path: '/api/auth/vk' });
    res.clearCookie('vk_state', { path: '/api/auth/vk' });

    return redirectOk(res, 'vk');
  } catch (e) {
    console.error('[vk/callback] error', e);
    return redirectError(res, 'vk', 'callback_failed');
  }
});

/**
 * Заглушки Telegram (пример): TG сам по себе логин «не завершает».
 * Мы сохраняем флаг pending, а финал делаем после VK.
 * Здесь просто показываю идею, реальные обработчики у вас уже есть.
 */

// Пример: POST /api/auth/tg — кладём флаг pending в куку и возвращаем 200
router.post('/api/auth/tg', express.json(), (req, res) => {
  res.cookie('tg_pending', '1', {
    httpOnly: true,
    sameSite: 'lax',
    secure: true,
    path: '/',
    maxAge: 10 * 60 * 1000,
  });
  return res.status(200).json({ ok: true });
});

export default router;
