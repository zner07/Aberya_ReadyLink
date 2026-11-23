'use strict';
/* Admin sessions.

   How it works:
   1. POST /api/admin/login checks the username and the password against ADMIN_USERNAME / ADMIN_PASSWORD_HASH (server/.env).
   2. On success the server makes a random 256-bit token and sends it in an HttpOnly cookie. The browser's JavaScript can
      never read that cookie. The token is NOT in the page, in localStorage, or in the URL.
   3. The server keeps only an HMAC of the token (using ADMIN_SESSION_SECRET), never the token itself.
      A session ends at logout, after ADMIN_SESSION_HOURS, or when the server restarts.
   4. Every admin request is checked here on the SERVER. Hiding the Admin button in the page is not security.

   Sessions are kept in memory on purpose (no database change): restarting the server signs every admin out.
   That is fine for one server process. Several server copies would need a shared store. */
const crypto = require('node:crypto');
const { verifyPassword } = require('./passwordService');
const { createCounter } = require('./rateLimiter');

const MAX_SESSIONS = 50;
const LOCK_WINDOW_MS = 15 * 60 * 1000;

function createAdminAuth(config, { now = Date.now, verify = verifyPassword, randomBytes = crypto.randomBytes } = {}) {
  const cfg = config.adminAuth;
  const sessions = new Map(); // HMAC of the token -> { name, createdAt, expiresAt }
  const ipFails = createCounter({ max: 5, windowMs: LOCK_WINDOW_MS, now }); // 5 wrong tries from one address, then locked for 15 minutes
  const userFails = createCounter({ max: 10, windowMs: LOCK_WINDOW_MS, now }); // 10 wrong tries for one username, from anywhere

  const hashToken = (token) => crypto.createHmac('sha256', cfg.sessionSecret || 'not-configured').update(token).digest('hex');
  const sha = (text) => crypto.createHash('sha256').update(text).digest();
  const sameText = (a, b) => crypto.timingSafeEqual(sha(a), sha(b));

  function sweep() {
    const t = now();
    for (const [key, s] of sessions) if (s.expiresAt <= t) sessions.delete(key);
    while (sessions.size >= MAX_SESSIONS) sessions.delete(sessions.keys().next().value); // oldest session first
  }

  /* Returns { ok: true, token, expiresAt, name } or { ok: false, code: 'NOT_CONFIGURED' | 'LOCKED' | 'INVALID', retryAfterSec? }. */
  async function login({ username, password, ip }) {
    if (!cfg.configured) return { ok: false, code: 'NOT_CONFIGURED' };
    const ipKey = `ip:${ip || 'unknown'}`;
    const userKey = `user:${String(username).trim().toLowerCase().slice(0, 100)}`;
    const byIp = ipFails.peek(ipKey);
    const byUser = userFails.peek(userKey);
    if (byIp.blocked || byUser.blocked) {
      return { ok: false, code: 'LOCKED', retryAfterSec: Math.max(byIp.blocked ? byIp.retryAfterSec : 0, byUser.blocked ? byUser.retryAfterSec : 0) };
    }

    const userOk = sameText(String(username).trim().toLowerCase(), cfg.username.toLowerCase());
    const passwordOk = await verify(String(password), cfg.passwordHash); // always checked, so a wrong username takes as long as a wrong password
    if (!(userOk && passwordOk)) {
      ipFails.hit(ipKey);
      userFails.hit(userKey);
      return { ok: false, code: 'INVALID' };
    }

    ipFails.reset(ipKey);
    userFails.reset(userKey);
    sweep();
    const token = randomBytes(32).toString('base64url');
    const createdAt = now();
    const expiresAt = createdAt + cfg.sessionMs;
    sessions.set(hashToken(token), { name: cfg.username, createdAt, expiresAt });
    return { ok: true, token, expiresAt, name: cfg.username };
  }

  /* The session behind a token, or null. Expired sessions are removed. */
  function validate(token) {
    if (!cfg.configured || typeof token !== 'string' || token.length < 20 || token.length > 100) return null;
    const key = hashToken(token);
    const s = sessions.get(key);
    if (!s) return null;
    if (s.expiresAt <= now()) {
      sessions.delete(key);
      return null;
    }
    return { name: s.name, expiresAt: s.expiresAt };
  }

  function logout(token) {
    if (typeof token === 'string' && token.length >= 20 && token.length <= 100) sessions.delete(hashToken(token));
  }

  return { configured: cfg.configured, sessionMs: cfg.sessionMs, login, validate, logout, activeSessions: () => sessions.size };
}

module.exports = { createAdminAuth, MAX_SESSIONS };
