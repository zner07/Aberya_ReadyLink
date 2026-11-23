'use strict';
/* Server configuration.
- Reads settings from environment variables (optionally filled from server/.env).
- Secrets (the admin password HASH, the session secret, later an AI key) are read from the environment ONLY
     (server/.env). They must never be written in code, in the frontend, or in git.
- Pure Node.js, no extra packages. */
const path = require('node:path');
const { isValidHashFormat } = require('./services/passwordService');

const SERVER_DIR = path.resolve(__dirname, '..');
const NODE_ENVS = ['development', 'test', 'production'];

/* Loads server/.env if it exists. Returns true when a file was loaded, false when there is none.
   Values that are already set in the real environment are NOT overridden. */
function loadEnvFileIfPresent(file = path.join(SERVER_DIR, '.env')) {
  try {
    process.loadEnvFile(file);
    return true;
  } catch (err) {
    if (err && err.code === 'ENOENT') return false;
    throw err;
  }
}

function parsePort(value) {
  if (value === undefined || String(value).trim() === '') return 3000;
  const text = String(value).trim();
  const port = Number(text);
  if (!/^\d+$/.test(text) || !Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error('PORT must be a whole number from 0 to 65535.');
  }
  return port;
}

const isLoopbackHost = (host) => host === '127.0.0.1' || host === 'localhost' || host === '::1';

const DB_DRIVERS = ['auto', 'better-sqlite3', 'node-sqlite'];
const ADMIN_WRITES_MODES = ['auto', 'on', 'off'];
const GEOCODERS = ['photon', 'nominatim', 'off'];
const AI_PROVIDERS = ['gemini', 'off'];
const DEFAULT_GEMINI_MODEL = 'gemini-3.5-flash-lite';
const MB = 1024 * 1024;

/* Admin login settings. Nothing set = admin is NOT set up (the admin API refuses everything, nothing is open by default).
   Some set but not all = a mistake, so the server refuses to start with a message that says what to fix. */
function parseAdminAuth(env) {
  const username = String(env.ADMIN_USERNAME || '').trim();
  const passwordHash = String(env.ADMIN_PASSWORD_HASH || '').trim();
  const sessionSecret = String(env.ADMIN_SESSION_SECRET || '').trim();
  const hoursText = String(env.ADMIN_SESSION_HOURS || '').trim();
  let hours = 8;
  if (hoursText) {
    hours = Number(hoursText);
    if (!/^\d+(\.\d+)?$/.test(hoursText) || hours < 0.25 || hours > 72) throw new Error('ADMIN_SESSION_HOURS must be a number from 0.25 to 72.');
  }
  const anySet = Boolean(username || passwordHash || sessionSecret);
  if (anySet) {
    if (!username || username.length > 100) throw new Error('ADMIN_USERNAME must be set (up to 100 characters). Run:  npm.cmd run admin:setup');
    if (!isValidHashFormat(passwordHash)) throw new Error('ADMIN_PASSWORD_HASH is missing or not a valid hash. It must be made by:  npm.cmd run admin:setup  (never type a plain password there).');
    if (sessionSecret.length < 32) throw new Error('ADMIN_SESSION_SECRET must be at least 32 characters. Run:  npm.cmd run admin:setup');
  }
  return Object.freeze({ configured: anySet, username, passwordHash, sessionSecret, sessionMs: Math.round(hours * 3600 * 1000) });
}

/* Place search (geocoding). Runs through THIS server, never straight from the browser. */
function parseGeocoder(env, nodeEnv) {
  const provider = String(env.GEOCODER || (nodeEnv === 'test' ? 'off' : 'photon')).trim();
  if (!GEOCODERS.includes(provider)) throw new Error(`GEOCODER must be one of: ${GEOCODERS.join(', ')}.`);
  const urlText = String(env.GEOCODER_URL || '').trim();
  let url = null;
  if (urlText) {
    let parsed;
    try {
      parsed = new URL(urlText);
    } catch (err) {
      throw new Error('GEOCODER_URL must be a full web address such as https://photon.komoot.io');
    }
    if (!['https:', 'http:'].includes(parsed.protocol)) throw new Error('GEOCODER_URL must start with https:// (or http:// for a service on your own computer).');
    url = urlText.replace(/\/+$/, '');
  }
  const timeoutText = String(env.GEOCODER_TIMEOUT_MS || '').trim();
  const timeoutMs = timeoutText ? Number(timeoutText) : 5000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 15000) throw new Error('GEOCODER_TIMEOUT_MS must be a whole number from 1000 to 15000.');
  return Object.freeze({ provider, url, contact: String(env.GEOCODER_CONTACT || '').trim().slice(0, 120), timeoutMs });
}

