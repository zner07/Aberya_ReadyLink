'use strict';
/* Phase 3 frontend tests. The REAL js/api-server.js, js/api.js, admin/js/admin-actions.js and the helper files run in a
   sandbox with a fake fetch. They check what the admin screen SENDS, what it does when the server says yes or no,
   that it never shows a change as saved before the server confirms it, and that odd reports do not crash it. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { loadFrontend, fakeFetch, reply, hang, plain } = require('../helpers/frontend');
const { FRONTEND_DIR } = require('../helpers/env');

const read = (file) => fs.readFileSync(path.join(FRONTEND_DIR, file), 'utf8');
const serverReport = (over = {}) => ({
  id: 'RL-026', type: 'pole', x: 752, y: 100, lat: 13.78, lng: 121.06, ai: 'hi', lv: 'hi', st: 'Pending', date: 'Sep 30', createdAt: '2026-09-30T04:00:00.000Z',
  desc: 'Pole is cracked.', brgy: 'Brgy. Alangilan', mine: false, img: null, log: [{ t: 'Report submitted', d: 'Sep 30, 12:00 PM', at: '2026-09-30T04:00:00.000Z' }], ...over,
});
const verified = (over = {}) => serverReport({ st: 'Verified', log: [{ t: 'Report submitted', d: 'x', at: 'x' }, { t: 'Verified by barangay admin', d: 'Oct 12, 1:00 PM', at: 'y', n: 'Checked on site.' }], ...over });
const healthy = (admin = { writes: true, auth: 'none' }) => reply(200, { ok: true, service: 'readylink-api', time: 'now', admin });

/* A frontend in server mode with simple stand-ins for the screen (S, toast, render) so the REAL update flow can run. */
function adminFrontend(handler, { config } = {}) {
  const toasts = [];
  const renders = [];
  const S = { adminBusy: false, remarkDraft: null, reports: { state: 'ready', message: '', loadedAt: 0 } };
  const fetch = fakeFetch(handler);
  const fe = loadFrontend({
    config: { API_MODE: 'server', ...(config || {}) },
    fetch,
    globals: { S, toast: (m) => toasts.push(m), render: () => renders.push({ busy: S.adminBusy, draft: S.remarkDraft && { ...S.remarkDraft }, reports: S.reports.state }) },
  });
  return fe.API.init().then(() => Object.assign(fe, { S, toasts, renders }));
}
const patches = (fe) => fe.fetch.calls.filter((c) => c.method === 'PATCH');

/* ============================ the PATCH request ============================ */

test('updateReport sends PATCH /api/reports/:id with the client id and ONLY the fields that have a value', async () => {
  const fe = await adminFrontend(() => reply(200, { report: verified() }));
  await fe.API.updateReport('RL-026', { status: 'Verified', remark: 'Checked on site.', level: 'mod' });
  await fe.API.updateReport('RL-026', { status: 'Verified', remark: '' });
  await fe.API.updateReport('RL-026', { remark: 'Only a remark', status: null, level: undefined });
  const [a, b, c] = patches(fe);
  assert.equal(a.url, '/api/reports/RL-026');
  assert.equal(a.headers['Content-Type'], 'application/json');
  assert.match(a.headers['X-Client-Id'], /^[A-Za-z0-9_-]{16,64}$/);
  assert.deepEqual(JSON.parse(a.body), { status: 'Verified', remark: 'Checked on site.', level: 'mod' });
  assert.deepEqual(JSON.parse(b.body), { status: 'Verified' }, 'an empty remark box is not sent');
  assert.deepEqual(JSON.parse(c.body), { remark: 'Only a remark' });
});

test('updateReport never sends the report id inside the body or any other report data', async () => {
  const fe = await adminFrontend(() => reply(200, { report: verified() }));
  await fe.API.updateReport('RL-026', { status: 'Verified', id: 'RL-999', desc: 'hacked', type: 'tree', x: 1, mine: true });
  assert.deepEqual(Object.keys(JSON.parse(patches(fe)[0].body)), ['status']);
});

