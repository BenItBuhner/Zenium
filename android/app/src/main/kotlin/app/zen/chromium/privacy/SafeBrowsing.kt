package app.zen.chromium.privacy

import android.util.Log
import app.zen.chromium.Storage
import app.zen.chromium.blocking.Domains
import app.zen.chromium.blocking.SafeBrowsingHit
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.DataInputStream
import java.io.DataOutputStream
import java.io.IOException
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.nio.LongBuffer
import java.security.MessageDigest
import java.util.Base64
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.zip.CRC32

/**
 * A Safe Browsing feed as loaded: the sorted 8-byte SHA-256 prefixes of its hosts, the Kotlin
 * twin of `PrefixTable` in `src/core/safebrowsing/prefixes.ts`, read from the same documents the
 * core persists. Prefixes are big-endian unsigned 64-bit integers; the core sorts them unsigned
 * (`BigUint64Array`), so the search compares unsigned too.
 */
class PrefixTable private constructor(private val values: LongArray) {
    val size: Int get() = values.size

    fun has(prefix: Long): Boolean {
        var lo = 0
        var hi = values.size - 1
        while (lo <= hi) {
            val mid = (lo + hi) ushr 1
            val c = java.lang.Long.compareUnsigned(values[mid], prefix)
            if (c == 0) return true
            if (c < 0) lo = mid + 1 else hi = mid - 1
        }
        return false
    }

    /** The expression of `hostname` (see [hostExpressions]) the table holds, or null. */
    fun matchHost(hostname: String): String? {
        if (values.isEmpty()) return null
        for (expression in hostExpressions(hostname)) if (has(prefixOf(expression))) return expression
        return null
    }

    /** Sorted big-endian prefixes as the core stores them (base64). */
    fun toBase64(): String {
        val buffer = ByteBuffer.allocate(values.size * PREFIX_BYTES).order(ByteOrder.BIG_ENDIAN)
        for (v in values) buffer.putLong(v)
        return Base64.getEncoder().encodeToString(buffer.array())
    }

    /** The sorted prefixes, as they are, into `out` (the snapshot's body; see [SafeBrowsing.writeSnapshot]). */
    internal fun copyInto(out: LongBuffer) {
        out.put(values)
    }

    companion object {
        const val PREFIX_BYTES = 8
        val EMPTY = PrefixTable(LongArray(0))

        /**
         * A table over prefixes already in unsigned order without duplicates: a snapshot's body,
         * exactly as [copyInto] wrote it (its checksum vouches for the bytes), so no sort.
         */
        internal fun sorted(values: LongArray): PrefixTable = if (values.isEmpty()) EMPTY else PrefixTable(values)

        /** The first [PREFIX_BYTES] bytes of `sha256(expression)` as one big-endian integer. */
        fun prefixOf(expression: String): Long {
            val digest = MessageDigest.getInstance("SHA-256").digest(expression.toByteArray(Charsets.UTF_8))
            return ByteBuffer.wrap(digest, 0, PREFIX_BYTES).order(ByteOrder.BIG_ENDIAN).long
        }

        /**
         * The expressions a hostname is looked up under: the host itself and each parent down to
         * its registrable domain (`a.b.example.com` → `a.b.example.com`, `b.example.com`,
         * `example.com`); never a public suffix on its own. IP literals are looked up as they are.
         */
        fun hostExpressions(hostname: String): List<String> {
            val host = hostname.lowercase().removeSuffix(".")
            if (host.isEmpty()) return emptyList()
            val base = Domains.registrableDomain(host)
            if (base == host || !host.endsWith(".$base")) return listOf(host)
            val out = ArrayList<String>(4)
            out.add(host)
            var rest = host
            while (true) {
                val dot = rest.indexOf('.')
                if (dot == -1) break
                rest = rest.substring(dot + 1)
                out.add(rest)
                if (rest == base) break
            }
            return out
        }

        /** From the core's base64 of concatenated big-endian prefixes (any order; a trailing partial prefix is dropped). */
        fun fromBase64(text: String): PrefixTable {
            val bytes = runCatching { Base64.getMimeDecoder().decode(text) }.getOrNull() ?: return EMPTY
            val count = bytes.size / PREFIX_BYTES
            val buffer = ByteBuffer.wrap(bytes, 0, count * PREFIX_BYTES).order(ByteOrder.BIG_ENDIAN)
            val values = LongArray(count) { buffer.getLong(it * PREFIX_BYTES) }
            return fromValues(values)
        }

        /** Build from hostnames (already normalised: lowercase, no trailing dot). */
        fun fromHosts(hosts: Iterable<String>): PrefixTable {
            val list = hosts.toList()
            return fromValues(LongArray(list.size) { prefixOf(list[it]) })
        }

        private fun fromValues(values: LongArray): PrefixTable {
            if (values.isEmpty()) return EMPTY
            // Unsigned order, as the core sorts. A signed sort puts the values with the top bit
            // set (negative as longs) first; unsigned order wants them last, so rotate.
            val signed = values.copyOf().apply { sort() }
            var firstNonNegative = 0
            while (firstNonNegative < signed.size && signed[firstNonNegative] < 0) firstNonNegative++
            val sorted = if (firstNonNegative == 0) signed else LongArray(signed.size).also { out ->
                System.arraycopy(signed, firstNonNegative, out, 0, signed.size - firstNonNegative)
                System.arraycopy(signed, 0, out, signed.size - firstNonNegative, firstNonNegative)
            }
            var unique = 0
            for (i in sorted.indices) {
                if (i > 0 && sorted[i] == sorted[i - 1]) continue
                sorted[unique++] = sorted[i]
            }
            return PrefixTable(if (unique == sorted.size) sorted else sorted.copyOf(unique))
        }
    }
}

