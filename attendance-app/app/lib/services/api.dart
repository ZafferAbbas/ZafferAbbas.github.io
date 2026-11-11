import 'dart:convert';
import 'dart:io' show Platform;

import 'package:geolocator/geolocator.dart';
import 'package:supabase_flutter/supabase_flutter.dart';

import 'secure_key.dart';

/// A user-facing error with a message that's safe to show on screen.
class AppException implements Exception {
  AppException(this.message, {this.code});
  final String message;
  final String? code;

  @override
  String toString() => message;
}

enum DeviceState {
  /// No usable key on this phone (first time, reinstall, or biometrics changed).
  needsRegistration,

  /// Registered, waiting for an admin to approve this phone.
  pending,

  /// Ready to check in.
  active,
}

class Site {
  Site(this.id, this.name, this.radiusM);
  final String id;
  final String name;
  final int radiusM;
}

class AttendanceRecord {
  AttendanceRecord(this.siteName, this.checkedInAt);
  final String siteName;
  final DateTime checkedInAt;
}

class CheckInResult {
  CheckInResult(this.siteName, this.distanceM);
  final String siteName;
  final int distanceM;
}

class AttendanceApi {
  AttendanceApi(this._db);
  final SupabaseClient _db;

  String get _uid => _db.auth.currentUser!.id;

  // ------------------------------------------------------------ device

  Future<DeviceState> deviceState() async {
    final rows = await _db
        .from('devices')
        .select('status')
        .eq('user_id', _uid)
        .inFilter('status', ['active', 'pending']);
    final statuses = rows.map((r) => r['status'] as String).toSet();
    final hasKey = await SecureKey.hasKey();

    if (!hasKey) return DeviceState.needsRegistration;
    if (statuses.contains('pending')) return DeviceState.pending;
    if (statuses.contains('active')) return DeviceState.active;
    return DeviceState.needsRegistration;
  }

  /// Creates a new hardware key, proves we hold it (biometric prompt), and
  /// sends the public key to the server. Returns the new state.
  Future<DeviceState> registerDevice() async {
    if (!await SecureKey.isSupported()) {
      throw AppException(
          'This phone needs fingerprint or Face ID set up before it can be used for check-in.');
    }
    final publicKey = await SecureKey.createKey();
    final challenge = await _challenge('register');

    final payload = jsonEncode({
      'type': 'register',
      'challenge_id': challenge.id,
      'nonce': challenge.nonce,
      'platform': Platform.isIOS ? 'ios' : 'android',
      'public_key': publicKey,
    });
    final signature =
        await SecureKey.sign(payload, reason: 'Confirm it\'s you to register this phone');

    final res = await _invoke('register-device', {'payload': payload, 'signature': signature});
    return res['status'] == 'active' ? DeviceState.active : DeviceState.pending;
  }

  // ------------------------------------------------------------- sites

  Future<List<Site>> sites() async {
    final rows = await _db
        .from('sites')
        .select('id, name, radius_m')
        .eq('active', true)
        .order('name');
    return rows
        .map((r) => Site(r['id'] as String, r['name'] as String, r['radius_m'] as int))
        .toList();
  }

  Future<List<AttendanceRecord>> history({int limit = 20}) async {
    final rows = await _db
        .from('attendance')
        .select('checked_in_at, sites(name)')
        .eq('user_id', _uid)
        .order('checked_in_at', ascending: false)
        .limit(limit);
    return rows
        .map((r) => AttendanceRecord(
              (r['sites'] as Map?)?['name'] as String? ?? 'Unknown',
              DateTime.parse(r['checked_in_at'] as String).toLocal(),
            ))
        .toList();
  }

  // ---------------------------------------------------------- check-in

  Future<CheckInResult> checkIn(Site site) async {
    final position = await _currentPosition();
    final challenge = await _challenge('checkin');

    final payload = jsonEncode({
      'type': 'checkin',
      'challenge_id': challenge.id,
      'nonce': challenge.nonce,
      'site_id': site.id,
      'latitude': position.latitude,
      'longitude': position.longitude,
      'accuracy_m': position.accuracy,
      // Android reports fake-GPS apps. The server rejects mocked readings.
      'is_mocked': position.isMocked,
    });

    final signature = await SecureKey.sign(payload, reason: 'Check in at ${site.name}');
    final res = await _invoke('check-in', {'payload': payload, 'signature': signature});
    return CheckInResult(res['site_name'] as String, (res['distance_m'] as num).round());
  }

  Future<Position> _currentPosition() async {
    if (!await Geolocator.isLocationServiceEnabled()) {
      throw AppException('Turn on Location to check in.');
    }
    var perm = await Geolocator.checkPermission();
    if (perm == LocationPermission.denied) {
      perm = await Geolocator.requestPermission();
    }
    if (perm == LocationPermission.denied) {
      throw AppException('Location permission is needed to check in.');
    }
    if (perm == LocationPermission.deniedForever) {
      throw AppException(
          'Location permission is turned off for this app. Enable it in Settings to check in.');
    }
    try {
      return await Geolocator.getCurrentPosition(
        locationSettings: const LocationSettings(
          accuracy: LocationAccuracy.best,
          timeLimit: Duration(seconds: 20),
        ),
      );
    } catch (_) {
      throw AppException('Couldn\'t get your location. Move near a window or outdoors and try again.');
    }
  }

  // ----------------------------------------------------------- helpers

  Future<({String id, String nonce})> _challenge(String purpose) async {
    final res = await _invoke('challenge', {'purpose': purpose});
    return (id: res['challenge_id'] as String, nonce: res['nonce'] as String);
  }

  Future<Map<String, dynamic>> _invoke(String fn, Map<String, dynamic> body) async {
    try {
      final res = await _db.functions.invoke(fn, body: body);
      return Map<String, dynamic>.from(res.data as Map);
    } on FunctionException catch (e) {
      final details = e.details;
      if (details is Map && details['message'] is String) {
        throw AppException(details['message'] as String, code: details['error'] as String?);
      }
      throw AppException('Server error (${e.status}). Please try again.');
    }
  }
}
