'use strict';
/* Catches "forgotten wiring": a page file calls API.something() or ServerAPI.something() and that function does not exist.
   Unit tests that replace a function with a stand-in cannot see this, but a real browser would crash on it. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadFrontend, fakeFetch, reply } = require('../helpers/frontend');
const { FRONTEND_DIR } = require('../helpers/env');

const jsDir = path.join(FRONTEND_DIR, 'js');
const code = (file) => fs.readFileSync(path.join(jsDir, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
const callsOf = (object) => {
  const found = new Map();
  for (const file of fs.readdirSync(jsDir)) {
    for (const m of code(file).matchAll(new RegExp(`\\b${object}\\.([A-Za-z_]\\w*)`, 'g'))) found.set(m[1], [...(found.get(m[1]) || []), file]);
  }
  return found;
};

test('every API.xxx the pages use exists on the API object', () => {
  const fe = loadFrontend({ config: { API_MODE: 'demo' }, fetch: fakeFetch(() => reply(200, {})) });
  const missing = [];
  const assigned = (name) => fs.readdirSync(jsDir).some((f) => new RegExp(`\\bAPI\\.${name}\\s*=[^=]`).test(code(f))); // a property the page code sets itself, like API.lastWarning
  for (const [name, files] of callsOf('API')) if (!(name in fe.API) && !assigned(name)) missing.push(`API.${name} (used in ${[...new Set(files)].join(', ')})`);
  assert.deepEqual(missing, []);
});

test('every ServerAPI.xxx the API layer uses exists on ServerAPI', () => {
  const fe = loadFrontend({ config: { API_MODE: 'demo' }, fetch: fakeFetch(() => reply(200, {})) });
  const missing = [];
  for (const [name, files] of callsOf('ServerAPI')) if (!(name in fe.ServerAPI)) missing.push(`ServerAPI.${name} (used in ${[...new Set(files)].join(', ')})`);
  assert.deepEqual(missing, []);
});

test('the new place-search functions are on API and behave: server mode sends the request, demo mode says it needs the server', async () => {
  const fetch = fakeFetch((c) => reply(200, c.url.includes('reverse') ? { label: 'Hall', lat: 13.78, lng: 121.06, inArea: true } : { results: [{ label: 'Alangilan Hall', lat: 13.78285, lng: 121.06668, inArea: true }, { label: 'broken' }] }));
  const server = loadFrontend({ config: { API_MODE: 'server' }, fetch });
  await server.API.init();
  const results = await server.API.searchPlaces('alangilan hall');
  assert.equal(fetch.calls[0].url, '/api/geocode/search?q=alangilan%20hall');
  assert.deepEqual(JSON.parse(JSON.stringify(results)), [{ label: 'Alangilan Hall', lat: 13.78285, lng: 121.06668, inArea: true }], 'entries without coordinates are dropped');
  assert.equal((await server.API.reversePlace(13.78, 121.06)).label, 'Hall');
  assert.equal(fetch.calls[1].url, '/api/geocode/reverse?lat=13.78&lng=121.06');

  const demoFetch = fakeFetch(() => { throw new Error('demo mode must not use the network'); });
  const demo = loadFrontend({ config: { API_MODE: 'demo' }, fetch: demoFetch });
  await demo.API.init();
  await assert.rejects(() => demo.API.searchPlaces('x'), (e) => /needs the READYLINK server/.test(e.userMessage));
  assert.equal((await demo.API.reversePlace(13.78, 121.06)).label, null);
  assert.equal(demoFetch.calls.length, 0);
});

test('every data-act="..." the pages produce has a handler in events.js', () => {
  const produced = new Set();
  for (const file of fs.readdirSync(jsDir)) for (const m of code(file).matchAll(/data-act=\\?"([a-z0-9-]+)\\?"/g)) produced.add(m[1]);
  const events = code('events.js');
  const missing = [...produced].filter((k) => !new RegExp(`k===['"]${k}['"]`).test(events) && !new RegExp(`['"]${k}['"]`).test(events));
  assert.deepEqual(missing, [], 'buttons that do nothing');
});