test('the report id is encoded in the URL', async () => {
  const fe = await adminFrontend(() => reply(404, { error: { code: 'NOT_FOUND', message: 'No such report.' } }));
  await assert.rejects(() => fe.API.updateReport('RL-1/../x?y', { status: 'Verified' }));
  assert.equal(patches(fe)[0].url, '/api/reports/RL-1%2F..%2Fx%3Fy');
});

test('the saved report is returned in the format the UI uses, with the photo address made complete when needed', async () => {
  const fe = await adminFrontend(() => reply(200, { report: verified({ img: '/uploads/3281e664-afc8-4af8-bbda-a7784714bd5d.jpg' }) }), { config: { API_BASE: 'http://localhost:3000' } });
  const saved = plain(await fe.API.updateReport('RL-026', { status: 'Verified' }));
  assert.equal(saved.st, 'Verified');
  assert.equal(saved.img, 'http://localhost:3000/uploads/3281e664-afc8-4af8-bbda-a7784714bd5d.jpg');
  assert.equal(saved.log[1].n, 'Checked on site.');
});

test('update errors become plain messages: validation, switched off, wrong address, missing report, server trouble, no connection', async () => {
  const cases = [
    ['validation', () => reply(400, { error: { code: 'VALIDATION', message: 'x', fields: { status: 'Use one of: Pending, Verified, Under monitoring, Resolved.' } } }), /Please check the change\. Status: Use one of/],
    ['admin changes off', () => reply(403, { error: { code: 'ADMIN_WRITES_DISABLED', message: 'long text' } }), /Admin changes are turned off on this server/],
    ['other address', () => reply(403, { error: { code: 'FORBIDDEN_ORIGIN', message: 'x' } }), /came from a different address/],
    ['missing report', () => reply(404, { error: { code: 'NOT_FOUND', message: 'No such report.' } }), /could not find that report/],
    ['server error', () => reply(500, { error: { code: 'INTERNAL', message: 'x' } }), /server had a problem/],
    ['not reachable', () => { throw new TypeError('fetch failed'); }, /Can't reach the READYLINK server/],
    ['unreadable answer', () => reply(200, 'oops'), /could not read/],
    ['answer without a report', () => reply(200, {}), /could not read/],
  ];
  for (const [name, handler, expected] of cases) {
    const fe = await adminFrontend(handler);
    await assert.rejects(() => fe.API.updateReport('RL-026', { status: 'Verified' }), (err) => expected.test(err.userMessage) && !/TypeError|fetch failed|<html/.test(err.userMessage), name);
  }
});

test('a server that does not answer is given up on', async () => {
  const fe = await adminFrontend(hang, { config: { REQUEST_TIMEOUT_MS: 30 } });
  await assert.rejects(() => fe.API.updateReport('RL-026', { status: 'Verified' }), (err) => /took too long/.test(err.userMessage));
});

test('API.adminWrites follows /api/health: true, false, or unknown when the answer has no admin information', async () => {
  const bodies = [
    [{ ok: true, service: 'readylink-api', admin: { writes: true, auth: 'none' } }, true],
    [{ ok: true, service: 'readylink-api', admin: { writes: false, auth: 'none' } }, false],
    [{ ok: true, service: 'readylink-api' }, null], // an older server without the admin field
  ];
  for (const [body, expected] of bodies) {
    const fe = loadFrontend({ config: { API_MODE: 'auto' }, fetch: fakeFetch(() => reply(200, body)) });
    await fe.API.init();
    assert.equal(fe.API.mode, 'server');
    assert.equal(fe.API.adminWrites, expected, JSON.stringify(body));
  }
  const forced = loadFrontend({ config: { API_MODE: 'server' }, fetch: fakeFetch(() => healthy()) });
  await forced.API.init();
  assert.equal(forced.API.adminWrites, null, 'unknown when the app was told to use the server without asking');
});

/* ============================ the update flow (admin/js/admin-actions.js) ============================ */

const list = (st = 'Pending') => reply(200, { reports: [serverReport({ st })] });

test('success: the screen locks, one PATCH is sent, the new status shows, the message says so, the controls unlock', async () => {
  const fe = await adminFrontend((c) => (c.method === 'PATCH' ? reply(200, { report: verified() }) : list('Verified')));
  await fe.run('loadReports()'); // the list is loaded before the admin opens a report
  fe.fetch.calls.length = 0;
  const result = await fe.run("adminUpdate('RL-026', { status: 'Verified', remark: 'Checked on site.' }, 'Report verified')");
  assert.equal(result.ok, true);
  assert.deepEqual(fe.fetch.calls.map((c) => `${c.method} ${c.url}`), ['PATCH /api/reports/RL-026', 'GET /api/reports'], 'one change, then one refresh');
  assert.equal(plain(fe.run('R'))[0].st, 'Verified');
  assert.deepEqual(fe.toasts, ['Report verified']);
  assert.equal(fe.S.adminBusy, false);
  assert.equal(fe.S.remarkDraft, null, 'the typed remark is cleared after it was saved');
  assert.equal(fe.renders[0].busy, true, 'the first redraw already has the controls disabled');
  assert.equal(fe.renders[fe.renders.length - 1].busy, false, 'the last redraw enables them again');
});

test('while one change is being saved the screen is locked, and extra clicks are ignored (no duplicate requests)', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const fe = await adminFrontend(async (c) => {
    if (c.method === 'PATCH') {
      await gate;
      return reply(200, { report: verified() });
    }
    return list('Verified');
  });
  const first = fe.run("adminUpdate('RL-026', { status: 'Verified' }, 'Report verified')");
  assert.equal(fe.S.adminBusy, true);
  const second = await fe.run("adminUpdate('RL-026', { status: 'Verified' }, 'Report verified')");
  const third = await fe.run("adminUpdate('RL-026', { status: 'Resolved' }, 'Marked as resolved')");
  assert.deepEqual([second, third].map((r) => plain(r)), [{ ok: false, busy: true }, { ok: false, busy: true }]);
  assert.equal(patches(fe).length, 1, 'only ONE request reached the server');
  release();
  assert.equal((await first).ok, true);
  assert.equal(fe.S.adminBusy, false);
  assert.deepEqual(fe.toasts, ['Report verified'], 'one message only');
});

