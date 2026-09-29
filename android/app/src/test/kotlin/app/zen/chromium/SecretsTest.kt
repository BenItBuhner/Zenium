package app.zen.chromium

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Assume.assumeTrue
import org.junit.Test
import java.io.File
import java.io.IOException
import java.security.GeneralSecurityException
import java.security.ProviderException
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.SecretKeySpec

/**
 * `Secrets` through its two seams – the sealed texts in a map, the key from a plain JVM AES key
 * in the Keystore's place (the same `AES/GCM/NoPadding` path the device runs; only the key's
 * home differs). What the phone must get right: a value opens only under its own name and its
 * own key, anything else reads as no value and is dropped, and a key store that cannot be used
 * is no value on a read and a named refusal on a write – never an exception out of the store.
 */
class SecretsTest {
    private class MapStorage : Secrets.Storage {
        val values = LinkedHashMap<String, String>()
        override fun read(key: String): String? = values[key]
        override fun write(key: String, sealed: String) {
            values[key] = sealed
        }
        override fun remove(key: String) {
            values.remove(key)
        }
    }

    private fun aesKey(): SecretKey = KeyGenerator.getInstance("AES").apply { init(256) }.generateKey()

    private fun store(storage: MapStorage = MapStorage(), key: SecretKey? = aesKey()): Secrets =
        Secrets(storage, Secrets.KeySource { key })

    /**
     * A key the cipher refuses at `init` with a `GeneralSecurityException` that is not a bad tag –
     * on the JVM `InvalidKeyException("Wrong algorithm")`, on the device AndroidKeyStore's
     * `InvalidKeyException("Keystore operation failed")` after a transient keystore2 failure.
     */
    private fun wrongAlgorithmKey(): SecretKey = SecretKeySpec(ByteArray(8), "DES")

    /** A key whose bytes the provider refuses to hand out at `init` – the Keystore's `ProviderException`, a RuntimeException. */
    private fun refusingKey(): SecretKey = object : SecretKey {
        override fun getAlgorithm() = "AES"
        override fun getFormat() = "RAW"
        override fun getEncoded(): ByteArray = throw ProviderException("Keystore operation failed")
    }

    @Test
    fun `a value goes round - sealed on the way in, opened on the way out, gone after delete`() {
        val storage = MapStorage()
        val secrets = store(storage)
        assertNull(secrets.get("sync.webdav.password"))
        secrets.set("sync.webdav.password", "app-pass")
        assertEquals("app-pass", secrets.get("sync.webdav.password"))
        val sealed = storage.values["sync.webdav.password"]!!
        assertTrue(sealed.startsWith("v1."))
        assertEquals(3, sealed.split('.').size)
        assertFalse(sealed.contains("app-pass"))
        secrets.set("sync.webdav.password", "rotated")
        assertEquals("rotated", secrets.get("sync.webdav.password"))
        secrets.delete("sync.webdav.password")
        assertNull(secrets.get("sync.webdav.password"))
        assertFalse(storage.values.containsKey("sync.webdav.password"))
        secrets.delete("sync.webdav.password")
    }

    @Test
    fun `the same value sealed twice reads differently on the wire - a fresh IV each time`() {
        val storage = MapStorage()
        val secrets = store(storage)
        secrets.set("a", "same")
        val first = storage.values["a"]
        secrets.set("a", "same")
        assertNotEquals(first, storage.values["a"])
        assertEquals("same", secrets.get("a"))
    }

    @Test
    fun `a sealed text copied under another name does not open there, and is dropped`() {
        val storage = MapStorage()
        val secrets = store(storage)
        secrets.set("a", "for a")
        storage.values["b"] = storage.values["a"]!!
        assertNull(secrets.get("b"))
        assertFalse(storage.values.containsKey("b"))
        assertEquals("for a", secrets.get("a"))
    }

