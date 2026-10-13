import 'package:flutter/foundation.dart';
import 'package:sqflite/sqflite.dart';
import 'package:uuid/uuid.dart';

/// Who is using this phone and where it syncs to. Stored in the `meta` table.
class DeviceProfile extends ChangeNotifier {
  DeviceProfile._(this._db, this.deviceId, this._values);

  /// The hosted HMIS server. A local server can be set on the Profile tab
  /// (the emulator reaches this computer at http://10.0.2.2:8000).
  static const defaultServerUrl = 'https://offline-hmis.vercel.app';

  final Database _db;

  /// Stable per install. Also the Automerge actor id, so this device's edits
  /// can be told apart from other devices' when a conflict is resolved.
  final String deviceId;
  final Map<String, String> _values;

  static Future<DeviceProfile> load(Database db) async {
    final rows = await db.query('meta');
    final values = {
      for (final r in rows) r['key'] as String: r['value'] as String,
    };
    var id = values['device_id'];
    if (id == null) {
      id = const Uuid().v4();
      await db.insert('meta', {'key': 'device_id', 'value': id});
    }
    return DeviceProfile._(db, id, values);
  }

  String get actorHex => deviceId.replaceAll('-', '');
  String get workerName => _values['worker_name'] ?? '';
  String get area => _values['area'] ?? '';
  String get deviceName => _values['device_name']?.isNotEmpty == true
      ? _values['device_name']!
      : 'Phone ${deviceId.substring(0, 4).toUpperCase()}';
  String get serverUrl => _values['server_url']?.isNotEmpty == true
      ? _values['server_url']!
      : defaultServerUrl;

  Future<void> save({
    required String workerName,
    required String area,
    required String deviceName,
    required String serverUrl,
  }) async {
    final updates = {
      'worker_name': workerName.trim(),
      'area': area.trim(),
      'device_name': deviceName.trim(),
      'server_url': serverUrl.trim().replaceAll(RegExp(r'/+$'), ''),
    };
    final batch = _db.batch();
    updates.forEach((key, value) {
      batch.insert('meta', {
        'key': key,
        'value': value,
      }, conflictAlgorithm: ConflictAlgorithm.replace);
    });
    await batch.commit(noResult: true);
    _values.addAll(updates);
    notifyListeners();
  }
}
