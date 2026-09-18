package app.zen.chromium.privacy

import app.zen.chromium.Storage
import app.zen.chromium.ext.ZipFixtures
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * The Safe Browsing tables as the host reads them from the core's files: the prefix format the
 * core writes (`PrefixTable` in `src/core/safebrowsing/prefixes.ts`), the lookup by host
 * expression, and the reload from `files/zen/safebrowsing/`.
 */
class SafeBrowsingTest {
    private val dir = ZipFixtures.tempDir("zen-safebrowsing")
    private val storage = Storage(dir)

    @After
    fun cleanUp() {
        dir.deleteRecursively()
    }

    // Vectors from Node's crypto: the first 8 bytes of sha256(expression), big-endian.
    private val listedPrefix = 0xffea46eef155c3c2UL.toLong()
    private val evilPrefix = 0x497cb114587ab5dbL
    private val ipPrefix = 0x6694f83c9f476da3L
    private val ukPrefix = 0x1bb5f1cd770af90bL

    /** The core's base64 of the four prefixes, sorted unsigned (`1bb5…`, `497c…`, `6694…`, `ffea…`). */
    private val sortedBase64 = "G7XxzXcK+QtJfLEUWHq122aU+DyfR22j/+pG7vFVw8I="

    @Test
    fun `prefixes are the leading eight bytes of the expression's SHA-256`() {
        assertEquals(listedPrefix, PrefixTable.prefixOf("listed.example"))
        assertEquals(evilPrefix, PrefixTable.prefixOf("evil.example.com"))
        assertEquals(ipPrefix, PrefixTable.prefixOf("1.2.3.4"))
        assertEquals(ukPrefix, PrefixTable.prefixOf("phish.example.co.uk"))
        assertEquals(0xe3b0c44298fc1c14UL.toLong(), PrefixTable.prefixOf(""))
    }

    @Test
    fun `a host is looked up as itself and each parent down to its registrable domain`() {
        assertEquals(listOf("a.b.example.com", "b.example.com", "example.com"), PrefixTable.hostExpressions("a.b.example.com"))
        assertEquals(listOf("example.com"), PrefixTable.hostExpressions("EXAMPLE.com."))
        assertEquals(listOf("www.example.co.uk", "example.co.uk"), PrefixTable.hostExpressions("www.example.co.uk"))
        assertEquals(listOf("1.2.3.4"), PrefixTable.hostExpressions("1.2.3.4"))
        assertEquals(listOf("localhost"), PrefixTable.hostExpressions("localhost"))
        assertTrue(PrefixTable.hostExpressions("").isEmpty())
    }

    @Test
    fun `the core's tables read back in unsigned order, without duplicates or a trailing partial prefix`() {
        val table = PrefixTable.fromBase64(sortedBase64)
        assertEquals(4, table.size)
        assertTrue(table.has(listedPrefix))
        assertTrue(table.has(evilPrefix))
        assertTrue(table.has(ipPrefix))
        assertTrue(table.has(ukPrefix))
        assertFalse(table.has(0L))
        assertFalse(table.has(-1L))
        assertFalse(table.has(evilPrefix + 1))
        assertEquals(sortedBase64, table.toBase64())

        // The same prefixes in another order, then one twice with three stray bytes at the end.
        val unsorted = PrefixTable.fromBase64("/+pG7vFVw8JJfLEUWHq122aU+DyfR22jG7XxzXcK+Qs=")
        assertEquals(sortedBase64, unsorted.toBase64())
        val messy = PrefixTable.fromBase64("/+pG7vFVw8L/6kbu8VXDwkl8sRRYerXbAQID")
        assertEquals(2, messy.size)
        assertTrue(messy.has(listedPrefix))
        assertTrue(messy.has(evilPrefix))
        assertFalse(messy.has(ipPrefix))

        // Built from hosts, the table is the one the core would write.
        val built = PrefixTable.fromHosts(listOf("listed.example", "evil.example.com", "1.2.3.4", "phish.example.co.uk", "listed.example"))
        assertEquals(4, built.size)
        assertEquals(sortedBase64, built.toBase64())

        assertSame(PrefixTable.EMPTY, PrefixTable.fromBase64(""))
        assertSame(PrefixTable.EMPTY, PrefixTable.fromBase64("AQID"))
        assertSame(PrefixTable.EMPTY, PrefixTable.fromBase64("not base64!"))
        assertEquals(0, PrefixTable.EMPTY.size)
        assertFalse(PrefixTable.EMPTY.has(0L))
        assertEquals("", PrefixTable.EMPTY.toBase64())
    }

