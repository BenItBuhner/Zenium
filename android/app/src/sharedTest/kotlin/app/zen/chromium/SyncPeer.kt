package app.zen.chromium

import org.json.JSONArray
import org.json.JSONObject
import java.security.MessageDigest
import java.security.SecureRandom
import java.text.Normalizer
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec
import kotlin.math.min

/**
 * A second device for the sync demo, in the harness's own hands: the file another Zenium writes
 * into a sync folder's `zenium-sync` directory (`DeviceFile` in `src/core/sync/transport.ts`),
 * produced here from the passphrase alone, so a driver seeds it into the tree it granted and the
 * app's engine reads it as it would a laptop's. The format is the engine's, bit for bit: scrypt
 * (RFC 7914; N 2^15, r 8, p 1, a 32-byte key) over the NFKC-normalised passphrase and the
 * folder's salt, AES-256-GCM with a 12-byte IV and a 16-byte tag, base64 in the envelope's four
 * fields, the device's identity in the clear beside it. Compiled into the unit tests and the
 * instrumentation alike (`src/sharedTest`), never into the app: `SyncPeerTest` holds the
 * derivation to RFC 7914's vectors and the whole of it to the pre-move engine's fixture
 * (`src/core/sync/__tests__/fixtures/legacy-device-file.json`) – the same key from the same
 * passphrase and salt, the same plaintext out of its envelope – and the run then proves the
 * engine decrypts what this writes.
 */
object SyncPeer {
    /** scrypt parameters every device derives with (`SCRYPT_PARAMS` in `crypto.ts`). */
    const val SCRYPT_N = 1 shl 15
    const val SCRYPT_R = 8
    const val SCRYPT_P = 1
    const val KEY_BYTES = 32
    private const val IV_BYTES = 12
    private const val TAG_BYTES = 16
    private const val FILE_EXT = ".zensync"

    // --- the device file -------------------------------------------------------------------------

    /** `<deviceId>.zensync`, the id reduced to characters every file system accepts (`deviceFileName`). */
    fun deviceFileName(deviceId: String): String = deviceId.replace(Regex("[^a-zA-Z0-9_-]"), "_") + FILE_EXT

    /** One record of a device's set (`SyncRecord`): `modified` is the device's wall clock at the edit. */
    fun record(id: String, type: String, modified: Long, data: JSONObject, deleted: Boolean = false): JSONObject =
        JSONObject().put("id", id).put("type", type).put("modified", modified).put("deleted", deleted).put("data", data)

    /** The plaintext a device encrypts: `{ v: 1, records }`. */
    fun payload(records: List<JSONObject>): String =
        JSONObject().put("v", 1).put("records", JSONArray(records)).toString()

    /** The text of a device file: identity in the clear, the payload under the shared key. */
    fun deviceFile(deviceId: String, deviceName: String, updatedAt: Long, envelope: JSONObject): String =
        JSONObject()
            .put("deviceId", deviceId)
            .put("deviceName", deviceName)
            .put("updatedAt", updatedAt)
            .put("envelope", envelope)
            .toString()

    /** The salt a device file's envelope carries (the folder's, shared by every device through the first file). */
    fun saltOf(deviceFileText: String): String = JSONObject(deviceFileText).getJSONObject("envelope").getString("salt")

    // --- the key ---------------------------------------------------------------------------------

    /** The bytes scrypt hashes: the passphrase NFKC-normalised, UTF-8 (`passphraseBytes`). */
    fun passphraseBytes(passphrase: String): ByteArray =
        Normalizer.normalize(passphrase, Normalizer.Form.NFKC).toByteArray(Charsets.UTF_8)

    /** scrypt(passphrase, salt) with the engine's parameters: the 32-byte AES key. */
    fun deriveKey(passphrase: String, saltB64: String): ByteArray =
        scrypt(passphraseBytes(passphrase), Base64.getDecoder().decode(saltB64), SCRYPT_N, SCRYPT_R, SCRYPT_P, KEY_BYTES)

    // --- the envelope ----------------------------------------------------------------------------

