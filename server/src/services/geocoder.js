'use strict';
/* Place search ("geocoding") for the report form. It runs on THIS server, not in the browser, so that:
   - the user's address is not sent to a third party from their device (only the typed text is sent, by this server),
   - the public search services' rules can be followed (identifying User-Agent, at most 1 request per second, caching),
   - results are limited to the area around Brgy. Alangilan and every result says whether it is INSIDE the barangay,
   - the provider can be switched or turned off in server/.env without touching the page.

   Providers:  photon (default, made for search-as-you-type)   nominatim (OpenStreetMap; its rules do not allow typeahead)
   Both are free public services that need internet. They have no uptime promise and are meant for light use.
   Nothing is invented: when there is no match the answer is an empty list, and the user picks the spot on the map. */
const { AppError } = require('../middleware/errors');

const DEFAULT_URLS = { photon: 'https://photon.komoot.io', nominatim: 'https://nominatim.openstreetmap.org' };
const MIN_GAP_MS = 1100; // the public services ask for at most one request per second
const CACHE_TTL_MS = 10 * 60 * 1000;
const MAX_CACHE = 200;
const MAX_QUEUE = 3;
const MAX_RESPONSE_CHARS = 500000;
const MAX_RESULTS = 6;
const MARGIN_DEGREES = 0.004; // search a little around the barangay, results are still marked inside / outside
const REVERSE_REACH_DEGREES = 0.03; // reverse lookups are only made close to Alangilan (the proxy is not a general geocoder)
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;

const unavailable = () => new AppError(502, 'GEOCODER_UNAVAILABLE', 'Place search is not available right now. You can choose the location on the map instead.');
const round6 = (n) => Math.round(n * 1e6) / 1e6;
/* A number, or text that is really a number. null, '' and everything else is NaN (Number(null) would wrongly be 0). */
const asNumber = (v) => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN);

function boundaryBox(geo, margin) {
  let minLng = Infinity;
  let minLat = Infinity;
  let maxLng = -Infinity;
  let maxLat = -Infinity;
  for (const [lng, lat] of geo.ring) {
    minLng = Math.min(minLng, lng);
    maxLng = Math.max(maxLng, lng);
    minLat = Math.min(minLat, lat);
    maxLat = Math.max(maxLat, lat);
  }
  return { minLng: minLng - margin, minLat: minLat - margin, maxLng: maxLng + margin, maxLat: maxLat + margin };
}

const query = (params) => new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)])).toString();
const trimLabel = (text) => String(text).replace(CONTROL_CHARS, ' ').replace(/\s+/g, ' ').trim().slice(0, 160);

/* ---- provider adapters: build the request, and turn the answer into [{ label, lat, lng }] ---- */
function photonLabel(raw) {
  const p = raw && typeof raw === 'object' ? raw : {};
  const street = [p.street, p.housenumber].filter(Boolean).join(' ');
  const parts = [p.name, street, p.district || p.suburb, p.city || p.town || p.village || p.county].filter((v) => typeof v === 'string' && v.trim());
  return trimLabel([...new Set(parts)].join(', ')) || 'Unnamed place';
}
const ADAPTERS = {
  photon: {
    searchUrl: (base, q, box) => `${base}/api/?${query({ q, limit: MAX_RESULTS, lang: 'en', bbox: `${box.minLng},${box.minLat},${box.maxLng},${box.maxLat}` })}`,
    reverseUrl: (base, lat, lng) => `${base}/reverse?${query({ lon: lng, lat, limit: 1, lang: 'en' })}`,
    parse: (data) =>
      (Array.isArray(data && data.features) ? data.features : []).map((f) => {
        const c = f && f.geometry && f.geometry.coordinates;
        return { label: photonLabel(f && f.properties), lat: Array.isArray(c) ? asNumber(c[1]) : NaN, lng: Array.isArray(c) ? asNumber(c[0]) : NaN };
      }),
  },
  nominatim: {
    searchUrl: (base, q, box) => `${base}/search?${query({ q, format: 'jsonv2', limit: MAX_RESULTS, viewbox: `${box.minLng},${box.maxLat},${box.maxLng},${box.minLat}`, bounded: 1, countrycodes: 'ph' })}`,
    reverseUrl: (base, lat, lng) => `${base}/reverse?${query({ format: 'jsonv2', lat, lon: lng, zoom: 18 })}`,
    parse: (data) => (Array.isArray(data) ? data : data && data.lat !== undefined ? [data] : []).map((r) => ({ label: trimLabel(r && r.display_name) || 'Unnamed place', lat: asNumber(r && r.lat), lng: asNumber(r && r.lon) })),
  },
};

