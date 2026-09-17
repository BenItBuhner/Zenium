package app.zen.chromium

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.security.SecureRandom
import javax.crypto.AEADBadTagException
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey

/**
 * The vault key wrapping as the Keystore performs it on the device, exercised here with software
 * AES keys: the same `VaultCipher` code path, minus the hardware.
 */
class VaultKeyBlobTest {
    private val random = SecureRandom()

    private fun aesKey(): SecretKey = KeyGenerator.getInstance("AES").apply { init(256) }.generateKey()

    private fun dataKey(): ByteArray = ByteArray(VaultKeyBlob.DATA_KEY_BYTES).also(random::nextBytes)

    @Test
    fun wrapThenUnwrapReturnsTheDataKey() {
        val key = aesKey()
        val dataKey = dataKey()
        val blob = VaultCipher.wrap(key, dataKey, authBound = true)
        assertEquals(VaultKeyBlob.IV_BYTES, blob.iv.size)
        assertEquals(VaultKeyBlob.DATA_KEY_BYTES + VaultKeyBlob.TAG_BYTES, blob.ciphertext.size)
        assertTrue(blob.authBound)
        assertArrayEquals(dataKey, VaultCipher.unwrap(key, blob))
    }

    @Test
    fun encodedBlobRoundTripsThroughText() {
        val key = aesKey()
        val dataKey = dataKey()
        val text = VaultCipher.wrap(key, dataKey, authBound = false).encode()
        assertTrue(text.startsWith("zenium-keystore:1:0:"))
        val parsed = VaultKeyBlob.parse(text)
        assertFalse(parsed.authBound)
        assertArrayEquals(dataKey, VaultCipher.unwrap(key, parsed))
        assertEquals(text, parsed.encode())
    }

    @Test
    fun everyWrappingUsesAFreshIv() {
        val key = aesKey()
        val dataKey = dataKey()
        val a = VaultCipher.wrap(key, dataKey, authBound = true)
        val b = VaultCipher.wrap(key, dataKey, authBound = true)
        assertFalse(a.iv.contentEquals(b.iv))
        assertFalse(a.ciphertext.contentEquals(b.ciphertext))
        assertNotEquals(a.encode(), b.encode())
    }

    @Test
    fun tamperedCiphertextFailsTheTagCheck() {
        val key = aesKey()
        val blob = VaultCipher.wrap(key, dataKey(), authBound = true)
        val flipped = blob.ciphertext.copyOf().also { it[3] = (it[3].toInt() xor 0x40).toByte() }
        assertThrows(AEADBadTagException::class.java) {
            VaultCipher.unwrap(key, VaultKeyBlob(blob.authBound, blob.iv, flipped))
        }
    }

    @Test
    fun tamperedIvFailsTheTagCheck() {
        val key = aesKey()
        val blob = VaultCipher.wrap(key, dataKey(), authBound = true)
        val iv = blob.iv.copyOf().also { it[0] = (it[0].toInt() xor 0x01).toByte() }
        assertThrows(AEADBadTagException::class.java) {
            VaultCipher.unwrap(key, VaultKeyBlob(blob.authBound, iv, blob.ciphertext))
        }
    }

    @Test
    fun anotherKeyCannotUnwrap() {
        val blob = VaultCipher.wrap(aesKey(), dataKey(), authBound = true)
        assertThrows(AEADBadTagException::class.java) { VaultCipher.unwrap(aesKey(), blob) }
    }

    @Test
    fun onlyThirtyTwoByteDataKeysAreWrapped() {
        val key = aesKey()
        assertThrows(IllegalArgumentException::class.java) { VaultCipher.wrap(key, ByteArray(16), authBound = false) }
        assertThrows(IllegalArgumentException::class.java) { VaultCipher.wrap(key, ByteArray(33), authBound = false) }
    }

    @Test
    fun parseRejectsForeignAndMalformedBlobs() {
        val good = VaultCipher.wrap(aesKey(), dataKey(), authBound = true).encode()
        val parts = good.split(':')
        assertThrows(IllegalArgumentException::class.java) { VaultKeyBlob.parse("") }
        assertThrows(IllegalArgumentException::class.java) { VaultKeyBlob.parse("v10:" + good.substringAfter(':')) }
        assertThrows(IllegalArgumentException::class.java) { VaultKeyBlob.parse("other-app:" + good.substringAfter(':')) }
        // A future version, an unknown flag, junk base64, a short IV, a short ciphertext.
        assertThrows(IllegalArgumentException::class.java) {
            VaultKeyBlob.parse(listOf(parts[0], "2", parts[2], parts[3], parts[4]).joinToString(":"))
        }
        assertThrows(IllegalArgumentException::class.java) {
            VaultKeyBlob.parse(listOf(parts[0], parts[1], "yes", parts[3], parts[4]).joinToString(":"))
        }
        assertThrows(IllegalArgumentException::class.java) {
            VaultKeyBlob.parse(listOf(parts[0], parts[1], parts[2], "***", parts[4]).joinToString(":"))
        }
        assertThrows(IllegalArgumentException::class.java) {
            VaultKeyBlob.parse(listOf(parts[0], parts[1], parts[2], "AAAA", parts[4]).joinToString(":"))
        }
        assertThrows(IllegalArgumentException::class.java) {
            VaultKeyBlob.parse(listOf(parts[0], parts[1], parts[2], parts[3], "AAAA").joinToString(":"))
        }
        assertThrows(IllegalArgumentException::class.java) { VaultKeyBlob.parse(good.substringBeforeLast(':')) }
        assertThrows(IllegalArgumentException::class.java) { VaultKeyBlob.parse("$good:extra") }
    }
}
