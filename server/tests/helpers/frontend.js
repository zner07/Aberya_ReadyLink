'use strict';
/* Loads the REAL frontend scripts (js/data.js ... js/api.js) into an isolated sandbox, the way a browser does,
   so tests run the actual js/api.js and js/api-server.js code. These files need no DOM, so no browser is required.
   Only the things a browser provides (fetch, localStorage, crypto, timers) are replaced by test doubles. */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { FRONTEND_DIR } = require('./env');

// Same order as in index.html, up to and including api.js. admin-actions.js is part of the separate admin site (admin/js/).
const SCRIPTS = ['js/data.js', 'js/seed-data.js', 'js/demo-insights.js', 'js/map-data.js', 'js/map.js', 'js/config.js', 'js/api-server.js', 'js/api.js', 'js/exif.js', 'js/location.js', 'admin/js/admin-actions.js'];

/* A tiny localStorage / sessionStorage. failing = true makes every call throw (like a blocked browser). */
function fakeStorage({ failing = false } = {}) {
  const data = new Map();
  const guard = () => {
    if (failing) throw new Error('storage is blocked');
  };
  return {
    data,
    getItem: (k) => (guard(), data.has(k) ? data.get(k) : null),
    setItem: (k, v) => (guard(), void data.set(k, String(v))),
    removeItem: (k) => (guard(), void data.delete(k)),
  };
}

/* A fetch double. handler({ url, method, headers, body }) returns a reply() or throws to simulate a network failure.
   It also honors AbortController, like a real fetch. Every call is recorded in fetch.calls. */
function fakeFetch(handler) {
  const calls = [];
  const fetch = (url, opts = {}) =>
    new Promise((resolve, reject) => {
      const call = { url: String(url), method: opts.method || 'GET', headers: { ...(opts.headers || {}) }, body: opts.body, credentials: opts.credentials };
      calls.push(call);
      if (opts.signal) {
        if (opts.signal.aborted) return reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        opts.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      }
      Promise.resolve()
        .then(() => handler(call))
        .then(resolve, reject);
    });
  fetch.calls = calls;
  return fetch;
}

/* An answer like fetch() gives. body can be an object (sent as JSON) or a plain string. */
const reply = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  json: async () => (typeof body === 'string' ? JSON.parse(body) : body),
});
const hang = () => new Promise(() => {}); // never answers (only an abort ends it)

/* Everything that crosses the sandbox boundary is turned into plain data, so deepEqual compares values only. */
const plain = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

function loadFrontend({ config, fetch, localStorage = fakeStorage(), sessionStorage = fakeStorage(), crypto = globalThis.crypto, globals = {} } = {}) {
  const sandbox = {
    console, setTimeout, clearTimeout, AbortController, fetch, localStorage, sessionStorage, crypto,
    guessType: () => 'road', // lives in pages-public.js (needs the DOM); only used when a draft has no sample type
    ...globals, // extra stand-ins, for example S, toast and render for admin/js/admin-actions.js
  };
  sandbox.window = sandbox;
  if (config) sandbox.READYLINK_CONFIG = config;
  vm.createContext(sandbox);
  for (const name of SCRIPTS) {
    const file = path.join(FRONTEND_DIR, ...name.split('/'));
    new vm.Script(fs.readFileSync(file, 'utf8'), { filename: file }).runInContext(sandbox);
  }
  const run = (code) => vm.runInContext(code, sandbox);
  return { sandbox, run, API: run('API'), ServerAPI: run('ServerAPI'), localStorage, sessionStorage, fetch };
}

/* A fetch that remembers cookies, like a browser does, so the real frontend client can sign in during integration tests.
   Only name=value is kept (the attributes HttpOnly, SameSite and so on are the server's business). */
function cookieFetch(realFetch = globalThis.fetch) {
  const jar = new Map();
  const wrapped = async (url, options = {}) => {
    const headers = { ...(options.headers || {}) };
    if (jar.size) headers.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    const res = await realFetch(url, { ...options, headers });
    for (const line of res.headers.getSetCookie ? res.headers.getSetCookie() : []) {
      const [pair, ...attrs] = line.split(';');
      const i = pair.indexOf('=');
      const name = pair.slice(0, i).trim();
      const value = pair.slice(i + 1).trim();
      const gone = /max-age=0/i.test(attrs.join(';')) || value === '';
      if (gone) jar.delete(name);
      else jar.set(name, value);
    }
    return res;
  };
  wrapped.jar = jar;
  return wrapped;
}

/* The real js/exif.js in a sandbox. Returns readPhotoGps(buffer). */
function loadExifReader() {
  const sandbox = { console };
  vm.createContext(sandbox);
  const file = path.join(FRONTEND_DIR, 'js', 'exif.js');
  new vm.Script(fs.readFileSync(file, 'utf8'), { filename: file }).runInContext(sandbox);
  return (buffer) => plain(vm.runInContext('readPhotoGps', sandbox)(buffer));
}

module.exports = { loadFrontend, loadExifReader, fakeStorage, fakeFetch, reply, hang, plain, cookieFetch };
