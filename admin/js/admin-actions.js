/* ADMIN ACTIONS (Phase 3): sending an admin change, and loading the reports for the admin pages.

   This file has no DOM code on purpose, so it can be tested without a browser
   (see server/tests/unit/frontendAdmin.test.js). It uses these globals from the other files:
   S (state.js), R and API (api.js), loadReports (api.js), toast (state.js), render (admin-router.js) and goto (state.js).

   In server mode every change needs a signed-in admin. The SERVER checks that on every request (HttpOnly session cookie).
   This page only reacts: when the server says 401, it goes back to the login page. Hiding buttons is not security. */

/* Sends ONE admin change (status, level and/or remark) and brings the screen up to date.
   - One change at a time: while a request is running, more clicks are ignored (S.adminBusy) and the controls are disabled.
   - Demo mode saves in this browser. Server mode saves in the database. Nothing is shown as saved before the server says so.
   - On success the saved report replaces the old one in R, then the whole list is refreshed.
   - On failure the report stays exactly as it was, the server's message is shown, and the remark that was typed is kept. */
async function adminUpdate(id, patch, okMessage) {
  if (S.adminBusy) return { ok: false, busy: true };
  S.adminBusy = true;
  S.remarkDraft = { id, text: patch.remark || '' };
  render(true); // disables the controls while the request runs
  let result;
  try {
    const saved = await API.updateReport(id, patch);
    const i = R.findIndex((x) => x.id === id);
    if (saved && saved.id && i >= 0) R[i] = saved; // show the saved report straight away
    try {
      await loadReports();
      S.reports.loadedAt = Date.now();
    } catch (refreshErr) {
      /* the change IS saved; the full list refreshes the next time the admin pages are opened */
    }
    S.remarkDraft = null;
    toast(okMessage);
    result = { ok: true, report: saved };
  } catch (e) {
    toast((e && e.userMessage) || 'Update failed (demo)');
    if (e && e.status === 401) {
      // The login ended (it expired, the server restarted, or the person signed out elsewhere). Back to the login page.
      S.admin = false;
      S.next = location.hash;
      goto('#/login');
    }
    result = { ok: false, error: e };
  } finally {
    S.adminBusy = false;
    render(true);
  }
  return result;
}

/* Server mode: is the browser still signed in as admin? If not, go to the login page. Demo mode: always true. */
async function ensureAdminSession() {
  if (API.mode !== 'server') return true;
  const ok = await API.refreshAdminSession();
  if (!ok && S.admin) {
    S.admin = false;
    S.next = location.hash;
    toast('Your admin session ended. Please sign in again.');
    goto('#/login');
  }
  return ok;
}

/* Reloads the reports for the admin pages and shows a loading or an error box while it runs (server mode). */
async function loadAdminReports() {
  if (S.reports.state === 'loading') return; // already on its way
  S.reports = { state: 'loading', message: '', loadedAt: S.reports.loadedAt };
  render(true);
  try {
    await loadReports();
    S.reports = { state: 'ready', message: '', loadedAt: Date.now() };
  } catch (e) {
    S.reports = { state: 'error', message: (e && e.userMessage) || 'Something went wrong. Please try again.', loadedAt: S.reports.loadedAt };
  }
  render(true);
}