    @Test
    fun `the unsigned order holds across the sign bit`() {
        // Values on both sides of the top bit, plus the extremes, in every order.
        val values = listOf(0L, 1L, Long.MAX_VALUE, Long.MIN_VALUE, -1L, Long.MAX_VALUE - 5, Long.MIN_VALUE + 5)
        val bytes = java.nio.ByteBuffer.allocate(values.size * PrefixTable.PREFIX_BYTES)
        for (v in values.shuffled(java.util.Random(7))) bytes.putLong(v)
        val table = PrefixTable.fromBase64(java.util.Base64.getEncoder().encodeToString(bytes.array()))
        assertEquals(values.size, table.size)
        for (v in values) assertTrue("missing ${v.toULong()}", table.has(v))
        assertFalse(table.has(2L))
        assertFalse(table.has(-2L))
        // Read back, the bytes are in unsigned order: 0, 1, MAX-5, MAX, MIN, MIN+5, -1.
        val out = java.nio.ByteBuffer.wrap(java.util.Base64.getDecoder().decode(table.toBase64()))
        val readBack = LongArray(values.size) { out.getLong() }
        assertEquals(listOf(0L, 1L, Long.MAX_VALUE - 5, Long.MAX_VALUE, Long.MIN_VALUE, Long.MIN_VALUE + 5, -1L), readBack.toList())
    }

    @Test
    fun `a table matches a host under any of its expressions`() {
        val table = PrefixTable.fromHosts(listOf("listed.example", "evil.example.com", "1.2.3.4"))
        assertEquals("listed.example", table.matchHost("listed.example"))
        assertEquals("listed.example", table.matchHost("cdn.listed.example"))
        assertEquals("listed.example", table.matchHost("a.b.LISTED.example."))
        assertEquals("evil.example.com", table.matchHost("www.evil.example.com"))
        assertEquals("1.2.3.4", table.matchHost("1.2.3.4"))
        assertNull(table.matchHost("example.com"))
        assertNull(table.matchHost("notlisted.example"))
        assertNull(table.matchHost("listed.example.evil"))
        assertNull(PrefixTable.EMPTY.matchHost("listed.example"))
    }

    private fun document(id: String, threat: String, hosts: List<String>, version: Int = SafeBrowsingTables.DOCUMENT_VERSION): String =
        JSONObject()
            .put("version", version)
            .put("id", id)
            .put("threat", threat)
            .put("entries", hosts.size)
            .put("updatedAt", 1_700_000_000_000L)
            .put("etag", JSONObject.NULL)
            .put("lastModified", JSONObject.NULL)
            .put("bundled", false)
            .put("prefixes", PrefixTable.fromHosts(hosts).toBase64())
            .toString()

