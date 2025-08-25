# Minimal VK ID auth backend (Render/Netlify)

**Files**
- `server.js` — entrypoint (at project root)
- `src/routes_auth.js` — VK OAuth2 + PKCE; uses global `fetch` (Node >=18)

**ENV (Render → Environment)**
- `JWT_SECRET`        — any 64-char random string (not used for token minting here, but kept for compatibility)
- `VK_CLIENT_ID`      — from VK ID app
- `VK_CLIENT_SECRET`  — from VK ID app (server key)
- `VK_REDIRECT_URI`   — `https://<service>.onrender.com/api/auth/vk/callback`
- `FRONTEND_URL`      — optional, e.g. `https://sweet-twilight-63a9b6.netlify.app`

**VK ID settings**
- Base domains: add your Netlify domain and the Render domain
- Trusted Redirect URL: same as `VK_REDIRECT_URI`
- Use the auth URL `https://id.vk.com/authorize` with `response_type=code` and PKCE (S256).

**Routes**
- `GET /api/auth/healthz` → ok
- `GET /api/auth/start`   → redirects to VK ID
- `GET /api/auth/vk/callback` → handles token exchange (no `device_id` used)