    /** AES-256-GCM over `plaintext` under `key`: the envelope as the engine writes it (a fresh IV each time). */
    fun encrypt(key: ByteArray, saltB64: String, plaintext: String): JSONObject {
        require(key.size == KEY_BYTES) { "AES-256 needs a 32-byte key" }
        val iv = ByteArray(IV_BYTES).also(SecureRandom()::nextBytes)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(TAG_BYTES * 8, iv))
        val sealed = cipher.doFinal(plaintext.toByteArray(Charsets.UTF_8))
        val split = sealed.size - TAG_BYTES
        val b64 = Base64.getEncoder()
        return JSONObject()
            .put("v", 1)
            .put("salt", saltB64)
            .put("iv", b64.encodeToString(iv))
            .put("tag", b64.encodeToString(sealed.copyOfRange(split, sealed.size)))
            .put("ciphertext", b64.encodeToString(sealed.copyOfRange(0, split)))
    }

    /** The plaintext of an envelope under `key`; throws when the key is wrong or the file was tampered with. */
    fun decrypt(key: ByteArray, envelope: JSONObject): String {
        val b64 = Base64.getDecoder()
        val iv = b64.decode(envelope.getString("iv"))
        val tag = b64.decode(envelope.getString("tag"))
        val ciphertext = b64.decode(envelope.getString("ciphertext"))
        require(iv.size == IV_BYTES && tag.size == TAG_BYTES) { "malformed envelope" }
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(TAG_BYTES * 8, iv))
        return cipher.doFinal(ciphertext + tag).toString(Charsets.UTF_8)
    }

    // --- scrypt (RFC 7914) -----------------------------------------------------------------------

    /**
     * scrypt as RFC 7914 §6 lays it out: PBKDF2-HMAC-SHA256 (one iteration) into `p` blocks of
     * 128·r bytes, ROMix over each with `n` rounds of BlockMix (Salsa20/8 at the core), PBKDF2 once
     * more over the mixed blocks to `dkLen`. `n` is a power of two. The work runs on 32-bit words
     * in little-endian order, the way the standard's C reads them.
     */
    fun scrypt(password: ByteArray, salt: ByteArray, n: Int, r: Int, p: Int, dkLen: Int): ByteArray {
        require(n > 1 && (n and (n - 1)) == 0) { "N must be a power of two greater than 1" }
        require(r > 0 && p > 0 && dkLen > 0)
        val blockBytes = 128 * r
        val words = 32 * r
        val b = pbkdf2HmacSha256(password, salt, p * blockBytes)
        val x = IntArray(words)
        val y = IntArray(words)
        val t = IntArray(16)
        val u = IntArray(16)
        val v = IntArray(words * n)
        for (i in 0 until p) {
            for (k in 0 until words) x[k] = readLe(b, i * blockBytes + 4 * k)
            roMix(x, y, t, u, v, n, r)
            for (k in 0 until words) writeLe(b, i * blockBytes + 4 * k, x[k])
        }
        return pbkdf2HmacSha256(password, b, dkLen)
    }

    /** ROMix (§5): `n` blocks of memory filled forward, then `n` lookups steered by the block itself. */
    private fun roMix(x: IntArray, y: IntArray, t: IntArray, u: IntArray, v: IntArray, n: Int, r: Int) {
        val words = 32 * r
        for (i in 0 until n) {
            System.arraycopy(x, 0, v, i * words, words)
            blockMix(x, y, t, u, r)
        }
        val mask = n - 1
        for (i in 0 until n) {
            // Integerify: the first word of the last 64-byte block, little-endian; N is a power of two.
            val j = x[(2 * r - 1) * 16] and mask
            val at = j * words
            for (k in 0 until words) x[k] = x[k] xor v[at + k]
            blockMix(x, y, t, u, r)
        }
    }

    /** BlockMix (§4): Salsa20/8 chained across the 2r blocks, the even outputs first, then the odd. */
    private fun blockMix(x: IntArray, y: IntArray, t: IntArray, u: IntArray, r: Int) {
        System.arraycopy(x, (2 * r - 1) * 16, t, 0, 16)
        for (i in 0 until 2 * r) {
            for (k in 0 until 16) t[k] = t[k] xor x[i * 16 + k]
            salsa20x8(t, u)
            val at = if (i % 2 == 0) (i / 2) * 16 else (r + i / 2) * 16
            System.arraycopy(t, 0, y, at, 16)
        }
        System.arraycopy(y, 0, x, 0, 32 * r)
    }

    /** The Salsa20/8 core (§3) over 16 words in place; `x` is scratch. */
    private fun salsa20x8(b: IntArray, x: IntArray) {
        System.arraycopy(b, 0, x, 0, 16)
        for (round in 0 until 4) {
            x[4] = x[4] xor rotl(x[0] + x[12], 7); x[8] = x[8] xor rotl(x[4] + x[0], 9)
            x[12] = x[12] xor rotl(x[8] + x[4], 13); x[0] = x[0] xor rotl(x[12] + x[8], 18)
            x[9] = x[9] xor rotl(x[5] + x[1], 7); x[13] = x[13] xor rotl(x[9] + x[5], 9)
            x[1] = x[1] xor rotl(x[13] + x[9], 13); x[5] = x[5] xor rotl(x[1] + x[13], 18)
            x[14] = x[14] xor rotl(x[10] + x[6], 7); x[2] = x[2] xor rotl(x[14] + x[10], 9)
            x[6] = x[6] xor rotl(x[2] + x[14], 13); x[10] = x[10] xor rotl(x[6] + x[2], 18)
            x[3] = x[3] xor rotl(x[15] + x[11], 7); x[7] = x[7] xor rotl(x[3] + x[15], 9)
            x[11] = x[11] xor rotl(x[7] + x[3], 13); x[15] = x[15] xor rotl(x[11] + x[7], 18)
            x[1] = x[1] xor rotl(x[0] + x[3], 7); x[2] = x[2] xor rotl(x[1] + x[0], 9)
            x[3] = x[3] xor rotl(x[2] + x[1], 13); x[0] = x[0] xor rotl(x[3] + x[2], 18)
            x[6] = x[6] xor rotl(x[5] + x[4], 7); x[7] = x[7] xor rotl(x[6] + x[5], 9)
            x[4] = x[4] xor rotl(x[7] + x[6], 13); x[5] = x[5] xor rotl(x[4] + x[7], 18)
            x[11] = x[11] xor rotl(x[10] + x[9], 7); x[8] = x[8] xor rotl(x[11] + x[10], 9)
            x[9] = x[9] xor rotl(x[8] + x[11], 13); x[10] = x[10] xor rotl(x[9] + x[8], 18)
            x[12] = x[12] xor rotl(x[15] + x[14], 7); x[13] = x[13] xor rotl(x[12] + x[15], 9)
            x[14] = x[14] xor rotl(x[13] + x[12], 13); x[15] = x[15] xor rotl(x[14] + x[13], 18)
        }
        for (k in 0 until 16) b[k] += x[k]
    }

    private fun rotl(value: Int, bits: Int): Int = (value shl bits) or (value ushr (32 - bits))

    private fun readLe(bytes: ByteArray, at: Int): Int =
        (bytes[at].toInt() and 0xff) or
            ((bytes[at + 1].toInt() and 0xff) shl 8) or
            ((bytes[at + 2].toInt() and 0xff) shl 16) or
            ((bytes[at + 3].toInt() and 0xff) shl 24)

    private fun writeLe(bytes: ByteArray, at: Int, value: Int) {
        bytes[at] = value.toByte()
        bytes[at + 1] = (value ushr 8).toByte()
        bytes[at + 2] = (value ushr 16).toByte()
        bytes[at + 3] = (value ushr 24).toByte()
    }

    /**
     * PBKDF2 with HMAC-SHA256 and one iteration (all scrypt asks for): block `i` of the output is
     * HMAC(password, salt ‖ INT(i)). HMAC by hand over MessageDigest, so an empty password (the
     * first of RFC 7914's vectors) hashes like any other rather than being refused as a key.
     */
    private fun pbkdf2HmacSha256(password: ByteArray, salt: ByteArray, dkLen: Int): ByteArray {
        val out = ByteArray(dkLen)
        var block = 1
        var at = 0
        while (at < dkLen) {
            val counter = byteArrayOf((block ushr 24).toByte(), (block ushr 16).toByte(), (block ushr 8).toByte(), block.toByte())
            val u = hmacSha256(password, salt + counter)
            val take = min(u.size, dkLen - at)
            System.arraycopy(u, 0, out, at, take)
            at += take
            block++
        }
        return out
    }

    private fun hmacSha256(key: ByteArray, message: ByteArray): ByteArray {
        val digest = MessageDigest.getInstance("SHA-256")
        val block = ByteArray(64)
        val k = if (key.size > 64) digest.digest(key) else key
        System.arraycopy(k, 0, block, 0, k.size)
        val inner = ByteArray(64) { (block[it].toInt() xor 0x36).toByte() }
        val outer = ByteArray(64) { (block[it].toInt() xor 0x5c).toByte() }
        digest.reset()
        digest.update(inner)
        digest.update(message)
        val innerHash = digest.digest()
        digest.reset()
        digest.update(outer)
        digest.update(innerHash)
        return digest.digest()
    }
}