    @Test
    fun `a damaged text, a text that is not sealed and a text from another key all read as no value and are dropped`() {
        val storage = MapStorage()
        val secrets = store(storage)
        secrets.set("a", "value")
        val sealed = storage.values["a"]!!
        val parts = sealed.split('.').toMutableList()
        val last = parts[2]
        parts[2] = (if (last[0] == 'A') "B" else "A") + last.substring(1)
        storage.values["a"] = parts.joinToString(".")
        assertNull(secrets.get("a"))
        assertFalse(storage.values.containsKey("a"))

        storage.values["b"] = "not a sealed value"
        assertNull(secrets.get("b"))
        assertFalse(storage.values.containsKey("b"))
        storage.values["c"] = "v1.!!!.???"
        assertNull(secrets.get("c"))
        assertFalse(storage.values.containsKey("c"))

        storage.values["d"] = sealed
        val otherKey = store(storage, aesKey())
        assertNull(otherKey.get("d"))
        assertFalse(storage.values.containsKey("d"))
    }

    @Test
    fun `no usable key store - a read is no value and keeps the text, a write is a named refusal, a delete goes through`() {
        val storage = MapStorage()
        store(storage).set("a", "kept")
        val sealed = storage.values["a"]!!

        for (broken in listOf<Secrets.KeySource>(
            Secrets.KeySource { null },
            Secrets.KeySource { throw GeneralSecurityException("keystore refused") },
            Secrets.KeySource { throw IOException("keystore file unreadable") },
            Secrets.KeySource { throw ProviderException("Failed to generate key") }
        )) {
            val secrets = Secrets(storage, broken)
            assertNull(secrets.get("a"))
            assertEquals(sealed, storage.values["a"])
            try {
                secrets.set("a", "new")
                fail("a write into no key store must refuse")
            } catch (e: Secrets.Unavailable) {
                assertEquals(Secrets.UNAVAILABLE_MESSAGE, e.message)
            }
            assertEquals(sealed, storage.values["a"])
        }
        val secrets = Secrets(storage, Secrets.KeySource { null })
        secrets.delete("a")
        assertFalse(storage.values.containsKey("a"))
    }

    @Test
    fun `a key the cipher refuses at init is the store unusable right now - a read is no value and the sealed text survives for the next beat`() {
        val storage = MapStorage()
        val key = aesKey()
        store(storage, key).set("a", "kept")
        val sealed = storage.values["a"]!!

        // A GeneralSecurityException out of `init` that is no bad tag: not a damaged text, so not dropped.
        val wrongAlgorithm = Secrets(storage, Secrets.KeySource { wrongAlgorithmKey() })
        assertNull(wrongAlgorithm.get("a"))
        assertEquals(sealed, storage.values["a"])
        // The Keystore's ProviderException out of `init`: the same case.
        val refusing = Secrets(storage, Secrets.KeySource { refusingKey() })
        assertNull(refusing.get("a"))
        assertEquals(sealed, storage.values["a"])

        // The next beat, the key store back: the text opens as it did.
        assertEquals("kept", store(storage, key).get("a"))
        // Whereas a text that will never open again is still dropped.
        assertNull(store(storage, aesKey()).get("a"))
        assertFalse(storage.values.containsKey("a"))
    }

    @Test
    fun `a key the cipher refuses at seal time is the same named refusal as no key at all, and nothing is written`() {
        val storage = MapStorage()
        store(storage).set("a", "kept")
        val sealed = storage.values["a"]!!
        for (refusing in listOf<Secrets.KeySource>(
            Secrets.KeySource { wrongAlgorithmKey() },
            Secrets.KeySource { refusingKey() }
        )) {
            val secrets = Secrets(storage, refusing)
            for (name in listOf("a", "b")) {
                try {
                    secrets.set(name, "new")
                    fail("a write the key store cannot seal must refuse")
                } catch (e: Secrets.Unavailable) {
                    assertEquals(Secrets.UNAVAILABLE_MESSAGE, e.message)
                }
            }
            assertEquals(sealed, storage.values["a"])
            assertFalse(storage.values.containsKey("b"))
        }
    }