/* deps: { config, geo, fetchFn, now, sleep }. Tests pass a fake fetchFn, so no test ever touches the internet. */
function createGeocoder({ config, geo, fetchFn = globalThis.fetch, now = Date.now, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }) {
  const cfg = config.geocoder;
  const adapter = ADAPTERS[cfg.provider];
  const enabled = Boolean(adapter) && typeof fetchFn === 'function';
  const base = cfg.url || DEFAULT_URLS[cfg.provider];
  const searchBox = boundaryBox(geo, MARGIN_DEGREES);
  const reverseBox = boundaryBox(geo, REVERSE_REACH_DEGREES);
  const userAgent = `READYLINK/3.5 (student project, Brgy. Alangilan hazard reporting; contact: ${cfg.contact || 'not set'})`;

  const cache = new Map();
  const cacheGet = (key) => {
    const hit = cache.get(key);
    if (!hit) return null;
    if (hit.expires <= now()) {
      cache.delete(key);
      return null;
    }
    return hit.value;
  };
  const cacheSet = (key, value) => {
    if (cache.size >= MAX_CACHE) cache.delete(cache.keys().next().value);
    cache.set(key, { value, expires: now() + CACHE_TTL_MS });
  };

  // One outbound request at a time, at least MIN_GAP_MS apart. A short queue; more than that is "busy".
  let chain = Promise.resolve();
  let lastAt = 0;
  let queued = 0;
  function schedule(task) {
    if (queued >= MAX_QUEUE) return Promise.reject(new AppError(429, 'GEOCODER_BUSY', 'Place search is busy. Try again in a moment.'));
    queued += 1;
    const run = chain.then(async () => {
      const wait = Math.max(0, lastAt + MIN_GAP_MS - now());
      if (wait) await sleep(wait);
      lastAt = now();
      return task();
    });
    chain = run.then(() => {}, () => {});
    return run.finally(() => {
      queued -= 1;
    });
  }

  async function callProvider(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
    try {
      const res = await fetchFn(url, { headers: { 'User-Agent': userAgent, Accept: 'application/json', 'Accept-Language': 'en' }, signal: controller.signal });
      if (!res || !res.ok) throw unavailable();
      const text = await res.text();
      if (text.length > MAX_RESPONSE_CHARS) throw unavailable();
      return JSON.parse(text);
    } catch (err) {
      throw err instanceof AppError ? err : unavailable(); // never pass provider details or errors on to the page
    } finally {
      clearTimeout(timer);
    }
  }

  /* Whatever shape the map service sends, a surprise becomes "not available", never a crash. */
  function parseSafely(data) {
    try {
      return adapter.parse(data).filter((r) => r && typeof r === 'object');
    } catch (err) {
      throw unavailable();
    }
  }

  function toPlace(raw) {
    const lat = asNumber(raw.lat);
    const lng = asNumber(raw.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
    return { label: String(raw.label), lat: round6(lat), lng: round6(lng), inArea: geo.isInsideBoundary(lat, lng) };
  }

  function requireEnabled() {
    if (!enabled) throw new AppError(503, 'GEOCODER_OFF', 'Place search is turned off on this server. Choose the location on the map instead.');
  }

  /* Text -> up to 6 places near Alangilan, each with inArea true/false. An empty list means "no match". */
  async function search(text) {
    requireEnabled();
    const q = typeof text === 'string' ? text.replace(CONTROL_CHARS, ' ').replace(/\s+/g, ' ').trim() : '';
    if (q.length < 3 || q.length > 100) throw new AppError(400, 'VALIDATION', 'Type 3 to 100 characters to search.', { q: 'Type 3 to 100 characters to search.' });
    const key = `s:${q.toLowerCase()}`;
    const cached = cacheGet(key);
    if (cached) return cached;
    const data = await schedule(() => callProvider(adapter.searchUrl(base, q, searchBox)));
    const results = parseSafely(data)
      .map(toPlace)
      .filter(Boolean)
      .slice(0, MAX_RESULTS);
    const value = { results };
    cacheSet(key, value);
    return value;
  }

  /* lat/lng -> a readable name (or null). Only asked for places close to Alangilan. Always answers inArea. */
  async function reverse(lat, lng) {
    requireEnabled();
    if (typeof lat !== 'number' || typeof lng !== 'number' || !Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      throw new AppError(400, 'VALIDATION', 'Send lat and lng as numbers.', { location: 'Send lat and lng as numbers.' });
    }
    const inArea = geo.isInsideBoundary(lat, lng);
    const near = lng >= reverseBox.minLng && lng <= reverseBox.maxLng && lat >= reverseBox.minLat && lat <= reverseBox.maxLat;
    if (!near) return { label: null, lat: round6(lat), lng: round6(lng), inArea: false }; // not asked from the provider at all
    const key = `r:${lat.toFixed(5)},${lng.toFixed(5)}`;
    const cached = cacheGet(key);
    if (cached) return cached;
    const data = await schedule(() => callProvider(adapter.reverseUrl(base, round6(lat), round6(lng))));
    const first = parseSafely(data)[0];
    const value = { label: first && first.label && first.label !== 'Unnamed place' ? String(first.label) : null, lat: round6(lat), lng: round6(lng), inArea };
    cacheSet(key, value);
    return value;
  }

  return { enabled, typeahead: enabled && cfg.provider === 'photon', provider: cfg.provider, search, reverse };
}

module.exports = { createGeocoder, boundaryBox, MIN_GAP_MS, MAX_RESULTS };
