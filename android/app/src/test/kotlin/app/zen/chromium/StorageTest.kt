package app.zen.chromium

import app.zen.chromium.ext.ZipFixtures
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/** The JSON documents under `files/zen/` (the extension registry among them) round-trip through atomic writes. */
class StorageTest {
    private val dir = ZipFixtures.tempDir("zen-storage")
    private val storage = Storage(dir)
    private val registry = """
        {"version":2,"extensions":[{"id":"ddkjiahejlhfcafbddmgiahcphecmpfh","source":"chrome-web-store","path":"/data/user/0/app/files/zen/extensions/ddkjiahejlhfcafbddmgiahcphecmpfh/2025.1.1","version":"2025.1.1","publisher":"chrome-web-store","updateUrl":"https://clients2.google.com/service/update2/crx","installedAt":1,"updatedAt":1,"enabled":true,"pinned":false,"allowFileAccess":false,"manifestVersion":3,"name":"uBlock Origin Lite","description":"","permissions":["declarativeNetRequest"],"hostPermissions":[],"optionsPage":"dashboard.html","popup":"popup.html","pendingWarnings":null}],"lastUpdateCheck":null}
    """.trimIndent()

    @After
    fun cleanUp() {
        dir.deleteRecursively()
    }

    @Test
    fun aSynchronousWriteRoundTripsAndLeavesNoTempFile() {
        storage.writeSync("extensions.json", registry)
        assertEquals(registry, storage.read("extensions.json"))
        assertEquals(registry, File(dir, "extensions.json").readText())
        assertFalse(File(dir, "extensions.json.tmp").exists())
    }

    @Test
    fun anAsynchronousWriteReportsWhenItIsOnDisk() {
        val done = CountDownLatch(1)
        storage.write("extensions.json", registry) { done.countDown() }
        assertTrue(done.await(10, TimeUnit.SECONDS))
        assertEquals(registry, storage.read("extensions.json"))
    }

    @Test
    fun aRewriteReplacesTheDocumentWhole() {
        storage.writeSync("extensions.json", registry)
        storage.writeSync("extensions.json", """{"version":2,"extensions":[],"lastUpdateCheck":5}""")
        assertEquals("""{"version":2,"extensions":[],"lastUpdateCheck":5}""", storage.read("extensions.json"))
        assertEquals(listOf("extensions.json"), dir.list()!!.toList())
    }

    @Test
    fun namesStayInsideTheDirectory() {
        storage.writeSync("../escape.json", "{}")
        assertNull(File(dir.parentFile, "escape.json").takeIf { it.exists() })
        assertEquals("{}", storage.read("../escape.json"))
        assertEquals(listOf(".._escape.json"), dir.list()!!.toList())
        assertNull(storage.read("missing.json"))
    }
}
