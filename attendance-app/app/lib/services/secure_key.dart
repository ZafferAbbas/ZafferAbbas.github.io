import 'package:flutter/services.dart';

/// Error from the native secure-key code. [code] is one of:
/// NO_BIOMETRICS, NO_KEY, KEY_INVALIDATED, CANCELLED, AUTH_ERROR, SIGN_FAILED, ERROR.
class SecureKeyException implements Exception {
  SecureKeyException(this.code, this.message);
  final String code;
  final String message;

  bool get cancelled => code == 'CANCELLED';

  @override
  String toString() => message;
}

/// Talks to the hardware-backed signing key:
/// Android Keystore (SecureKeyChannel.kt) / iOS Secure Enclave (AppDelegate.swift).
///
/// The private key never leaves the chip, and every [sign] call shows the
/// system Face ID / fingerprint prompt.
class SecureKey {
  static const _channel = MethodChannel('attendance/secure_key');

  static Future<T> _call<T>(String method, [Map<String, Object?>? args]) async {
    try {
      return await _channel.invokeMethod<T>(method, args) as T;
    } on PlatformException catch (e) {
      throw SecureKeyException(e.code, _friendly(e));
    }
  }

  static String _friendly(PlatformException e) => switch (e.code) {
        'NO_BIOMETRICS' =>
          'Set up fingerprint or Face ID on this phone first (in the phone\'s Settings).',
        'CANCELLED' => 'Cancelled.',
        _ => e.message ?? 'Something went wrong with the phone\'s security chip.',
      };

  /// Strong biometrics are set up and usable.
  static Future<bool> isSupported() => _call<bool>('isSupported');

  static Future<bool> hasKey() => _call<bool>('hasKey');

  /// Creates a new key (replacing any old one). Returns the public key
  /// as base64 DER SubjectPublicKeyInfo.
  static Future<String> createKey() => _call<String>('createKey');

  static Future<void> deleteKey() => _call<void>('deleteKey');

  /// Shows the biometric prompt, then signs [payload] (UTF-8) with
  /// ECDSA P-256 / SHA-256. Returns a base64 DER signature.
  static Future<String> sign(String payload, {required String reason}) =>
      _call<String>('sign', {'payload': payload, 'reason': reason});
}
