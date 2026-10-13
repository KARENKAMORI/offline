import 'dart:convert';

import 'package:http/http.dart' as http;

/// GET /api/sync/manifest/
class Manifest {
  const Manifest(this.serverTime, this.docs);

  final String serverTime;

  /// Patient uuid to its sorted head hashes.
  final Map<String, List<String>> docs;
}

/// POST /api/sync/
class SyncReply {
  const SyncReply(this.docs, this.problems);

  /// Patient uuid to a base64 sync message, or null when the server has
  /// nothing more to send.
  final Map<String, String?> docs;
  final Map<String, List<String>> problems;
}

class SyncHttpException implements Exception {
  const SyncHttpException(this.message, {this.unreachable = false});
  final String message;

  /// No reply from the server, as opposed to the server refusing the request.
  final bool unreachable;
  @override
  String toString() => message;
}

/// HTTP transport for HMIS/patients/sync_views.py.
class SyncApi {
  SyncApi(this.baseUrl, {http.Client? client})
    : _client = client ?? http.Client();

  final String baseUrl;
  final http.Client _client;
  static const _timeout = Duration(seconds: 20);

  Future<Manifest> manifest(String? since) async {
    final uri = Uri.parse('$baseUrl/api/sync/manifest/')
        .replace(queryParameters: since == null ? null : {'since': since});
    final j = await _send(() => _client.get(uri));
    return Manifest(j['server_time'] as String, {
      for (final MapEntry(:key, :value) in (j['docs'] as Map).entries)
        key as String: (value as List).cast<String>(),
    });
  }

  /// Whether the server answers at all. Any HTTP reply counts, even a 404,
  /// except the gateway errors a proxy sends when it cannot reach the server.
  Future<bool> reachable() async {
    try {
      final res = await _client
          .head(Uri.parse('$baseUrl/api/'))
          .timeout(const Duration(seconds: 5));
      return !_gatewayError(res.statusCode);
    } on Exception {
      return false;
    }
  }

  Future<SyncReply> exchange(Map<String, String> docs) async {
    final j = await _send(
      () => _client.post(
        Uri.parse('$baseUrl/api/sync/'),
        headers: {'content-type': 'application/json'},
        body: jsonEncode({'docs': docs}),
      ),
    );
    return SyncReply((j['docs'] as Map).cast<String, String?>(), {
      for (final MapEntry(:key, :value) in (j['problems'] as Map).entries)
        key as String: (value as List).cast<String>(),
    });
  }

  Future<Map<String, dynamic>> _send(
    Future<http.Response> Function() request,
  ) async {
    final http.Response res;
    try {
      res = await request().timeout(_timeout);
    } on Exception {
      throw const SyncHttpException(
        "Server didn't respond. Will retry.",
        unreachable: true,
      );
    }
    if (_gatewayError(res.statusCode)) {
      throw SyncHttpException(
        "Server didn't respond (${res.statusCode}). Will retry.",
        unreachable: true,
      );
    }
    if (res.statusCode != 200) {
      throw SyncHttpException('Server returned ${res.statusCode}.');
    }
    return jsonDecode(res.body) as Map<String, dynamic>;
  }

  void close() => _client.close();

  static bool _gatewayError(int status) =>
      status == 502 || status == 503 || status == 504;
}
