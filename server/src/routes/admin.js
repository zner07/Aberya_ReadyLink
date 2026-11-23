'use strict';
/* Admin login routes.
     POST /api/admin/login    { username, password }   -> sets the session cookie
     POST /api/admin/logout                            -> ends the session on the server and clears the cookie
     GET  /api/admin/session                           -> { configured, authenticated, name, writes }  (never an error)
   The password is only ever read here, compared with the stored hash, and forgotten. It is never logged or returned. */
const { AppError } = require('../middleware/errors');
const { readToken, sessionCookie, clearedCookie } = require('../middleware/adminAuth');
const { assertSameOrigin, assertJson } = require('../middleware/origin');

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function createAdminHandlers({ config, auth }) {
  const secure = config.isProduction;

  return {
    async login(req, res, next) {
      try {
        assertSameOrigin(req);
        assertJson(req);
        const body = req.body;
        const fields = {};
        if (!isPlainObject(body)) throw new AppError(400, 'VALIDATION', 'Send the username and password as JSON.', { _body: 'Send the username and password as JSON.' });
        if (typeof body.username !== 'string' || !body.username.trim() || body.username.length > 100) fields.username = 'Enter your username.';
        if (typeof body.password !== 'string' || !body.password || body.password.length > 1000) fields.password = 'Enter your password.';
        if (Object.keys(fields).length) throw new AppError(400, 'VALIDATION', 'Enter your username and password.', fields);

        const out = await auth.login({ username: body.username, password: body.password, ip: req.socket && req.socket.remoteAddress });
        if (!out.ok) {
          if (out.code === 'NOT_CONFIGURED') {
            throw new AppError(503, 'ADMIN_NOT_CONFIGURED', 'Admin login is not set up on this server yet. Run "npm.cmd run admin:setup" in the server folder, then restart the server.');
          }
          if (out.code === 'LOCKED') {
            res.set('Retry-After', String(out.retryAfterSec));
            throw new AppError(429, 'TOO_MANY_ATTEMPTS', `Too many failed sign-in attempts. Try again in ${Math.ceil(out.retryAfterSec / 60)} minute(s).`);
          }
          throw new AppError(401, 'INVALID_CREDENTIALS', 'Incorrect username or password.'); // the same text for a wrong username and a wrong password
        }
        res.set('Set-Cookie', sessionCookie(out.token, { maxAgeSec: Math.floor(auth.sessionMs / 1000), secure }));
        res.json({ ok: true, admin: { name: out.name }, writes: Boolean(config.adminWrites) });
      } catch (err) {
        next(err);
      }
    },

    logout(req, res, next) {
      try {
        assertSameOrigin(req);
        assertJson(req);
        auth.logout(readToken(req));
        res.set('Set-Cookie', clearedCookie({ secure }));
        res.json({ ok: true });
      } catch (err) {
        next(err);
      }
    },

    session(req, res) {
      const session = auth.configured ? auth.validate(readToken(req)) : null;
      res.json({ configured: auth.configured, authenticated: Boolean(session), name: session ? session.name : null, writes: Boolean(config.adminWrites) });
    },
  };
}

function createAdminRouter(handlers) {
  const express = require('express'); // loaded here, so the handlers above can be unit-tested without Express
  const router = express.Router();
  router.post('/login', express.json({ limit: '8kb', strict: true }), handlers.login);
  router.post('/logout', express.json({ limit: '1kb', strict: true }), handlers.logout);
  router.get('/session', handlers.session);
  return router;
}

module.exports = { createAdminHandlers, createAdminRouter };
