'use strict';
/* Small checks shared by the admin routes. They are extra safety rails, not a replacement for the login. */
const { AppError } = require('./errors');

/* True when the request comes from a page on THIS server (browsers send an Origin header on POST and PATCH). */
function isSameOrigin(origin, host) {
  try {
    return Boolean(host) && new URL(origin).host === host;
  } catch (err) {
    return false; // for example "null" (a page opened from disk)
  }
}

function assertSameOrigin(req) {
  const origin = req.headers.origin;
  if (origin && !isSameOrigin(origin, req.headers.host)) {
    throw new AppError(403, 'FORBIDDEN_ORIGIN', 'Admin changes can only be made from the READYLINK app on this server.');
  }
}

function assertJson(req) {
  const contentType = String(req.headers['content-type'] || '').toLowerCase();
  if (!contentType.startsWith('application/json')) {
    throw new AppError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Send the request as JSON (Content-Type: application/json).');
  }
}

module.exports = { isSameOrigin, assertSameOrigin, assertJson };
