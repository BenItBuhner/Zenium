package app.zen.chromium

import android.app.KeyguardManager
import android.content.Context
import android.os.Build
import android.os.Handler
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyInfo
import android.security.keystore.KeyPermanentlyInvalidatedException
import android.security.keystore.KeyProperties
import android.security.keystore.UserNotAuthenticatedException
import android.util.Log
import java.security.KeyStore
import java.util.Base64
import java.util.concurrent.ExecutorService
import javax.crypto.AEADBadTagException
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.SecretKeyFactory

/**
 * Protects the password vault's random data key with an AES-256-GCM key that lives in the Android
 * Keystore and never leaves it (`vault.wrap` / `vault.unwrap` on the bridge).
 *
 * On a device with a screen lock the key is authentication-bound (`setUserAuthenticationRequired`):
 * it only works within [AUTH_VALIDITY_SECONDS] of the user proving themselves with the device
 * credential or a Class 3 biometric. Unlocking the phone counts, so most starts open the vault
 * silently; otherwise an interactive call shows the system prompt and retries, and a silent one
 * (the startup probe) is rejected so the core keeps the vault locked until the manager is opened.
 *
 * Documented fallback: without a screen lock the key cannot be authentication-bound, so a plain
 * hardware-backed key protects the vault (app sandbox plus Keystore). Removing the screen lock later
 * permanently invalidates an authentication-bound key; the vault then only opens with its
 * passphrase, and the next `wrap` (a passphrase unlock re-wraps) mints a fresh key.
 */
class VaultKeystore(
    private val context: Context,
    private val reauth: Reauth,
    private val io: ExecutorService,
    private val main: Handler
) {
    /** The Keystore is usable: the provider loads and the key exists or can be created. */
    fun available(): Boolean = runCatching { obtainKey() != null }.getOrDefault(false)

    fun wrap(dataKeyBase64: String, reply: (Any?) -> Unit) {
        val dataKey = try {
            Base64.getDecoder().decode(dataKeyBase64)
        } catch (e: IllegalArgumentException) {
            reply(Host.Rejection("malformed data key"))
            return
        }
        attempt(interactive = true, reason = "Protect your saved passwords", reply = reply) {
            val key = obtainKey() ?: throw IllegalStateException("The Android Keystore is unavailable")
            VaultCipher.wrap(key, dataKey, authBound = keyIsAuthBound).encode()
        }
    }

    fun unwrap(blobText: String, interactive: Boolean, reply: (Any?) -> Unit) {
        val blob = try {
            VaultKeyBlob.parse(blobText)
        } catch (e: IllegalArgumentException) {
            reply(Host.Rejection(e.message ?: "malformed keystore blob"))
            return
        }
        attempt(interactive, reason = "Unlock your saved passwords", reply = reply) {
            val key = existingKey() ?: throw IllegalStateException("The vault key is missing from the Android Keystore")
            Base64.getEncoder().encodeToString(VaultCipher.unwrap(key, blob))
        }
    }

    /**
     * Run a Keystore operation off the main thread. When the key wants a fresh authentication and
     * the call may show UI, prompt with authenticators that satisfy the key (device credential or a
     * Class 3 biometric) and retry once; every other failure rejects the bridge call with a message
     * the core can show.
     */
    private fun attempt(interactive: Boolean, reason: String, reply: (Any?) -> Unit, op: () -> String) {
        io.execute {
            val outcome = runCatching(op)
            val error = outcome.exceptionOrNull()
            if (error == null) {
                main.post { reply(outcome.getOrThrow()) }
                return@execute
            }
            if (error is UserNotAuthenticatedException && interactive) {
                main.post {
                    reauth.authenticate(reason, strong = true) { ok ->
                        if (!ok) {
                            reply(Host.Rejection("Authentication was cancelled"))
                            return@authenticate
                        }
                        io.execute {
                            val retry = runCatching(op)
                            main.post {
                                retry.onSuccess(reply).onFailure { reply(Host.Rejection(describe(it))) }
                            }
                        }
                    }
                }
                return@execute
            }
            if (error is KeyPermanentlyInvalidatedException) deleteKey()
            main.post { reply(Host.Rejection(describe(error))) }
        }
    }

    private fun describe(error: Throwable): String = when (error) {
        is UserNotAuthenticatedException -> "Authentication is required to open the vault"
        is KeyPermanentlyInvalidatedException ->
            "The screen lock was changed or removed, which invalidated the vault key on this device"
        is AEADBadTagException -> "The vault key was not protected on this device"
        else -> error.message ?: error.javaClass.simpleName
    }

    // ---------------------------------------------------------------------------------------------
    // Key management
    // ---------------------------------------------------------------------------------------------

    private var keyIsAuthBound = false

    private fun keyStore(): KeyStore = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }

    private fun existingKey(): SecretKey? {
        val store = keyStore()
        val key = store.getKey(ALIAS, null) as? SecretKey ?: return null
        keyIsAuthBound = runCatching {
            val factory = SecretKeyFactory.getInstance(key.algorithm, ANDROID_KEYSTORE)
            (factory.getKeySpec(key, KeyInfo::class.java) as KeyInfo).isUserAuthenticationRequired
        }.getOrDefault(false)
        return key
    }

    @Synchronized
    private fun obtainKey(): SecretKey? = existingKey() ?: createKey()

    private fun deviceSecure(): Boolean =
        (context.getSystemService(Context.KEYGUARD_SERVICE) as? KeyguardManager)?.isDeviceSecure == true

    private fun createKey(): SecretKey? {
        val authBound = deviceSecure()
        if (authBound) {
            runCatching { generate(authBound = true) }.onSuccess {
                keyIsAuthBound = true
                return it
            }.onFailure { Log.w(TAG, "authentication-bound vault key failed; using a plain Keystore key", it) }
        }
        return runCatching { generate(authBound = false) }
            .onSuccess { keyIsAuthBound = false }
            .onFailure { Log.e(TAG, "cannot create the vault key", it) }
            .getOrNull()
    }

    @Suppress("DEPRECATION")
    private fun generate(authBound: Boolean): SecretKey {
        val spec = KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
        if (authBound) {
            spec.setUserAuthenticationRequired(true)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                spec.setUserAuthenticationParameters(
                    AUTH_VALIDITY_SECONDS,
                    KeyProperties.AUTH_DEVICE_CREDENTIAL or KeyProperties.AUTH_BIOMETRIC_STRONG
                )
            } else {
                spec.setUserAuthenticationValidityDurationSeconds(AUTH_VALIDITY_SECONDS)
            }
        }
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE)
        generator.init(spec.build())
        return generator.generateKey()
    }

    private fun deleteKey() {
        runCatching { keyStore().deleteEntry(ALIAS) }
    }

    companion object {
        private const val TAG = "ZeniumVault"
        private const val ANDROID_KEYSTORE = "AndroidKeyStore"
        const val ALIAS = "zenium-vault-data-key"
        /** How long one device authentication (including unlocking the phone) keeps the key usable. */
        const val AUTH_VALIDITY_SECONDS = 300
    }
}
