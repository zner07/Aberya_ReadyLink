# READYLINK server (Phase 3.5: admin login, better report locations)

Node.js + Express backend for READYLINK.

## What works in Phase 1
- A SQLite database for hazard reports, created automatically (`server/data/readylink.db`, never committed).
- Three endpoints: `GET /api/reports`, `GET /api/reports/:id`, `POST /api/reports`.
- Photo upload with real file checks (content, type and size), stored in `server/uploads/` (never committed).
- A repeatable seed that loads the 12 frontend sample reports (`RL-023` to `RL-034`) into the database.
- The existing frontend is still served unchanged by Express.

## What Phase 3.5 adds
1. **Admin login that the SERVER enforces.** A dedicated login page, protected admin pages, a protected `PATCH /api/reports/:id`, logout, no default account. See "Admin login" below.
2. **Show/hide password** on the login page (eye button; works on phones).
3. **Better report locations.** Four ways to say where the hazard is, even if you are somewhere else now: real GPS, tap or drag the pin (or use the arrow keys), search a place or address, or the GPS stored inside the photo (only as a suggestion you must confirm). See "Report locations" below.
4. **"My reports" is now "Reports".** There are no user accounts, so the page says what it really shows: the reports sent from THIS device. (Everyone's reports are on the Risk map.) The old address `#/mine` still works.
5. **No database change.** No new column, no migration. Nothing in your database is reset or deleted. Existing reports, photos, ids, history and statuses are untouched.

## What Phase 3 added (admin review workflow)
Admins can now review reports **and the changes are saved in the database**:
- Change a report's **status** (Pending, Verified, Under monitoring, Resolved), its **risk level**, and add a **remark**.
- Every change adds one entry to the report's history (timeline) with a timestamp. The original "Report submitted" and "AI-assisted assessment" entries are never touched.
- The new status shows everywhere: admin pages, Risk map, Track page and My Reports, also after a page refresh or a server restart.
- Only one change is sent at a time (the controls lock while saving), and a failed change never looks saved. The typed remark is kept so it can be sent again.
- No database change is needed: the existing tables already hold status, level, remarks and history. Nothing in your database is reset or deleted.

### Admin changes need an admin login (Phase 3.5, see below)
Since Phase 3.5, every admin action (status, level, remark) needs a signed-in admin. The old note "there is no admin login yet" no longer applies.

### Statuses (a difference from the original request)
The request listed the order `Pending → Under Monitoring → Verified → Resolved`. The project already uses
**`Pending → Verified → Under monitoring → Resolved`** everywhere (database checks, sample data, progress bars, filters),
with a lowercase "m" in "Under monitoring". To avoid silently changing the data model, **the existing names and order are kept**.
- The server accepts the status in any capital letters (`Under Monitoring` works) and always stores the exact name.
- Any change between the four statuses is allowed (including going back, for example to reopen a report). Moving exactly one step forward gets a milestone text ("Verified by barangay admin", "Placed under monitoring", "Marked as resolved"). Any other change reads "Status changed to ...".
- If the group really wants the other order, it must be changed in one go in the database check, `reportValidation.js`, `js/data.js` (`STS`) and the sample data.

## What Phase 2 added (the frontend is connected)
When the page is served by this server, the frontend **now uses the database**:
- Reports are loaded from `GET /api/reports`. New reports are sent with `POST /api/reports`, including the photo.
- **Reports** (formerly "My reports") loads from `GET /api/reports?mine=1`, using an anonymous id the browser creates once (`X-Client-Id`, kept in localStorage). It shows the reports sent from this device.
- Reports and photos are still there after refreshing the page or restarting the server.
- Loading, error (with Try again) and empty states were added using the existing design.
- Everything else is unchanged. The same files still work as a pure demo on GitHub Pages, VS Code Live Server or a file opened from disk.

### Which data source is used? (`js/config.js`)
| `API_MODE` | Meaning |
|---|---|
| `auto` (default) | Ask `GET /api/health`. If the READYLINK server answers: **server mode**. Otherwise: **demo mode** (original behavior). |
| `server` | Always use the server. If it cannot be reached, an error with a Try again button is shown. Demo data is never used quietly. |
| `demo` | Never contact a server. |

`API_BASE` stays `''` (same origin). CORS is not set up, so the frontend must be served by this server.
In server mode the footer says so, and the "Reset demo data" button is hidden (it must never touch the database).

## What is still demo or not built yet
- **AI assessment** is still the demo/mock result. Its risk level is sent to the server as a suggestion for now.
- **Priority list** is still the hand-written sample list.
- **Admin accounts:** there is one admin login (see "Admin login"). There are no resident accounts, no password reset, no two-factor sign-in, and no record of which admin made a change.
- **Offline sync is basic:** a report saved offline waits in this browser (localStorage) and **Send now** really sends it to the server. There is no IndexedDB and no automatic sending.
- Reports made by other people appear after you reload the page (no live updates).
- Nothing is deployed publicly. The server only listens on this computer.

## Admin login (Phase 3.5)

**How it works**
- There is **no default admin account and no default password**. Until you create one, nobody can sign in and every admin action is refused (the safe default).
- You create the account on the server with one command (below). It saves the username, a **hash** of the password (scrypt, with a random salt) and a long random session secret in `server/.env`. **The password itself is never saved anywhere.**
- Signing in gives the browser a **session cookie** that is `HttpOnly` (the page's JavaScript can never read it), `SameSite=Strict`, limited in time, and `Secure` in production. Nothing secret is kept in the page, in localStorage or in the address.
- The server keeps only a keyed hash of each session token, in memory. **Logout ends the session on the server**, so a copied cookie stops working. Restarting the server signs everyone out.
- **The server checks every admin request.** Hiding the Admin button or the admin pages is not the protection. A visitor who edits the page or calls the API directly is refused with `401`.
- Guessing is slowed down: after 5 wrong tries from one address (or 10 for one username) the login is locked for 15 minutes, even for the right password. The wrong-username and wrong-password messages are the same.
- Extra safety rails that are not the login: requests from other websites are refused (`Origin` check), the body must be JSON, and `ADMIN_WRITES` (below) is a second switch for changes.

**Set it up (once)** in PowerShell, from the `server` folder:
```powershell
npm.cmd run admin:setup
```
It asks for a username and a password (not shown while you type; at least 12 characters), then writes `ADMIN_USERNAME`, `ADMIN_PASSWORD_HASH` and `ADMIN_SESSION_SECRET` into `server/.env`. If `.env` does not exist it is made from `.env.example`. If it exists, a copy is saved as `.env.bak-<time>` first, and your other settings are kept. Then **restart the server** (`Ctrl + C`, `npm.cmd start`). Run the same command again any time to change the password.

**Never** type the hash or the secret by hand, share `server/.env`, paste it in a chat, or commit it. It is already listed in `.gitignore`. Use a different admin password for every deployment. One shared admin account is fine for this project: share the password in person, not in chat, and change it with `admin:setup` when someone leaves.

**Without a server** (a static copy on GitHub Pages, Live Server, a file opened from disk) the admin pages still work **as a simulation for presentations**: any details are accepted and nothing is protected. The login page says so in plain words. A static page has no server, so it cannot protect anything. Do not keep real information there.

**Before putting it on the internet:** use HTTPS in front of the server (the cookie then gets `Secure`), set `NODE_ENV=production`, and set `ADMIN_WRITES=on` on purpose. This project has not had a professional security review.

## Report locations (Phase 3.5)

On the report form, step 2 ("Where is the hazard?") lets the person choose the place where the hazard was photographed, even from somewhere else:

| Way | How it works |
|---|---|
| **Use my current location** | Real GPS from the browser (`navigator.geolocation`). It asks permission only when the button is pressed, reads the position once, and never follows you. A position outside Brgy. Alangilan is not accepted (a message says so and your pin is not touched). Denied, unavailable, timed out and "not supported" each get a plain message. It needs `https://` or `http://localhost`. |
| **Tap or drag the pin** | Tap the map to place the pin, drag it, or press the arrow keys (Shift = bigger steps). The pin cannot leave the barangay. |
| **Search a place or address** | Type at least 3 characters. The page asks THIS server, which asks a free public map service (see below). Results say if they are inside Brgy. Alangilan; outside ones cannot be used. No match means no match: nothing is invented, and the map is always the fallback. |
| **Location stored in the photo (EXIF GPS)** | If the photo you pick has a GPS position, the page tells you ("Photo location detected. Please confirm this location") and shows it as a separate blue pin. **It is only a suggestion.** It is used only if you press "Use this location". It never replaces a location you already chose. Photos without GPS (screenshots, edited or compressed photos) simply upload as normal. |

**One coordinate system.** The page and the server both use the constants in `GEO` (`js/map-data.js`, `server/src/services/geo.js`). The database stores `lat` and `lng`; `x` and `y` (map units) are always calculated from them. The page sends `lat`/`lng`; `x`/`y` still work too (older clients, the offline queue). **The server checks every location again** (valid numbers, on the map, inside the boundary of Brgy. Alangilan), whatever the page said.

**Privacy of photos (EXIF):**
- The GPS inside a photo is read **on the device**, from the original file, only to make the suggestion. Nothing else in the metadata (camera, date, serial number) is read.
- The page shrinks the photo before sending, which already removes all metadata. **The server also removes EXIF/GPS/XMP/IPTC and comments from every photo it stores** (JPEG, PNG, WebP), without re-encoding the picture (the picture data is copied byte for byte). A photo whose structure cannot be read with confidence is refused, because it could not be promised clean.
- Photos served at `/uploads/...` and every API answer are free of EXIF. Photos uploaded before Phase 3.5 were already shrunk by the page, so they have none either; they are not changed.
- HEIC photos (iPhone "high efficiency" format) are not supported by the upload, so their GPS cannot be read.

**Place search and privacy.** The search text is sent from this server to a free public service: **Photon** (`photon.komoot.io`, default, made for search-as-you-type) or **Nominatim** (OpenStreetMap, search only when the Search button is pressed, because its rules forbid typeahead). Those services need internet, have no uptime promise, are meant for light use, and receive what people type. Requests are spaced 1.1 seconds apart, cached, limited to 30 per minute per address, and limited to the area around Alangilan. Turn it off with `GEOCODER=off` (the rest of the form still works). It was tested here with a fake map service only: **the real Photon and Nominatim servers were not contacted**, so check it once on your computer.

## Setup (Windows PowerShell, Node.js 20.12 or newer)
From the project folder:

```powershell
node --version
cd server
npm.cmd install
Copy-Item .env.example .env
npm.cmd run db:init
npm.cmd run seed
npm.cmd run db:list
npm.cmd run test:unit
npm.cmd test
npm.cmd start
```

Then open **http://localhost:3000** (the app, still in demo mode) and **http://localhost:3000/api/reports** (the 12 sample reports as JSON).
Stop the server with `Ctrl + C`. `.env` is optional: without it the defaults are used.

`npm.cmd install` also installs the optional package `better-sqlite3`. If it fails, nothing breaks: see "Database drivers".

## Settings (`server/.env`)
| Name | Default | Meaning |
|---|---|---|
| `PORT` | `3000` | Port (0 to 65535) |
| `HOST` | `127.0.0.1` | `127.0.0.1` = only this computer |
| `NODE_ENV` | `development` | `development`, `test` or `production` |
| `DB_DRIVER` | `auto` | `auto`, `better-sqlite3` or `node-sqlite` |
| `DB_FILE` | `data/readylink.db` | Database file (relative to `server/`), or `:memory:` |
| `UPLOADS_DIR` | `uploads` | Folder for photos (relative to `server/`) |
| `MAX_PHOTO_BYTES` | `5242880` | Largest photo (5 MB). Allowed: 1024 to 20971520 |
| `FRONTEND_DIR` | repository root | Folder with `index.html` |
| `ADMIN_USERNAME`, `ADMIN_PASSWORD_HASH`, `ADMIN_SESSION_SECRET` | (none) | The admin account. **Written by `npm.cmd run admin:setup`. Do not type them by hand.** Empty = admin is not set up (everything admin is refused). Setting only some of them stops the server at start with a message. |
| `ADMIN_SESSION_HOURS` | `8` | How long a login lasts (0.25 to 72). Logout ends it at once. |
| `ADMIN_WRITES` | `auto` | A second switch for admin changes (a login is still needed). `auto` = only on a local-only (`127.0.0.1`), non-production server. `on` = always allowed (use HTTPS). `off` = never. |
| `GEOCODER` | `photon` | Place search: `photon`, `nominatim` or `off`. |
| `GEOCODER_URL`, `GEOCODER_CONTACT`, `GEOCODER_TIMEOUT_MS` | (none), (none), `5000` | Optional: another server address, an email for the map service, and the time limit (1000 to 15000). |

## Database drivers
Both are real SQLite and use the same SQL (`src/schema.sql`):
- **better-sqlite3**: the recommended driver. It has a native part, so installing it can fail on some Windows setups.
- **node-sqlite**: the SQLite built into Node.js 22.5 and newer. No install needed. Node prints an "ExperimentalWarning" when it is used. That is expected.

`DB_DRIVER=auto` uses better-sqlite3 when it works and otherwise falls back to node-sqlite with a clear message in the terminal. The tests run once for every driver that is available on your computer.
Only `src/db.js` talks to a driver. Moving to PostgreSQL later means changing that file and the SQL in `src/services/`.

## Database commands
| Command | What it does |
|---|---|
| `npm.cmd run db:init` | Creates the database and tables if they do not exist. Safe to repeat |
| `npm.cmd run seed` | Adds the frontend sample reports. Skips the ones that already exist, so it is safe to repeat |
| `npm.cmd run db:list` | Prints the newest reports straight from the database file (read only). Use `npm.cmd run db:list -- 20` for more. Handy to confirm that a report really was saved |
| `npm.cmd run seed -- --reset` | Removes ONLY the sample reports, then adds them again. Real reports are never touched. Refused when `NODE_ENV=production` |

The sample data is read from `js/seed-data.js` (it is not copied), so the demo and the database cannot disagree.

## API
All answers are JSON. Errors always look like `{"error":{"code":"VALIDATION","message":"...","fields":{...}}}`.

### The report format (same field names the frontend already uses)
```json
{
  "id": "RL-035", "type": "drain",
  "x": 500, "y": 300, "lat": 13.7851, "lng": 121.0702,
  "ai": "hi", "lv": "hi", "st": "Pending",
  "date": "Oct 12", "createdAt": "2026-10-12T05:00:00.000Z",
  "desc": "Blocked drain near the school.", "brgy": "Brgy. Alangilan",
  "mine": true, "img": "/uploads/3281e664-afc8-4af8-bbda-a7784714bd5d.jpg",
  "log": [ { "t": "Report submitted", "d": "Oct 12, 1:00 PM", "at": "2026-10-12T05:00:00.000Z" } ]
}
```
- `x`, `y` are **SVG map units** (0 to 1000 by 0 to 611), exactly what the frontend draws. They are NOT latitude and longitude. The database stores real `lat`/`lng` and converts with the same constants as `js/map-data.js`.
- `type`: `tree`, `drain`, `road`, `pole`, `flood`, `slope`, `river`, `wall`.
- `ai`, `lv`: `hi`, `mod`, `lo`.
- `st`: `Pending`, `Verified`, `Under monitoring`, `Resolved` (exact spelling).
- `date` and `log[].d` are display text in Manila time. `createdAt` and `log[].at` are ISO 8601 (UTC).
- `img` is a URL path or `null`. `mine` is `true` when the request's `X-Client-Id` matches the report's owner. The client id is never returned.

### `GET /api/reports`
Everything for the public map, newest first (at most 500). Add `?mine=1` (and the `X-Client-Id` header) to get only this device's reports.
Answer: `{ "reports": [ ... ] }`

### `GET /api/reports/RL-023`
Answer: `{ "report": { ... } }`, or `404 NOT_FOUND`.

### `POST /api/reports`
Headers: `Content-Type: application/json` and `X-Client-Id: <16 to 64 letters, numbers, - or _>`.
```json
{ "type": "drain", "x": 500, "y": 300, "desc": "Blocked drain.", "level": "hi",
  "photo": "data:image/jpeg;base64,/9j/4AAQ..." }
```
| Field | Required | Rules |
|---|---|---|
| `type` | yes | One of the 8 keys, exactly |
| `x`, `y` | yes | Numbers. Must be inside the map and inside the Brgy. Alangilan boundary |
| `desc` | no | Up to 240 characters. Empty becomes "No description provided." |
| `level` | no | `hi`, `mod` or `lo` (default `mod`). **Temporary:** trusted from the client until the AI phase |
| `photo` | no | A base64 data URL of a JPEG, PNG or WEBP, up to `MAX_PHOTO_BYTES` |

Anything else (`id`, `status`, `mine`, ...) is ignored: a client cannot choose a report's id or status. New reports are always `Pending`.
Answer: `201 { "report": { ... } }` with a `Location` header.
Errors: `400 VALIDATION` (with `fields`), `400 CLIENT_ID_REQUIRED` / `INVALID_CLIENT_ID`, `400 INVALID_JSON`, `413 PAYLOAD_TOO_LARGE`, `415 UNSUPPORTED_MEDIA_TYPE`.

### `POST /api/admin/login`, `POST /api/admin/logout`, `GET /api/admin/session`
- `POST /api/admin/login` with `{ "username": "...", "password": "..." }` (JSON). `200` sets the session cookie and returns `{ ok, admin: { name }, writes }`. `401 INVALID_CREDENTIALS` (the same text for a wrong username or password), `429 TOO_MANY_ATTEMPTS` (with `Retry-After`), `503 ADMIN_NOT_CONFIGURED`, `400 VALIDATION`, `415` (not JSON), `403 FORBIDDEN_ORIGIN`.
- `POST /api/admin/logout` ends the session and clears the cookie (always `200`).
- `GET /api/admin/session` returns `{ configured, authenticated, name, writes }` and never fails. It is how the page knows whether it is signed in, because the cookie is HttpOnly.

### `GET /api/geocode/search?q=...` and `GET /api/geocode/reverse?lat=...&lng=...`
Public. `search` returns `{ results: [{ label, lat, lng, inArea }] }` (up to 6; empty = no match). `reverse` returns `{ label|null, lat, lng, inArea }` (only asked from the map service for places near Alangilan). Errors: `400 VALIDATION`, `429` (too many / busy), `502 GEOCODER_UNAVAILABLE`, `503 GEOCODER_OFF`. `GET /api/health` shows `geocoder: { enabled, typeahead }` and `admin: { configured, auth, writes }`.

### `POST /api/reports` (location)
Send **either** `lat` and `lng` (degrees) **or** `x` and `y` (map units). If both are sent, `lat`/`lng` win. `lat`/`lng` are rounded to 6 decimals and must be inside Brgy. Alangilan (`400` with `fields.location` otherwise).

### `PATCH /api/reports/RL-026` (admin review, NEEDS AN ADMIN LOGIN)
Body (JSON, **at least one** of the three; an empty remark counts as none):
```json
{ "status": "Verified", "level": "mod", "remark": "Checked on site." }
```
| Field | Allowed values |
|---|---|
| `status` | `Pending`, `Verified`, `Under monitoring`, `Resolved` (capital letters do not matter) |
| `level` | `hi`, `mod`, `lo` (the final risk level; the AI suggestion `ai` is never changed) |
| `remark` | text, at most 500 characters |

Answer `200`: `{ "report": { ...the updated report with its history in "log" }, "changed": { "status": true, "level": false, "remark": true } }`.
Asking for what is already true (same status, same level, the same remark again within 30 seconds) changes nothing and writes no history: `changed` is all `false`. The status change and its history entries are saved together in one transaction.

| Code | When |
|---|---|
| `401 UNAUTHENTICATED` | No valid admin session (checked before anything else, so a visitor learns nothing about the report) |
| `503 ADMIN_NOT_CONFIGURED` | No admin account is set up on this server |
| `400 VALIDATION` | Invalid status or level, remark too long or not text, nothing to change, body not a JSON object (`fields` says which) |
| `400 INVALID_JSON` | The body is not valid JSON |
| `403 ADMIN_WRITES_DISABLED` | Signed in, but admin changes are turned off on this server (`ADMIN_WRITES`) |
| `403 FORBIDDEN_ORIGIN` | The request came from another website |
| `404 NOT_FOUND` | No such report (also for a malformed id) |
| `413 PAYLOAD_TOO_LARGE` | Body over 32 KB |
| `415 UNSUPPORTED_MEDIA_TYPE` | Not `Content-Type: application/json` |

History entries look like `{ "t": "Verified by barangay admin", "d": "Oct 12, 1:00 PM", "at": "2026-10-12T05:00:00.000Z", "n": "Checked on site." }` (`n` only when there is a remark).

### `GET /uploads/<name>`
Serves a photo. Only names made by the server are served (random UUID plus `.jpg`, `.png` or `.webp`). Everything else is a 404.

### Photo safety
The server does not trust the file name, the extension or the declared type. It checks the real bytes (JPEG, PNG or WEBP signature, complete file), compares them with the declared type, enforces the size limit before decoding, and stores the file under a random name. Files are served with a fixed content type, `nosniff` and a restrictive Content-Security-Policy.
Not checked in Phase 1: image dimensions and deep decoding.

### About `X-Client-Id`
An anonymous id the browser creates once and keeps. It only **labels** reports as "mine". It is not a password and does not protect anything, and the id is never returned. Admin changes do not use it at all (they have no login yet).

## Try it from PowerShell
Start the server in one window (`npm.cmd start`), then in another:

```powershell
Invoke-RestMethod http://localhost:3000/api/health
(Invoke-RestMethod http://localhost:3000/api/reports).reports.Count
Invoke-RestMethod http://localhost:3000/api/reports/RL-023

$body = @{ type='drain'; x=500; y=300; desc='Test report'; level='hi' } | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri http://localhost:3000/api/reports -ContentType 'application/json' -Headers @{ 'X-Client-Id'='client-test-1234567890' } -Body $body
```

With a photo (use any small JPG):
```powershell
$b64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes("$HOME\Pictures\test.jpg"))
$body = @{ type='tree'; x=500; y=300; desc='With photo'; photo="data:image/jpeg;base64,$b64" } | ConvertTo-Json
$r = Invoke-RestMethod -Method Post -Uri http://localhost:3000/api/reports -ContentType 'application/json' -Headers @{ 'X-Client-Id'='client-test-1234567890' } -Body $body
$r.report.img            # open http://localhost:3000 + this path in the browser
```

To see an error body (Windows PowerShell 5.1 throws on 400):
```powershell
try { Invoke-RestMethod -Method Post -Uri http://localhost:3000/api/reports -ContentType 'application/json' -Headers @{ 'X-Client-Id'='client-test-1234567890' } -Body (@{ type='bridge' } | ConvertTo-Json) }
catch { $_.ErrorDetails.Message }
```

## Tests
| Command | Needs `npm.cmd install`? | What it checks |
|---|---|---|
| `npm.cmd run test:unit` | No | Settings, path policy, errors, **the real frontend `js/api.js` and `js/api-server.js` run with a fake fetch (what they send, errors, demo mode unchanged)**, map conversion (checked against `js/map-data.js`), photo validation, input validation, the database (every available driver), report logic, seeding vs the frontend sample data, and the HTTP handlers (with fake requests) |
| `npm.cmd run test:integration` | **Yes** | The real Express app over real HTTP: **the real frontend API client against the real server (sending, photos, my reports, restart, errors)**, reports API, photos served safely, restart persistence, private files and server code not exposed, frontend served byte for byte |
| `npm.cmd test` | **Yes** | Both |

The tests use temporary databases and folders. They never touch `server/data` or `server/uploads`.

## Backup before you upgrade (recommended, takes one minute)
Phase 3.5 changes **no** database structure, so nothing needs migrating. Still, make a copy first. With the server stopped, in PowerShell from the `server` folder:
```powershell
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
New-Item -ItemType Directory -Force "..\backup-$stamp" | Out-Null
Copy-Item -Recurse -Force data, uploads "..\backup-$stamp"
if (Test-Path .env) { Copy-Item .env "..\backup-$stamp\.env" }
```
That copies your database (`server\data`), your uploaded photos (`server\uploads`) and your `.env`. To go back, stop the server and copy them back. Keep the backup folder private (it can contain `.env`). Do NOT run `npm.cmd run seed -- --reset` unless you want the 12 sample reports put back to their original state.

## Phase 3.5 checklist: login, locations, photos
Start the server. It prints either `Admin: NOT SET UP` or `Admin: login set up for "<name>"`.

**Admin login**
1. If it says NOT SET UP: run `npm.cmd run admin:setup`, answer the questions, restart the server.
2. The public site has no Admin link. Open http://localhost:3000/admin/ (typing `/admin` also works, it redirects to `/admin/`). You land on **Admin sign in** (the address ends with `#/login`). The boxes are empty and the password is hidden. Also check that http://localhost:3000/ (the public site) shows no Admin link and that `#/admin` there just shows the home page.
3. Type a password and press the **eye** button: the password shows, press again: it hides. What you typed stays. Try it on your phone too.
4. Type a wrong password: you get "Incorrect username or password." Use the right one: you reach the dashboard.
5. As a visitor (private window, not signed in) open `http://localhost:3000/admin/#/reports`: you must be sent to the login page.
6. In the private window open the browser console (F12) and run
   `fetch('/api/reports/RL-026',{method:'PATCH',headers:{'content-type':'application/json'},body:'{"status":"Resolved"}'}).then(r=>r.status)`
   It must print **401**, and the report must not change.
7. Change a status as the admin, then press **Logout**. Open `http://localhost:3000/admin/` again: the login page. Restart the server while signed in and try a change: you are sent back to the login page.

**Locations** (open Report a risk, pick a sample photo, Continue)
8. Tap the map: a pin and its coordinates appear. Drag the pin. Tap far outside the barangay: a message, no pin.
9. Press **Use my current location**. Your browser asks for permission (only now). If you are not in Brgy. Alangilan you get a message and your pin is not moved. Try "Block" too: a plain message.
10. Type `alangilan` in the search box (needs internet): suggestions appear after a short pause. Pick one with the keyboard (arrow down, Enter) or a tap. Search for a place in another city: it is shown as "cannot be used".
11. Choose a photo taken with a phone that had location turned on: **Photo location detected** appears; on step 2 a blue pin shows it. Nothing is chosen until you press **Use this location**. Choose a location first and then add such a photo: your location must not change until you accept.
12. Send the report. In the **Risk map** it appears where you chose. Run `npm.cmd run db:list -- 3`: the row is there. Open the photo's address (`/uploads/...`) and save it: its Properties > Details must show **no GPS and no camera**.
13. Send a report with a **screenshot** or a photo without location: it uploads and sends normally.

**Reports page**
14. The menu says **Reports** (not "My reports"). The page says it lists the reports sent from this device. `#/mine` still opens it. Track a report by its id (for example RL-035): it still works.

## Phase 3 checklist: does the admin review really save?
Start the server (`npm.cmd start`). It prints "Admin: changes ENABLED, but there is NO admin login". Open **http://localhost:3000**.
1. Send a new report from **Report a risk** (with a photo). Note its id, for example `RL-035`.
2. Open **Admin**, sign in with the account you made with `npm.cmd run admin:setup`, then **Reports**, then open that report. You should see its id, category, note, photo, location, date, the status **Pending**, the AI suggestion (marked demo), (and no warning about a missing login).
3. Type a remark, then change the status to **Verified**. A message says the status was updated, the history shows "Verified by barangay admin" with your remark.
4. Press **Start monitoring**, change the **Final risk level**, press **Save remark** with an empty box (it should ask for text), then use **Mark as resolved**.
5. Double-click **Save remark** with some text: only one history entry must be added.
6. In PowerShell (folder `server`) confirm it is in the database:
   ```powershell
   npm.cmd run db:list -- 3
   (Invoke-RestMethod http://localhost:3000/api/reports/RL-035).report.log | Format-Table t, n
   ```
7. Check that every screen agrees: **Risk map** (click the pin), **Track report**, and **Reports** (in the browser that sent it). Refresh the page (F5), then stop and restart the server: everything must still be there.
8. Make it fail on purpose: stop the server (`Ctrl + C`) and change a status. You must see "Can't reach the READYLINK server", the old status must stay, and the remark you typed must still be in the box.
9. Admin changes off: set `ADMIN_WRITES=off` in `server/.env`, restart. The review page says changes are turned off and the controls are disabled. Set it back to `auto` afterwards.
10. Demo mode: open `index.html` from disk (or GitHub Pages). The admin still works in the browser only, with no mention of a server.

## Phase 2 checklist: is the frontend really using the database?
Start the server (`npm.cmd start`), then open **http://localhost:3000** in the browser.
1. Home shows **12 risks reported** and the footer says "Reports are saved in the READYLINK database". There is no "Reset demo data" button.
2. Open Report a risk, send a report (pick a sample photo or upload your own).
3. In a second PowerShell window, from the `server` folder, confirm it is in the database:
   ```powershell
   npm.cmd run db:list -- 3
   (Invoke-RestMethod http://localhost:3000/api/reports).reports.Count
   ```
   Your report must appear (with its `RL-0xx` id and status `Pending`) and the count must be 13.
4. Press F5 to refresh the page. Open Reports: your report is still there. If you uploaded a photo, the photo still shows.
5. Stop the server (`Ctrl + C`), start it again, refresh: still there.
6. Open the site in a private window: Reports is empty (it has its own anonymous id), but the Risk map still shows all reports.
7. Stop the server and refresh the page: you must NOT see a blank page. With `API_MODE: 'server'` you get an error box with Try again. With the default `auto` the page was served by the server, so it needs the server to load at all.
8. To see demo mode again: open `index.html` from disk, or run the page on GitHub Pages. It uses demo data as before.

## Phase 1 checklist (run these on your computer)
1. `npm.cmd install` finishes. Note whether `better-sqlite3` installed (the next commands show the driver name).
2. `npm.cmd run test:unit` shows no failures.
3. `npm.cmd test` shows no failures.
4. `npm.cmd run db:init` prints "Database ready" with a driver name.
5. `npm.cmd run seed` prints "12 added", and running it again prints "0 added, 12 already there".
6. `npm.cmd start`, then open http://localhost:3000/api/reports: 12 reports, `RL-034` first.
7. http://localhost:3000/api/reports/RL-023 shows `"x":355,"y":81`.
8. Create a report with the PowerShell commands above: you get `RL-035` with status `Pending`.
9. Create one with a photo, then open its `img` path in the browser: the same photo shows. A new file appears in `server/uploads/`.
10. Stop the server, start it again: the new reports and photos are still there.
11. Try http://localhost:3000/server/src/db.js, http://localhost:3000/server/package.json and http://localhost:3000/.env: all must be "Not found".
12. http://localhost:3000 still shows the READYLINK app and the demo flow still works.
13. `git status` shows no `.db`, `.db-wal`, `.db-shm`, `.env` or uploaded photos.

## Known limitations
- The photo travels as base64 inside JSON (about 33 percent larger). That is fine for the 80 to 250 KB photos the frontend produces. A file-upload format can replace it later if needed.
- The suggested risk level comes from the client until the AI phase.
- **No admin login** (see above). Admin changes are limited to a local-only server by default. Two admins editing the same report at once: the last change wins, and both are recorded in the history.
- The history does not say who made a change (no admin accounts exist yet, and no personal data is stored).
- The admin pages show the reports as loaded when the page opened. They refresh when you enter the admin area, after you sign in, and with the Refresh button on the Reports page. There are no live updates.
- `GET /api/reports` returns all reports (maximum 500) with no pagination, because the admin dashboard and the map work from the full list.
- The sample reports are not "mine" for any device.
- Sample timeline entries show 12:00 PM, because the demo data only has dates.
- No rate limiting yet (planned for the hardening phase), so do not expose this server to the internet.
- SQLite files do not survive on hosts with temporary disks. A hosted database would be needed for deployment.

## Keeping the original frontend recoverable
```powershell
git tag frontend-demo-v1
git switch -c backend
```
Work on the `backend` branch. `main` (and your GitHub Pages demo) stays as it was. To go back: `git switch main`.

## Safety rules
- Never commit `.env`, `*.db` files or uploaded photos. They are in `.gitignore`. `.env.example` has no secrets.
- Never put secrets in files under `css/`, `js/` or `index.html`. Anything there is public.
- The server only serves `index.html`, `css/`, `js/`, `data/` and `/uploads/<server-made-name>`. It never serves `server/`, `.env`, `.git` or `README.md`.
- GitHub Pages publishes the repository, so the `server/` source code is visible if the repository is public. That is fine as long as no secrets are committed.

## Folder layout
```
server/
  package.json  .env.example
  data/  uploads/            (database and photos; contents are not committed)
  src/
    server.js  app.js  bootstrap.js  config.js  db.js  schema.sql  staticPolicy.js
    middleware/errors.js  adminAuth.js  origin.js
    routes/reports.js  uploads.js  admin.js  geocode.js
    services/geo.js  photoService.js  reportValidation.js  reportService.js  seedService.js
             passwordService.js  adminAuth.js  rateLimiter.js  geocoder.js
    scripts/initDb.js  seed.js  listReports.js  adminSetup.js
  tests/
    helpers/   unit/   integration/
```

Frontend files added in Phase 3.5: `js/exif.js` (reads the GPS position from a photo, no libraries), `js/location.js` (GPS, map pin, place search and the photo suggestion). Changed in Phase 3.5: `js/api-server.js`, `js/api.js`, `js/admin-actions.js`, `js/events.js`, `js/router.js`, `js/pages-admin.js`, `js/pages-public.js`, `js/shells.js`, `js/state.js`, `js/map.js` (an optional second pin and keyboard support for the picking map), `js/utils.js`, `css/styles.css` (new rules added at the end only), `index.html`.

Frontend files added in Phase 3: `js/admin-actions.js` (the admin update flow, kept apart so it can be tested without a browser). Changed in Phase 3: `js/api-server.js`, `js/api.js`, `js/events.js`, `js/router.js`, `js/pages-admin.js`, `js/pages-public.js`, `js/state.js`, `js/utils.js`, `js/data.js`, `js/illustrations.js`, `index.html`.

Frontend files added in Phase 2 (in the project root, not in `server/`):
- `js/config.js`: the settings above
- `js/api-server.js`: the only file that talks to the reports API (anonymous client id, requests, error messages)
- changed: `js/api.js` (server-mode branches, demo code kept), `js/events.js` (start-up loading/error), `js/router.js`, `js/pages-public.js`, `js/pages-admin.js`, `js/connection.js`, `js/shells.js`, `js/state.js`, `index.html`
