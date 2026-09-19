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
        // The reserved test hosts are listed even without tables, exactly, and count for nothing.
        val test = SafeBrowsingTables.EMPTY.lookup("malware.zenium.test")!!
        assertEquals(SafeBrowsingTables.TEST_FEED, test.feedId)
        assertEquals("malware", test.threat)
        assertEquals("malware.zenium.test", test.expression)
        assertEquals("phishing", tables.lookup("phishing.zenium.test")!!.threat)
        assertNull(tables.lookup("www.malware.zenium.test"))
        assertNull(tables.lookup("zenium.test"))
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
        assertEquals(
            listOf("safebrowsing/notes.txt", "safebrowsing/phishing-database.json", "safebrowsing/renamed.json", "safebrowsing/tables.bin", "safebrowsing/urlhaus.json"),
            storage.list("safebrowsing").sorted()
        )
        assertTrue(storage.list("").isEmpty())
        assertTrue(storage.list("missing").isEmpty())
    }

    // --- the snapshot -----------------------------------------------------------------------------

    /** A feed document of `count` random prefixes (any order; the guard sorts), the shape of a real feed's. */
    private fun bigDocument(id: String, threat: String, count: Int, seed: Long): String {
        val random = java.util.Random(seed)
        val bytes = java.nio.ByteBuffer.allocate(count * PrefixTable.PREFIX_BYTES)
        repeat(count) { bytes.putLong(random.nextLong()) }
        return JSONObject()
            .put("version", SafeBrowsingTables.DOCUMENT_VERSION)
            .put("id", id)
            .put("threat", threat)
            .put("entries", count)
            .put("updatedAt", 1_700_000_000_000L)
            .put("etag", JSONObject.NULL)
            .put("lastModified", JSONObject.NULL)
            .put("bundled", false)
            .put("prefixes", java.util.Base64.getEncoder().encodeToString(bytes.array()))
            .toString()
    }

    private fun collecting(safeBrowsing: SafeBrowsing): MutableList<String> {
        val lines = java.util.Collections.synchronizedList(ArrayList<String>())
        safeBrowsing.log = { lines.add(it) }
        return lines
    }

    /**
     * Wait for the loader thread's `tables:` line, the last thing a load of the documents does
     * (after it published the tables, counted the parses and wrote the snapshot), and return it.
     */
    private fun awaitTablesLine(lines: List<String>): String {
        val deadline = System.currentTimeMillis() + 20_000
        while (System.currentTimeMillis() < deadline) {
            synchronized(lines) { lines.firstOrNull { it.startsWith("tables: ") } }?.let { return it }
            Thread.sleep(20)
        }
        throw AssertionError("no load of the documents in 20 s; said: $lines")
    }

    private val snapshotFile: File get() = storage.fileFor(SafeBrowsing.SNAPSHOT)!!

    /** Rewrite a document so its version tag differs for sure (a size other than before; the time may be the same millisecond). */
    private fun rewrite(name: String, text: String) {
        val before = storage.fileFor(name)!!.length()
        storage.writeSync(name, text)
        if (storage.fileFor(name)!!.length() == before) storage.writeSync(name, "$text ")
    }

    @Test
    fun `the snapshot reads back exactly the tables the documents parse to`() {
        val big = 100_000
        storage.writeSync("safebrowsing/phishing-database.json", bigDocument("phishing-database", "phishing", big, 7))
        storage.writeSync("safebrowsing/urlhaus.json", document("urlhaus", "malware", listOf("listed.example", "evil.example.com", "1.2.3.4")))
        storage.writeSync("safebrowsing/ransom.json", document("ransom", "ransom", listOf("ransom.example")))
        // Present but not feeds: the snapshot names them (with no table), as the load skips them.
        storage.writeSync("safebrowsing/broken.json", "not json")
        storage.writeSync("safebrowsing/renamed.json", document("urlhaus", "malware", listOf("stray.example")))
        storage.writeSync("safebrowsing/notes.txt", "not a feed")

        val parsed = SafeBrowsing(storage)
        parsed.reload()
        assertEquals(SafeBrowsing.SnapshotOutcome.WRITTEN, parsed.lastSnapshot)
        assertTrue(snapshotFile.isFile)
        // The body is the raw prefixes: 8 bytes each, after a header of a few hundred bytes.
        val bodyBytes = parsed.tables.entries.toLong() * PrefixTable.PREFIX_BYTES
        assertTrue(snapshotFile.length() in (bodyBytes + 40)..(bodyBytes + 400))

        val loaded = SafeBrowsing(storage)
        val lines = collecting(loaded)
        assertTrue(loaded.loadSnapshot())
        assertNull(loaded.snapshotRejected)
        assertTrue(loaded.snapshotLoadMs >= 0)
        println(
            "snapshot: ${loaded.tables.entries} prefixes from ${loaded.tables.feeds.size} feeds loaded in ${loaded.snapshotLoadMs} ms; " +
                "the documents (${bodyBytes * 4 / 3 / 1024} KB of base64) parsed in ${parsed.lastLoadMs} ms"
        )

        // The same feeds in the same order, with the same threats and the very same prefixes.
        assertEquals(listOf("phishing-database", "ransom", "urlhaus"), loaded.tables.feeds.map { it.id })
        assertEquals(parsed.tables.feeds.map { it.id }, loaded.tables.feeds.map { it.id })
        assertEquals(listOf("phishing", "unknown", "malware"), loaded.tables.feeds.map { it.threat })
        assertEquals(parsed.tables.entries, loaded.tables.entries)
        assertTrue(loaded.tables.entries >= big + 4 - 2) // random prefixes may collide, rarely
        for ((a, b) in parsed.tables.feeds.zip(loaded.tables.feeds)) {
            assertEquals(a.table.size, b.table.size)
            assertEquals(a.table.toBase64(), b.table.toBase64())
        }
        // The lookups agree, on the hosts, on a sample of the big feed's prefixes, and on misses.
        for (host in listOf("cdn.listed.example", "www.evil.example.com", "1.2.3.4", "ransom.example", "news.example", "stray.example", "example.com")) {
            val expected = parsed.tables.lookup(host)
            val actual = loaded.tables.lookup(host)
            assertEquals(host, expected?.feedId, actual?.feedId)
            assertEquals(host, expected?.threat, actual?.threat)
            assertEquals(host, expected?.expression, actual?.expression)
        }
        assertEquals("urlhaus", loaded.tables.lookup("cdn.listed.example")!!.feedId)
        assertEquals("unknown", loaded.tables.lookup("ransom.example")!!.threat)
        assertNull(loaded.tables.lookup("stray.example"))
        val random = java.util.Random(7)
        val bigTable = loaded.tables.feeds[0].table
        val parsedBig = parsed.tables.feeds[0].table
        repeat(big) {
            val prefix = random.nextLong()
            assertTrue(bigTable.has(prefix))
            assertTrue(parsedBig.has(prefix))
        }
        val other = java.util.Random(8)
        repeat(1000) {
            val prefix = other.nextLong()
            assertEquals(parsedBig.has(prefix), bigTable.has(prefix))
        }
        assertEquals(parsedBig.has(0L), bigTable.has(0L))
        assertEquals(parsedBig.has(-1L), bigTable.has(-1L))

        // The load published: the first navigation has nothing to wait for. The documents' load
        // that follows finds the snapshot is already theirs and leaves it alone.
        assertEquals(loaded.tables.entries, loaded.tablesForNavigation().entries)
        assertTrue(loaded.firstNavigation!!.waitedMs < 50)
        assertTrue(loaded.firstNavigation!!.loaded)
        val before = snapshotFile.readBytes()
        loaded.reload()
        assertEquals(SafeBrowsing.SnapshotOutcome.UNCHANGED, loaded.lastSnapshot)
        assertTrue(before.contentEquals(snapshotFile.readBytes()))
        assertTrue(lines.any { it.startsWith("first navigation: ${loaded.tables.entries} prefixes") && it.endsWith("(loaded)") })
    }

    @Test
    fun `a snapshot that is not whole, not this format or not of the documents present is ignored and deleted`() {
        storage.writeSync("safebrowsing/urlhaus.json", document("urlhaus", "malware", listOf("listed.example")))
        storage.writeSync("safebrowsing/phishing-database.json", bigDocument("phishing-database", "phishing", 5_000, 3))
        SafeBrowsing(storage).reload()
        val good = snapshotFile.readBytes()

        fun rejected(bytes: ByteArray, why: String) {
            snapshotFile.writeBytes(bytes)
            val safeBrowsing = SafeBrowsing(storage)
            assertFalse(safeBrowsing.loadSnapshot())
            assertTrue("'${safeBrowsing.snapshotRejected}' should say '$why'", safeBrowsing.snapshotRejected!!.contains(why))
            assertFalse(snapshotFile.exists())
            assertSame(SafeBrowsingTables.EMPTY, safeBrowsing.tables)
            assertEquals(-1L, safeBrowsing.snapshotLoadMs)
        }

        // Another file under the name, another format version, a header cut short.
        rejected(good.copyOf().also { it[0] = 'X'.code.toByte() }, "not a snapshot")
        rejected(good.copyOf().also { it[5] = 2 }, "format 2")
        rejected(good.copyOf(11), "unreadable header")
        rejected(ByteArray(0), "unreadable header")
        // A body cut short, or with bytes tacked on; a body with one bit flipped.
        rejected(good.copyOf(good.size - 5), "body of")
        rejected(good + ByteArray(8), "body of")
        rejected(good.copyOf().also { it[good.size - 1] = (it[good.size - 1] + 1).toByte() }, "checksum")
        // The one written, but a document has changed since; or one was added; or one is gone.
        rewrite("safebrowsing/urlhaus.json", document("urlhaus", "malware", listOf("fresh.example", "other.example")))
        rejected(good, "not the ones it was built from")
        SafeBrowsing(storage).reload()
        val current = snapshotFile.readBytes()
        storage.writeSync("safebrowsing/added.json", document("added", "malware", listOf("added.example")))
        rejected(current, "not the ones it was built from")
        SafeBrowsing(storage).reload()
        val withAdded = snapshotFile.readBytes()
        File(dir, "safebrowsing/added.json").delete()
        rejected(withAdded, "not the ones it was built from")
        // No snapshot at all is no error: nothing published, nothing said.
        val none = SafeBrowsing(storage)
        assertFalse(none.loadSnapshot())
        assertNull(none.snapshotRejected)

        // After a rejection the documents' load writes a fresh one, which reads back.
        val fresh = SafeBrowsing(storage)
        fresh.reload()
        assertEquals(SafeBrowsing.SnapshotOutcome.WRITTEN, fresh.lastSnapshot)
        val again = SafeBrowsing(storage)
        assertTrue(again.loadSnapshot())
        assertEquals("urlhaus", again.tables.lookup("fresh.example")!!.feedId)
        assertNull(again.tables.lookup("listed.example"))
        assertNull(again.tables.lookup("added.example"))
        assertEquals(fresh.tables.entries, again.tables.entries)
    }

    @Test
    fun `the snapshot is rewritten only when a document's tag differs from its header`() {
        storage.writeSync("safebrowsing/urlhaus.json", document("urlhaus", "malware", listOf("listed.example")))
        storage.writeSync("safebrowsing/phishing-database.json", document("phishing-database", "phishing", listOf("evil.example.com")))
        val safeBrowsing = SafeBrowsing(storage)
        safeBrowsing.reload()
        assertEquals(SafeBrowsing.SnapshotOutcome.WRITTEN, safeBrowsing.lastSnapshot)
        val first = snapshotFile.readBytes()

        // Nothing written since: the load leaves the snapshot alone.
        safeBrowsing.reload()
        assertEquals(SafeBrowsing.SnapshotOutcome.UNCHANGED, safeBrowsing.lastSnapshot)
        assertTrue(first.contentEquals(snapshotFile.readBytes()))

        // One document refreshed: written again, with the new prefixes.
        rewrite("safebrowsing/urlhaus.json", document("urlhaus", "malware", listOf("fresh.example", "another.example")))
        safeBrowsing.reload()
        assertEquals(SafeBrowsing.SnapshotOutcome.WRITTEN, safeBrowsing.lastSnapshot)
        val second = snapshotFile.readBytes()
        assertFalse(first.contentEquals(second))
        val reader = SafeBrowsing(storage)
        assertTrue(reader.loadSnapshot())
        assertEquals("urlhaus", reader.tables.lookup("another.example")!!.feedId)
        assertNull(reader.tables.lookup("listed.example"))
        // The instance that loaded it knows its header: its own load of the documents leaves it alone.
        reader.reload()
        assertEquals(SafeBrowsing.SnapshotOutcome.UNCHANGED, reader.lastSnapshot)
        assertTrue(second.contentEquals(snapshotFile.readBytes()))

        // A document changing under a load: that load defers to the one the change scheduled.
        val stale = listOf("safebrowsing/phishing-database.json" to "0-0", "safebrowsing/urlhaus.json" to "0-0")
        assertEquals(SafeBrowsing.SnapshotOutcome.DEFERRED, reader.writeSnapshot(reader.tables.feeds, stale))
        assertTrue(second.contentEquals(snapshotFile.readBytes()))

        // A document gone: written again without it. No documents: nothing to snapshot.
        File(dir, "safebrowsing/phishing-database.json").delete()
        reader.reload()
        assertEquals(SafeBrowsing.SnapshotOutcome.WRITTEN, reader.lastSnapshot)
        assertEquals(listOf("urlhaus"), SafeBrowsing(storage).also { assertTrue(it.loadSnapshot()) }.tables.feeds.map { it.id })
        File(dir, "safebrowsing/urlhaus.json").delete()
        reader.reload()
        assertEquals(SafeBrowsing.SnapshotOutcome.NONE, reader.lastSnapshot)
        assertEquals(0, reader.tables.entries)
    }

    @Test
    fun `the first navigation waits for the first load up to the cap, and nothing after it waits`() {
        storage.writeSync("safebrowsing/urlhaus.json", document("urlhaus", "malware", listOf("listed.example")))

        // The load lands within the hold: the navigation sees the tables and waited about as long.
        val held = SafeBrowsing(storage)
        val heldLines = collecting(held)
        val loader = Thread {
            Thread.sleep(60)
            held.reload()
        }
        loader.start()
        var started = System.nanoTime()
        val tables = held.tablesForNavigation()
        val waited = (System.nanoTime() - started) / 1_000_000
        loader.join()
        assertEquals(1, tables.entries)
        assertEquals("urlhaus", tables.lookup("listed.example")!!.feedId)
        val first = held.firstNavigation!!
        assertTrue("waited $waited ms", waited >= 40 && waited < SafeBrowsing.FIRST_NAVIGATION_HOLD_MS)
        assertTrue(first.loaded)
        assertEquals(1, first.entries)
        assertTrue(first.waitedMs >= 40)
        assertEquals(-1L, first.sinceStartMs) // never started: the load was called directly
        assertTrue(heldLines.any { it.startsWith("first navigation: 1 prefixes from 1 feeds after a wait of") && it.endsWith("ms after start (loaded)") })

        // No load in sight: the navigation waits the cap and goes on unchecked.
        val cold = SafeBrowsing(storage)
        val coldLines = collecting(cold)
        started = System.nanoTime()
        val empty = cold.tablesForNavigation()
        val capped = (System.nanoTime() - started) / 1_000_000
        assertSame(SafeBrowsingTables.EMPTY, empty)
        assertTrue("waited $capped ms", capped >= SafeBrowsing.FIRST_NAVIGATION_HOLD_MS - 10 && capped < 2_000)
        assertFalse(cold.firstNavigation!!.loaded)
        assertEquals(0, cold.firstNavigation!!.entries)
        assertTrue(coldLines.any { it.startsWith("first navigation: 0 prefixes") && it.endsWith("(load pending: unchecked)") })
        println("hold: the first navigation waited $waited ms for a load that began 60 ms in; with no load in sight $capped ms (cap ${SafeBrowsing.FIRST_NAVIGATION_HOLD_MS} ms)")

        // A second navigation while the load is still pending: no wait at all, the tables as they are.
        started = System.nanoTime()
        assertSame(SafeBrowsingTables.EMPTY, cold.tablesForNavigation())
        assertTrue((System.nanoTime() - started) / 1_000_000 < 100)
        assertEquals(1, coldLines.size)
        // Once loaded, later navigations and the subresources' [tables] see the same tables.
        cold.reload()
        assertSame(cold.tables, cold.tablesForNavigation())
        assertEquals(1, cold.tables.entries)
        assertEquals(0, cold.firstNavigation!!.entries)
    }

    @Test
    fun `start publishes the snapshot ahead of the documents, then loads them and leaves it alone`() {
        storage.writeSync("safebrowsing/phishing-database.json", bigDocument("phishing-database", "phishing", 50_000, 11))
        storage.writeSync("safebrowsing/urlhaus.json", document("urlhaus", "malware", listOf("listed.example")))
        val writer = SafeBrowsing(storage)
        writer.reload()
        val expected = writer.tables.entries

        val safeBrowsing = SafeBrowsing(storage)
        val lines = collecting(safeBrowsing)
        safeBrowsing.start()
        try {
            val started = System.nanoTime()
            val tables = safeBrowsing.tablesForNavigation()
            val waited = (System.nanoTime() - started) / 1_000_000
            assertEquals(expected, tables.entries)
            assertEquals("urlhaus", tables.lookup("cdn.listed.example")!!.feedId)
            assertTrue(safeBrowsing.firstNavigation!!.loaded)
            assertTrue("waited $waited ms", waited < SafeBrowsing.FIRST_NAVIGATION_HOLD_MS)
            // Started: the check knows how long after start it came (at once, here).
            val sinceStart = safeBrowsing.firstNavigation!!.sinceStartMs
            assertTrue("$sinceStart ms after start", sinceStart >= 0 && sinceStart < SafeBrowsing.FIRST_NAVIGATION_HOLD_MS)
            assertTrue(lines.any { it.startsWith("first navigation: $expected prefixes from 2 feeds after a wait of") && it.contains(" ms after start (loaded)") })
            assertTrue(safeBrowsing.snapshotLoadMs >= 0)
            assertNull(safeBrowsing.snapshotRejected)
            // The documents' load follows on the same thread, seeded from the snapshot: it parses
            // nothing and finds the snapshot is theirs.
            val tablesLine = awaitTablesLine(lines)
            assertEquals(SafeBrowsing.SnapshotOutcome.UNCHANGED, safeBrowsing.lastSnapshot)
            assertEquals(expected, safeBrowsing.tables.entries)
            assertEquals(2, safeBrowsing.snapshotSeeded)
            assertEquals(0, safeBrowsing.lastParsed)
            assertTrue(lines.any { it.startsWith("snapshot: $expected prefixes from 2 feeds in") && it.endsWith("; 2 documents seeded, none to parse") })
            assertTrue(tablesLine, tablesLine.startsWith("tables: $expected prefixes from 2 feeds in") && tablesLine.endsWith(" (0 parsed); snapshot unchanged"))
            println("start: snapshot of $expected prefixes published in ${safeBrowsing.snapshotLoadMs} ms; the documents' load parsed ${safeBrowsing.lastParsed} of 2 in ${safeBrowsing.lastLoadMs} ms (the writer parsed 2 in ${writer.lastLoadMs} ms)")
        } finally {
            safeBrowsing.stop()
        }

        // Without a snapshot, start() loads the documents, which write one.
        assertTrue(storage.deleteBytes(SafeBrowsing.SNAPSHOT))
        val cold = SafeBrowsing(storage)
        collecting(cold)
        cold.start()
        try {
            val deadline = System.currentTimeMillis() + 20_000
            while (cold.lastSnapshot == SafeBrowsing.SnapshotOutcome.NONE && System.currentTimeMillis() < deadline) Thread.sleep(20)
            assertEquals(SafeBrowsing.SnapshotOutcome.WRITTEN, cold.lastSnapshot)
            assertEquals(-1L, cold.snapshotLoadMs)
            assertNull(cold.snapshotRejected)
            assertEquals(0, cold.snapshotSeeded)
            assertEquals(2, cold.lastParsed)
            assertTrue(snapshotFile.isFile)
        } finally {
            cold.stop()
        }
    }

    @Test
    fun `a reload parses only the documents whose version changed and keeps the others' tables`() {
        val safeBrowsing = SafeBrowsing(storage)
        storage.writeSync("safebrowsing/urlhaus.json", document("urlhaus", "malware", listOf("listed.example")))
        storage.writeSync("safebrowsing/phishing-database.json", document("phishing-database", "phishing", listOf("evil.example.com")))
        safeBrowsing.reload()
        assertEquals(2, safeBrowsing.lastParsed)
        val phishing = safeBrowsing.tables.feeds.first { it.id == "phishing-database" }

        // Nothing written: nothing parsed, the same tables.
        safeBrowsing.reload()
        assertEquals(0, safeBrowsing.lastParsed)
        assertSame(phishing, safeBrowsing.tables.feeds.first { it.id == "phishing-database" })
        assertEquals(2, safeBrowsing.tables.entries)

        // One feed refreshed (a later moment, other bytes): that one is parsed, the other kept.
        File(dir, "safebrowsing/urlhaus.json").setLastModified(System.currentTimeMillis() - 60_000)
        storage.writeSync("safebrowsing/urlhaus.json", document("urlhaus", "malware", listOf("fresh.example", "another.example")))
        safeBrowsing.reload()
        assertEquals(1, safeBrowsing.lastParsed)
        assertSame(phishing, safeBrowsing.tables.feeds.first { it.id == "phishing-database" })
        assertEquals("urlhaus", safeBrowsing.tables.lookup("fresh.example")!!.feedId)
        assertNull(safeBrowsing.tables.lookup("listed.example"))

        // A document that is not a feed stays known as such (not parsed again) until it changes;
        // a removed document drops out with its table.
        storage.writeSync("safebrowsing/broken.json", "not json")
        safeBrowsing.reload()
        assertEquals(1, safeBrowsing.lastParsed)
        assertEquals(listOf("phishing-database", "urlhaus"), safeBrowsing.tables.feeds.map { it.id })
        safeBrowsing.reload()
        assertEquals(0, safeBrowsing.lastParsed)
        File(dir, "safebrowsing/phishing-database.json").delete()
        safeBrowsing.reload()
        assertEquals(0, safeBrowsing.lastParsed)
        assertEquals(listOf("urlhaus"), safeBrowsing.tables.feeds.map { it.id })
        assertNull(safeBrowsing.tables.lookup("evil.example.com"))
        // Written back (as a fresh file), it is parsed once more.
        storage.writeSync("safebrowsing/phishing-database.json", document("phishing-database", "phishing", listOf("evil.example.com")))
        safeBrowsing.reload()
        assertEquals(1, safeBrowsing.lastParsed)
        assertEquals("phishing", safeBrowsing.tables.lookup("evil.example.com")!!.threat)
    }

    @Test
    fun `the snapshot names the documents by the version tag the incremental load keys on`() {
        storage.writeSync("safebrowsing/urlhaus.json", document("urlhaus", "malware", listOf("listed.example")))
        storage.writeSync("safebrowsing/phishing-database.json", document("phishing-database", "phishing", listOf("evil.example.com")))
        val writer = SafeBrowsing(storage)
        writer.reload()
        assertEquals(2, writer.lastParsed)
        assertEquals(SafeBrowsing.SnapshotOutcome.WRITTEN, writer.lastSnapshot)

        // The header's tags are `Storage.etag`, the files' size and time and nothing of this
        // process: a Storage of its own over the directory (the next process) recognises the snapshot.
        val next = SafeBrowsing(Storage(dir))
        assertTrue(next.loadSnapshot())
        assertEquals(2, next.tables.entries)
        assertEquals("urlhaus", next.tables.lookup("listed.example")!!.feedId)

        // A feed refreshed with other bytes of the same size, within the millisecond: another
        // version to the incremental load (parsed again) and to the header (written again).
        storage.writeSync("safebrowsing/urlhaus.json", document("urlhaus", "malware", listOf("fresh1.example")))
        writer.reload()
        assertEquals(1, writer.lastParsed)
        assertEquals(SafeBrowsing.SnapshotOutcome.WRITTEN, writer.lastSnapshot)
        assertEquals("urlhaus", writer.tables.lookup("fresh1.example")!!.feedId)
        assertNull(writer.tables.lookup("listed.example"))
        val again = SafeBrowsing(Storage(dir))
        assertTrue(again.loadSnapshot())
        assertEquals("urlhaus", again.tables.lookup("fresh1.example")!!.feedId)
        assertNull(again.tables.lookup("listed.example"))
        // The instance that loaded the snapshot has its cache seeded from it: its load parses nothing and leaves it alone.
        again.reload()
        assertEquals(0, again.lastParsed)
        assertEquals(SafeBrowsing.SnapshotOutcome.UNCHANGED, again.lastSnapshot)
    }

    // --- the snapshot seeds the incremental load --------------------------------------------------

    @Test
    fun `a reload after a verified snapshot parses nothing and publishes the same tables`() {
        storage.writeSync("safebrowsing/phishing-database.json", bigDocument("phishing-database", "phishing", 60_000, 5))
        storage.writeSync("safebrowsing/urlhaus.json", document("urlhaus", "malware", listOf("listed.example", "1.2.3.4")))
        storage.writeSync("safebrowsing/ransom.json", document("ransom", "ransom", listOf("ransom.example")))
        // Present but not feeds: named in the header with no table, so the load skips them too.
        storage.writeSync("safebrowsing/broken.json", "not json")
        storage.writeSync("safebrowsing/renamed.json", document("urlhaus", "malware", listOf("stray.example")))
        val documents = 5

        // Before: a process without a snapshot parses every document (what the load after a
        // snapshot did too, until it was seeded).
        val cold = SafeBrowsing(storage)
        cold.reload()
        assertEquals(documents, cold.lastParsed)
        assertEquals(SafeBrowsing.SnapshotOutcome.WRITTEN, cold.lastSnapshot)
        val coldMs = cold.lastLoadMs

        // After: the snapshot passes, seeds the load with every document it names, and the load
        // that follows parses none of them; the tables are the very ones the snapshot published.
        val seeded = SafeBrowsing(storage)
        assertTrue(seeded.loadSnapshot())
        assertEquals(documents, seeded.snapshotSeeded)
        val published = seeded.tables
        seeded.reload()
        assertEquals(0, seeded.lastParsed)
        assertEquals(SafeBrowsing.SnapshotOutcome.UNCHANGED, seeded.lastSnapshot)
        println("seed: a load after a snapshot parsed $documents documents (${coldMs} ms) before; seeded, it parsed ${seeded.lastParsed} (${seeded.lastLoadMs} ms)")
        assertEquals(published.feeds.size, seeded.tables.feeds.size)
        for ((before, after) in published.feeds.zip(seeded.tables.feeds)) assertSame(before, after)
        assertEquals(listOf("phishing-database", "ransom", "urlhaus"), seeded.tables.feeds.map { it.id })
        assertEquals(cold.tables.entries, seeded.tables.entries)
        for ((a, b) in cold.tables.feeds.zip(seeded.tables.feeds)) {
            assertEquals(a.id, b.id)
            assertEquals(a.threat, b.threat)
            assertEquals(a.table.toBase64(), b.table.toBase64())
        }
        for (host in listOf("cdn.listed.example", "1.2.3.4", "ransom.example", "stray.example", "news.example")) {
            assertEquals(host, cold.tables.lookup(host)?.feedId, seeded.tables.lookup(host)?.feedId)
            assertEquals(host, cold.tables.lookup(host)?.threat, seeded.tables.lookup(host)?.threat)
        }
        // And so on for every load with nothing changed.
        seeded.reload()
        assertEquals(0, seeded.lastParsed)
        assertSame(published.feeds[0], seeded.tables.feeds[0])

        // The same on the real path: start() loads the snapshot, then the documents, and says so.
        val started = SafeBrowsing(storage)
        val startedLines = collecting(started)
        started.start()
        try {
            val tablesLine = awaitTablesLine(startedLines)
            assertEquals(SafeBrowsing.SnapshotOutcome.UNCHANGED, started.lastSnapshot)
            assertEquals(0, started.lastParsed)
            assertEquals(documents, started.snapshotSeeded)
            assertEquals(cold.tables.entries, started.tables.entries)
            assertTrue(startedLines.any { it.startsWith("snapshot: ${cold.tables.entries} prefixes from 3 feeds in") && it.endsWith("; $documents documents seeded, none to parse") })
            assertTrue(tablesLine, tablesLine.startsWith("tables: ${cold.tables.entries} prefixes from 3 feeds in") && tablesLine.endsWith(" (0 parsed); snapshot unchanged"))
        } finally {
            started.stop()
        }
    }

    @Test
    fun `a document that changed after the snapshot seeded the load is parsed as any other`() {
        storage.writeSync("safebrowsing/phishing-database.json", document("phishing-database", "phishing", listOf("evil.example.com")))
        storage.writeSync("safebrowsing/urlhaus.json", document("urlhaus", "malware", listOf("listed.example")))
        storage.writeSync("safebrowsing/broken.json", "not json")
        SafeBrowsing(storage).reload()

        val safeBrowsing = SafeBrowsing(storage)
        assertTrue(safeBrowsing.loadSnapshot())
        assertEquals(3, safeBrowsing.snapshotSeeded)
        val phishing = safeBrowsing.tables.feeds.first { it.id == "phishing-database" }

        // One feed refreshed between the snapshot's load and the documents': that one is parsed,
        // the others are kept as seeded, and the snapshot is written again for the new tag.
        rewrite("safebrowsing/urlhaus.json", document("urlhaus", "malware", listOf("fresh.example", "another.example")))
        safeBrowsing.reload()
        assertEquals(1, safeBrowsing.lastParsed)
        assertSame(phishing, safeBrowsing.tables.feeds.first { it.id == "phishing-database" })
        assertEquals("urlhaus", safeBrowsing.tables.lookup("another.example")!!.feedId)
        assertNull(safeBrowsing.tables.lookup("listed.example"))
        assertEquals(SafeBrowsing.SnapshotOutcome.WRITTEN, safeBrowsing.lastSnapshot)

        // A document that was not a feed, rewritten as one: parsed, and a feed now.
        rewrite("safebrowsing/broken.json", document("broken", "unwanted", listOf("unwanted.example")))
        safeBrowsing.reload()
        assertEquals(1, safeBrowsing.lastParsed)
        assertEquals("unwanted", safeBrowsing.tables.lookup("unwanted.example")!!.threat)
        assertSame(phishing, safeBrowsing.tables.feeds.first { it.id == "phishing-database" })

        // A document added, one removed: the added one is parsed, the removed one drops out, the
        // seeded one is still kept.
        storage.writeSync("safebrowsing/added.json", document("added", "malware", listOf("added.example")))
        File(dir, "safebrowsing/urlhaus.json").delete()
        safeBrowsing.reload()
        assertEquals(1, safeBrowsing.lastParsed)
        assertEquals(listOf("added", "broken", "phishing-database"), safeBrowsing.tables.feeds.map { it.id })
        assertSame(phishing, safeBrowsing.tables.feeds.first { it.id == "phishing-database" })
        assertNull(safeBrowsing.tables.lookup("another.example"))
        // Then nothing changes: nothing is parsed.
        safeBrowsing.reload()
        assertEquals(0, safeBrowsing.lastParsed)
        assertEquals(SafeBrowsing.SnapshotOutcome.UNCHANGED, safeBrowsing.lastSnapshot)

        // The next process loads the snapshot of these documents and, again, parses nothing.
        val next = SafeBrowsing(Storage(dir))
        assertTrue(next.loadSnapshot())
        assertEquals(3, next.snapshotSeeded)
        next.reload()
        assertEquals(0, next.lastParsed)
        assertEquals(listOf("added", "broken", "phishing-database"), next.tables.feeds.map { it.id })
    }

    @Test
    fun `a snapshot that was rejected seeds nothing, and the load parses every document`() {
        storage.writeSync("safebrowsing/phishing-database.json", document("phishing-database", "phishing", listOf("evil.example.com")))
        storage.writeSync("safebrowsing/urlhaus.json", document("urlhaus", "malware", listOf("listed.example")))
        SafeBrowsing(storage).reload()
        val good = snapshotFile.readBytes()

        fun seedsNothing(bytes: ByteArray, why: String) {
            snapshotFile.writeBytes(bytes)
            val safeBrowsing = SafeBrowsing(storage)
            assertFalse(safeBrowsing.loadSnapshot())
            assertTrue("'${safeBrowsing.snapshotRejected}' should say '$why'", safeBrowsing.snapshotRejected!!.contains(why))
            assertEquals(0, safeBrowsing.snapshotSeeded)
            assertSame(SafeBrowsingTables.EMPTY, safeBrowsing.tables)
            // The load after it parses every document, as with no snapshot at all.
            safeBrowsing.reload()
            assertEquals(2, safeBrowsing.lastParsed)
            assertEquals(2, safeBrowsing.tables.entries)
            assertEquals("phishing", safeBrowsing.tables.lookup("evil.example.com")!!.threat)
            assertEquals(SafeBrowsing.SnapshotOutcome.WRITTEN, safeBrowsing.lastSnapshot)
        }

        // Not whole: a body cut short; a bit flipped.
        seedsNothing(good.copyOf(good.size - 3), "body of")
        seedsNothing(good.copyOf().also { it[good.size - 1] = (it[good.size - 1] + 1).toByte() }, "checksum")
        // Not this format.
        seedsNothing(good.copyOf().also { it[5] = 7 }, "format 7")
        // Not of the documents present: a feed refreshed since it was written. The header's other
        // entry still matches its document, and is not seeded either: the whole snapshot is out.
        val current = snapshotFile.readBytes()
        rewrite("safebrowsing/urlhaus.json", document("urlhaus", "malware", listOf("fresh.example")))
        seedsNothing(current, "not the ones it was built from")

        // No snapshot at all: nothing seeded, nothing said, every document parsed.
        assertTrue(storage.deleteBytes(SafeBrowsing.SNAPSHOT))
        val none = SafeBrowsing(storage)
        assertFalse(none.loadSnapshot())
        assertNull(none.snapshotRejected)
        assertEquals(0, none.snapshotSeeded)
        none.reload()
        assertEquals(2, none.lastParsed)
    }
}
