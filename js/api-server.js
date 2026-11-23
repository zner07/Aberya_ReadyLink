/* SERVER API CLIENT (Phase 2).

   Talks to the READYLINK Express server. js/api.js calls these functions when API.mode is 'server'.
   Everything that touches the network lives here, so the demo code in api.js stays untouched and readable.

   What is connected:                  GET /api/reports, GET /api/reports?mine=1, POST /api/reports (with the photo and location),
                                       PATCH /api/reports/:id (admin review, needs an admin login), /api/admin/* (login, logout, session),
                                       /api/geocode/* (place search for the report form)
   Still demo (later phases):          AI analysis, priority list, the offline queue

   Every request sends the header  X-Client-Id  (an anonymous id made once and kept in localStorage).
   It only LABELS reports as "mine". It is not a password, and nothing secret is stored or sent from the browser.

   Errors are thrown as ApiError. Its  .userMessage  is plain text that is safe to show in a toast or an error box. */
const ServerAPI = (() => {
  const CLIENT_ID_KEY = 'readylink-client-id'; // not under the demo keys, so "Reset demo data" never changes it
  const CLIENT_ID_PATTERN = /^[A-Za-z0-9_-]{16,64}$/; // the same rule the server enforces
  const FIELD_LABELS = { type: 'Hazard type', location: 'Location', desc: 'Description', level: 'Risk level', photo: 'Photo', status: 'Status', remark: 'Remark' };

  class ApiError extends Error {
    constructor(message, { status = 0, code = '', fields = null, userMessage } = {}) {
      super(message);
      this.name = 'ApiError';
      this.status = status; // HTTP status, 0 when the server could not be reached
      this.code = code; // for example VALIDATION, NOT_FOUND
      this.fields = fields; // field-by-field messages for VALIDATION
      this.userMessage = userMessage || message;
    }
  }

  const cfg = () => window.READYLINK_CONFIG || {};
  const base = () => String(cfg().API_BASE || '').replace(/\/+$/, '');

  /* ---- anonymous client id ------------------------------------------------------------------ */
  let memoryId = null; // used when localStorage is blocked (some private modes)
  function newClientId() {
    const c = typeof crypto !== 'undefined' ? crypto : null;
    if (c && typeof c.randomUUID === 'function') return c.randomUUID();
    const bytes = new Uint8Array(16);
    if (c && typeof c.getRandomValues === 'function') c.getRandomValues(bytes);
    else for (let i = 0; i < 16; i += 1) bytes[i] = Math.floor(Math.random() * 256);
    return 'c' + Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  }
  function clientId() {
    try {
      const saved = localStorage.getItem(CLIENT_ID_KEY);
      if (saved && CLIENT_ID_PATTERN.test(saved)) return saved;
      const id = newClientId();
      localStorage.setItem(CLIENT_ID_KEY, id);
      return id;
    } catch (err) {
      if (!memoryId) memoryId = newClientId();
      return memoryId;
    }
  }

  /* ---- friendly messages --------------------------------------------------------------------- */
  const UNREACHABLE = "Can't reach the READYLINK server. Check that it is running, then try again.";
  function friendlyMessage(status, error, what = 'report') {
    if (status === 400 && error && error.code === 'VALIDATION' && error.fields) {
      const parts = Object.entries(error.fields).map(([k, v]) => `${FIELD_LABELS[k] || k}: ${v}`);
      return `Please check the ${what}. ${parts.join(' ')}`;
    }
    if (status === 403 && error && error.code === 'ADMIN_WRITES_DISABLED') return 'Admin changes are turned off on this server.';
    if (status === 403 && error && error.code === 'FORBIDDEN_ORIGIN') return 'The server refused this change because it came from a different address. Open the app from the same address as the server.';
    if (status === 404) return 'The server could not find that report. Refresh the page and try again.';
    if (status === 401) return what === 'sign-in' ? (error && error.message) || 'Incorrect username or password.' : 'Your admin session has ended. Please sign in again.';
    if (status === 503 && error && error.code === 'ADMIN_NOT_CONFIGURED') return 'Admin login is not set up on this server yet.';
    if (status === 413) return 'That report is too large to send. Try a smaller photo.';
    if (status === 503 && error && error.code === 'GEOCODER_OFF') return 'Place search is turned off on this server. Choose the location on the map instead.';
    if (status === 502 && error && error.code === 'GEOCODER_UNAVAILABLE') return 'Place search is not available right now. You can choose the location on the map instead.';
    if (status === 429) return what === 'sign-in' && error && error.message ? error.message : 'Too many requests. Please wait a moment and try again.'; // the login lock says how long to wait
    if (status >= 500) return 'The server had a problem. Please try again in a moment.';
    return (error && error.message) || 'The server did not accept the request.';
  }

  /* ---- one request ---------------------------------------------------------------------------- */
  async function request(method, path, { body, timeoutMs, what } = {}) {
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs || cfg().REQUEST_TIMEOUT_MS || 20000) : null;
    try {
      let res;
      try {
        res = await fetch(base() + path, {
          method,
          headers: { Accept: 'application/json', 'X-Client-Id': clientId(), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
          body: body !== undefined ? JSON.stringify(body) : undefined,
          cache: 'no-store',
          credentials: 'same-origin', // the admin session cookie is HttpOnly: the browser sends it, this code never sees it
          signal: controller ? controller.signal : undefined,
        });
      } catch (err) {
        const timedOut = controller && controller.signal.aborted;
        throw new ApiError('network error', { userMessage: timedOut ? 'The server took too long to answer. Please try again.' : UNREACHABLE });
      }

      let data = null;
      try {
        const text = await res.text();
        if (text) data = JSON.parse(text);
      } catch (err) {
        data = null; // not JSON: handled below
      }

      if (!res.ok) {
        const error = data && data.error ? data.error : null;
        throw new ApiError((error && error.message) || `HTTP ${res.status}`, { status: res.status, code: error ? error.code : '', fields: error ? error.fields : null, userMessage: friendlyMessage(res.status, error, what) });
      }
      if (!data || typeof data !== 'object') {
        throw new ApiError('unexpected answer', { status: res.status, userMessage: 'The server sent an answer the app could not read. Please try again.' });
      }
      return data;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /* ---- server report -> the report object the UI already uses -------------------------------- */
  // The server uses the same field names (id, type, x, y, ai, lv, st, date, desc, brgy, mine, img, log).
  // Only the photo URL needs the API base when the API is not on the same origin.
  // The server always sends every field. These defaults only protect the pages from a damaged or older record,
  // so the screens never print the words "null" or "undefined".
  const toUiReport = (r) => ({
    ...r,
    brgy: r.brgy || 'Brgy. Alangilan',
    date: r.date || 'date unknown',
    desc: typeof r.desc === 'string' ? r.desc : '',
    img: r.img ? base() + r.img : null,
    log: Array.isArray(r.log) ? r.log.map((e) => ({ ...e, t: e.t || 'Update', d: e.d || '' })) : [],
  });

  function reportList(data) {
    if (!Array.isArray(data.reports)) throw new ApiError('unexpected answer', { userMessage: 'The server sent an answer the app could not read. Please try again.' });
    return data.reports.map(toUiReport);
  }

  /* ---- public functions ----------------------------------------------------------------------- */

  /* Is a READYLINK server answering at API_BASE? Never throws. Used by API_MODE 'auto'. */
  let lastHealth = null; // the last answer of /api/health (admin.writes tells whether admin changes are allowed)
  async function probe() {
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), cfg().PROBE_TIMEOUT_MS || 2000) : null;
    try {
      const res = await fetch(base() + '/api/health', { cache: 'no-store', signal: controller ? controller.signal : undefined });
      if (!res.ok) return false;
      const data = await res.json();
      const isReadylink = Boolean(data && data.ok === true && data.service === 'readylink-api');
      if (isReadylink) lastHealth = data;
      return isReadylink;
    } catch (err) {
      return false;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /* GET /api/reports : everything for the public map, newest first. */
  const listReports = async () => reportList(await request('GET', '/api/reports'));

  /* GET /api/reports?mine=1 : only the reports sent from this browser (same X-Client-Id). */
  const listMyReports = async () => reportList(await request('GET', '/api/reports?mine=1'));


  /* POST /api/ai/analyze : ask the server to classify the reported hazard. */
  async function analyzeReport(draft) {
    const body = {
      desc: typeof draft?.desc === 'string' ? draft.desc : ''
    };

    if (typeof draft?.img === 'string' && draft.img) {
      body.photo = draft.img;
    }

    const allowedTypes = ['tree', 'drain', 'road', 'pole', 'flood', 'slope', 'river', 'wall', 'other'];

    if (allowedTypes.includes(draft?.type)) {
      body.selectedType = draft.type;
    }

    const data = await request('POST', '/api/ai/analyze', {
      body,
      what: 'analysis'
    });

    if (!data.analysis || typeof data.analysis !== 'object') {
      throw new ApiError('unexpected answer', {
        userMessage: 'The server sent an assessment the app could not read. Please try again.'
      });
    }

    return data.analysis;
  }


  /* POST /api/reports. The server validates the preliminary assessment and
     receives the selected photo as a data URL when one is available.
     Gemini or the deterministic fallback supplies the preliminary level;
     an admin must verify the report. */
  async function submitReport(draft, analysis) {
  if (
    !analysis ||
    analysis.outcome !== 'hazard_detected' ||
    typeof analysis.type !== 'string' ||
    !['lo', 'mod', 'hi'].includes(analysis.level)
  ) {
    throw new ApiError('invalid assessment', {
      userMessage: 'Only reports with a valid hazard assessment can be submitted.'
    });
  }

  const body = {
    type: analysis.type,
    desc: draft.desc || '',
    assessment: {
      outcome: analysis.outcome,
      level: analysis.level,
      hazardName: analysis.hazardName ?? null,
      reason: analysis.reason,
      source: analysis.source,
      demo: Boolean(analysis.demo)
    }
  };

  if (typeof draft.lat === 'number' && typeof draft.lng === 'number') {
    body.lat = draft.lat;
    body.lng = draft.lng;
  } else {
    body.x = draft.x;
    body.y = draft.y;
  }

  if (draft.img) body.photo = draft.img;

  const data = await request('POST', '/api/reports', { body });

  if (!data.report) {
    throw new ApiError('unexpected answer', {
      userMessage: 'The server sent an answer the app could not read. Please try again.'
    });
  }

  return toUiReport(data.report);
}

  /* PATCH /api/reports/:id : admin review. patch = { status?, level?, remark? }. Empty values are not sent.
     There is NO admin login yet (see server/README.md). Returns the saved report in the format the UI uses. */
  async function updateReport(id, patch) {
    const body = {};
    for (const key of ['status', 'level', 'remark']) {
      if (patch && patch[key] !== undefined && patch[key] !== null && patch[key] !== '') body[key] = patch[key];
    }
    const data = await request('PATCH', `/api/reports/${encodeURIComponent(id)}`, { body, what: 'change' });
    if (!data.report) throw new ApiError('unexpected answer', { userMessage: 'The server sent an answer the app could not read. Please try again.' });
    return toUiReport(data.report);
  }

  /* GET /api/geocode/search?q= : places near Alangilan, each { label, lat, lng, inArea }. An empty list means no match. */
  async function searchPlaces(q) {
    const data = await request('GET', `/api/geocode/search?q=${encodeURIComponent(q)}`, { what: 'search' });
    if (!Array.isArray(data.results)) throw new ApiError('unexpected answer', { userMessage: 'The server sent an answer the app could not read. Please try again.' });
    return data.results.filter((r) => r && typeof r.label === 'string' && Number.isFinite(r.lat) && Number.isFinite(r.lng));
  }

  /* GET /api/geocode/reverse : a readable name for a position, { label|null, lat, lng, inArea }. */
  async function reversePlace(lat, lng) {
    return request('GET', `/api/geocode/reverse?lat=${encodeURIComponent(lat)}&lng=${encodeURIComponent(lng)}`, { what: 'search' });
  }

  /* ---- admin login (the session lives in an HttpOnly cookie; nothing secret is stored in this page) ---- */

  /* GET /api/admin/session : { configured, authenticated, name, writes }. */
  async function adminSession() {
    const d = await request('GET', '/api/admin/session');
    return { configured: Boolean(d.configured), authenticated: Boolean(d.authenticated), name: d.name || null, writes: Boolean(d.writes) };
  }

  /* POST /api/admin/login. Returns { ok: true, name, writes } or { ok: false, status, message }. Only a lost connection throws. */
  async function adminLogin(username, password) {
    try {
      const d = await request('POST', '/api/admin/login', { body: { username, password }, what: 'sign-in' });
      return { ok: true, name: d.admin && d.admin.name, writes: Boolean(d.writes) };
    } catch (err) {
      if (err instanceof ApiError && err.status) return { ok: false, status: err.status, code: err.code, message: err.userMessage };
      throw err;
    }
  }

  /* POST /api/admin/logout : ends the session on the server and clears the cookie. */
  const adminLogout = () => request('POST', '/api/admin/logout', { body: {} });

    return { probe, listReports, listMyReports, analyzeReport, submitReport, updateReport, searchPlaces, reversePlace, adminSession, adminLogin, adminLogout, health: () => lastHealth, clientId, toUiReport, ApiError };
})();