/** One feed's loaded table with what a hit on it is reported as. */
class FeedTable(val id: String, val threat: String, val table: PrefixTable)

/** The loaded feeds together: one lookup across every table, in the feeds' file order. */
class SafeBrowsingTables(val feeds: List<FeedTable>) {
    val entries: Int get() = feeds.sumOf { it.table.size }

    /** The first feed listing `host` (or a parent of it), or null. The test hosts are always listed. */
    fun lookup(host: String): SafeBrowsingHit? {
        TEST_HOSTS[host]?.let { return SafeBrowsingHit(TEST_FEED, it, host) }
        if (feeds.isEmpty()) return null
        for (expression in PrefixTable.hostExpressions(host)) {
            val prefix = PrefixTable.prefixOf(expression)
            for (feed in feeds) if (feed.table.has(prefix)) return SafeBrowsingHit(feed.id, feed.threat, expression)
        }
        return null
    }

    companion object {
        val EMPTY = SafeBrowsingTables(emptyList())

        /** `SAFE_BROWSING_TEST_HOSTS` in `src/core/safebrowsing/feeds.ts`: reserved names (RFC 6761) for trying the warning page. */
        val TEST_HOSTS = mapOf("malware.zenium.test" to "malware", "phishing.zenium.test" to "phishing")
        const val TEST_FEED = "test"

        /**
         * One persisted feed document (`FeedDocument` in `src/core/safebrowsing/service.ts`), or
         * null when the text is not one. `expectedId` (the file's name) must match the document's.
         */
        fun parseDocument(text: String, expectedId: String?): FeedTable? {
            val o = runCatching { JSONObject(text) }.getOrNull() ?: return null
            if (o.optInt("version") != DOCUMENT_VERSION) return null
            val id = o.optString("id", "")
            if (id.isEmpty() || (expectedId != null && id != expectedId)) return null
            val prefixes = o.optString("prefixes", "")
            val threat = o.optString("threat", "").takeIf { it in THREATS } ?: "unknown"
            return FeedTable(id, threat, PrefixTable.fromBase64(prefixes))
        }

        const val DOCUMENT_VERSION = 1
        private val THREATS = setOf("malware", "phishing", "unwanted", "unknown")
    }
}

