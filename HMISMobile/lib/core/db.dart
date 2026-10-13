import 'package:path/path.dart';
import 'package:sqflite/sqflite.dart';

import 'schema.dart';

/// Opens the app's SQLite database.
///
/// | Table       | Purpose                                                        |
/// |-------------|----------------------------------------------------------------|
/// | `docs`      | Automerge document bytes per patient. The source of truth.     |
/// | `patients`, `visits` | Read model rebuilt from each document after every change. |
/// | `replaced`  | Fields where this device's edit lost to a concurrent edit.     |
/// | `dirty`     | Patients changed here and not yet received by the server.      |
/// | `problems`  | Values the server could not save.                              |
/// | `notices`   | "Merged a change from ..." banners.                            |
/// | `sync_runs` | Sync history.                                                  |
/// | `meta`      | Device profile, manifest cursor, last sync time.               |
class AppDatabase {
  static const fileName = 'hmis_mobile.db';

  // Bump and add a step to _onUpgrade when the schema changes. Never edit a
  // shipped version.
  static const version = 3;

  /// Meta key set by an upgrade whose new columns need every document
  /// projected again; `DocStore.reprojectIfNeeded` clears it.
  static const reprojectKey = 'reproject';

  static Future<Database> open({String? path}) async {
    return openDatabase(
      path ?? join(await getDatabasesPath(), fileName),
      version: version,
      onCreate: (db, _) async {
        await _createV2(db);
        await _upgradeV3(db);
      },
      onUpgrade: (db, from, _) async {
        if (from < 2) {
          // v1 kept patients in plain tables with integer ids. Those rows have
          // no document behind them and cannot sync, so they are dropped.
          await db.execute('DROP TABLE IF EXISTS visits');
          await db.execute('DROP TABLE IF EXISTS patients');
          await _createV2(db);
        }
        if (from < 3) {
          await _upgradeV3(db);
          // Documents synced before v3 may already carry merged_into.
          await db.insert('meta', {
            'key': reprojectKey,
            'value': '1',
          }, conflictAlgorithm: ConflictAlgorithm.replace);
        }
      },
    );
  }

  /// v3: the server merges duplicate patients (DOCUMENT_SCHEMA.md,
  /// "Duplicate patients").
  static Future<void> _upgradeV3(Database db) => db.execute(
    "ALTER TABLE patients ADD COLUMN merged_into TEXT NOT NULL DEFAULT ''",
  );

  static Future<void> _createV2(Database db) async {
    final vitalColumns = vitalFields
        .map((f) => "${f.key} TEXT NOT NULL DEFAULT ''")
        .join(',\n');
    final batch = db.batch()
      ..execute('''
        CREATE TABLE docs (
          id TEXT PRIMARY KEY,
          bytes BLOB NOT NULL,
          heads TEXT NOT NULL,
          -- Heads the server is known to have; changes after these are pending.
          synced_heads TEXT NOT NULL DEFAULT ''
        )''')
      ..execute('''
        CREATE TABLE patients (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          phone TEXT NOT NULL,
          status TEXT NOT NULL,
          location TEXT NOT NULL,
          head_of_household INTEGER NOT NULL,
          registered_at TEXT NOT NULL
        )''')
      ..execute('''
        CREATE TABLE visits (
          id TEXT PRIMARY KEY,
          patient_id TEXT NOT NULL,
          visit_type TEXT NOT NULL,
          timestamp TEXT NOT NULL,
          reason TEXT NOT NULL DEFAULT '',
          $vitalColumns,
          deleted_at TEXT NOT NULL DEFAULT ''
        )''')
      ..execute('''
        CREATE TABLE replaced (
          patient_id TEXT NOT NULL,
          path TEXT NOT NULL,
          key TEXT NOT NULL,
          mine TEXT NOT NULL,
          kept TEXT NOT NULL,
          kept_by TEXT NOT NULL,
          PRIMARY KEY (patient_id, path, key)
        )''')
      ..execute('CREATE TABLE dirty (id TEXT PRIMARY KEY, token TEXT NOT NULL)')
      ..execute(
        'CREATE TABLE problems (id TEXT PRIMARY KEY, messages TEXT NOT NULL)',
      )
      ..execute('''
        CREATE TABLE notices (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          patient_id TEXT NOT NULL,
          title TEXT NOT NULL,
          body TEXT NOT NULL,
          created_at TEXT NOT NULL,
          dismissed INTEGER NOT NULL DEFAULT 0
        )''')
      ..execute('''
        CREATE TABLE sync_runs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          finished_at TEXT NOT NULL,
          outcome TEXT NOT NULL,
          sent INTEGER NOT NULL,
          received INTEGER NOT NULL,
          detail TEXT NOT NULL
        )''')
      ..execute('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
      ..execute(
        'CREATE INDEX idx_patients_name ON patients(name COLLATE NOCASE)',
      )
      ..execute(
        'CREATE INDEX idx_visits_patient ON visits(patient_id, timestamp)',
      )
      ..execute('CREATE INDEX idx_visits_timestamp ON visits(timestamp)');
    await batch.commit(noResult: true);
  }
}
