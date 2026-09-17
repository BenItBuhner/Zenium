package app.zen.chromium

import java.security.GeneralSecurityException
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * The vault's wrapped data key as the JS core stores it in the vault document: the 32-byte data
 * key encrypted with AES-256-GCM under the Android Keystore key, plus the IV the Keystore chose and
 * whether that key demanded user authentication when the blob was written (informational; the
 * Keystore itself enforces it).
 *
 *     zenium-keystore:1:<auth 0|1>:<base64 iv>:<base64 ciphertext+tag>
 *
 * Pure Kotlin on purpose, so the format and the cipher logic run under plain JUnit.
 */
class VaultKeyBlob(val authBound: Boolean, val iv: ByteArray, val ciphertext: ByteArray) {
    init {
        require(iv.size == IV_BYTES) { "IV must be $IV_BYTES bytes, got ${iv.size}" }
        require(ciphertext.size == DATA_KEY_BYTES + TAG_BYTES) {
            "ciphertext must be ${DATA_KEY_BYTES + TAG_BYTES} bytes, got ${ciphertext.size}"
        }
    }

    fun encode(): String {
        val b64 = Base64.getEncoder()
        return "$PREFIX:$VERSION:${if (authBound) 1 else 0}:${b64.encodeToString(iv)}:${b64.encodeToString(ciphertext)}"
    }

    companion object {
        const val PREFIX = "zenium-keystore"
        const val VERSION = 1
        const val IV_BYTES = 12
        const val DATA_KEY_BYTES = 32
        const val TAG_BYTES = 16

        /** @throws IllegalArgumentException when the text is not a blob written by this format. */
        fun parse(text: String): VaultKeyBlob {
            val parts = text.split(':')
            require(parts.size == 5) { "not a Zenium keystore blob" }
            require(parts[0] == PREFIX) { "not a Zenium keystore blob" }
            require(parts[1] == VERSION.toString()) { "unsupported keystore blob version ${parts[1]}" }
            val authBound = when (parts[2]) {
                "0" -> false
                "1" -> true
                else -> throw IllegalArgumentException("malformed keystore blob")
            }
            val decoder = Base64.getDecoder()
            val iv = try { decoder.decode(parts[3]) } catch (e: IllegalArgumentException) {
                throw IllegalArgumentException("malformed keystore blob", e)
            }
            val ciphertext = try { decoder.decode(parts[4]) } catch (e: IllegalArgumentException) {
                throw IllegalArgumentException("malformed keystore blob", e)
            }
            return VaultKeyBlob(authBound, iv, ciphertext)
        }
    }
}

/**
 * AES-256-GCM around the data key with a fixed AAD, so a blob can only ever be a Zenium vault key
 * wrapping (any other ciphertext under the same key, or a tampered blob, fails the tag check).
 * Works with a Keystore key on the device and with any software `SecretKey` under JUnit.
 */
object VaultCipher {
    private const val TRANSFORMATION = "AES/GCM/NoPadding"
    private const val TAG_BITS = VaultKeyBlob.TAG_BYTES * 8
    private val AAD = "zenium-vault-data-key:1".toByteArray(Charsets.UTF_8)

    /** The Keystore (or the provider) picks a fresh random IV for every wrapping. */
    fun wrap(key: SecretKey, dataKey: ByteArray, authBound: Boolean): VaultKeyBlob {
        require(dataKey.size == VaultKeyBlob.DATA_KEY_BYTES) {
            "data key must be ${VaultKeyBlob.DATA_KEY_BYTES} bytes, got ${dataKey.size}"
        }
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, key)
        cipher.updateAAD(AAD)
        val ciphertext = cipher.doFinal(dataKey)
        return VaultKeyBlob(authBound, cipher.iv, ciphertext)
    }

    /**
     * @throws javax.crypto.AEADBadTagException when the blob was tampered with or written under
     *   another key; other `GeneralSecurityException`s bubble up (the Keystore's
     *   `UserNotAuthenticatedException` and `KeyPermanentlyInvalidatedException` among them).
     */
    fun unwrap(key: SecretKey, blob: VaultKeyBlob): ByteArray {
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(TAG_BITS, blob.iv))
        cipher.updateAAD(AAD)
        val dataKey = cipher.doFinal(blob.ciphertext)
        if (dataKey.size != VaultKeyBlob.DATA_KEY_BYTES) {
            throw GeneralSecurityException("unexpected data key length ${dataKey.size}")
        }
        return dataKey
    }
}
