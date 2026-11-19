const { createHash, createHmac, randomBytes, timingSafeEqual } = require("node:crypto");
const { HttpError } = require("./store");

const COOKIE = "__Host-ricotta-admin";
const SESSION_SECONDS = 8 * 60 * 60;

function passwordSecret() {
  const password = process.env.RICOTTA_ADMIN_PASSWORD;
  return typeof password === "string" && password.length >= 16 ? password : null;
}

function digest(value) {
  return createHash("sha256").update(value).digest();
}

function verifyPassword(candidate) {
  const secret = passwordSecret();
  return !!secret && typeof candidate === "string" && candidate.length <= 256 &&
    timingSafeEqual(digest(candidate), digest(secret));
}

function signature(payload, secret) {
  return createHmac("sha256", secret).update("ricotta-admin-v1:" + payload).digest("base64url");
}

function isAdmin(cookieHeader) {
  const secret = passwordSecret();
  const token = (cookieHeader || "").split(/;\s*/).find(value => value.startsWith(COOKIE + "="))?.slice(COOKIE.length + 1);
  if (!secret || !token || !/^\d+\.[a-f0-9]{32}\.[a-zA-Z0-9_-]{43}$/.test(token)) return false;
  const [expiry, nonce, signed] = token.split(".");
  return Number(expiry) > Date.now() &&
    timingSafeEqual(Buffer.from(signed), Buffer.from(signature(`${expiry}.${nonce}`, secret)));
}

function requireAdmin(request) {
  if (!isAdmin(request.headers.get("cookie"))) throw new HttpError(401, "יש להתחבר לממשק הניהול.");
}

function requireSameOrigin(request) {
  if (request.headers.get("origin") !== new URL(request.url).origin) {
    throw new HttpError(403, "מקור הבקשה אינו מורשה.");
  }
}

function sessionCookie(activate) {
  const payload = `${Date.now() + SESSION_SECONDS * 1000}.${randomBytes(16).toString("hex")}`;
  const value = activate ? `${payload}.${signature(payload, passwordSecret())}` : "";
  return `${COOKIE}=${value}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${activate ? SESSION_SECONDS : 0}`;
}

module.exports = { passwordSecret, verifyPassword, isAdmin, requireAdmin, requireSameOrigin, sessionCookie };
