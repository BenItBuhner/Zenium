package app.zen.chromium

import app.zen.chromium.ext.ZipFixtures
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.ByteArrayInputStream
import java.io.File

/**
 * The file-backed handoffs to the chrome: the boot manifest splits the core's documents by size
 * and tags their versions, the document handler streams them (and only them), a fetched body
 * over the inline limit is spilled to a file the chrome fetches once by token.
 */
class BootHandoffTest {
    private val dir = ZipFixtures.tempDir("zen-handoff")
    private val spill = ZipFixtures.tempDir("zen-handoff-spill")
    private val storage = Storage(dir)
    private val handoff = BootHandoff(storage, spill)

    @After
    fun cleanUp() {
        dir.deleteRecursively()
        spill.deleteRecursively()
    }

    private fun BootHandoff.Answer.text(): String = stream!!.use { String(it.readBytes(), Charsets.UTF_8) }

    // --- the boot manifest -----------------------------------------------------------------------

    @Test
    fun `small documents travel inline and big ones are deferred with their size and version tag`() {
        storage.writeSync("state.json", """{"version":1}""")
        storage.writeSync("history.json", "[]")
        storage.writeSync("blocking/index.json", """{"version":1,"sets":[]}""")
        val big = """{"version":1,"id":"phishing-database","prefixes":"${"A".repeat(2_000)}"}"""
        storage.writeSync("safebrowsing/phishing-database.json", big)
        storage.writeSync("safebrowsing/urlhaus.json", """{"version":1,"id":"urlhaus","prefixes":""}""")
        // Not boot documents: a set's filter text, a temp file, a non-JSON file under a folder.
        storage.writeSync("blocking/easylist.json", """{"filterText":"${"x".repeat(5_000)}"}""")
        File(dir, "safebrowsing/urlhaus-filter.json.tmp").writeText(big)
        storage.writeSync("safebrowsing/notes.txt", "not a feed")

        val documents = storage.bootDocuments(1_024)
        assertEquals(
            setOf("history.json", "state.json", "blocking/index.json", "safebrowsing/urlhaus.json"),
            documents.files.keys().asSequence().toSet()
        )
        assertEquals("""{"version":1}""", documents.files.getString("state.json"))
        assertEquals(1, documents.deferred.length())
        val deferred = documents.deferred.getJSONObject(0)
        assertEquals("safebrowsing/phishing-database.json", deferred.getString("name"))
        assertEquals(big.length.toLong(), deferred.getLong("bytes"))
        assertEquals(storage.etag("safebrowsing/phishing-database.json"), deferred.getString("etag"))

        // Every boot document inline, whatever its size: the payload before the handoff.
        val all = storage.readAll()
        assertEquals(big, all.getString("safebrowsing/phishing-database.json"))
        assertEquals(5, all.length())
        assertEquals(0, storage.bootDocuments(Long.MAX_VALUE).deferred.length())
    }

    @Test
    fun `the version tag follows every write and names the same bytes while nothing is written`() {
        assertNull(storage.etag("safebrowsing/phishing-database.json"))
        storage.writeSync("safebrowsing/phishing-database.json", """{"version":1,"id":"phishing-database","prefixes":"AAAA"}""")
        val first = storage.etag("safebrowsing/phishing-database.json")
        assertNotNull(first)
        assertEquals(first, storage.etag("safebrowsing/phishing-database.json"))
        assertEquals(first, storage.bootDocuments(0).deferred.getJSONObject(0).getString("etag"))
        // A rewrite (the refreshed feed) changes the tag: different bytes here, a later moment always.
        File(dir, "safebrowsing/phishing-database.json").setLastModified(System.currentTimeMillis() - 60_000)
        val aged = storage.etag("safebrowsing/phishing-database.json")
        assertNotEquals(first, aged)
        storage.writeSync("safebrowsing/phishing-database.json", """{"version":1,"id":"phishing-database","prefixes":"AAAAAAAA"}""")
        val rewritten = storage.etag("safebrowsing/phishing-database.json")
        assertNotEquals(aged, rewritten)
        // Other bytes of the same size, written within the same millisecond, are another version too.
        storage.writeSync("safebrowsing/phishing-database.json", """{"version":1,"id":"phishing-database","prefixes":"BBBBBBBB"}""")
        assertNotEquals(rewritten, storage.etag("safebrowsing/phishing-database.json"))
        assertNull(storage.etag("../escape.json"))
    }

