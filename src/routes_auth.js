import express from "express";
import fetch from "node-fetch";
import cookieParser from "cookie-parser";
import { createVerifier, createChallenge, writePkce, readPkce, clearPkce, getOrSetDeviceId } from "./pkce.js";

const VK_AUTHORIZE = "https://id.vk.com/authorize";
const VK_TOKEN = "https://oauth.vk.com/access_token"; // keep your previous endpoint if different

function requiredEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env ${name}`);
  return v;
}

const VK_CLIENT_ID = requiredEnv("VK_CLIENT_ID");
const VK_CLIENT_SECRET = requiredEnv("VK_CLIENT_SECRET");
const VK_REDIRECT_URI = requiredEnv("VK_REDIRECT_URI");
const FRONTEND_URL = requiredEnv("FRONTEND_URL");
const COOKIE_SECRET = process.env.COOKIE_SECRET || "change-me";

export function registerAuthRoutes(app) {
  const router = express.Router();
  router.use(cookieParser(COOKIE_SECRET));

  // health
  router.get("/healthz", (req, res) => res.type("text").send("ok"));

  // Start auth -> redirect to VK
  router.get("/vk/start", async (req, res) => {
    try {
      const state = cryptoRandom();
      const verifier = createVerifier();
      const challenge = createChallenge(verifier);
      const deviceId = getOrSetDeviceId(req, res);

      writePkce(res, { state, verifier, createdAt: Date.now(), deviceId });

      const params = new URLSearchParams({
        response_type: "code",
        client_id: VK_CLIENT_ID,
        redirect_uri: VK_REDIRECT_URI,
        scope: "email",
        state,
        code_challenge: challenge,
        code_challenge_method: "S256",
        // device_id isn't required by /authorize, but adding doesn't hurt if VK ignores it
      });

      const url = `${VK_AUTHORIZE}?${params.toString()}`;
      res.redirect(url);
    } catch (e) {
      console.error("[VK START] error", e);
      res.status(500).type("text").send("auth start failed");
    }
  });

  // Callback
  router.get("/vk/callback", async (req, res) => {
    const code = req.query.code?.toString();
    const state = req.query.state?.toString();
    if (!code) return res.status(400).type("text").send("Missing code");
    if (!state) return res.status(400).type("text").send("Missing state");

    const pkce = readPkce(req);
    if (!pkce || pkce.state !== state) {
      console.warn("[VK CALLBACK] invalid state check:", {
        hasPkce: !!pkce, savedState: pkce?.state, gotState: state,
      });
      return res.status(400).type("text").send("Invalid state");
    }

    try {
      // Exchange code for token
      const body = new URLSearchParams({
        client_id: VK_CLIENT_ID,
        client_secret: VK_CLIENT_SECRET,
        redirect_uri: VK_REDIRECT_URI,  // CRITICAL: must match authorize redirect exactly
        code,
        grant_type: "authorization_code",
        // Some VK flows also accept PKCE; include if supported
        code_verifier: pkce.verifier,
        device_id: pkce.deviceId || "",
      });

      const r = await fetch(VK_TOKEN, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
      });

      const text = await r.text();
      let token;
      try { token = JSON.parse(text); } catch { token = null; }

      if (!r.ok || (token && token.error)) {
        console.error("[VK CALLBACK] token exchange failed:", r.status, token || text);
        clearPkce(res);
        return res.status(400).type("text").send("Token exchange failed");
      }

      // token received; continue whatever you do (user fetch / session, etc)
      clearPkce(res);
      // Redirect to frontend app (append minimal flag)
      const to = new URL(FRONTEND_URL);
      to.searchParams.set("vk_login", "1");
      return res.redirect(to.toString());
    } catch (e) {
      console.error("[VK CALLBACK] error", e);
      return res.status(500).type("text").send("auth callback failed");
    }
  });

  app.use("/api/auth", router);
}

function cryptoRandom() {
  // short state string
  return Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
}
