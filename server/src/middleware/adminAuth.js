'use strict';
/* Cookie handling and the guard that protects every admin-only API route. No extra packages. */
const { AppError } = require('./errors');

const COOKIE_NAME = 'readylink_admin';

function parseCookies(header) {
  const out = {};
  if (typeof header !== 'string' || header.length > 8192) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 1) continue;
    const name = part.slice(0, i).trim();
    if (!name) continue;
    let value = part.slice(i + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    if (!(name in out)) out[name] = value;
  }
  return out;
}

const readToken = (req) => parseCookies(req.headers && req.headers.cookie)[COOKIE_NAME] || null;

/* HttpOnly: JavaScript cannot read it. SameSite=Strict: other websites cannot make the browser send it.
   Secure is added in production (HTTPS). */
function sessionCookie(token, { maxAgeSec, secure }) {
  return `${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSec}${secure ? '; Secure' : ''}`;
}
function clearedCookie({ secure }) {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT${secure ? '; Secure' : ''}`;
}

/* Put this in front of any admin-only route. On success req.admin = { name, expiresAt }. */
function requireAdmin(auth) {
  return function adminGuard(req, res, next) {
    if (!auth.configured) {
      return next(new AppError(503, 'ADMIN_NOT_CONFIGURED', 'Admin login is not set up on this server yet. Run "npm.cmd run admin:setup" in the server folder, then restart the server.'));
    }
    const session = auth.validate(readToken(req));
    if (!session) return next(new AppError(401, 'UNAUTHENTICATED', 'Sign in as an admin to do this.'));
    req.admin = session;
    return next();
  };
}

module.exports = { COOKIE_NAME, parseCookies, readToken, sessionCookie, clearedCookie, requireAdmin };
