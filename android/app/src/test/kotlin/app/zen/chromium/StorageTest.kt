package app.zen.chromium

import app.zen.chromium.ext.ZipFixtures
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.io.IOException
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
        var failure: Throwable? = IllegalStateException("not called")
        storage.write("extensions.json", registry) { failure = it; done.countDown() }
        assertTrue(done.await(10, TimeUnit.SECONDS))
        assertNull(failure)
        assertEquals(registry, storage.read("extensions.json"))
    }

    @Test
    fun aWriteThatCannotReplaceTheDocumentReportsItsFailure() {
        // A directory with something in it where the document should be: the temp file cannot be
        // renamed over it, and it cannot be removed to make way.
        File(dir, "extensions.json/keep").apply { parentFile!!.mkdirs() }.writeText("x")
        val failure = runCatching { storage.writeSync("extensions.json", registry) }.exceptionOrNull()
        assertTrue("$failure", failure is IOException)
        assertFalse(File(dir, "extensions.json.tmp").exists())

        val done = CountDownLatch(1)
        var reported: Throwable? = null
        storage.write("extensions.json", registry) { reported = it; done.countDown() }
        assertTrue(done.await(10, TimeUnit.SECONDS))
        assertTrue("$reported", reported is IOException)
        assertTrue(File(dir, "extensions.json").isDirectory)

        // A name outside the directory is a failure too, not a silent no-op.
        assertTrue(runCatching { storage.writeSync("../escape.json", "{}") }.exceptionOrNull() is IOException)
    }

    @Test
    fun aBackupKeepsThePreviousDocumentAcrossAWrite() {
        val first = """{"version":1,"tabs":["a"]}"""
        val second = """{"version":1,"tabs":["a","b"]}"""
        val third = """{"version":1,"tabs":["a","b","c"]}"""
        // Nothing to keep the first time: the document appears, no backup.
        storage.writeSync("state.json", first, backup = true)
        assertEquals(first, storage.read("state.json"))
        assertNull(storage.read("state.json.bak"))
        // The document that was there becomes the backup, whole; the write itself replaces the document.
        storage.writeSync("state.json", second, backup = true)
        assertEquals(second, storage.read("state.json"))
        assertEquals(first, storage.read("state.json.bak"))
        val done = CountDownLatch(1)
        storage.write("state.json", third, backup = true) { done.countDown() }
        assertTrue(done.await(10, TimeUnit.SECONDS))
        assertEquals(third, storage.read("state.json"))
        assertEquals(second, storage.read("state.json.bak"))
        // A write without the option leaves the backup as it was; the payload never carries backups.
        storage.writeSync("state.json", first)
        assertEquals(second, storage.read("state.json.bak"))
        assertEquals(setOf("state.json"), storage.readAll().keys().asSequence().toSet())
        assertFalse(storage.isBootDocument("state.json.bak"))
        assertEquals(setOf("state.json", "state.json.bak"), dir.list()!!.toSet())
    }

    @Test
    fun aRewriteOfTheSameSizeWithinTheMillisecondIsAnotherVersion() {
        storage.writeSync("state.json", """{"version":1,"tabs":["a"]}""")
        val file = File(dir, "state.json")
        // The document's clock is put well ahead: the rewrite lands "within the same millisecond".
        val ahead = file.lastModified() + 5_000
        assertTrue(file.setLastModified(ahead))
        val before = storage.etag("state.json")
        storage.writeSync("state.json", """{"version":1,"tabs":["b"]}""")
        assertEquals("""{"version":1,"tabs":["b"]}""", storage.read("state.json"))
        assertEquals(ahead + 1, file.lastModified())
        assertNotEquals(before, storage.etag("state.json"))
        // Once more, with a backup: the backup keeps the previous clock, the document moves on again.
        storage.writeSync("state.json", """{"version":1,"tabs":["c"]}""", backup = true)
        assertEquals(ahead + 1, File(dir, "state.json.bak").lastModified())
        assertEquals(ahead + 2, file.lastModified())
        // Another size is another version by itself: the clock is the write's own.
        storage.writeSync("state.json", """{"version":1,"tabs":["c","d"]}""")
        assertTrue(file.lastModified() < ahead)
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
        runCatching { storage.writeSync("../escape.json", "{}") }
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
    fun aReadForTheBridgeIsTheTextWhileSmallAndATokenForPiecesPastTheLimit() {
        storage.writeSync("ext-storage/abc.json", "small")
        assertEquals("small", storage.readOrBegin("ext-storage/abc.json", 1L shl 20))
        assertNull(storage.readOrBegin("ext-storage/missing.json", 1L shl 20))
        val big = "b".repeat(3000)
        storage.writeSync("ext-storage/big.json", big)
        val answer = storage.readOrBegin("ext-storage/big.json", 1024) as JSONObject
        val token = answer.getLong("token")
        assertTrue(storage.hasPending(token))
        val pieces = ArrayList<String>()
        while (true) pieces.add(storage.readChunk(token, 1024) ?: break)
        assertEquals(listOf(1024, 1024, 952), pieces.map { it.length })
        assertEquals(big, pieces.joinToString(""))
        assertFalse(storage.hasPending(token))
    }

    @Test
    fun aWriteInPiecesKeepsTheBackupWhenAskedAndMovesTheVersionTagOn() {
        storage.writeSync("state.json", "{\"tabs\":[1]}")
        val before = storage.etag("state.json")!!
        val token = storage.beginWrite("state.json", backup = true)!!
        assertTrue(storage.writeChunk(token, "{\"tabs\""))
        assertTrue(storage.writeChunk(token, ":[2]}"))
        assertTrue(storage.endWrite(token))
        assertEquals("{\"tabs\":[2]}", storage.read("state.json"))
        assertEquals("{\"tabs\":[1]}", storage.read("state.json.bak"))
        assertNotEquals(before, storage.etag("state.json"))
        assertEquals(0, dir.list()!!.count { it.endsWith(".tmp") })
    }

    @Test
    fun aDocumentOpensForStreamingWithItsVersionTag() {
        assertNull(storage.open("extensions.json"))
        storage.writeSync("extensions.json", registry)
        val opened = storage.open("extensions.json")!!
        assertEquals(storage.etag("extensions.json"), opened.etag)
        assertEquals(registry.toByteArray().size.toLong(), opened.length)
        assertEquals(registry, opened.stream.use { String(it.readBytes()) })
        assertNull(storage.open("../escape.json"))
        assertNull(storage.open("blocking"))
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

    @Test
    fun aCacheFileIsWrittenWholeReadBackAndDeletedWithoutAChangeNotification() {
        val heard = ArrayList<String>()
        val listener: (String) -> Unit = { heard.add(it) }
        Storage.addChangeListener(listener)
        try {
            val bytes = ByteArray(4096) { (it * 7).toByte() }
            assertNull(storage.readBytes("safebrowsing/tables.bin"))
            assertTrue(storage.writeBytes("safebrowsing/tables.bin", bytes))
            assertTrue(bytes.contentEquals(storage.readBytes("safebrowsing/tables.bin")!!))
            assertFalse(File(dir, "safebrowsing/tables.bin.tmp").exists())
            assertEquals(listOf("safebrowsing/tables.bin"), storage.list("safebrowsing"))
            // A rewrite replaces the file whole.
            assertTrue(storage.writeBytes("safebrowsing/tables.bin", ByteArray(3)))
            assertEquals(3, storage.readBytes("safebrowsing/tables.bin")!!.size)
            assertTrue(storage.deleteBytes("safebrowsing/tables.bin"))
            assertNull(storage.readBytes("safebrowsing/tables.bin"))
            assertTrue(storage.deleteBytes("safebrowsing/tables.bin"))
            assertFalse(storage.writeBytes("../escape.bin", bytes))
            assertFalse(storage.deleteBytes("../escape.bin"))
            // A document's write is heard; the cache's never was.
            storage.writeSync("safebrowsing/urlhaus.json", "{}")
            assertEquals(listOf("safebrowsing/urlhaus.json"), heard)
        } finally {
            Storage.removeChangeListener(listener)
        }
    }
}