/* AI hazard classification settings. API key is kept in memory on the server only. */
function parseAi(env, nodeEnv) {
  const provider = String(env.AI_PROVIDER || (nodeEnv === 'test' ? 'off' : 'gemini')).trim();
  if (!AI_PROVIDERS.includes(provider)) {
    throw new Error(`AI_PROVIDER must be one of: ${AI_PROVIDERS.join(', ')}.`);
  }

  const apiKey = String(env.GEMINI_API_KEY || '').trim();
  const model = String(env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL).trim();
  if (!/^[A-Za-z0-9._-]{1,80}$/.test(model)) {
    throw new Error('GEMINI_MODEL must be a valid model identifier (letters, numbers, ".", "-" or "_").');
  }

  const timeoutText = String(env.AI_TIMEOUT_MS || '').trim();
  const timeoutMs = timeoutText ? Number(timeoutText) : 8000;
  if (!/^\d+$/.test(timeoutText || '8000') || !Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 30000) {
    throw new Error('AI_TIMEOUT_MS must be a whole number from 1000 to 30000.');
  }

  const enabled = provider === 'gemini' && Boolean(apiKey);
  return Object.freeze({ provider, enabled, apiKey, model, timeoutMs });
}

/* Relative paths in .env are relative to the server/ folder, so the result never depends on where you run the command. */
function resolveInServerDir(value, fallback) {
  return path.resolve(SERVER_DIR, value && String(value).trim() ? String(value).trim() : fallback);
}

function parseMaxPhotoBytes(value) {
  if (value === undefined || String(value).trim() === '') return 5 * MB;
  const text = String(value).trim();
  const n = Number(text);
  if (!/^\d+$/.test(text) || n < 1024 || n > 20 * MB) {
    throw new Error('MAX_PHOTO_BYTES must be a whole number of bytes from 1024 to 20971520 (20 MB).');
  }
  return n;
}

function loadConfig(env = process.env) {
  const nodeEnv = String(env.NODE_ENV || 'development').trim();
  if (!NODE_ENVS.includes(nodeEnv)) {
    throw new Error(`NODE_ENV must be one of: ${NODE_ENVS.join(', ')}.`);
  }
  const host = String(env.HOST || '127.0.0.1').trim();
  const frontendDir = path.resolve(env.FRONTEND_DIR ? String(env.FRONTEND_DIR) : path.join(SERVER_DIR, '..'));

  const dbDriver = String(env.DB_DRIVER || 'auto').trim();
  if (!DB_DRIVERS.includes(dbDriver)) {
    throw new Error(`DB_DRIVER must be one of: ${DB_DRIVERS.join(', ')}.`);
  }
  const dbFileRaw = env.DB_FILE && String(env.DB_FILE).trim();
  const dbFile = dbFileRaw === ':memory:' ? ':memory:' : resolveInServerDir(dbFileRaw, path.join('data', 'readylink.db'));
  const maxPhotoBytes = parseMaxPhotoBytes(env.MAX_PHOTO_BYTES);

  // Admin changes (PATCH /api/reports/:id) need an admin login (ADMIN_* settings) AND this second switch. By default they are
  // only allowed on a server that listens on this computer only and is not in production. 'on' forces them on, 'off' turns them off.
  const adminWritesSetting = String(env.ADMIN_WRITES || 'auto').trim();
  if (!ADMIN_WRITES_MODES.includes(adminWritesSetting)) {
    throw new Error(`ADMIN_WRITES must be one of: ${ADMIN_WRITES_MODES.join(', ')}.`);
  }
  const isLoopbackOnly = isLoopbackHost(host);
  const adminWrites = adminWritesSetting === 'on' ? true : adminWritesSetting === 'off' ? false : isLoopbackOnly && nodeEnv !== 'production';

  const adminAuth = parseAdminAuth(env);
  const geocoder = parseGeocoder(env, nodeEnv);
  const ai = parseAi(env, nodeEnv);

  return Object.freeze({
    nodeEnv,
    isProduction: nodeEnv === 'production',
    port: parsePort(env.PORT),
    host,
    isLoopbackOnly,
    frontendDir,
    dbDriver,
    dbFile,
    uploadsDir: resolveInServerDir(env.UPLOADS_DIR, 'uploads'),
    maxPhotoBytes,
    adminWritesSetting,
    adminWrites,
    adminAuth, // holds the password HASH and the session secret in memory only. Never print or send this object.
    geocoder,
    ai, // holds GEMINI_API_KEY in memory only. Never print or send this object.
    // The photo travels inside a JSON body as base64 text (about 4/3 of the file size), plus the other fields.
    jsonLimitBytes: Math.ceil((maxPhotoBytes * 4) / 3) + 64 * 1024,
  });
}

module.exports = { loadConfig, loadEnvFileIfPresent, SERVER_DIR, DB_DRIVERS, ADMIN_WRITES_MODES, GEOCODERS, AI_PROVIDERS, DEFAULT_GEMINI_MODEL };