/**
 * Follows the core's Safe Browsing files (`files/zen/safebrowsing/<feed>.json`, written by
 * `SafeBrowsingService` when a feed is refreshed or the bundled snapshot is seeded) and keeps the
 * loaded [tables] for the request guard, rebuilt on a background thread whenever one is rewritten.
 *
 * The documents are the truth, and parsing them is slow: 7.4 MB of JSON around a base64 string
 * of 690 000 prefixes takes the debug build's interpreter 4 to 6 s on the emulator, during which
 * the tables were empty and the navigations of a warm start passed the guard unchecked. Two
 * things close that window. A compact snapshot of the loaded tables (`safebrowsing/tables.bin`,
 * see [writeSnapshot]) is written after every load that changed them and read back first at
 * [start], ahead of the documents, in tens of milliseconds ([loadSnapshot]); it is a cache this
 * side owns, keyed on the documents it was built from and never trusted when they differ, and
 * the core never reads it. And the process's first main-frame navigation waits for the first
 * load, snapshot or documents, up to [FIRST_NAVIGATION_HOLD_MS] before going on with what there
 * is ([tablesForNavigation]).
 */
class SafeBrowsing(private val storage: Storage) {
    @Volatile
    var tables: SafeBrowsingTables = SafeBrowsingTables.EMPTY
        private set

    /** Wall-clock milliseconds of the last load, for diagnostics. */
    @Volatile
    var lastLoadMs: Long = 0
        private set

    /** Documents the last load parsed (the ones whose version tag had changed), for diagnostics. */
    @Volatile
    var lastParsed: Int = 0
        private set

    /** Milliseconds the snapshot took to load and publish, or -1 when none was (yet), for diagnostics. */
    @Volatile
    var snapshotLoadMs: Long = -1
        private set

    /** Why the snapshot found at [start] was ignored (and deleted), or null; for diagnostics. */
    @Volatile
    var snapshotRejected: String? = null
        private set

    /** What the last load did about the snapshot, for diagnostics. */
    @Volatile
    var lastSnapshot: SnapshotOutcome = SnapshotOutcome.NONE
        private set

    /** What the process's first main-frame check found (see [tablesForNavigation]), or null before it. */
    @Volatile
    var firstNavigation: FirstNavigation? = null
        private set

    /** Where the informational lines go: logcat in the app, a list in the tests (no `Log` on the JVM). */
    internal var log: (String) -> Unit = { Log.i(TAG, it) }

    /**
     * Every document as last parsed, by name, with the version tag ([Storage.etag]) it was
     * parsed from: a load re-parses only the documents the core rewrote since (a refreshed
     * feed's), the megabytes of the others – decoded, sorted – stay as they are. Loader thread only.
     */
    private val parsed = HashMap<String, Pair<String, FeedTable?>>()

    private val loader = Executors.newSingleThreadScheduledExecutor { r -> Thread(r, "zen-safebrowsing") }
    private var scheduled: ScheduledFuture<*>? = null

    /** Open until the first load – the snapshot's or the documents' – has published [tables]. */
    private val firstLoad = CountDownLatch(1)

    /** Whether the process's first main-frame check is still to come (it alone may wait). */
    private val firstNavigationPending = AtomicBoolean(true)

    /** `System.nanoTime()` at [start], for the first navigation's diagnostics; 0 before. */
    @Volatile
    private var startedAt = 0L

    /** The header of the snapshot on disk, as loaded or last written; null when there is none. Loader thread only. */
    private var snapshotHeader: List<SnapshotFeed>? = null

    private val onStorageChanged: (String) -> Unit = { name ->
        if (name.startsWith("$DIR/") && name.endsWith(".json")) scheduleReload(RELOAD_DELAY_MS)
    }

    /** The snapshot first, on the loader thread, then the documents as before; returns at once. */
    fun start() {
        startedAt = System.nanoTime()
        Storage.addChangeListener(onStorageChanged)
        runCatching { loader.execute { loadSnapshotLogged() } }
        scheduleReload(0)
    }

    fun stop() {
        Storage.removeChangeListener(onStorageChanged)
        loader.shutdownNow()
    }

    @Synchronized
    private fun scheduleReload(delayMs: Long) {
        scheduled?.cancel(false)
        scheduled = runCatching { loader.schedule({ reloadLogged() }, delayMs, TimeUnit.MILLISECONDS) }.getOrNull()
    }