    // --- the document handler --------------------------------------------------------------------

    @Test
    fun `the document handler streams a boot document with its tag and answers 404 for the rest`() {
        val text = """{"version":1,"id":"phishing-database","prefixes":"QUJDREVGR0g="}"""
        storage.writeSync("safebrowsing/phishing-database.json", text)
        storage.writeSync("state.json", """{"version":1}""")
        storage.writeSync("blocking/index.json", """{"version":1,"sets":[]}""")
        // On disk, readable through the bridge, but not boot documents: not served here.
        storage.writeSync("blocking/easylist.json", """{"filterText":"||ads^"}""")
        storage.writeSync("privacy/flags.json", """{"doNotTrack":true}""")
        storage.writeSync("state.json.bak", """{"version":0}""")

        val answer = handoff.document("safebrowsing/phishing-database.json")
        assertTrue(answer.ok)
        assertEquals("application/json", answer.mimeType)
        assertEquals(storage.etag("safebrowsing/phishing-database.json"), answer.etag)
        assertEquals(text.length.toLong(), answer.length)
        assertEquals(text, answer.text())
        // A leading slash (the path as the URL carries it) names the same document.
        assertEquals(text, handoff.document("/safebrowsing/phishing-database.json").text())
        assertEquals("""{"version":1}""", handoff.document("state.json").text())
        assertEquals("""{"version":1,"sets":[]}""", handoff.document("blocking/index.json").text())

        // Not a boot document, missing, escaping the directory, a folder, a temp file, nothing at all: not found.
        val notServed = listOf(
            "blocking/easylist.json", "privacy/flags.json", "state.json.bak", "safebrowsing/notes.txt",
            "safebrowsing/missing.json", "../escape.json", "safebrowsing", "state.json.tmp", ".json", "", "/"
        )
        for (path in notServed) {
            val missing = handoff.document(path)
            assertFalse(path, missing.ok)
            assertEquals(404, missing.status)
            assertNull(missing.stream)
        }
        assertTrue(storage.exists("blocking/easylist.json"))
        assertEquals("""{"filterText":"||ads^"}""", storage.read("blocking/easylist.json"))
    }

    @Test
    fun `the boot set is the root documents, the blocking index and the feed documents`() {
        for (name in listOf("state.json", "extensions-runtime.json", "/state.json", "blocking/index.json", "safebrowsing/urlhaus.json", "safebrowsing//a.json")) {
            assertTrue(name, storage.isBootDocument(name))
        }
        for (name in listOf("blocking/easylist.json", "blocking/index.json.tmp", "state.json.bak", "safebrowsing/notes.txt", "privacy/flags.json", "a/b/c.json", "blocking", ".json", "")) {
            assertFalse(name, storage.isBootDocument(name))
        }
    }

    // --- fetched bodies --------------------------------------------------------------------------

    @Test
    fun `a body within the inline limit is answered as text and leaves no file`() {
        val body = "héllo wörld ✓".repeat(100)
        val read = handoff.readBody(ByteArrayInputStream(body.toByteArray(Charsets.UTF_8)), inlineLimit = 8 * 1024)
        assertTrue(read is BootHandoff.Body.Inline)
        assertEquals(body, (read as BootHandoff.Body.Inline).text)
        assertTrue(spill.listFiles().isNullOrEmpty())
        // An empty body is an empty text, not a spill file.
        assertEquals("", (handoff.readBody(ByteArrayInputStream(ByteArray(0))) as BootHandoff.Body.Inline).text)
    }

