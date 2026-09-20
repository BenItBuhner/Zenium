package app.zen.chromium

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import java.io.File

/**
 * The sync demo's second device ([SyncPeer]) writes what the engine reads: the key derivation
 * against RFC 7914's vectors, and the whole format against the pre-move engine's fixture
 * (`src/core/sync/__tests__/fixtures/legacy-device-file.json`, written by node:crypto at
 * 04bb7748 and pinned by `compat.test.ts` for the core): the same key from the same passphrase
 * and salt, the same plaintext out of its envelope.
 */
class SyncPeerTest {
    private fun hex(bytes: ByteArray): String = bytes.joinToString("") { "%02x".format(it) }

    // --- RFC 7914 §12 ----------------------------------------------------------------------------

    @Test
    fun `scrypt of the empty password and salt (N 16, r 1, p 1)`() {
        val out = SyncPeer.scrypt(ByteArray(0), ByteArray(0), 16, 1, 1, 64)
        assertEquals(
            "77d6576238657b203b19ca42c18a0497f16b4844e3074ae8dfdffa3fede21442" +
                "fcd0069ded0948f8326a753a0fc81f17e8d3e0fb2e0d3628cf35e20c38d18906",
            hex(out)
        )
    }

    @Test
    fun `scrypt of password and NaCl (N 1024, r 8, p 16)`() {
        val out = SyncPeer.scrypt("password".toByteArray(), "NaCl".toByteArray(), 1024, 8, 16, 64)
        assertEquals(
            "fdbabe1c9d3472007856e7190d01e9fe7c6ad7cbc8237830e77376634b373162" +
                "2eaf30d92e22a3886ff109279d9830dac727afb94a83ee6d8360cbdfa2cc0640",
            hex(out)
        )
    }

    @Test
    fun `scrypt of pleaseletmein and SodiumChloride (N 16384, r 8, p 1)`() {
        val out = SyncPeer.scrypt("pleaseletmein".toByteArray(), "SodiumChloride".toByteArray(), 16384, 8, 1, 64)
        assertEquals(
            "7023bdcb3afd7348461c06cd81fd38ebfda8fbba904f8e3ea9b543f6545da1f2" +
                "d5432955613f0fcf62d49705242a9af9e61e85dc0d651e40dfcf017b45575887",
            hex(out)
        )
    }

    // --- the engine's fixture --------------------------------------------------------------------

    /** The repository's fixture, from wherever Gradle runs the test (the module directory, or the root). */
    private fun fixture(): JSONObject? {
        var dir: File? = File("").absoluteFile
        while (dir != null) {
            val file = File(dir, "src/core/sync/__tests__/fixtures/legacy-device-file.json")
            if (file.isFile) return JSONObject(file.readText())
            dir = dir.parentFile
        }
        return null
    }

    @Test
    fun `derives the key the engine derives from the fixture's passphrase and salt`() {
        val fixture = fixture()
        assumeTrue("the core's fixture is not beside the module", fixture != null)
        val key = SyncPeer.deriveKey(fixture!!.getString("passphrase"), fixture.getString("salt"))
        assertEquals(fixture.getString("keyHex"), hex(key))
    }

    @Test
    fun `opens the fixture's envelope to the plaintext the old engine encrypted`() {
        val fixture = fixture()
        assumeTrue("the core's fixture is not beside the module", fixture != null)
        val key = SyncPeer.deriveKey(fixture!!.getString("passphrase"), fixture.getString("salt"))
        val envelope = fixture.getJSONObject("deviceFile").getJSONObject("envelope")
        assertEquals(fixture.getString("plaintext"), SyncPeer.decrypt(key, envelope))
        assertEquals(fixture.getString("salt"), SyncPeer.saltOf(fixture.getJSONObject("deviceFile").toString()))
    }

    // --- what the driver writes ------------------------------------------------------------------

    @Test
    fun `an envelope it seals opens under the same key and under no other`() {
        val key = SyncPeer.scrypt("orbit-lantern-quiet-42".toByteArray(), "salt".toByteArray(), 16, 8, 1, 32)
        val other = SyncPeer.scrypt("orbit-lantern-quiet-43".toByteArray(), "salt".toByteArray(), 16, 8, 1, 32)
        val plaintext = SyncPeer.payload(
            listOf(
                SyncPeer.record(
                    "bm_demo", "bookmark", 1_758_300_000_000L,
                    JSONObject().put("parentId", "2").put("index", 0).put("type", "url")
                        .put("title", "Zenium").put("url", "https://example.com/").put("dateAdded", 1_758_300_000_000L)
                )
            )
        )
        val envelope = SyncPeer.encrypt(key, "c2FsdA==", plaintext)
        assertEquals(1, envelope.getInt("v"))
        assertEquals("c2FsdA==", envelope.getString("salt"))
        assertEquals(plaintext, SyncPeer.decrypt(key, envelope))
        assertThrows(Exception::class.java) { SyncPeer.decrypt(other, envelope) }
        // A fresh IV every time: two seals of one text never read alike.
        assertNotEquals(envelope.getString("ciphertext"), SyncPeer.encrypt(key, "c2FsdA==", plaintext).getString("ciphertext"))
    }

    @Test
    fun `a device file carries the identity in the clear beside the envelope, under the engine's file name`() {
        val key = ByteArray(32) { it.toByte() }
        val envelope = SyncPeer.encrypt(key, "c2FsdA==", SyncPeer.payload(emptyList()))
        val text = SyncPeer.deviceFile("device_peer.1", "Work laptop", 1_758_300_000_000L, envelope)
        val parsed = JSONObject(text)
        assertEquals("device_peer.1", parsed.getString("deviceId"))
        assertEquals("Work laptop", parsed.getString("deviceName"))
        assertEquals(1_758_300_000_000L, parsed.getLong("updatedAt"))
        assertTrue(parsed.getJSONObject("envelope").has("ciphertext"))
        assertEquals("device_peer_1.zensync", SyncPeer.deviceFileName("device_peer.1"))
        assertEquals("c2FsdA==", SyncPeer.saltOf(text))
    }

    @Test
    fun `the passphrase is hashed NFKC-normalised, so composed and decomposed input agree`() {
        val composed = SyncPeer.passphraseBytes("caf\u00e9 latte")
        val decomposed = SyncPeer.passphraseBytes("cafe\u0301 latte")
        assertEquals(hex(composed), hex(decomposed))
    }
}
