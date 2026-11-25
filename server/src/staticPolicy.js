'use strict';
/* Which URL paths may Express serve from the repository root?

   The frontend lives in the repository root, next to the server/ folder (and later .env, the database and uploads).
   So the server must never serve "everything under the root". It serves ONLY:
     "/" and "/index.html"        -> index.html (the PUBLIC site)
     "/css/...", "/js/...", "/data/..." -> the existing frontend assets
     "/admin/" and "/admin/index.html"  -> admin/index.html (the separate ADMIN site)
     "/admin/js/..."                    -> the admin-only scripts
     "/admin" (no slash)                -> a redirect to "/admin/" (the admin page uses relative file paths)

   classify() is a pure function so it can be unit-tested without Express.
   It rejects anything that looks like path trickery BEFORE the file system is touched:
   encoded dots/slashes, "..", backslashes, NUL bytes, empty segments and dotfiles. */
const PUBLIC_DIRS = Object.freeze(['css', 'js', 'data']);
const ADMIN_ASSET_DIRS = Object.freeze(['admin/js']); // folders (under the frontend folder) with admin-only scripts
const BAD_ENCODINGS = /%2e|%2f|%5c|%00/i;

/* kind: 'index' (serve index.html) | 'admin-index' (serve admin/index.html) | 'admin-redirect' (send /admin to /admin/)
         | 'asset' (let express.static serve it) | 'other' (not part of the frontend) | 'deny' (suspicious) */
function classify(rawPath) {
  if (typeof rawPath !== 'string' || !rawPath.startsWith('/')) return { kind: 'deny', reason: 'not an absolute path' };
  const pathOnly = rawPath.split(/[?#]/, 1)[0];
  if (pathOnly.includes('\0') || pathOnly.includes('\\') || BAD_ENCODINGS.test(pathOnly)) {
    return { kind: 'deny', reason: 'encoded or unsafe characters' };
  }
  if (pathOnly === '/' || pathOnly === '/index.html') return { kind: 'index' };
  if (pathOnly === '/admin') return { kind: 'admin-redirect' };
  if (pathOnly === '/admin/' || pathOnly === '/admin/index.html') return { kind: 'admin-index' };
  const segments = pathOnly.slice(1).split('/');
  if (segments.some((s) => s === '')) return { kind: 'deny', reason: 'empty path segment' };
  if (segments.some((s) => s.startsWith('.'))) return { kind: 'deny', reason: 'dot segment or dotfile' };
  if (PUBLIC_DIRS.includes(segments[0]) && segments.length >= 2) return { kind: 'asset' };
  if (segments.length >= 3 && ADMIN_ASSET_DIRS.includes(segments[0] + '/' + segments[1])) return { kind: 'asset' };
  return { kind: 'other', reason: 'not part of the public frontend' };
}

const isServable = (rawPath) => ['index', 'admin-index', 'asset'].includes(classify(rawPath).kind);

module.exports = { classify, isServable, PUBLIC_DIRS, ADMIN_ASSET_DIRS };
