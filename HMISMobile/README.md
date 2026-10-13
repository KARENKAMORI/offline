# FieldVisit (HMISMobile)

Offline-first Android app for registering patients and recording visits. It syncs
with the HMIS server (`../HMIS`) and shares its data with HMISWeb (`../HMISWeb`).

Every screen reads and writes SQLite on the phone, so the app works with no
network. Sync runs in the background whenever the server is reachable.

## Screens

| Tab      | What it shows |
|----------|---------------|
| Visits   | Greeting, today's visits with Synced/Waiting badges, the next visit, and banners when sync merged or replaced an edit. Record, edit, delete and restore visits (reason, visit type, time, vitals). |
| Patients | Search, register and edit patients (name, phone, location, status, head of household). Patient page lists visits, including deleted ones on request, and values the server could not save. |
| Sync     | Changes waiting to sync, Sync now, pending changes list, sync history with counts. |
| Profile  | Your name and area (for the greeting), this device's name (shown to other devices on conflicts) and the server address. |

Tap the Online / Offline / Syncing pill on any screen to see what it means.

## How data is stored

Each patient is one [Automerge](https://automerge.org) document, in the shape
defined in `../HMIS/DOCUMENT_SCHEMA.md` and shared with the server and HMISWeb.
Automerge runs in Rust (`rust/src/api/doc.rs`), called from Dart through
[flutter_rust_bridge](https://cjycode.com/flutter_rust_bridge/).

SQLite (`lib/core/db.dart`) holds:

| Table       | Purpose |
|-------------|---------|
| `docs`      | Document bytes per patient, plus the heads the server is known to have. The source of truth. |
| `patients`, `visits` | Read model rebuilt from each document after every change. Screens query these. |
| `replaced`  | Fields where this phone's edit lost to a concurrent edit elsewhere ("One of your edits was replaced"). |
| `dirty`     | Patients changed here and not yet received by the server. |
| `problems`  | Values the server could not save. |
| `notices`   | "Merged a change from ..." banners. |
| `sync_runs` | Sync history. |
| `meta`      | Device profile, manifest cursor, last sync time. |

All writes go through `DocStore` (`lib/core/doc_store.dart`), which updates the
document, the read model and the sync flag in one transaction. Each change is
committed with a JSON message naming the device and what changed; the Pending
changes screen and conflict banners are built from those messages.

Patients are never deleted. Visits are soft-deleted (`deleted_at`) so the
server keeps every record and a concurrent edit on another device is not lost.

## How sync works

`SyncService` (`lib/core/sync_service.dart`) follows HMISWeb's SyncService and
`../HMIS/benchmarks/client/device.mjs`:

1. `GET /api/sync/manifest/?since=...` lists documents changed on the server.
2. Documents changed locally, or whose heads differ, are exchanged in batches of
   up to 500 with `POST /api/sync/` until none has anything left to send.
3. Results are merged into SQLite, keeping any edits made while the sync ran.

It runs at start, when the network comes back, when the app returns to the
foreground, every 60 seconds, and 2 seconds after a local edit.

## Setup

You need Flutter, the Android SDK and NDK, and Rust:

```sh
curl https://sh.rustup.rs -sSf | sh          # once
cargo install flutter_rust_bridge_codegen --version 2.13.0 --locked   # only to change the Rust API
```

The Android build compiles the Rust library for each Android architecture
automatically (cargokit, in `rust_builder/`). The first build takes several minutes.

## Running

```sh
# Server, in ../HMIS
venv/bin/python manage.py migrate
venv/bin/python manage.py runserver 0.0.0.0:8000

# App
flutter run
```

The app syncs with the hosted server at `https://offline-hmis.vercel.app` by default.
To use a local server instead, set its address on the Profile tab: the emulator
reaches the computer at `http://10.0.2.2:8000`. On a real phone, set the computer's LAN address (for example
`http://192.168.1.10:8000`) on the Profile tab and add that address to
`HMIS_ALLOWED_HOSTS` when starting the server. Debug builds allow plain http;
release builds need an https server.

## Tests

```sh
(cd rust && cargo test && cargo build)   # Rust tests, then the host library the Dart tests load
flutter test                             # data layer, sync against a fake server, full app flow
```

End-to-end against a running server (uses real HTTP; point it at a throwaway database):

```sh
HMIS_SERVER=http://127.0.0.1:8000 flutter test test/e2e
```

## Changing the Rust API

Edit `rust/src/api/doc.rs`, then run `flutter_rust_bridge_codegen generate` to
regenerate `lib/src/rust/` and `rust/src/frb_generated.rs`. Never edit the
generated files by hand.

## Schema changes

Document fields: update `../HMIS/DOCUMENT_SCHEMA.md`, `lib/core/schema.dart`,
the projection in `DocStore._write`, the server and HMISWeb together.

SQLite tables: bump `AppDatabase.version` in `lib/core/db.dart` and add a step to
`onUpgrade`. Version 2 replaced version 1's integer-id tables; rows from
version 1 had no document behind them and are dropped on upgrade.
