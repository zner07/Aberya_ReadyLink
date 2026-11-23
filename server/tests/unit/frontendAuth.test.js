'use strict';
/* The page side of the admin login: signing in and out, noticing that the login ended, and the login page itself.
   The REAL js files run in a sandbox with a fake server. The server side is tested in adminAuth/adminRoutes and the integration tests. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { loadFrontend, fakeStorage, fakeFetch, reply, plain } = require('../helpers/frontend');
const { FRONTEND_DIR } = require('../helpers/env');

const read = (file) => fs.readFileSync(path.join(FRONTEND_DIR, file), 'utf8');
const server = (handler, { mode = 'server', config } = {}) => {
  const toasts = [];
  const gotos = [];
  const S = { admin: false, next: null, adminBusy: false, remarkDraft: null, reports: { state: 'ready', message: '', loadedAt: 0 } };
  const sessionStorage = fakeStorage();
  const localStorage = fakeStorage();
  const fetch = fakeFetch(handler);
  const fe = loadFrontend({ config: { API_MODE: mode, ...(config || {}) }, fetch, localStorage, sessionStorage, globals: { S, toast: (m) => toasts.push(m), goto: (h) => gotos.push(h), render: () => {}, location: { hash: '#/admin/reports' } } });
  return fe.API.init().then(() => Object.assign(fe, { S, toasts, gotos, sessionStorage, localStorage }));
};
const login = (body) => reply(200, body || { ok: true, admin: { name: 'boss' }, writes: true });
const bad = (status, code, message) => reply(status, { error: { code, message } });

test('server mode sign-in: POST /api/admin/login with the username and password, nothing else, same-origin cookies', async () => {
  const fe = await server(() => login());
  const out = await fe.API.signIn('boss', 'my long password');
  assert.deepEqual(plain(out), { ok: true, user: { name: 'boss' } });
  const call = fe.fetch.calls[0];
  assert.equal(call.method, 'POST');
  assert.equal(call.url, '/api/admin/login');
  assert.deepEqual(JSON.parse(call.body), { username: 'boss', password: 'my long password' });
  assert.equal(call.credentials, 'same-origin');
  assert.equal(fe.API.adminInfo.authenticated, true);
});

test('nothing about the login is kept in the page: no password, no token, no "admin" flag in any browser storage', async () => {
  const fe = await server(() => login());
  await fe.API.signIn('boss', 'my long password 123');
  for (const storage of [fe.localStorage, fe.sessionStorage]) {
    const dump = JSON.stringify([...storage.data]);
    assert.ok(!dump.includes('my long password'), 'the password is not stored');
    assert.ok(!/token|session|readylink_admin/i.test(dump.replace(/readylink-client-id|readylink-demo[a-z-]*/g, '')), dump);
  }
  assert.equal(fe.sessionStorage.getItem('readylink-demo-admin'), null, 'server mode never sets the demo sign-in flag');
});

test('sign-in failures give plain messages and ask to clear the password box', async () => {
  const cases = [
    [bad(401, 'INVALID_CREDENTIALS', 'Incorrect username or password.'), /Incorrect username or password\./],
    [bad(429, 'TOO_MANY_ATTEMPTS', 'Too many failed sign-in attempts. Try again in 15 minute(s).'), /Too many failed sign-in attempts/],
    [bad(503, 'ADMIN_NOT_CONFIGURED', 'long'), /Admin login is not set up on this server yet\./],
    [bad(400, 'VALIDATION', 'Enter your username and password.'), /Enter your username and password\./],
  ];
  for (const [answer, pattern] of cases) {
    const fe = await server(() => answer);
    const out = await fe.API.signIn('boss', 'x');
    assert.equal(out.ok, false);
    assert.match(out.message, pattern);
    assert.equal(out.clearPassword, true);
  }
});

