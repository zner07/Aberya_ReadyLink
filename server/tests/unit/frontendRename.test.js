'use strict';
/* "My reports" is now "Reports". There are no user accounts, so the page lists reports from THIS DEVICE and says so. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { FRONTEND_DIR } = require('../helpers/env');

const read = (file) => fs.readFileSync(path.join(FRONTEND_DIR, file), 'utf8');
const files = ['index.html', ...fs.readdirSync(path.join(FRONTEND_DIR, 'js')).map((f) => `js/${f}`)];
const withoutComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

test('no visible text in the page code still says "My reports"', () => {
  for (const file of files) assert.doesNotMatch(withoutComments(read(file)), /my reports?\b/i, file);
});

test('the main menu and the page heading say "Reports"', () => {
  const shells = read('js/shells.js');
  assert.match(shells, /\['reports','Reports'\]/);
  assert.doesNotMatch(shells, /'My reports'/);
  const pages = read('js/pages-public.js');
  assert.match(pages, /<h1[^>]*>Reports<\/h1>/);
  assert.match(pages, /Reports sent from this device\. There are no accounts/);
  assert.match(pages, /href=\\"#\/reports\\"|href="#\/reports"/);
});

test('the old address #/mine keeps working and the page is also at #/reports', () => {
  const router = read('js/router.js');
  assert.match(router, /if\(p\[0\]==='reports'\)p\[0\]='mine'/);
  assert.match(router, /m\[p\[0\]\]/);
  assert.match(read('js/pages-public.js'), /\^#\\\/\(mine\|reports\)/, 'the reload after loading accepts both addresses');
});

test('report tracking and report ids are untouched', () => {
  const pages = read('js/pages-public.js');
  assert.match(pages, /function pageTrack/);
  assert.match(pages, /#\/track\//);
  assert.match(read('js/api.js'), /RL-/);
});

test('the report-not-found message and breadcrumb use the new name', () => {
  const pages = read('js/pages-public.js');
  assert.match(pages, /Back to Reports/);
  assert.match(pages, /<a href=\\?"#\/reports\\?">Reports<\/a>/);
});
