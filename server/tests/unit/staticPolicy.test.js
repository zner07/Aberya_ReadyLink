'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { classify, isServable } = require('../../src/staticPolicy');

test('the page itself is served', () => {
  for (const p of ['/', '/index.html', '/?x=1', '/index.html?v=2', '/#/map']) {
    assert.equal(classify(p).kind, 'index', p);
  }
});

test('the existing frontend assets are served (css, js, data)', () => {
  const files = [
    '/css/tokens.css', '/css/styles.css',
    '/js/utils.js', '/js/api.js', '/js/map-data.js', '/js/pages-public.js', '/js/events.js',
    '/data/alangilan.geojson', '/data/alangilan-features.geojson',
    '/js/api.js?v=2',
  ];
  for (const p of files) assert.equal(classify(p).kind, 'asset', p);
});

test('server code, secrets, git data and project files are NOT served', () => {
  const notFrontend = [
    '/server/package.json', '/server/src/app.js', '/server/.env', '/server/.env.example',
    '/.env', '/.git/config', '/.gitignore', '/README.md', '/tests/x.js', '/docs/API.md',
    '/node_modules/express/package.json', '/uploads/photo.jpg', '/favicon.ico',
    '/server/data/readylink.db', '/server/data/readylink.db-wal', '/server/uploads/photo.jpg', '/server/src/db.js', '/server/src/schema.sql', '/server/tests/helpers/images.js',
  ];
  for (const p of notFrontend) assert.equal(isServable(p), false, p);
});

test('path traversal tricks are rejected before touching the file system', () => {
  const tricks = [
    '/css/../server/package.json',
    '/js/../../etc/passwd',
    '/css/%2e%2e/server/package.json',
    '/css/%2E%2E/server/package.json',
    '/js/..%2fserver%2fpackage.json',
    '/js/..%2Fserver%2Fpackage.json',
    '/js/%2e%2e%2fserver%2fpackage.json',
    '/css\\..\\server\\package.json',
    '/js/..%5cserver%5cpackage.json',
    '/js/api.js%00.png',
    '/js/api.js\0',
    '/js//api.js',
    '//js/api.js',
    '/js/./api.js',
  ];
  for (const p of tricks) {
    assert.equal(isServable(p), false, p);
    assert.equal(classify(p).kind, 'deny', p);
  }
});

test('dotfiles and hidden folders inside the public folders are rejected', () => {
  for (const p of ['/css/.hidden', '/js/.env', '/data/.git/config', '/js/sub/.secret.js']) {
    assert.equal(classify(p).kind, 'deny', p);
  }
});

test('directories (no file name) are not served', () => {
  for (const p of ['/css', '/js', '/data', '/css/', '/js/']) {
    assert.equal(isServable(p), false, p);
  }
});

test('malformed input is rejected', () => {
  for (const p of ['', 'index.html', 'js/api.js', null, undefined, 42, {}]) {
    assert.equal(classify(p).kind, 'deny', String(p));
  }
});

test('a normal percent-encoded file name is still allowed to reach express.static', () => {
  assert.equal(classify('/js/my%20file.js').kind, 'asset');
});

/* ---- the separate admin site ---- */

test('the admin page, its redirect and its scripts are recognised', () => {
  assert.equal(classify('/admin').kind, 'admin-redirect');
  assert.equal(classify('/admin?x=1').kind, 'admin-redirect');
  for (const p of ['/admin/', '/admin/index.html', '/admin/?x=1', '/admin/index.html?v=2']) assert.equal(classify(p).kind, 'admin-index', p);
  for (const p of ['/admin/js/admin-app.js', '/admin/js/pages-admin.js', '/admin/js/admin-router.js?v=2']) assert.equal(classify(p).kind, 'asset', p);
  assert.equal(isServable('/admin/'), true);
  assert.equal(isServable('/admin'), false, 'the bare address is only a redirect');
});

test('nothing else under /admin is served, and the usual path tricks are still refused there', () => {
  for (const p of ['/admin/js', '/admin/js/', '/admin/css/x.css', '/admin/server/package.json', '/admin/index.htm', '/admin/other.html', '/ADMIN/', '/Admin']) {
    assert.equal(isServable(p), false, p);
    assert.notEqual(classify(p).kind, 'admin-index', p);
  }
  for (const p of ['/admin//index.html', '/admin/js//x.js', '/admin/js/.env', '/admin/js/../../server/package.json', '/admin/%2e%2e/server/package.json',
    '/admin/js/..%2fserver%2fpackage.json', '/admin\\js\\x.js', '/admin/js/x.js%00.png', '/admin/./js/x.js']) {
    assert.equal(classify(p).kind, 'deny', p);
  }
});