    @Test
    fun `feed documents are parsed strictly and looked up in file order`() {
        val urlhaus = SafeBrowsingTables.parseDocument(document("urlhaus", "malware", listOf("listed.example")), "urlhaus")
        assertNotNull(urlhaus)
        assertEquals("urlhaus", urlhaus!!.id)
        assertEquals("malware", urlhaus.threat)
        assertEquals(1, urlhaus.table.size)
        // The file's name must be the document's id; the version must be the one the host reads.
        assertNull(SafeBrowsingTables.parseDocument(document("urlhaus", "malware", listOf("a.example")), "phishing-database"))
        assertNull(SafeBrowsingTables.parseDocument(document("urlhaus", "malware", listOf("a.example"), version = 99), "urlhaus"))
        assertNull(SafeBrowsingTables.parseDocument("not json", "urlhaus"))
        assertNull(SafeBrowsingTables.parseDocument("""{"version":1,"prefixes":""}""", "urlhaus"))
        // An unknown threat reads as such; a document without a name is accepted when none is expected.
        assertEquals("unknown", SafeBrowsingTables.parseDocument(document("x", "ransom", listOf("a.example")), null)!!.threat)

        val tables = SafeBrowsingTables(
            listOf(
                SafeBrowsingTables.parseDocument(document("phishing-database", "phishing", listOf("evil.example.com", "both.example")), null)!!,
                urlhaus,
                SafeBrowsingTables.parseDocument(document("malware-filter", "malware", listOf("both.example")), null)!!
            )
        )
        assertEquals(4, tables.entries)
        val hit = tables.lookup("cdn.listed.example")!!
        assertEquals("urlhaus", hit.feedId)
        assertEquals("malware", hit.threat)
        assertEquals("listed.example", hit.expression)
        val phish = tables.lookup("login.evil.example.com")!!
        assertEquals("phishing-database", phish.feedId)
        assertEquals("phishing", phish.threat)
        // Listed twice: the first feed in order answers.
        assertEquals("phishing-database", tables.lookup("both.example")!!.feedId)
        assertNull(tables.lookup("news.example"))
        assertNull(tables.lookup("example.com"))
        assertNull(SafeBrowsingTables.EMPTY.lookup("listed.example"))
        assertEquals(0, SafeBrowsingTables.EMPTY.entries)
    }

    @Test
    fun `the host reloads every feed the core wrote under safebrowsing, and nothing else`() {
        val safeBrowsing = SafeBrowsing(storage)
        safeBrowsing.reload()
        assertEquals(0, safeBrowsing.tables.entries)

        storage.writeSync("safebrowsing/urlhaus.json", document("urlhaus", "malware", listOf("listed.example")))
        storage.writeSync("safebrowsing/phishing-database.json", document("phishing-database", "phishing", listOf("evil.example.com")))
        // A document under another feed's name, a stray temp file and an unrelated document are left out.
        storage.writeSync("safebrowsing/renamed.json", document("urlhaus", "malware", listOf("stray.example")))
        File(dir, "safebrowsing/malware-filter.json.tmp").writeText(document("malware-filter", "malware", listOf("tmp.example")))
        storage.writeSync("safebrowsing/notes.txt", "not a feed")
        storage.writeSync("state.json", """{"version":1}""")

        safeBrowsing.reload()
        val tables = safeBrowsing.tables
        assertEquals(listOf("phishing-database", "urlhaus"), tables.feeds.map { it.id })
        assertEquals(2, tables.entries)
        assertEquals("urlhaus", tables.lookup("listed.example")!!.feedId)
        assertEquals("phishing", tables.lookup("evil.example.com")!!.threat)
        assertNull(tables.lookup("stray.example"))
        assertNull(tables.lookup("tmp.example"))
        assertTrue(safeBrowsing.lastLoadMs >= 0)

        // A refreshed feed replaces its table on the next load.
        storage.writeSync("safebrowsing/urlhaus.json", document("urlhaus", "malware", listOf("fresh.example")))
        safeBrowsing.reload()
        assertNull(safeBrowsing.tables.lookup("listed.example"))
        assertEquals("urlhaus", safeBrowsing.tables.lookup("fresh.example")!!.feedId)
        assertEquals(listOf("safebrowsing/notes.txt", "safebrowsing/phishing-database.json", "safebrowsing/renamed.json", "safebrowsing/urlhaus.json"), storage.list("safebrowsing").sorted())
        assertTrue(storage.list("").isEmpty())
        assertTrue(storage.list("missing").isEmpty())
    }
}
