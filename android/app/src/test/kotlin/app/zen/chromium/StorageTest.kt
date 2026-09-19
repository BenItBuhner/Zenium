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
    fun namesThatEscapeTheDirectoryAreRefused() {
        storage.writeSync("../escape.json", "{}")
        assertFalse(File(dir.parentFile, "escape.json").exists())
        assertNull(storage.read("../escape.json"))
        assertNull(storage.fileFor("../escape.json"))
        assertNull(storage.fileFor("a/b/c.json"))
        assertEquals(emptyList<String>(), dir.list()!!.toList())
        assertNull(storage.read("missing.json"))
    }

    @Test
    fun aDocumentWrittenInPiecesLandsWholeWithASurrogatePairAcrossTwoPieces() {
        val changed = ArrayList<String>()
        val listener: (String) -> Unit = { changed.add(it) }
        Storage.addChangeListener(listener)
        try {
            val doc = "{\"a\":\"" + "x".repeat(10) + "\uD83D\uDE42" + "y".repeat(10) + "\"}"
            val cut = doc.indexOf('\uD83D') + 1
            val token = storage.beginWrite("ext-storage/abc.json")!!
            assertTrue(storage.writeChunk(token, doc.substring(0, cut)))
            assertTrue(storage.writeChunk(token, doc.substring(cut)))
            assertTrue(storage.hasPending(token))
            assertEquals(emptyList<String>(), changed)
            assertTrue(storage.endWrite(token))
            assertFalse(storage.hasPending(token))
            assertEquals(doc, storage.read("ext-storage/abc.json"))
            assertEquals(listOf("abc.json"), File(dir, "ext-storage").list()!!.toList())
            assertEquals(listOf("ext-storage/abc.json"), changed)
            assertFalse(storage.endWrite(token))
            assertFalse(storage.writeChunk(token, "late"))
        } finally {
            Storage.removeChangeListener(listener)
        }
    }

    @Test
    fun anAbortedWriteInPiecesLeavesTheDocumentAndNoTempFile() {
        storage.writeSync("ext-storage/abc.json", "old")
        val token = storage.beginWrite("ext-storage/abc.json")!!
        assertTrue(storage.writeChunk(token, "new"))
        storage.abortWrite(token)
        assertEquals("old", storage.read("ext-storage/abc.json"))
        assertEquals(listOf("abc.json"), File(dir, "ext-storage").list()!!.toList())
        assertNull(storage.beginWrite("../escape.json"))
    }

    @Test
    fun twoWritesOfOneDocumentInFlightTogetherKeepTheirOwnTempFilesAndTheLastEndWins() {
        val first = storage.beginWrite("ext-storage/abc.json")!!
        val second = storage.beginWrite("ext-storage/abc.json")!!
        assertTrue(storage.writeChunk(first, "first"))
        assertTrue(storage.writeChunk(second, "second"))
        assertEquals(2, File(dir, "ext-storage").list()!!.count { it.endsWith(".tmp") })
        assertTrue(storage.endWrite(first))
        assertEquals("first", storage.read("ext-storage/abc.json"))
        assertTrue(storage.endWrite(second))
        assertEquals("second", storage.read("ext-storage/abc.json"))
        assertEquals(listOf("abc.json"), File(dir, "ext-storage").list()!!.toList())
    }

    @Test
    fun aDocumentIsReadInPiecesUntilNull() {
        val doc = "a".repeat(2 * 1024 * 1024 + 3)
        storage.writeSync("ext-storage/abc.json", doc)
        assertNull(storage.beginRead("ext-storage/missing.json"))
        val token = storage.beginRead("ext-storage/abc.json")!!
        val pieces = ArrayList<String>()
        while (true) pieces.add(storage.readChunk(token, 1 shl 20) ?: break)
        assertEquals(listOf(1 shl 20, 1 shl 20, 3), pieces.map { it.length })
        assertEquals(doc, pieces.joinToString(""))
        assertFalse(storage.hasPending(token))
        assertNull(storage.readChunk(token, 1 shl 20))
        val early = storage.beginRead("ext-storage/abc.json")!!
        assertEquals(7, storage.readChunk(early, 7)!!.length)
        storage.endRead(early)
        assertFalse(storage.hasPending(early))
    }

    @Test
    fun legacyExtensionStorageMovesIntoItsFolderAndOutOfTheBootPayload() {
        File(dir, "ext-storage-abc.json").writeText("""{"local":{"a":1}}""")
        File(dir, "ext-storage-def.json").writeText("""{"local":{"d":1}}""")
        File(dir, "ext-storage").mkdirs()
        File(dir, "ext-storage/def.json").writeText("""{"local":{"d":2}}""")
        File(dir, "extensions.json").writeText(registry)
        val fresh = Storage(dir)
        assertEquals("""{"local":{"a":1}}""", fresh.read("ext-storage/abc.json"))
        assertEquals("""{"local":{"d":2}}""", fresh.read("ext-storage/def.json"))
        assertEquals(listOf("ext-storage", "extensions.json"), dir.list()!!.sorted())
        assertEquals(listOf("extensions.json"), fresh.readAll().keys().asSequence().toList())
    }

    @Test
    fun oneDirectoryLevelIsAllowedAndUnsafeCharactersAreReplaced() {
        storage.writeSync("blocking/index.json", """{"lists":[]}""")
        assertEquals("""{"lists":[]}""", storage.read("blocking/index.json"))
        assertTrue(storage.exists("blocking/index.json"))
        assertEquals("""{"lists":[]}""", storage.readAll().getString(Storage.BLOCKING_INDEX))
        storage.writeSync("ext storage:x.json", "{}")
        assertEquals(File(dir, "ext_storage_x.json"), storage.fileFor("ext storage:x.json"))
        assertEquals("{}", storage.read("ext storage:x.json"))
    }
}