    private fun reloadLogged() {
        try {
            reload()
            log("tables: ${tables.entries} prefixes from ${tables.feeds.size} feeds in $lastLoadMs ms ($lastParsed parsed); snapshot ${lastSnapshot.name.lowercase()}")
        } catch (e: Throwable) {
            Log.e(TAG, "Safe Browsing tables not reloaded", e)
        }
    }

    /**
     * Read every feed document under `safebrowsing/` whose version tag changed since the last
     * load, keep the others' tables; called on the loader thread (and in tests).
     */
    internal fun reload() {
        val started = System.nanoTime()
        val tags = documentTags()
        val feeds = ArrayList<FeedTable>()
        val present = HashSet<String>()
        var parsedNow = 0
        for (name in storage.list(DIR).sorted()) {
            if (!name.endsWith(".json")) continue
            val id = name.substringAfterLast('/').removeSuffix(".json")
            val tag = storage.etag(name) ?: continue
            present.add(name)
            val known = parsed[name]
            val table = if (known != null && known.first == tag) {
                known.second
            } else {
                val text = storage.read(name) ?: continue
                parsedNow++
                val fresh = SafeBrowsingTables.parseDocument(text, id)
                // Remember the table under the tag only when the file is still the one read: a
                // write that landed in between is parsed by the load it schedules.
                if (storage.etag(name) == tag) parsed[name] = tag to fresh else parsed.remove(name)
                fresh
            }
            table?.let { feeds.add(it) }
        }
        parsed.keys.retainAll(present)
        tables = SafeBrowsingTables(feeds)
        lastParsed = parsedNow
        lastLoadMs = (System.nanoTime() - started) / 1_000_000
        firstLoad.countDown()
        lastSnapshot = writeSnapshot(feeds, tags)
    }

    // --- the first navigation's hold ------------------------------------------------------------

    /**
     * The tables for a main-frame navigation's check. The process's first one, when no load has
     * published tables yet, waits for the first up to [FIRST_NAVIGATION_HOLD_MS] – next to
     * nothing with a snapshot, the cap over a parse of the documents without one – and then goes
     * on with whatever there is: unchecked when the load is still pending, the way Chrome's
     * lookup times out open. Every later navigation, and every subresource, takes [tables] as
     * they are. Called on WebView's IO threads.
     */
    fun tablesForNavigation(): SafeBrowsingTables {
        if (firstNavigationPending.compareAndSet(true, false)) {
            val started = System.nanoTime()
            val sinceStartMs = if (startedAt == 0L) -1 else (started - startedAt) / 1_000_000
            val loaded = firstLoad.count == 0L || awaitFirstLoad()
            val waitedMs = (System.nanoTime() - started) / 1_000_000
            val now = tables
            firstNavigation = FirstNavigation(now.entries, waitedMs, loaded, sinceStartMs)
            log(
                "first navigation: ${now.entries} prefixes from ${now.feeds.size} feeds after a wait of $waitedMs ms, " +
                    "$sinceStartMs ms after start " + if (loaded) "(loaded)" else "(load pending: unchecked)"
            )
        }
        return tables
    }

    private fun awaitFirstLoad(): Boolean = try {
        firstLoad.await(FIRST_NAVIGATION_HOLD_MS, TimeUnit.MILLISECONDS)
    } catch (_: InterruptedException) {
        Thread.currentThread().interrupt()
        false
    }

    // --- the snapshot -----------------------------------------------------------------------------

    /**
     * The feed documents present, with their version tags ([Storage.etag]: the same tag [reload]
     * keeps its parsed tables by, a property of the file that the next process reads back), in
     * the order [reload] reads them.
     */
    private fun documentTags(): List<Pair<String, String>> {
        val out = ArrayList<Pair<String, String>>()
        for (name in storage.list(DIR).sorted()) {
            if (!name.endsWith(".json")) continue
            val tag = storage.etag(name) ?: continue
            out.add(name to tag)
        }
        return out
    }

    private fun loadSnapshotLogged() {
        try {
            if (loadSnapshot()) {
                log("snapshot: ${tables.entries} prefixes from ${tables.feeds.size} feeds in $snapshotLoadMs ms")
            } else {
                snapshotRejected?.let { log("snapshot ignored and deleted: $it") }
            }
        } catch (e: Throwable) {
            Log.e(TAG, "Safe Browsing snapshot not loaded", e)
        }
    }