    @Test
    fun `seal and open are the one format, with the name as the associated data`() {
        val key = aesKey()
        val sealed = Secrets.seal(key, "sync.webdav.password", "app-pass")
        assertEquals("app-pass", Secrets.open(key, "sync.webdav.password", sealed))
        try {
            Secrets.open(key, "another.name", sealed)
            fail("another name must not open the value")
        } catch (e: GeneralSecurityException) {
            // AEADBadTagException: the tag covers the name.
        }
        try {
            Secrets.open(key, "sync.webdav.password", "v2.$sealed")
            fail("another format must not open")
        } catch (e: IllegalArgumentException) {
            // not a sealed value
        }
        assertEquals("", Secrets.open(key, "empty", Secrets.seal(key, "empty", "")))
        val unicode = "pässwörd ✓ 🔑"
        assertEquals(unicode, Secrets.open(key, "u", Secrets.seal(key, "u", unicode)))
    }

    // --- the sides that read these --------------------------------------------------------------------

    /** A file of the repository, from wherever Gradle runs the test (the module directory, or the root). */
    private fun repoFile(path: String): File? {
        var dir: File? = File("").absoluteFile
        while (dir != null) {
            val file = File(dir, path)
            if (file.isFile) return file
            dir = dir.parentFile
        }
        return null
    }

    @Test
    fun `the chrome's side strips the same refusal prefix, the engine names the key, and Host runs the store off the main thread`() {
        val ts = repoFile("src/android/secrets.ts")
        val webdav = repoFile("src/core/sync/webdav.ts")
        val host = repoFile("android/app/src/main/kotlin/app/zen/chromium/Host.kt")
        assumeTrue("the repository is not beside the module", ts != null && webdav != null && host != null)
        assertTrue(ts!!.readText().contains("export const SECRETS_UNAVAILABLE_PREFIX = '${Secrets.UNAVAILABLE_PREFIX}'"))
        assertTrue(webdav!!.readText().contains("export const WEBDAV_SECRET_KEY = 'sync.webdav.password'"))
        val dispatch = host!!.readText()
        assertTrue(dispatch.contains("\"secrets.get\" -> secretsOp(reply) { it.get(args.str(\"key\")) }"))
        assertTrue(dispatch.contains("\"secrets.set\" -> secretsOp(reply) { it.set(args.str(\"key\"), args.str(\"value\")); null }"))
        assertTrue(dispatch.contains("\"secrets.delete\" -> secretsOp(reply) { it.delete(args.str(\"key\")); null }"))
        assertTrue(dispatch.contains("Rejection(\"\${Secrets.UNAVAILABLE_PREFIX} \${e.message}\")"))
        val body = dispatch.substringAfter("private fun secretsOp(").substringBefore("fun attachHidden")
        assertTrue(body.contains("io.execute {"))
        assertTrue(body.contains("main.post { reply(result) }"))
        // Never the value in a log line.
        assertFalse(body.contains("args.str(\"value\")"))
        assertFalse(body.contains("Log.w(TAG, \"secret store operation failed\", e)"))
    }

    @Test
    fun `the device store is built lazily - a field that is null until the first call`() {
        val host = repoFile("android/app/src/main/kotlin/app/zen/chromium/Host.kt")
        assumeTrue("the repository is not beside the module", host != null)
        val text = host!!.readText()
        assertTrue(text.contains("private var secrets: Secrets? = null"))
        assertTrue(text.contains("val store = secrets ?: Secrets.onDevice(activity).also { secrets = it }"))
        // The Secrets class touches neither the Keystore nor the preferences in a constructor.
        val secrets = repoFile("android/app/src/main/kotlin/app/zen/chromium/Secrets.kt")!!.readText()
        assertFalse(secrets.contains("init {"))
        assertTrue(secrets.contains("private fun prefs() = context.getSharedPreferences(PREFERENCES_FILE, Context.MODE_PRIVATE)"))
    }
}
