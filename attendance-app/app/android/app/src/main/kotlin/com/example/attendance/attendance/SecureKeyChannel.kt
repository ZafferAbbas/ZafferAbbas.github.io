package com.example.attendance.attendance

import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyPermanentlyInvalidatedException
import android.security.keystore.KeyProperties
import android.util.Base64
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricManager.Authenticators.BIOMETRIC_STRONG
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
import io.flutter.plugin.common.BinaryMessenger
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.PrivateKey
import java.security.Signature
import java.security.spec.ECGenParameterSpec

/**
 * A P-256 signing key that lives in the Android Keystore (TEE / StrongBox
 * hardware where available). The private key can't be exported, and every
 * single signature requires a fresh strong-biometric check (BiometricPrompt
 * with a CryptoObject), so a rooted phone can't fake "biometric passed".
 *
 * Methods (channel "attendance/secure_key"):
 *   isSupported()            -> Boolean
 *   hasKey()                 -> Boolean
 *   createKey()              -> String  (base64 DER SubjectPublicKeyInfo)
 *   deleteKey()              -> null
 *   sign({payload, reason})  -> String  (base64 DER ECDSA-SHA256 signature)
 */
class SecureKeyChannel(
    private val activity: FragmentActivity,
    messenger: BinaryMessenger,
) : MethodChannel.MethodCallHandler {

    companion object {
        const val CHANNEL = "attendance/secure_key"
        private const val ALIAS = "attendance_signing_key"
        private const val KEYSTORE = "AndroidKeyStore"
    }

    init {
        MethodChannel(messenger, CHANNEL).setMethodCallHandler(this)
    }

    override fun onMethodCall(call: MethodCall, result: MethodChannel.Result) {
        try {
            when (call.method) {
                "isSupported" -> result.success(
                    BiometricManager.from(activity).canAuthenticate(BIOMETRIC_STRONG) ==
                        BiometricManager.BIOMETRIC_SUCCESS
                )
                "hasKey" -> result.success(keyStore().containsAlias(ALIAS))
                "createKey" -> result.success(createKey())
                "deleteKey" -> {
                    keyStore().deleteEntry(ALIAS)
                    result.success(null)
                }
                "sign" -> sign(
                    call.argument<String>("payload") ?: "",
                    call.argument<String>("reason") ?: "Confirm it's you",
                    result,
                )
                else -> result.notImplemented()
            }
        } catch (e: Exception) {
            result.error("ERROR", e.message, null)
        }
    }

    private fun keyStore(): KeyStore = KeyStore.getInstance(KEYSTORE).apply { load(null) }

    private fun createKey(): String {
        val canAuth = BiometricManager.from(activity).canAuthenticate(BIOMETRIC_STRONG)
        if (canAuth != BiometricManager.BIOMETRIC_SUCCESS) {
            throw IllegalStateException("NO_BIOMETRICS")
        }
        keyStore().deleteEntry(ALIAS)

        val builder = KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_SIGN)
            .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
            .setDigests(KeyProperties.DIGEST_SHA256)
            .setUserAuthenticationRequired(true)
            // Enrolling a new fingerprint/face kills the key, so someone who
            // adds their own fingerprint to your phone can't check in as you.
            .setInvalidatedByBiometricEnrollment(true)

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            // 0 = a biometric check for every single use.
            builder.setUserAuthenticationParameters(0, KeyProperties.AUTH_BIOMETRIC_STRONG)
        } else {
            @Suppress("DEPRECATION")
            builder.setUserAuthenticationValidityDurationSeconds(-1)
        }

        val kpg = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, KEYSTORE)
        kpg.initialize(builder.build())
        val pair = kpg.generateKeyPair()
        // X.509 SubjectPublicKeyInfo DER.
        return Base64.encodeToString(pair.public.encoded, Base64.NO_WRAP)
    }

    private fun sign(payload: String, reason: String, result: MethodChannel.Result) {
        val ks = keyStore()
        val key = ks.getKey(ALIAS, null) as? PrivateKey
        if (key == null) {
            result.error("NO_KEY", "No key on this phone. Register it first.", null)
            return
        }

        val signature = Signature.getInstance("SHA256withECDSA")
        try {
            signature.initSign(key)
        } catch (e: KeyPermanentlyInvalidatedException) {
            ks.deleteEntry(ALIAS)
            result.error(
                "KEY_INVALIDATED",
                "Your fingerprint/face settings changed. Register this phone again.",
                null,
            )
            return
        }

        val prompt = BiometricPrompt(
            activity,
            ContextCompat.getMainExecutor(activity),
            object : BiometricPrompt.AuthenticationCallback() {
                private var replied = false

                override fun onAuthenticationSucceeded(res: BiometricPrompt.AuthenticationResult) {
                    if (replied) return
                    replied = true
                    try {
                        val sig = res.cryptoObject?.signature
                            ?: throw IllegalStateException("No signature object")
                        sig.update(payload.toByteArray(Charsets.UTF_8))
                        result.success(Base64.encodeToString(sig.sign(), Base64.NO_WRAP))
                    } catch (e: Exception) {
                        result.error("SIGN_FAILED", e.message, null)
                    }
                }

                override fun onAuthenticationError(code: Int, msg: CharSequence) {
                    if (replied) return
                    replied = true
                    val cancelled = code == BiometricPrompt.ERROR_USER_CANCELED ||
                        code == BiometricPrompt.ERROR_NEGATIVE_BUTTON ||
                        code == BiometricPrompt.ERROR_CANCELED
                    result.error(if (cancelled) "CANCELLED" else "AUTH_ERROR", msg.toString(), null)
                }
                // onAuthenticationFailed = one bad attempt; the prompt stays open.
            },
        )

        val info = BiometricPrompt.PromptInfo.Builder()
            .setTitle("Check in")
            .setSubtitle(reason)
            .setAllowedAuthenticators(BIOMETRIC_STRONG)
            .setNegativeButtonText("Cancel")
            .build()

        prompt.authenticate(info, BiometricPrompt.CryptoObject(signature))
    }
}
