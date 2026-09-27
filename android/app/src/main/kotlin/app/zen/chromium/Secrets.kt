package app.zen.chromium

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.io.IOException
import java.security.GeneralSecurityException
import java.security.KeyStore
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * The core's `platform.secrets` on the phone (`secrets.get` / `secrets.set` / `secrets.delete` on
 * the bridge; the contract is `SecretStore` in src/core/platform.ts, the caller `AndroidSecrets`
 * in src/android/secrets.ts): small strings – today the WebDAV app password – sealed with an
 * AES-256-GCM key that lives in the Android Keystore and never leaves it, the sealed values in a
 * private SharedPreferences file. The desktop's `SafeStorageSecrets` over `secrets.json`.
 *
 * A value is sealed under its own key name (the name is the GCM's associated data), so a sealed
 * text copied to another name does not open. The key is not authentication-bound, unlike the
 * password vault's: the sync engine reads the password on its background beats, when nobody is
 * there to pass a prompt. Nothing here is ever logged: the value is the user's credential.
 *
 * Failure is quiet by design: a value that does not open (the key was replaced, the entry was
 * damaged) and a Keystore that cannot be used both read as *no value* – the engine then asks for
 * the password again (`authRefused`) – and only a write into a Keystore that cannot be used
 * refuses, with [UNAVAILABLE_PREFIX], which the chrome shows as a toast. Never a crash.
 *
 * Never opened at boot: [Host] creates its instance on the first `secrets.*` call, and the
 * Keystore and the preferences file are only touched inside the operation, on a worker thread.
 */
class Secrets(private val storage: Storage, private val keys: KeySource) {

    /** Where the sealed texts live, by key name. */
    interface Storage {
        fun read(key: String): String?
        fun write(key: String, sealed: String)
        fun remove(key: String)
    }

    /** Hands out the sealing key, or null when the key store cannot be used right now. */
    fun interface KeySource {
        fun key(): SecretKey?
    }

    /** A write cannot happen because there is no usable key store. */
    class Unavailable(message: String) : RuntimeException(message)

    /**
     * The value stored under [key], or null when there is none, when it does not open, or when
     * the key store is unusable. A stored text that does not open is dropped, so a later `set`
     * starts clean.
     */
    fun get(key: String): String? {
        val sealed = storage.read(key) ?: return null
        val secret = obtainKey() ?: return null
        return try {
            open(secret, key, sealed)
        } catch (e: GeneralSecurityException) {
            // AEADBadTagException and kin: the key changed, or the text was damaged.
            storage.remove(key)
            null
        } catch (e: IllegalArgumentException) {
            // Not a sealed text at all.
            storage.remove(key)
            null
        } catch (e: RuntimeException) {
            // The Keystore's own refusals (`ProviderException`): the store is unusable right now.
            null
        }
    }

    /** Seal [value] under [key], replacing what was there. Throws [Unavailable] when there is no key store to seal with. */
    fun set(key: String, value: String) {
        val secret = obtainKey() ?: throw Unavailable(UNAVAILABLE_MESSAGE)
        storage.write(key, seal(secret, key, value))
    }

    fun delete(key: String) {
        storage.remove(key)
    }

    /** The key, or null for any failure of the store – `GeneralSecurityException`, `IOException`, the Keystore's `ProviderException`. */
    private fun obtainKey(): SecretKey? = try {
        keys.key()
    } catch (e: GeneralSecurityException) {
        null
    } catch (e: IOException) {
        null
    } catch (e: RuntimeException) {
        null
    }

    companion object {
        /** The bridge's rejection prefix for a refused write; the message after it is the toast. */
        const val UNAVAILABLE_PREFIX = "secrets-unavailable:"
        const val UNAVAILABLE_MESSAGE = "The Android Keystore is unavailable on this device, so a password cannot be kept here"

        /** The preferences file holding the sealed values (`Context.MODE_PRIVATE`). */
        const val PREFERENCES_FILE = "zenium-secrets"
        /** The Keystore alias of the sealing key. */
        const val KEY_ALIAS = "zenium-secrets-key"
        private const val ANDROID_KEYSTORE = "AndroidKeyStore"
        private const val TRANSFORMATION = "AES/GCM/NoPadding"
        private const val TAG_BITS = 128
        /** The sealed text's format: `v1.<base64 iv>.<base64 ciphertext+tag>`. */
        private const val FORMAT = "v1"

        /** The device's store: a Keystore key under [KEY_ALIAS], the sealed texts in [PREFERENCES_FILE]. */
        fun onDevice(context: Context): Secrets {
            val app = context.applicationContext
            return Secrets(PreferencesStorage(app), KeystoreKeys())
        }

        /** Seal [value] under [name]; a fresh random IV each time (the cipher draws it). */
        fun seal(key: SecretKey, name: String, value: String): String {
            val cipher = Cipher.getInstance(TRANSFORMATION)
            cipher.init(Cipher.ENCRYPT_MODE, key)
            cipher.updateAAD(name.toByteArray())
            val sealed = cipher.doFinal(value.toByteArray())
            val b64 = Base64.getEncoder()
            return "$FORMAT.${b64.encodeToString(cipher.iv)}.${b64.encodeToString(sealed)}"
        }

        /** Open a [seal]ed text; a wrong key, a wrong [name] or a damaged text throw (`AEADBadTagException`, `IllegalArgumentException`). */
        fun open(key: SecretKey, name: String, sealed: String): String {
            val parts = sealed.split('.')
            require(parts.size == 3 && parts[0] == FORMAT) { "not a sealed value" }
            val b64 = Base64.getDecoder()
            val iv = b64.decode(parts[1])
            val cipher = Cipher.getInstance(TRANSFORMATION)
            cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(TAG_BITS, iv))
            cipher.updateAAD(name.toByteArray())
            return String(cipher.doFinal(b64.decode(parts[2])))
        }
    }

    /** The sealed texts in a private preferences file, opened on first use (a worker thread's). */
    private class PreferencesStorage(private val context: Context) : Storage {
        private fun prefs() = context.getSharedPreferences(PREFERENCES_FILE, Context.MODE_PRIVATE)
        override fun read(key: String): String? = prefs().getString(key, null)
        override fun write(key: String, sealed: String) {
            prefs().edit().putString(key, sealed).commit()
        }
        override fun remove(key: String) {
            prefs().edit().remove(key).commit()
        }
    }

    /**
     * The Keystore's AES-256-GCM key under [KEY_ALIAS], minted on first use: purposes encrypt and
     * decrypt, no authentication binding (the engine reads on background beats). Any failure to
     * load the provider or mint the key reads as no key (`null`).
     */
    private class KeystoreKeys : KeySource {
        @Synchronized
        override fun key(): SecretKey? {
            val store = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
            (store.getKey(KEY_ALIAS, null) as? SecretKey)?.let { return it }
            val spec = KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build()
            val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE)
            generator.init(spec)
            return generator.generateKey()
        }
    }
}