test('sign-in when the server cannot be reached: a message, not a crash', async () => {
  const fe = await server(() => { throw new TypeError('fetch failed'); });
  const out = await fe.API.signIn('boss', 'x');
  assert.equal(out.ok, false);
  assert.match(out.message, /Can't reach the READYLINK server/);
});

test('a 401 on a normal request says the session has ended (not "incorrect password")', async () => {
  const fe = await server(() => bad(401, 'UNAUTHENTICATED', 'Sign in as an admin to do this.'));
  await assert.rejects(() => fe.API.updateReport('RL-026', { status: 'Verified' }), (e) => e.status === 401 && /session has ended/.test(e.userMessage));
});

test('refreshAdminSession asks the server (the cookie is HttpOnly, the page cannot see it)', async () => {
  const yes = await server(() => reply(200, { configured: true, authenticated: true, name: 'boss', writes: true }));
  assert.equal(await yes.API.refreshAdminSession(), true);
  assert.equal(yes.fetch.calls[0].url, '/api/admin/session');
  assert.equal(yes.API.adminInfo.name, 'boss');
  const no = await server(() => reply(200, { configured: true, authenticated: false, name: null, writes: true }));
  assert.equal(await no.API.refreshAdminSession(), false);
  const down = await server(() => { throw new TypeError('x'); });
  assert.equal(await down.API.refreshAdminSession(), false, 'when in doubt: not signed in');
  const off = await server(() => reply(200, { configured: false, authenticated: false, name: null, writes: true }));
  assert.equal(await off.API.refreshAdminSession(), false);
  assert.equal(off.API.adminInfo.configured, false);
});

test('sign-out ends the session on the server, and still signs out here if the server cannot be reached', async () => {
  const fe = await server(() => reply(200, { ok: true }));
  await fe.API.signIn('boss', 'x');
  assert.deepEqual(plain(await fe.API.signOut()), { ok: true });
  const call = fe.fetch.calls.find((c) => c.url === '/api/admin/logout');
  assert.equal(call.method, 'POST');
  assert.equal(fe.API.adminInfo.authenticated, false);
  const down = await server(() => { throw new TypeError('x'); });
  const out = await down.API.signOut();
  assert.equal(out.ok, false);
  assert.match(out.message, /signed out here/);
});

test('ensureAdminSession: a signed-in admin passes; when the server says the login ended the page goes to the login page', async () => {
  const fe = await server(() => reply(200, { configured: true, authenticated: false, name: null, writes: true }));
  fe.S.admin = true;
  assert.equal(await fe.run('ensureAdminSession()'), false);
  assert.equal(fe.S.admin, false);
  assert.deepEqual(fe.gotos, ['#/admin/login']);
  assert.equal(fe.S.next, '#/admin/reports', 'it remembers where the admin was going');
  assert.match(fe.toasts[0], /session ended/);

  const ok = await server(() => reply(200, { configured: true, authenticated: true, name: 'boss', writes: true }));
  ok.S.admin = true;
  assert.equal(await ok.run('ensureAdminSession()'), true);
  assert.equal(ok.S.admin, true);
  assert.deepEqual(ok.gotos, []);
});

test('when an admin change is answered with 401 the page signs out and goes to the login page, keeping the typed remark', async () => {
  const fe = await server(() => bad(401, 'UNAUTHENTICATED', 'Sign in as an admin to do this.'));
  fe.S.admin = true;
  const result = await fe.run("adminUpdate('RL-026', { status: 'Verified', remark: 'My careful remark' }, 'ok')");
  assert.equal(result.ok, false);
  assert.equal(fe.S.admin, false);
  assert.deepEqual(fe.gotos, ['#/admin/login']);
  assert.match(fe.toasts[0], /session has ended/);
  assert.deepEqual(plain(fe.S.remarkDraft), { id: 'RL-026', text: 'My careful remark' });
});

test('demo mode (a static copy): sign-in is simulated, needs no network, and is clearly not protection', async () => {
  const fe = await server(() => { throw new Error('demo mode must not use the network'); }, { mode: 'demo' });
  assert.equal((await fe.API.signIn('', '')).ok, false, 'empty details are still refused');
  assert.equal((await fe.API.signIn('anyone', 'anything')).ok, true);
  assert.equal(fe.fetch.calls.length, 0);
  assert.equal(fe.API.hasSession(), true);
  await fe.API.signOut();
  assert.equal(fe.API.hasSession(), false);
  assert.equal(await fe.API.refreshAdminSession(), false);
  assert.equal(await fe.run('ensureAdminSession()'), true, 'demo mode never asks a server');
});

/* ---------------- the login page ---------------- */

function loginPage(mode, adminInfo) {
  const fe = loadFrontend({ config: { API_MODE: mode }, fetch: fakeFetch(() => reply(200, {})), globals: { ic: (n) => `<i class="ic-${n}"></i>`, LOGO: '<svg/>', S: { admin: false } } });
  const script = new vm.Script(read('js/pages-admin.js'), { filename: 'pages-admin.js' });
  script.runInContext(fe.sandbox);
  vm.runInContext(/const esc=[^\n]*\n/.exec(read('js/utils.js'))[0], fe.sandbox);
  vm.runInContext(`API.mode = ${JSON.stringify(mode)}; API.adminInfo = ${JSON.stringify(adminInfo || null)};`, fe.sandbox);
  return vm.runInContext('pageLogin()', fe.sandbox);
}

test('the login page has NO prefilled username or password, and no credentials anywhere in the page code', () => {
  for (const html of [loginPage('server', { configured: true }), loginPage('demo')]) {
    assert.doesNotMatch(html, /value=/, 'no input has a value');
    assert.doesNotMatch(html, /demo-password|admin@barangay/);
  }
  for (const file of fs.readdirSync(path.join(FRONTEND_DIR, 'js'))) assert.doesNotMatch(read(`js/${file}`), /demo-password|admin@barangay\.example/, file);
  assert.doesNotMatch(read('index.html'), /demo-password|admin@barangay/);
});

test('the password box is hidden by default and has an accessible show/hide button next to it', () => {
  const html = loginPage('server', { configured: true });
  assert.match(html, /<input type="password" id="pw"/);
  assert.match(html, /autocomplete="current-password"/);
  assert.match(html, /<button type="button" class="pwtoggle" data-act="togglepw" aria-label="Show password" aria-pressed="false" aria-controls="pw"/);
  assert.match(html, /class="ic-eye"/);
  assert.match(html, /<input type="text" id="em" autocomplete="username"/);
});

test('server mode with no admin set up: the form is disabled and says how to fix it', () => {
  const html = loginPage('server', { configured: false });
  assert.match(html, /Admin login is not set up on this server yet/);
  assert.match(html, /npm\.cmd run admin:setup/);
  assert.equal((html.match(/ disabled>/g) || []).length + (html.match(/ disabled /g) || []).length >= 4, true, 'username, password, toggle and button are disabled');
});

test('demo mode says plainly that sign-in is simulated and protects nothing', () => {
  const html = loginPage('demo');
  assert.match(html, /Demo mode\./);
  assert.match(html, /nothing is protected/);
  assert.doesNotMatch(html, / disabled/);
});

test('server mode with an admin set up shows a clean form with no notice', () => {
  const html = loginPage('server', { configured: true });
  assert.doesNotMatch(html, /class="note"/);
  assert.match(html, /Admin sign in/);
});

/* ---------------- routes ---------------- */

test('the router has a dedicated admin login route and sends every other admin page there when signed out', () => {
  const router = read('js/router.js');
  assert.match(router, /p\[1\]==='login'/);
  assert.match(router, /else if\(!S\.admin\)\{S\.next=hash;goto\('#\/admin\/login'\);return\}/);
  assert.match(router, /if\(S\.admin\)\{goto\('#\/admin'\);return\}/, 'a signed-in admin is not shown the login page');
});

test('the password toggle changes only the input type and never touches the value', () => {
  const code = /if\(k==='togglepw'\)[^\n]*\n[^\n]*\n/.exec(read('js/events.js'));
  assert.ok(code, 'the handler exists');
  assert.doesNotMatch(code[0], /\.value\s*=/, 'it never assigns the value');
  assert.match(code[0], /pw\.type=show\?'text':'password'/);
  assert.match(code[0], /aria-pressed/);
  assert.match(code[0], /Hide password/);
});
