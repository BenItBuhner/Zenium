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
        // The Safe Browsing feed documents are not boot documents at all, whatever their size: the
        // core reads them through the handler once it is up (`AndroidStoreIO.read`).
        storage.writeSync("safebrowsing/phishing-database.json", big)
        storage.writeSync("safebrowsing/urlhaus.json", """{"version":1,"id":"urlhaus","prefixes":""}""")
        // The rule sets' documents: a small one travels inline, uBlock Origin Lite's are deferred; a
        // session grown big is deferred the same way.
        val ruleSet = """{"id":"ext:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:static:ruleset_1","rules":[${"""{"id":1,"action":{"type":"block"},"condition":{"urlFilter":"||ads.example^"}},""".repeat(40)}null]}"""
        storage.writeSync("blocking/sets/ext_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa_static_ruleset_1-0c0ffee0.json", ruleSet)
        storage.writeSync("blocking/sets/user.json", """{"id":"user","rules":[]}""")
        val session = """{"version":1,"tabs":[${"""{"url":"https://example.com/"},""".repeat(60)}null]}"""
        storage.writeSync("session.json", session)
        // Not boot documents: a set's filter text, a temp file, a non-JSON file under a folder.
        storage.writeSync("blocking/easylist.json", """{"filterText":"${"x".repeat(5_000)}"}""")
        File(dir, "safebrowsing/urlhaus-filter.json.tmp").writeText(big)
        File(dir, "blocking/sets/user.json.tmp").writeText("torn")
        storage.writeSync("safebrowsing/notes.txt", "not a feed")

        val documents = storage.bootDocuments(1_024)
        assertEquals(
            setOf("history.json", "state.json", "blocking/index.json", "blocking/sets/user.json"),
            documents.files.keys().asSequence().toSet()
        )
        assertEquals("""{"version":1}""", documents.files.getString("state.json"))
        assertEquals("""{"id":"user","rules":[]}""", documents.files.getString("blocking/sets/user.json"))
        assertEquals(2, documents.deferred.length())
        // The manifest's order is the payload's: the root, then the blocking index and its set documents.
        val deferredSession = documents.deferred.getJSONObject(0)
        assertEquals("session.json", deferredSession.getString("name"))
        assertEquals(session.length.toLong(), deferredSession.getLong("bytes"))
        assertEquals(storage.etag("session.json"), deferredSession.getString("etag"))
        val deferredSet = documents.deferred.getJSONObject(1)
        assertEquals("blocking/sets/ext_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa_static_ruleset_1-0c0ffee0.json", deferredSet.getString("name"))
        assertEquals(ruleSet.length.toLong(), deferredSet.getLong("bytes"))
        assertEquals(storage.etag(deferredSet.getString("name")), deferredSet.getString("etag"))

        // Every boot document inline, whatever its size: the payload before the handoff. The feed
        // documents are in neither.
        val all = storage.readAll()
        assertEquals(session, all.getString("session.json"))
        assertEquals(ruleSet, all.getString(deferredSet.getString("name")))
        assertFalse(all.has("safebrowsing/phishing-database.json"))
        assertFalse(all.has("safebrowsing/urlhaus.json"))
        assertEquals(6, all.length())
        assertEquals(0, storage.bootDocuments(Long.MAX_VALUE).deferred.length())
        // Served by the document handler all the same, for the core's read after boot.
        assertTrue(storage.isServedDocument("safebrowsing/phishing-database.json"))
        assertEquals(big, handoff.document("safebrowsing/phishing-database.json").text())
    }

    @Test
    fun `the version tag follows every write and names the same bytes while nothing is written`() {
        assertNull(storage.etag("safebrowsing/phishing-database.json"))
        storage.writeSync("safebrowsing/phishing-database.json", """{"version":1,"id":"phishing-database","prefixes":"AAAA"}""")
        val first = storage.etag("safebrowsing/phishing-database.json")
        assertNotNull(first)
        assertEquals(first, storage.etag("safebrowsing/phishing-database.json"))
        // The manifest names a deferred boot document by the same tag; a feed document is no boot document.
        storage.writeSync("state.json", """{"version":1}""")
        val deferred = storage.bootDocuments(0).deferred
        assertEquals(1, deferred.length())
        assertEquals("state.json", deferred.getJSONObject(0).getString("name"))
        assertEquals(storage.etag("state.json"), deferred.getJSONObject(0).getString("etag"))
        // The tag is the file's size and modification time and nothing of this process: the next
        // process (the Safe Browsing snapshot's header is compared across them) reads the same one.
        val file = File(dir, "safebrowsing/phishing-database.json")
        assertEquals("${java.lang.Long.toHexString(file.length())}-${java.lang.Long.toHexString(file.lastModified())}", first)
        assertEquals(first, Storage(dir).etag("safebrowsing/phishing-database.json"))
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
        // A rule set's document, at the name the index gives it (`/zen-docs/blocking/sets/<name>.json`).
        storage.writeSync("blocking/sets/user.json", """{"id":"user","rules":[]}""")
        val setDocument = handoff.document("/blocking/sets/user.json")
        assertTrue(setDocument.ok)
        assertEquals(storage.etag("blocking/sets/user.json"), setDocument.etag)
        assertEquals("""{"id":"user","rules":[]}""", setDocument.text())

        // Not a boot document, missing, escaping the directory, a folder, a temp file, nothing at all: not found.
        val notServed = listOf(
            "blocking/easylist.json", "privacy/flags.json", "state.json.bak", "safebrowsing/notes.txt",
            "safebrowsing/missing.json", "../escape.json", "safebrowsing", "state.json.tmp", ".json", "", "/",
            "blocking/sets", "blocking/sets/missing.json", "blocking/sets/user.json.tmp", "blocking/other/user.json"
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
    fun `the served set is the root documents, the blocking index and set documents, and the feed documents`() {
        for (name in listOf("state.json", "extensions-runtime.json", "/state.json", "blocking/index.json", "safebrowsing/urlhaus.json", "safebrowsing//a.json", "blocking/sets/user.json", "/blocking/sets/ext_a_static_1-0c0ffee0.json")) {
            assertTrue(name, storage.isServedDocument(name))
        }
        for (name in listOf("blocking/easylist.json", "blocking/index.json.tmp", "state.json.bak", "safebrowsing/notes.txt", "privacy/flags.json", "a/b/c.json", "blocking", ".json", "", "blocking/sets", "blocking/sets/.json", "blocking/sets/user.json.bak", "blocking/other/user.json", "safebrowsing/sets/a.json")) {
            assertFalse(name, storage.isServedDocument(name))
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
    fun `a cap under the inline limit bounds the download too`() {
        // An OpenSearch description's 64 KB cap: the read stops inside the inline loop, within a
        // buffer of the cap, rather than going on to the inline limit and spilling.
        var served = 0
        val endless = object : java.io.InputStream() {
            override fun read(): Int { served++; return 'x'.code }
            override fun read(b: ByteArray, off: Int, len: Int): Int { served += len; b.fill('x'.code.toByte(), off, off + len); return len }
        }
        val failure = runCatching { handoff.readBody(endless, inlineLimit = 256 * 1024, maxBytes = 64 * 1024) }.exceptionOrNull()
        assertTrue("$failure", failure is java.io.IOException)
        assertTrue("served $served bytes", served <= 64 * 1024 + 64 * 1024)
        assertTrue(spill.listFiles().isNullOrEmpty())
        // At the cap exactly, inline as before.
        val atCap = handoff.readBody(ByteArrayInputStream(ByteArray(64 * 1024) { 'y'.code.toByte() }), inlineLimit = 256 * 1024, maxBytes = 64 * 1024)
        assertEquals(64 * 1024, (atCap as BootHandoff.Body.Inline).text.length)
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
