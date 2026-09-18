package app.zen.chromium.privacy

import android.util.Log
import app.zen.chromium.Storage
import app.zen.chromium.blocking.Domains
import app.zen.chromium.blocking.SafeBrowsingHit
import org.json.JSONObject
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.security.MessageDigest
import java.util.Base64
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit

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

    companion object {
        const val PREFIX_BYTES = 8
        val EMPTY = PrefixTable(LongArray(0))

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

    /** The first feed listing `host` (or a parent of it), or null. */
    fun lookup(host: String): SafeBrowsingHit? {
        if (feeds.isEmpty()) return null
        for (expression in PrefixTable.hostExpressions(host)) {
            val prefix = PrefixTable.prefixOf(expression)
            for (feed in feeds) if (feed.table.has(prefix)) return SafeBrowsingHit(feed.id, feed.threat, expression)
        }
        return null
    }

    companion object {
        val EMPTY = SafeBrowsingTables(emptyList())

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
 */
class SafeBrowsing(private val storage: Storage) {
    @Volatile
    var tables: SafeBrowsingTables = SafeBrowsingTables.EMPTY
        private set

    /** Wall-clock milliseconds of the last load, for diagnostics. */
    @Volatile
    var lastLoadMs: Long = 0
        private set

    private val loader = Executors.newSingleThreadScheduledExecutor { r -> Thread(r, "zen-safebrowsing") }
    private var scheduled: ScheduledFuture<*>? = null

    private val onStorageChanged: (String) -> Unit = { name ->
        if (name.startsWith("$DIR/")) scheduleReload(RELOAD_DELAY_MS)
    }

    fun start() {
        Storage.addChangeListener(onStorageChanged)
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
            Log.i(TAG, "tables: ${tables.entries} prefixes from ${tables.feeds.size} feeds in $lastLoadMs ms")
        } catch (e: Throwable) {
            Log.e(TAG, "Safe Browsing tables not reloaded", e)
        }
    }

    /** Read every feed document under `safebrowsing/`; called on the loader thread (and in tests). */
    internal fun reload() {
        val started = System.nanoTime()
        val feeds = ArrayList<FeedTable>()
        for (name in storage.list(DIR).sorted()) {
            if (!name.endsWith(".json")) continue
            val id = name.substringAfterLast('/').removeSuffix(".json")
            val text = storage.read(name) ?: continue
            SafeBrowsingTables.parseDocument(text, id)?.let { feeds.add(it) }
        }
        tables = SafeBrowsingTables(feeds)
        lastLoadMs = (System.nanoTime() - started) / 1_000_000
    }

    companion object {
        private const val TAG = "zen-safebrowsing"

        /** Where the core keeps the feed documents (`SAFE_BROWSING_DIR` in `service.ts`). */
        const val DIR = "safebrowsing"

        /** The core writes the feeds one after another; one beat coalesces a refresh of them all. */
        private const val RELOAD_DELAY_MS = 300L
    }
}