    /**
     * Publish the tables from `safebrowsing/tables.bin` when it is the snapshot of exactly the
     * documents present – the header names each with the tag it had – and whole: right magic and
     * version, a body of the length the header adds up to, and the body's checksum. Anything
     * else is ignored and deleted (the documents' load that follows writes a fresh one). True
     * when tables were published. Loader thread (and tests).
     */
    internal fun loadSnapshot(): Boolean {
        val started = System.nanoTime()
        val bytes = storage.readBytes(SNAPSHOT) ?: return false
        val header = try {
            readSnapshotHeader(bytes)
        } catch (e: IOException) {
            return rejectSnapshot(e.message ?: "unreadable header")
        }
        val bodyStart = header.bodyStart
        var total = 0L
        for (feed in header.feeds) total += feed.count.toLong() * PrefixTable.PREFIX_BYTES
        if (bytes.size.toLong() - bodyStart != total) return rejectSnapshot("body of ${bytes.size - bodyStart} bytes, header adds up to $total")
        val crc = CRC32().also { it.update(bytes, bodyStart, bytes.size - bodyStart) }
        if (crc.value.toInt() != header.crc) return rejectSnapshot("body checksum differs")
        val present = documentTags()
        val named = header.feeds.map { "$DIR/${it.id}.json" to it.tag }
        if (named != present) return rejectSnapshot("the documents present are not the ones it was built from")

        val longs = ByteBuffer.wrap(bytes, bodyStart, bytes.size - bodyStart).order(ByteOrder.BIG_ENDIAN).asLongBuffer()
        val feeds = ArrayList<FeedTable>(header.feeds.size)
        for (feed in header.feeds) {
            val values = LongArray(feed.count)
            longs.get(values)
            // A document present that was not a feed when the snapshot was written has no table.
            if (feed.threat.isNotEmpty()) feeds.add(FeedTable(feed.id, feed.threat, PrefixTable.sorted(values)))
        }
        tables = SafeBrowsingTables(feeds)
        snapshotHeader = header.feeds
        snapshotRejected = null
        snapshotLoadMs = (System.nanoTime() - started) / 1_000_000
        firstLoad.countDown()
        return true
    }

    private fun rejectSnapshot(why: String): Boolean {
        snapshotRejected = why
        snapshotHeader = null
        storage.deleteBytes(SNAPSHOT)
        return false
    }

    private class SnapshotHeader(val feeds: List<SnapshotFeed>, val crc: Int, val bodyStart: Int)

    @Throws(IOException::class)
    private fun readSnapshotHeader(bytes: ByteArray): SnapshotHeader {
        val input = ByteArrayInputStream(bytes)
        val data = DataInputStream(input)
        if (data.readInt() != SNAPSHOT_MAGIC) throw IOException("not a snapshot")
        val version = data.readShort().toInt()
        if (version != SNAPSHOT_VERSION) throw IOException("snapshot format $version, this build reads $SNAPSHOT_VERSION")
        val count = data.readShort().toInt()
        if (count < 0 || count > MAX_SNAPSHOT_FEEDS) throw IOException("$count feeds")
        val feeds = ArrayList<SnapshotFeed>(count)
        for (i in 0 until count) {
            val id = data.readUTF()
            val threat = data.readUTF()
            val tag = data.readUTF()
            val prefixes = data.readInt()
            if (prefixes < 0) throw IOException("a negative prefix count")
            feeds.add(SnapshotFeed(id, threat, tag, prefixes))
        }
        val crc = data.readInt()
        return SnapshotHeader(feeds, crc, bytes.size - input.available())
    }