    @Test
    fun `a body over the inline limit is spilled to a file the chrome fetches by token, once`() {
        val body = buildString { for (i in 0 until 50_000) append("line-").append(i).append(" ✓\n") }
        val bytes = body.toByteArray(Charsets.UTF_8)
        val read = handoff.readBody(ByteArrayInputStream(bytes), inlineLimit = 64 * 1024)
        assertTrue(read is BootHandoff.Body.Spilled)
        val spilled = read as BootHandoff.Body.Spilled
        assertTrue(spilled.token, Regex("^[0-9a-f]{32}$").matches(spilled.token))
        assertEquals(bytes.size.toLong(), spilled.bytes)
        assertEquals(listOf(spilled.token), spill.list()!!.toList())

        val answer = handoff.spilled("/${spilled.token}")
        assertTrue(answer.ok)
        assertEquals("text/plain", answer.mimeType)
        assertEquals(bytes.size.toLong(), answer.length)
        // The first read consumes the file (the open stream reads on); a second fetch of the token finds nothing.
        assertTrue(spill.listFiles().isNullOrEmpty())
        assertEquals(404, handoff.spilled(spilled.token).status)
        assertEquals(body, answer.text())

        // Releasing a consumed token, one released already, or something that is not a token, is harmless.
        handoff.release(spilled.token)
        handoff.release(spilled.token)
        handoff.release("../../${spilled.token}")
        assertEquals(404, handoff.spilled(spilled.token).status)
    }

    @Test
    fun `a spilled body the chrome never reads is released by token`() {
        val body = ByteArray(300 * 1024) { 'b'.code.toByte() }
        val spilled = handoff.readBody(ByteArrayInputStream(body)) as BootHandoff.Body.Spilled
        assertEquals(listOf(spilled.token), spill.list()!!.toList())
        handoff.release(spilled.token)
        assertTrue(spill.listFiles().isNullOrEmpty())
        assertEquals(404, handoff.spilled(spilled.token).status)
    }

    @Test
    fun `a connection that fails midway leaves no spill file and fails the fetch`() {
        val failing = object : java.io.InputStream() {
            private var served = 0
            override fun read(): Int = throw UnsupportedOperationException()
            override fun read(b: ByteArray, off: Int, len: Int): Int {
                if (served >= 200 * 1024) throw java.io.IOException("connection reset")
                val n = minOf(len, 64 * 1024)
                b.fill('c'.code.toByte(), off, off + n)
                served += n
                return n
            }
        }
        val failure = runCatching { handoff.readBody(failing, inlineLimit = 64 * 1024) }.exceptionOrNull()
        assertTrue("$failure", failure is java.io.IOException)
        assertEquals("connection reset", failure!!.message)
        assertTrue(spill.listFiles().isNullOrEmpty())
    }

    @Test
    fun `a body over the cap is not spilled`() {
        val big = ByteArray(2 * 1024 * 1024) { 'd'.code.toByte() }
        val failure = runCatching { handoff.readBody(ByteArrayInputStream(big), inlineLimit = 64 * 1024, maxBytes = 1024 * 1024) }.exceptionOrNull()
        assertTrue("$failure", failure is java.io.IOException)
        assertTrue(spill.listFiles().isNullOrEmpty())
        // At the cap exactly it is fine.
        val atCap = handoff.readBody(ByteArrayInputStream(ByteArray(1024 * 1024)), inlineLimit = 64 * 1024, maxBytes = 1024 * 1024)
        assertEquals(1024L * 1024, (atCap as BootHandoff.Body.Spilled).bytes)
        assertEquals(128L * 1024 * 1024, BootHandoff.NET_BODY_LIMIT)
    }

    @Test
    fun `only a live token names a spill file`() {
        File(spill, "not-a-token.txt").writeText("secret")
        assertEquals(404, handoff.spilled("not-a-token.txt").status)
        assertEquals(404, handoff.spilled("../not-a-token.txt").status)
        assertEquals(404, handoff.spilled("").status)
        assertEquals(404, handoff.spilled("0123456789abcdef0123456789abcdef").status)
        assertTrue(File(spill, "not-a-token.txt").exists())
    }

    @Test
    fun `a sweep deletes every spill file a gone chrome never released`() {
        val big = ByteArray(300 * 1024) { 'a'.code.toByte() }
        val first = handoff.readBody(ByteArrayInputStream(big)) as BootHandoff.Body.Spilled
        val second = handoff.readBody(ByteArrayInputStream(big)) as BootHandoff.Body.Spilled
        assertNotEquals(first.token, second.token)
        assertEquals(2, spill.list()!!.size)
        handoff.sweep()
        assertTrue(spill.listFiles().isNullOrEmpty())
        assertEquals(404, handoff.spilled(first.token).status)
        // A sweep with no directory at all is fine too.
        spill.deleteRecursively()
        handoff.sweep()
    }
}
