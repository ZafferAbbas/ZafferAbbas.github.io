import Flutter
import LocalAuthentication
import Security
import UIKit

@main
@objc class AppDelegate: FlutterAppDelegate, FlutterImplicitEngineDelegate {
  override func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?
  ) -> Bool {
    return super.application(application, didFinishLaunchingWithOptions: launchOptions)
  }

  func didInitializeImplicitFlutterEngine(_ engineBridge: FlutterImplicitEngineBridge) {
    GeneratedPluginRegistrant.register(with: engineBridge.pluginRegistry)
    if let registrar = engineBridge.pluginRegistry.registrar(forPlugin: "SecureKeyPlugin") {
      SecureKeyPlugin.register(with: registrar)
    }
  }
}

/// A P-256 signing key created inside the Secure Enclave. The private key can
/// never be read out, and the access control `.biometryCurrentSet` means:
///   - every signature needs Face ID / Touch ID (no passcode fallback), and
///   - enrolling a new face/fingerprint permanently disables the key.
///
/// Same channel and methods as the Android side (SecureKeyChannel.kt).
/// Note: the iOS Simulator has no Secure Enclave; test on a real device.
final class SecureKeyPlugin: NSObject, FlutterPlugin {
  private static let tag = "com.example.attendance.signing_key".data(using: .utf8)!

  static func register(with registrar: FlutterPluginRegistrar) {
    let channel = FlutterMethodChannel(
      name: "attendance/secure_key", binaryMessenger: registrar.messenger())
    registrar.addMethodCallDelegate(SecureKeyPlugin(), channel: channel)
  }

  func handle(_ call: FlutterMethodCall, result: @escaping FlutterResult) {
    switch call.method {
    case "isSupported":
      var err: NSError?
      let ok = LAContext().canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &err)
      result(ok)
    case "hasKey":
      result(Self.loadKey(context: nil) != nil)
    case "createKey":
      do { result(try Self.createKey()) } catch let e as FlutterError { result(e) } catch {
        result(FlutterError(code: "ERROR", message: error.localizedDescription, details: nil))
      }
    case "deleteKey":
      Self.deleteKey()
      result(nil)
    case "sign":
      let args = call.arguments as? [String: Any] ?? [:]
      let payload = args["payload"] as? String ?? ""
      let reason = args["reason"] as? String ?? "Confirm it's you"
      // SecKeyCreateSignature blocks while Face ID runs: keep it off the main thread.
      DispatchQueue.global(qos: .userInitiated).async {
        let reply = Self.sign(payload: payload, reason: reason)
        DispatchQueue.main.async { result(reply) }
      }
    default:
      result(FlutterMethodNotImplemented)
    }
  }

  // MARK: - Key management

  private static func createKey() throws -> String {
    var laErr: NSError?
    guard LAContext().canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &laErr)
    else {
      throw FlutterError(code: "NO_BIOMETRICS", message: "Set up Face ID or Touch ID first.", details: nil)
    }
    deleteKey()

    var acErr: Unmanaged<CFError>?
    guard let access = SecAccessControlCreateWithFlags(
      nil, kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly,
      [.privateKeyUsage, .biometryCurrentSet], &acErr)
    else {
      throw FlutterError(code: "ERROR", message: "Couldn't create access control.", details: nil)
    }

    let attrs: [String: Any] = [
      kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
      kSecAttrKeySizeInBits as String: 256,
      kSecAttrTokenID as String: kSecAttrTokenIDSecureEnclave,
      kSecPrivateKeyAttrs as String: [
        kSecAttrIsPermanent as String: true,
        kSecAttrApplicationTag as String: tag,
        kSecAttrAccessControl as String: access,
      ],
    ]

    var cfErr: Unmanaged<CFError>?
    guard let privateKey = SecKeyCreateRandomKey(attrs as CFDictionary, &cfErr),
      let publicKey = SecKeyCopyPublicKey(privateKey),
      let raw = SecKeyCopyExternalRepresentation(publicKey, &cfErr) as Data?
    else {
      let msg = cfErr?.takeRetainedValue().localizedDescription ?? "Secure Enclave unavailable."
      throw FlutterError(code: "ERROR", message: msg, details: nil)
    }

    // iOS gives the raw 65-byte point (04||X||Y). Wrap it in the fixed P-256
    // SubjectPublicKeyInfo header so both platforms send the same format.
    let spkiHeader: [UInt8] = [
      0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01,
      0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07, 0x03, 0x42, 0x00,
    ]
    return (Data(spkiHeader) + raw).base64EncodedString()
  }

  private static func loadKey(context: LAContext?) -> SecKey? {
    var query: [String: Any] = [
      kSecClass as String: kSecClassKey,
      kSecAttrApplicationTag as String: tag,
      kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
      kSecReturnRef as String: true,
    ]
    if let context = context {
      query[kSecUseAuthenticationContext as String] = context
    } else {
      // Just checking existence: never show UI.
      let silent = LAContext()
      silent.interactionNotAllowed = true
      query[kSecUseAuthenticationContext as String] = silent
    }
    var item: CFTypeRef?
    guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess, let item = item
    else { return nil }
    return (item as! SecKey)
  }

  private static func deleteKey() {
    let query: [String: Any] = [
      kSecClass as String: kSecClassKey,
      kSecAttrApplicationTag as String: tag,
    ]
    SecItemDelete(query as CFDictionary)
  }

  // MARK: - Signing

  private static func sign(payload: String, reason: String) -> Any {
    let context = LAContext()
    context.localizedReason = reason
    context.localizedCancelTitle = "Cancel"

    guard let key = loadKey(context: context) else {
      return FlutterError(code: "NO_KEY", message: "No key on this phone. Register it first.", details: nil)
    }

    var cfErr: Unmanaged<CFError>?
    guard let sig = SecKeyCreateSignature(
      key, .ecdsaSignatureMessageX962SHA256, Data(payload.utf8) as CFData, &cfErr) as Data?
    else {
      let err = cfErr?.takeRetainedValue()
      let code = err.map { CFErrorGetCode($0) } ?? 0
      if code == LAError.userCancel.rawValue || code == LAError.appCancel.rawValue
        || code == LAError.systemCancel.rawValue
      {
        return FlutterError(code: "CANCELLED", message: "Cancelled.", details: nil)
      }
      if code == Int(errSecItemNotFound) {
        // biometryCurrentSet: the key stops working after Face ID/Touch ID changes.
        return FlutterError(
          code: "KEY_INVALIDATED",
          message: "Your Face ID / Touch ID settings changed. Register this phone again.",
          details: nil)
      }
      return FlutterError(
        code: "AUTH_ERROR", message: err?.localizedDescription ?? "Couldn't sign.", details: nil)
    }
    return sig.base64EncodedString()  // DER ECDSA signature
  }
}