    /**
     * After a load of the documents (the end of [reload]): write `safebrowsing/tables.bin` from
     * the tables just published, unless the snapshot on disk already is the one of these
     * documents (the header as loaded or last written: the same names, tags and counts), or a
     * document changed under the load (`tags` were taken before it; the change scheduled the
     * next load, which writes). Called on the loader thread (and in tests).
     *
     * The format, big-endian throughout: `int` magic `ZSBT`, `short` format version, `short`
     * feed count; per document present (sorted by name): `UTF` id, `UTF` threat (empty when the
     * document was not a feed), `UTF` tag, `int` prefix count; `int` CRC-32 of the body. Then
     * the body: every feed's sorted 8-byte prefixes, raw, one feed after the other.
     */
    internal fun writeSnapshot(feeds: List<FeedTable>, tags: List<Pair<String, String>>): SnapshotOutcome {
        if (tags.isEmpty()) return SnapshotOutcome.NONE
        if (documentTags() != tags) return SnapshotOutcome.DEFERRED
        val byId = feeds.associateBy { it.id }
        val header = tags.map { (name, tag) ->
            val id = name.substringAfterLast('/').removeSuffix(".json")
            val feed = byId[id]
            SnapshotFeed(id, feed?.threat ?: "", tag, feed?.table?.size ?: 0)
        }
        if (header == snapshotHeader) return SnapshotOutcome.UNCHANGED

        val headerBytes = ByteArrayOutputStream()
        DataOutputStream(headerBytes).use { data ->
            data.writeInt(SNAPSHOT_MAGIC)
            data.writeShort(SNAPSHOT_VERSION)
            data.writeShort(header.size)
            for (feed in header) {
                data.writeUTF(feed.id)
                data.writeUTF(feed.threat)
                data.writeUTF(feed.tag)
                data.writeInt(feed.count)
            }
            data.writeInt(0) // the checksum, patched in below
        }
        val headerSize = headerBytes.size()
        var body = 0
        for (feed in header) body += feed.count * PrefixTable.PREFIX_BYTES
        val buffer = ByteBuffer.allocate(headerSize + body).order(ByteOrder.BIG_ENDIAN)
        buffer.put(headerBytes.toByteArray())
        val longs = buffer.asLongBuffer()
        for (feed in header) byId[feed.id]?.table?.copyInto(longs)
        val crc = CRC32().also { it.update(buffer.array(), headerSize, body) }
        buffer.putInt(headerSize - Int.SIZE_BYTES, crc.value.toInt())
        if (!storage.writeBytes(SNAPSHOT, buffer.array())) return SnapshotOutcome.FAILED
        snapshotHeader = header
        return SnapshotOutcome.WRITTEN
    }

    /** One document's line in the snapshot's header. */
    internal data class SnapshotFeed(val id: String, val threat: String, val tag: String, val count: Int)

    /** What a load of the documents did about the snapshot. */
    enum class SnapshotOutcome {
        /** No documents, nothing to snapshot. */
        NONE,
        /** Written from the tables just published. */
        WRITTEN,
        /** The snapshot on disk is already the one of these documents. */
        UNCHANGED,
        /** A document changed under the load; the load that change scheduled writes. */
        DEFERRED,
        /** The bytes did not land. */
        FAILED
    }

    /**
     * The process's first main-frame check: the prefixes it saw, how long it waited, whether a
     * load had published, and how long after [start] it came (-1 before a start).
     */
    class FirstNavigation(val entries: Int, val waitedMs: Long, val loaded: Boolean, val sinceStartMs: Long)

    companion object {
        private const val TAG = "zen-safebrowsing"

        /** Where the core keeps the feed documents (`SAFE_BROWSING_DIR` in `service.ts`). */
        const val DIR = "safebrowsing"

        /** The snapshot of the loaded tables, beside the documents; the Kotlin side's own. */
        const val SNAPSHOT = "$DIR/tables.bin"

        /** `ZSBT`, the snapshot's first four bytes. */
        internal const val SNAPSHOT_MAGIC = 0x5A534254

        /** The snapshot format this build writes and reads; another version is ignored. */
        internal const val SNAPSHOT_VERSION = 1

        /** More feeds than this in a header is garbage, not a snapshot. */
        private const val MAX_SNAPSHOT_FEEDS = 1024

        /** How long the process's first main-frame navigation waits for the first load, at most. */
        const val FIRST_NAVIGATION_HOLD_MS = 250L

        /** The core writes the feeds one after another; one beat coalesces a refresh of them all. */
        private const val RELOAD_DELAY_MS = 300L
    }
}
