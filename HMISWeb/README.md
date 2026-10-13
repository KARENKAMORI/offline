# HMISWeb

Offline-first patient registration and visit recording that syncs with the HMIS server (`../HMIS`).

Every screen reads and writes IndexedDB in the browser, so the app works with no network once it has been loaded. Sync runs in the background whenever the server is reachable. The service worker caches the app itself, so it also reloads offline.

## Design

The screens follow the FieldVisit design of the Flutter app in `../HMISMobile`:

- Colours, corner radii and type sizes come from `HMISMobile/lib/ui/theme.dart` and live as CSS variables in `src/styles.scss`.
- The same four tabs (Visits, Patients, Sync, Profile) sit along the bottom on phones and become a side rail from 900px wide.
- Shared pieces mirror `HMISMobile/lib/ui/widgets.dart` and live in `src/app/shared/ui/`: the white app bar with the Online/Offline/Syncing pill, record cards, avatars, the Synced/Waiting badge, tags, empty states and bottom sheets.
- Icons come from `lucide-angular` and are bundled, so they work offline.

When a screen changes in the mobile app, change the matching file under `src/app/features/` the same way.

## How data is stored

Each patient is one [Automerge](https://automerge.org) document, the same shape the server uses (`HMIS/patients/crdt.py`):

```
{ patient: { name, phone, status, location, head_of_household, registered_at },
  visits:  { "<visit uuid>": { visit_type, timestamp, reason,
                               temperature_c, pulse_bpm, systolic_mmhg, diastolic_mmhg,
                               respiratory_rate, spo2_pct, weight_kg, deleted_at } } }
```

The full contract, shared with the server and the Flutter app, is in
[`HMIS/DOCUMENT_SCHEMA.md`](../HMIS/DOCUMENT_SCHEMA.md). In short: every value is a string
(`ImmutableString`), vitals are decimal strings such as `"38.4"`, and `""` (or a missing key, in
documents written before these fields existed) means "not recorded". Vitals are flat keys on the
visit rather than a nested map, because two devices creating the same nested map offline would
lose one device's readings. The ranges the server accepts are in `VITAL_FIELDS`
(`src/app/core/db/models.ts`), which the visit form also uses for validation.

IndexedDB (Dexie, `src/app/core/db/hmis-db.ts`) holds:

| Store      | Purpose                                                                  |
| ---------- | ------------------------------------------------------------------------ |
| `docs`     | Automerge document bytes per patient. The source of truth.               |
| `patients`, `visits` | Read model rebuilt from each document after every change. Screens query these. |
| `dirty`    | Patients changed on this device and not yet received by the server.      |
| `problems` | Values the server could not save (for example an invalid status).        |
| `meta`     | Manifest cursor (`since`), last successful sync time, this device's id and name. |

All writes go through `DocStore`, which updates the document, the read model and the `dirty` flag in one transaction.

Two devices can edit the same patient offline. Edits to different fields both survive, the same field resolves to one value on every device, and visits never collide because they are keyed by UUID.

Patients cannot be deleted: the server keeps every record, so set a patient's status to `inactive` or `suspended` instead. A visit stays with the patient it was recorded for.

Visits are soft-deleted. Deleting one sets its `deleted_at` to the current time and lists hide it; the visit stays in the document and on the server, and opening it again offers **Restore visit**, which sets `deleted_at` back to `""`. Removing the key from the map instead would silently discard an edit another device made to that visit while offline.

Every change is committed with a JSON message naming this browser and what changed, for example `{"device_id": "...", "device_name": "Web browser", "kind": "visit.create", "summary": "Visit: Grace Njeri"}`. The device id is generated once and kept in the `meta` table (`deviceId`, `deviceName`). Other devices use it to show who made a change, such as when one edit replaced another.

## How sync works

`SyncService` (`src/app/core/sync/sync.service.ts`) follows `HMIS/benchmarks/client/device.mjs`:

1. `GET /api/sync/manifest/?since=...` lists documents changed on the server.
2. Documents that changed locally or whose heads differ are exchanged in batches of up to 500 with `POST /api/sync/` until none has anything left to send.
3. Results are merged into IndexedDB, keeping any edits made while the sync ran.

It runs at start, when the browser comes back online, when the tab becomes visible, every 60 seconds, and 2 seconds after a local edit. The header shows the state and has a "Sync now" button. Only one tab syncs at a time.

## Commands

```bash
npm start              # dev server at http://localhost:4200, /api proxied to https://offline-hmis.vercel.app (service worker off)
npm test -- --watch=false --browsers=ChromeHeadless
npm run serve:offline  # production build at http://localhost:8080 with the service worker, /api proxied to the hosted server
```

The HMIS server is hosted at `https://offline-hmis.vercel.app`. To work against a local server instead (`venv/bin/python manage.py runserver` in `../HMIS`), change the target in `proxy.conf.json` and the `-P` address in the `serve:offline` script to `http://localhost:8000`.

To check offline mode: run `npm run serve:offline`, open the app once, then stop the server (or turn off the network) and reload. Register patients and record visits, bring the network back, and watch the header change from "N waiting" to "Synced".

## Configuration

`SYNC_CONFIG` in `src/app/core/sync/sync-api.ts` sets the server origin (`apiBaseUrl`, default same origin), the background interval and the edit debounce. In production, either serve the app and `/api` from the same origin, or set the server address (Profile tab or `apiBaseUrl`) and add the app's origin to `HMIS_CORS_ALLOWED_ORIGINS` on the server, for example `HMIS_CORS_ALLOWED_ORIGINS=https://hmis-web.example.org`. The server only sends CORS headers to origins in that list.

If you are logged in to the Django admin on `localhost`, the session cookie is also sent to the proxied `/api` calls and Django's CSRF check rejects the sync POST. Log out of the admin, or use a different host name, while testing.
