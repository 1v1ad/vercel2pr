import crypto from "node:crypto";

const PKCE_COOKIE = "__vk_pkce";
const DEVICE_COOKIE = "__vk_device";
const COOKIE_PATH = "/api/auth/vk";

function b64url(input) {
  return input.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function createVerifier() {
  // 64 random bytes ~ 86 chars base64url
  return b64url(crypto.randomBytes(64).toString("base64"));
}

export function createChallenge(verifier) {
  const hash = crypto.createHash("sha256").update(verifier).digest("base64");
  return b64url(hash);
}

export function readPkce(req) {
  const raw = req.cookies?.[PKCE_COOKIE];
  if (!raw) return null;
  try {
    const obj = JSON.parse(raw);
    return obj && typeof obj === "object" ? obj : null;
  } catch {
    return null;
  }
}

export function writePkce(res, data) {
  // httpOnly to protect verifier; SameSite=Lax is enough for top-level redirects
  res.cookie(PKCE_COOKIE, JSON.stringify(data), {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: COOKIE_PATH,
    maxAge: 10 * 60 * 1000, // 10 minutes
  });
}

export function clearPkce(res) {
  res.clearCookie(PKCE_COOKIE, { path: COOKIE_PATH });
}

export function getOrSetDeviceId(req, res) {
  let id = req.cookies?.[DEVICE_COOKIE];
  if (!id) {
    // uuid v4-ish
    id = crypto.randomUUID();
    res.cookie(DEVICE_COOKIE, id, {
      httpOnly: false,
      secure: true,
      sameSite: "lax",
      path: "/",
      maxAge: 365 * 24 * 60 * 60 * 1000,
    });
  }
  return id;
}