test('failure: nothing is shown as saved, the old status stays, the server\'s message is shown, and the typed remark is kept', async () => {
  const fe = await adminFrontend((c) => (c.method === 'PATCH' ? reply(500, { error: { code: 'INTERNAL', message: 'x' } }) : list('Pending')));
  await fe.run('loadReports()');
  fe.fetch.calls.length = 0;
  const result = await fe.run("adminUpdate('RL-026', { status: 'Verified', remark: 'My long remark' }, 'Report verified')");
  assert.equal(result.ok, false);
  assert.equal(plain(fe.run('R'))[0].st, 'Pending', 'the report is exactly as it was');
  assert.deepEqual(fe.toasts, ['The server had a problem. Please try again in a moment.']);
  assert.ok(!fe.toasts.includes('Report verified'), 'a failed change is never reported as saved');
  assert.deepEqual(plain(fe.S.remarkDraft), { id: 'RL-026', text: 'My long remark' }, 'the typed remark is still there to try again');
  assert.equal(fe.S.adminBusy, false, 'the controls are usable again');
  assert.deepEqual(fe.fetch.calls.map((c) => c.method), ['PATCH'], 'no refresh after a failure');
});

test('every kind of failure leaves the screen usable: validation, switched off, no connection, missing report', async () => {
  const cases = [
    [() => reply(400, { error: { code: 'VALIDATION', fields: { status: 'bad' } } }), /Please check the change/],
    [() => reply(403, { error: { code: 'ADMIN_WRITES_DISABLED', message: 'x' } }), /turned off/],
    [() => { throw new TypeError('fetch failed'); }, /Can't reach/],
    [() => reply(404, { error: { code: 'NOT_FOUND', message: 'x' } }), /could not find/],
  ];
  for (const [handler, expected] of cases) {
    const fe = await adminFrontend(handler);
    const result = await fe.run("adminUpdate('RL-026', { status: 'Verified' }, 'ok')");
    assert.equal(result.ok, false);
    assert.match(fe.toasts[0], expected);
    assert.equal(fe.S.adminBusy, false);
    assert.equal(fe.renders[fe.renders.length - 1].busy, false);
  }
});

test('after a failure the admin can simply try again and it works', async () => {
  let attempts = 0;
  const fe = await adminFrontend((c) => {
    if (c.method !== 'PATCH') return list('Verified');
    return ++attempts === 1 ? reply(500, { error: { code: 'INTERNAL', message: 'x' } }) : reply(200, { report: verified() });
  });
  await fe.run('loadReports()');
  assert.equal((await fe.run("adminUpdate('RL-026', { status: 'Verified' }, 'Report verified')")).ok, false);
  assert.equal((await fe.run("adminUpdate('RL-026', { status: 'Verified' }, 'Report verified')")).ok, true);
  assert.equal(plain(fe.run('R'))[0].st, 'Verified');
  assert.equal(fe.S.remarkDraft, null);
});

test('the change is saved but refreshing the list fails: still a success, and the saved report is shown', async () => {
  const fe = await adminFrontend((c) => {
    if (c.method === 'PATCH') return reply(200, { report: verified() });
    throw new TypeError('fetch failed');
  });
  fe.run('R').push(serverReport()); // the list that was loaded earlier
  const result = await fe.run("adminUpdate('RL-026', { status: 'Verified' }, 'Report verified')");
  assert.equal(result.ok, true);
  assert.equal(plain(fe.run('R'))[0].st, 'Verified', 'the answer of the server is used even though the full refresh failed');
  assert.deepEqual(fe.toasts, ['Report verified']);
});

test('the status shown comes from the server\'s answer, not from what the admin asked for (even when the list refresh fails)', async () => {
  // the server decides: the admin asked for Resolved, the answer says Verified. The refresh fails, so ONLY the answer can be shown.
  const fe = await adminFrontend((c) => {
    if (c.method === 'PATCH') return reply(200, { report: verified() });
    throw new TypeError('fetch failed');
  });
  fe.run('R').push(serverReport());
  const result = await fe.run("adminUpdate('RL-026', { status: 'Resolved' }, 'Marked as resolved')");
  assert.equal(result.ok, true);
  assert.equal(plain(fe.run('R'))[0].st, 'Verified', 'what the server confirmed, never what was asked');
});

test('demo mode: the same flow saves in this browser, uses no network, and still works', async () => {
  const toasts = [];
  const S = { adminBusy: false, remarkDraft: null, reports: { state: 'ready', message: '', loadedAt: 0 } };
  const fetch = fakeFetch(() => { throw new Error('demo mode must not use the network'); });
  const fe = loadFrontend({ config: { API_MODE: 'demo' }, fetch, globals: { S, toast: (m) => toasts.push(m), render: () => {} } });
  await fe.API.init();
  await fe.run('loadReports()');
  const result = await fe.run("adminUpdate('RL-026', { status: 'Verified' }, 'Report verified')");
  assert.equal(result.ok, true);
  assert.equal(plain(fe.run('R')).find((r) => r.id === 'RL-026').st, 'Verified');
  assert.deepEqual(toasts, ['Report verified']);
  assert.equal(fetch.calls.length, 0);
});

/* ============================ loading the reports for the admin pages ============================ */

test('loadAdminReports: loading, then ready; the screen is redrawn in both states', async () => {
  const fe = await adminFrontend(() => reply(200, { reports: [serverReport(), serverReport({ id: 'RL-027' })] }));
  await fe.run('loadAdminReports()');
  assert.deepEqual(fe.renders.map((r) => r.reports), ['loading', 'ready']);
  assert.equal(fe.S.reports.state, 'ready');
  assert.ok(fe.S.reports.loadedAt > 0);
  assert.equal(plain(fe.run('R')).length, 2);
});

test('loadAdminReports: an error is shown with a readable message, and trying again works', async () => {
  let up = false;
  const fe = await adminFrontend(() => { if (!up) throw new TypeError('fetch failed'); return reply(200, { reports: [serverReport()] }); });
  await fe.run('loadAdminReports()');
  assert.equal(fe.S.reports.state, 'error');
  assert.match(fe.S.reports.message, /Can't reach the READYLINK server/);
  up = true;
  await fe.run('loadAdminReports()');
  assert.equal(fe.S.reports.state, 'ready');
  assert.equal(plain(fe.run('R')).length, 1);
});

test('loadAdminReports does not start a second load while one is already running', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const fe = await adminFrontend(async () => { await gate; return reply(200, { reports: [serverReport()] }); });
  const first = fe.run('loadAdminReports()');
  await fe.run('loadAdminReports()'); // returns straight away
  assert.equal(fe.fetch.calls.length, 1, 'only one request');
  release();
  await first;
  assert.equal(fe.S.reports.state, 'ready');
});

test('an empty database is a normal "ready" state, not an error', async () => {
  const fe = await adminFrontend(() => reply(200, { reports: [] }));
  await fe.run('loadAdminReports()');
  assert.equal(fe.S.reports.state, 'ready');
  assert.deepEqual(plain(fe.run('R')), []);
});

/* ============================ odd reports must not crash the screens ============================ */

test('a report with an unknown type, missing text, bad position or unknown status is handled safely', async () => {
  const fe = await adminFrontend(() => reply(200, { reports: [] }));
  const lineOf = (file, re) => re.exec(read(file))[0];
  const evalIn = (code) => vm.runInContext(code, fe.sandbox);
  evalIn(lineOf('js/utils.js', /const esc=[^\n]*\n/)); // esc(), the one place all text goes through
  evalIn(lineOf('js/state.js', /const lvB=[^\n]*\n/));
  const weird = { id: 'RL-077', type: 'alien', x: null, y: undefined, st: '???', lv: 'urgent', desc: null, log: undefined, img: null };
  assert.equal(evalIn(`title(${JSON.stringify(weird)})`), 'Hazard report');
  assert.equal(evalIn(`cat(${JSON.stringify(weird)})`), 'Other');
  assert.match(evalIn(`aiReason(${JSON.stringify(weird)})`), /No suggestion is available/);
  assert.equal(evalIn(`si(${JSON.stringify(weird)})`), 0, 'an unknown status counts as the first step, not as -1');
  assert.equal(evalIn(`plottable(${JSON.stringify(weird)})`), false);
  assert.equal(evalIn('esc(null)'), '');
  assert.equal(evalIn('esc(undefined)'), '');
  assert.equal(evalIn("esc('<b>&\"')"), '&lt;b&gt;&amp;&quot;', 'normal text is still escaped');
  assert.match(evalIn("lvB('urgent')"), /Unknown/);
  assert.match(evalIn("lvB('hi')"), /class="lv hi">High/);
});

test('plottable accepts real positions and rejects missing, text or not-a-number positions', async () => {
  const fe = await adminFrontend(() => reply(200, { reports: [] }));
  const check = (r) => vm.runInContext(`plottable(${JSON.stringify(r)})`, fe.sandbox);
  assert.equal(check({ x: 500, y: 300 }), true);
  assert.equal(check({ x: 0, y: 0 }), true);
  for (const bad of [{}, { x: 1 }, { x: '5', y: '6' }, { x: null, y: null }]) assert.equal(check(bad), false, JSON.stringify(bad));
});

test('the sample illustration step does not crash on an unknown hazard type or a missing photo', async () => {
  const fe = await adminFrontend(() => reply(200, { reports: [] }));
  new vm.Script(read('js/illustrations.js'), { filename: 'illustrations.js' }).runInContext(fe.sandbox);
  const html = vm.runInContext(`photo(${JSON.stringify({ type: 'alien', img: null })})`, fe.sandbox);
  assert.match(html, /No picture/);
  assert.match(vm.runInContext(`photo(${JSON.stringify({ type: 'drain', img: null })})`, fe.sandbox), /<svg/, 'a known type still shows its illustration');
  assert.match(vm.runInContext(`photo(${JSON.stringify({ type: 'alien', img: '/uploads/x.jpg' })})`, fe.sandbox), /<img src="\/uploads\/x\.jpg"/, 'a real photo is always shown');
});

test('the server client copes with a report that has missing fields (no "null" or "undefined" reaches the screen)', async () => {
  const fe = await adminFrontend(() => reply(200, { reports: [{ id: 'RL-001' }, { id: 'RL-002', log: null, img: undefined, desc: null, brgy: null, date: null }, { id: 'RL-003', log: [{ t: 'Only a title' }, {}] }] }));
  const reports = plain(await fe.API.listReports());
  assert.deepEqual(reports.map((r) => r.id), ['RL-001', 'RL-002', 'RL-003']);
  assert.deepEqual(reports.slice(0, 2).map((r) => r.log), [[], []]);
  assert.deepEqual(reports.map((r) => r.img), [null, null, null]);
  assert.deepEqual(reports.map((r) => r.desc), ['', '', '']);
  assert.deepEqual(reports.map((r) => r.brgy), ['Brgy. Alangilan', 'Brgy. Alangilan', 'Brgy. Alangilan']);
  assert.deepEqual(reports.map((r) => r.date), ['date unknown', 'date unknown', 'date unknown']);
  assert.deepEqual(reports[2].log, [{ t: 'Only a title', d: '' }, { t: 'Update', d: '' }]);
  for (const r of reports) {
    for (const field of ['brgy', 'date', 'desc']) assert.equal(typeof r[field], 'string', `${r.id}.${field} is text, never null`);
    for (const e of r.log) assert.ok(typeof e.t === 'string' && typeof e.d === 'string', 'timeline entries are text');
  }
});

/* ============================ wiring ============================ */

test('on the admin page admin-actions.js is loaded after the admin router and before the admin events, and admin-events.js does not define adminUpdate', () => {
  const html = read('admin/index.html');
  const srcs = [...html.matchAll(/<script src="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(srcs.indexOf('js/admin-actions.js') > srcs.indexOf('js/admin-router.js'));
  assert.ok(srcs.indexOf('js/admin-actions.js') < srcs.indexOf('js/admin-events.js'));
  assert.doesNotMatch(read('admin/js/admin-events.js'), /async function adminUpdate\(/);
  assert.match(read('admin/js/admin-actions.js'), /async function adminUpdate\(/);
  assert.doesNotMatch(read('admin/js/admin-actions.js'), /document\.|window\.|localStorage/, 'no browser code in this file, so it can be tested');
});

test('the review page no longer claims there is no login; it only says so when the server has turned admin changes off, and it locks while saving', () => {
  const admin = read('admin/js/pages-admin.js');
  assert.doesNotMatch(admin, /no admin login yet/i, 'the Phase 3 warning is gone now that a login exists');
  assert.match(admin, /Admin changes are turned off on this server\./);
  assert.match(admin, /API\.adminWrites!==false\)return ''/);
  assert.match(admin, /const busy=S\.adminBusy/);
  assert.match(admin, /\$\{lock\}/);
  assert.match(admin, /data-act="refresh-admin"/);
});
