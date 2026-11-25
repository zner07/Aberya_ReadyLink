'use strict';
/* The admin site is a SEPARATE page (admin/index.html, opened at /admin/). The public site (index.html) must not
   contain, load or link to any admin screen. These tests keep it that way, and check that both pages are wired
   correctly (every script exists, no forgotten button handler). */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { FRONTEND_DIR } = require('../helpers/env');

const read = (file) => fs.readFileSync(path.join(FRONTEND_DIR, file), 'utf8');
const exists = (file) => fs.existsSync(path.join(FRONTEND_DIR, file));
const scriptsOf = (page) => [...read(page).matchAll(/<script src="([^"]+)"/g)].map((m) => m[1]);
const stylesOf = (page) => [...read(page).matchAll(/<link rel="stylesheet" href="([^"]+)"/g)].map((m) => m[1]);
const dirOf = (page) => path.posix.dirname(page);
const resolveFrom = (page, ref) => path.posix.normalize(path.posix.join(dirOf(page) === '.' ? '' : dirOf(page), ref));
const code = (file) => read(file).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
const jsFiles = (dir) => fs.readdirSync(path.join(FRONTEND_DIR, dir)).filter((f) => f.endsWith('.js')).map((f) => `${dir}/${f}`);

/* ============================ the PUBLIC site has no admin in it ============================ */

test('the public page loads no admin script and does not mention the admin site', () => {
  for (const src of scriptsOf('index.html')) assert.doesNotMatch(src, /admin/i, src);
  assert.doesNotMatch(read('index.html'), /admin/i);
});

test('no public script has an admin screen, an admin route, or a link to the admin site', () => {
  for (const file of jsFiles('js')) {
    const text = code(file);
    assert.doesNotMatch(text, /#\/admin/, `${file}: no #/admin address`);
    assert.doesNotMatch(text, /href=\\?["'][^"']*\/admin/, `${file}: no link to /admin`);
    assert.doesNotMatch(text, /function (pageLogin|pageOverview|pageReview|admShell|loginShell)\b/, `${file}: no admin screens`);
    assert.doesNotMatch(text, /\badminUpdate\b|\bensureAdminSession\b|\bloadAdminReports\b/, `${file}: no admin actions`);
  }
});

test('the public router and navigation have no admin route and no Admin link', () => {
  assert.doesNotMatch(code('js/router.js'), /admin/i);
  assert.doesNotMatch(read('js/shells.js'), /href="#\/admin|<a [^>]*>[^<]*Admin<\/a>|<span>Admin<\/span>/, 'no Admin link in the navbar or the mobile menu');
});

test('the public site never asks the server about an admin login', () => {
  assert.doesNotMatch(code('js/events.js'), /refreshAdminSession|hasSession|signIn|signOut/);
  assert.doesNotMatch(code('js/router.js'), /refreshAdminSession|hasSession|signIn|signOut/);
});

test('every script of the public page exists on disk', () => {
  for (const src of scriptsOf('index.html')) assert.ok(exists(resolveFrom('index.html', src)), src);
  for (const href of stylesOf('index.html')) assert.ok(exists(resolveFrom('index.html', href)), href);
});

/* ============================ the ADMIN site is its own page ============================ */

test('the admin page exists, is not indexed by search engines, and sets the admin marker before anything else', () => {
  assert.ok(exists('admin/index.html'));
  assert.match(read('admin/index.html'), /<meta name="robots" content="noindex, nofollow">/);
  assert.equal(scriptsOf('admin/index.html')[0], 'js/admin-app.js');
  assert.match(read('admin/js/admin-app.js'), /window\.READYLINK_APP\s*=\s*'admin'/);
});

test('every script and stylesheet of the admin page exists on disk (the page uses relative paths from /admin/)', () => {
  for (const src of scriptsOf('admin/index.html')) assert.ok(exists(resolveFrom('admin/index.html', src)), src);
  for (const href of stylesOf('admin/index.html')) assert.ok(exists(resolveFrom('admin/index.html', href)), href);
});

test('the admin page uses its own router, events and shell and none of the public ones (they define the same function names)', () => {
  const srcs = scriptsOf('admin/index.html');
  for (const publicOnly of ['../js/router.js', '../js/events.js', '../js/shells.js', '../js/exif.js', '../js/location.js']) {
    assert.ok(!srcs.includes(publicOnly), `${publicOnly} must not be loaded on the admin page`);
  }
  for (const own of ['js/admin-shell.js', 'js/pages-admin.js', 'js/admin-router.js', 'js/admin-actions.js', 'js/admin-events.js']) {
    assert.ok(srcs.includes(own), `${own} is loaded on the admin page`);
  }
  // shared code is loaded before the admin code that uses it
  const at = (s) => srcs.indexOf(s);
  for (const shared of ['../js/utils.js', '../js/data.js', '../js/api.js', '../js/state.js', '../js/connection.js', '../js/menu.js', '../js/pages-public.js']) {
    assert.ok(at(shared) >= 0 && at(shared) < at('js/admin-shell.js'), `${shared} comes before the admin scripts`);
  }
  assert.ok(at('js/admin-router.js') < at('js/admin-events.js'), 'boot() in admin-events.js runs after the router exists');
});

test('every data-act the admin pages produce has a handler in admin-events.js (no buttons that do nothing)', () => {
  const produced = new Set();
  for (const file of jsFiles('admin/js')) for (const m of code(file).matchAll(/data-act=\\?"([a-z0-9-]+)\\?"/g)) produced.add(m[1]);
  // the map page is shared code (js/pages-public.js) and is also shown inside the admin site: its buttons need handlers here too
  for (const k of ['view', 'hot', 'clear']) produced.add(k);
  const handlers = code('admin/js/admin-events.js');
  const missing = [...produced].filter((k) => !new RegExp(`k===['"]${k}['"]`).test(handlers) && !new RegExp(`dataset\\.act===['"]${k}['"]`).test(handlers));
  assert.deepEqual(missing, [], 'buttons that do nothing on the admin site');
});

test('admin links use the admin addresses (#/reports, #/report/ID) and never the old #/admin/... ones', () => {
  for (const file of jsFiles('admin/js')) assert.doesNotMatch(code(file), /#\/admin/, file);
  assert.match(read('admin/js/admin-actions.js'), /goto\('#\/login'\)/, 'a 401 sends the admin to the login page');
  assert.match(read('admin/js/admin-events.js'), /goto\('#\/login'\)/, 'sign out lands on the login page');
});

test('the admin sidebar and mobile menu can go back to the public site', () => {
  assert.match(read('admin/js/admin-shell.js'), /href="\.\.\/index\.html"/);
});

/* ============================ shared files stay shared ============================ */

test('the shared theme helpers and the mobile menu code load on both pages', () => {
  assert.match(read('js/state.js'), /function theme\(\)/);
  assert.match(read('js/state.js'), /const themeBtn=/);
  assert.match(read('js/menu.js'), /function closeMenu\(\)/);
  assert.ok(scriptsOf('index.html').includes('js/menu.js'));
  assert.ok(scriptsOf('admin/index.html').includes('../js/menu.js'));
  // admin filters are kept apart from the public map filters
  assert.match(read('js/state.js'), /const F=\(\)=>IS_ADMIN_APP\(\)\?S\.af:S\.pf/);
});
