package app.zen.chromium.ext

import androidx.annotation.VisibleForTesting
import app.zen.chromium.strOrNull
import org.json.JSONArray
import org.json.JSONObject
import java.lang.ref.SoftReference
import java.security.MessageDigest

/**
 * Compiles the content-script units the core plans for one extension (`ext.configure`) into the
 * document-start scripts the WebView injects, and remembers them per extension and version:
 *
 *  - the sources of an extension's files are read once per version, however many units and
 *    reconfigures ask for them (a `registerContentScripts` call re-plans the extension's units,
 *    it does not change its files) – held softly: every source is also inside the assembled
 *    script, so under heap pressure the GC takes the raw texts back and the next reconfigure
 *    reads them again (Grammarly's ten million characters of sources are that much heap twice,
 *    on a 192 MB debug heap that also holds the other extensions' units). A file of
 *    [LARGE_SOURCE_CHARS] or more is not held at all: it goes into the script as a
 *    [ExtensionScripts.Source.transient] text released as it is copied in, and a re-plan reads
 *    it from disk again (Monica's 28 million characters of `content.js`: a soft copy of it kept
 *    the heap at its limit, and the assembly's third copy of it was the allocation that failed);
 *  - a unit whose inputs (config, groups, CSS, debug flag) did not change keeps its assembled
 *    script, so a reconfigure that re-sends an unchanged unit costs a hash, not an assembly;
 *  - a unit the heap cannot hold as one script is refused before any of it is read
 *    ([budgetChars], [Compiled.refused]): the extension's other units, its pages and its
 *    background go on, the refused unit's content scripts do not run. Total Adblock lists a
 *    9.3 million character `vendor.min.js` ahead of every one of its eight content-script
 *    entries, and a unit copies a file once per group it is in: 75 million characters, whose
 *    builder – Latin-1 until the first character outside it, then twice the size – was a 150 MB
 *    allocation on a 192 MB heap, and the process died under it (compat round 13);
 *  - every other extension's cache is untouched, and a new version starts from nothing.
 *
 * Pure string work over an injected reader, so the JVM unit tests cover it.
 */
class UnitCompiler(
    /** The most characters one unit may run to; [unitBudgetChars] of this process's heap unless a test says otherwise. */
    val budgetChars: Int = unitBudgetChars(Runtime.getRuntime().maxMemory()),
    private val bootstrap: () -> String
) {
    /** One compiled unit: what the WebView gets and what the core is told about it. */
    class Compiled(
        val extensionId: String,
        val key: String,
        val origins: List<String>,
        /** The isolated world to inject into, or null for the page's main world. */
        val world: String?,
        val script: String,
        val hash: String,
        /** Whether the script came from the cache rather than being assembled now. */
        val cached: Boolean,
        /** Why the unit was not assembled, when it was not: its size against the budget. The script is then empty. */
        val refused: Refused? = null
    )

    /** A unit over the budget: what it would have run to (from the files' sizes), over how many groups, against what. */
    class Refused(val chars: Long, val groups: Int, val budgetChars: Int)

    private class ExtensionCache(val version: String) {
        /** Extension-relative path → the file's text behind a [SoftReference], or [MISSING] (unreadable). */
        val sources = HashMap<String, Any>()
        val units = HashMap<String, Compiled>()
    }

    private val cache = HashMap<String, ExtensionCache>()

    /**
     * Compile `units` (`[{ key, origins, world, config, groups: [{ ext, index, js, isolation }],
     * css: [{ ext, path }] }]`) for one extension. `read` answers an extension-relative path with
     * the file's text, or null; `size` with the file's length in bytes without reading it, or
     * null. A unit is measured from the sizes before any of its files is read: a UTF-8 file has
     * at most as many characters as bytes, so the sum bounds the script, and a unit over the
     * budget is [Compiled.refused] with nothing of it allocated.
     */
    @Synchronized
    fun compile(
        id: String,
        version: String,
        units: JSONArray,
        debug: Boolean,
        read: (String) -> String?,
        size: (String) -> Long?
    ): List<Compiled> {
        var entry = cache[id]
        if (entry == null || entry.version != version) {
            entry = ExtensionCache(version)
            cache[id] = entry
        }
        val out = ArrayList<Compiled>(units.length())
        val keysNow = HashSet<String>()
        for (i in 0 until units.length()) {
            val u = units.optJSONObject(i) ?: continue
            val key = u.optString("key")
            keysNow.add(key)
            val origins = u.optJSONArray("origins").let { a -> if (a == null) emptyList() else List(a.length()) { k -> a.optString(k, "*") } }
                .toSet().ifEmpty { setOf("*") }.toList()
            // A main-world unit comes with `world: null`, which `optString` would read as "null".
            val world = u.strOrNull("world")?.takeIf { it.isNotEmpty() }
            val config = u.optString("config", "{}")
            val groupsJson = u.optJSONArray("groups") ?: JSONArray()
            val cssJson = u.optJSONArray("css") ?: JSONArray()
            val hash = sha256("$config\u0000$groupsJson\u0000$cssJson\u0000$debug\u0000${world ?: ""}")
            val previous = entry.units[key]
            if (previous != null && previous.hash == hash) {
                val kept = Compiled(id, key, origins, world, previous.script, hash, cached = true, refused = previous.refused)
                entry.units[key] = kept
                out.add(kept)
                continue
            }
            val estimate = estimateChars(entry, config, groupsJson, cssJson, size)
            if (estimate > budgetChars) {
                // Refused the way a compiled unit is kept: the same plan sent again answers from
                // the cache, so the extension's console hears of it once per plan.
                val refused = Compiled(id, key, origins, world, "", hash, cached = false, refused = Refused(estimate, groupsJson.length(), budgetChars))
                entry.units[key] = refused
                out.add(refused)
                continue
            }
            val groups = ArrayList<ExtensionScripts.Group>()
            for (j in 0 until groupsJson.length()) {
                val g = groupsJson.optJSONObject(j) ?: continue
                val ext = g.optString("ext", id)
                val files = g.optJSONArray("js") ?: JSONArray()
                val sources = List(files.length()) { k ->
                    val path = files.optString(k, "")
                    if (path.startsWith(INLINE_CODE)) ExtensionScripts.Source(path.substring(INLINE_CODE.length))
                    else source(entry, path, read)
                        ?: ExtensionScripts.Source("console.error(${JSONObject.quote("[Zenium] extension $ext: missing content script $path")});")
                }
                groups.add(ExtensionScripts.Group(ext, g.optInt("index"), sources, g.optString("isolation", "with")))
            }
            val css = LinkedHashMap<String, String>()
            for (j in 0 until cssJson.length()) {
                val c = cssJson.optJSONObject(j) ?: continue
                val path = c.optString("path")
                val text = text(entry, path, read) ?: continue
                css["${c.optString("ext", id)}/${path.trimStart('/')}"] = text
            }
            val script = ExtensionScripts.documentStart(bootstrap(), config, groups, css, debug)
            val compiled = Compiled(id, key, origins, world, script, hash, cached = false)
            entry.units[key] = compiled
            out.add(compiled)
        }
        // Units the plan no longer has are not kept around (a registered script that went away).
        entry.units.keys.retainAll(keysNow)
        return out
    }

    /** The compiled units of one extension as last configured (empty when not configured). */
    @Synchronized
    fun unitsOf(id: String): List<Compiled> = cache[id]?.units?.values?.sortedBy { it.key } ?: emptyList()

    /** Drop everything remembered for an extension (it was detached). */
    @Synchronized
    fun forget(id: String) {
        cache.remove(id)
    }

    /** The number of source files held for an extension (a text the GC took back no longer counts), for instrumentation. */
    @Synchronized
    fun cachedSources(id: String): Int = cache[id]?.sources?.values?.count { it === MISSING || (it as SoftReference<*>).get() != null } ?: 0

    /** What the GC may do at any time: let go of every source text held for the extension. */
    @VisibleForTesting
    @Synchronized
    fun clearSourcesForTest(id: String) {
        cache[id]?.sources?.values?.forEach { (it as? SoftReference<*>)?.clear() }
    }

    /**
     * What the unit's script would run to, in characters, from what is known without reading a
     * file: the sizes on disk (a file listed in several groups counts once per group, as the
     * script copies it), an inline entry's own length, a source already held in the cache by
     * its real length, and the fixed parts ([ExtensionScripts.documentStart] sizes its builder
     * the same way). A file that is not there costs its console stub.
     */
    private fun estimateChars(entry: ExtensionCache, config: String, groupsJson: JSONArray, cssJson: JSONArray, size: (String) -> Long?): Long {
        var total = bootstrap().length.toLong() + config.length + 4096
        for (j in 0 until groupsJson.length()) {
            val g = groupsJson.optJSONObject(j) ?: continue
            val files = g.optJSONArray("js") ?: JSONArray()
            total += GROUP_ROOM
            for (k in 0 until files.length()) {
                val path = files.optString(k, "")
                total += if (path.startsWith(INLINE_CODE)) (path.length - INLINE_CODE.length).toLong() else fileChars(entry, path, size)
            }
        }
        for (j in 0 until cssJson.length()) {
            val c = cssJson.optJSONObject(j) ?: continue
            total += fileChars(entry, c.optString("path"), size) + 64
        }
        return total
    }

    /** A file's characters as far as they are known without reading it: the held text's length, else its size in bytes. */
    private fun fileChars(entry: ExtensionCache, path: String, size: (String) -> Long?): Long {
        if (path.isEmpty()) return 0
        when (val held = entry.sources[path]) {
            MISSING -> return MISSING_STUB_CHARS
            is SoftReference<*> -> (held.get() as String?)?.let { return it.length.toLong() }
        }
        return size(path) ?: MISSING_STUB_CHARS
    }

    /** A script file as the assembly takes it: held (small, soft-cached) or transient (large, released as it is copied in). */
    private fun source(entry: ExtensionCache, path: String, read: (String) -> String?): ExtensionScripts.Source? {
        val text = text(entry, path, read) ?: return null
        return if (text.length >= LARGE_SOURCE_CHARS) ExtensionScripts.Source.transient(text) else ExtensionScripts.Source(text)
    }

    /** The file's text: from the soft cache, or read now (and cached when under [LARGE_SOURCE_CHARS]). */
    private fun text(entry: ExtensionCache, path: String, read: (String) -> String?): String? {
        if (path.isEmpty()) return null
        when (val held = entry.sources[path]) {
            MISSING -> return null
            is SoftReference<*> -> (held.get() as String?)?.let { return it }
        }
        val text = runCatching { read(path) }.getOrNull()
        when {
            text == null -> entry.sources[path] = MISSING
            text.length < LARGE_SOURCE_CHARS -> entry.sources[path] = SoftReference(text)
        }
        return text
    }

    companion object {
        /** Marks a path whose file is missing or unreadable, so it is not read again for the version. */
        private val MISSING = Any()

        /**
         * From this many characters a file is not soft-cached and travels into the script as a
         * transient source: a megabyte of text is two megabytes of heap held for a re-plan that
         * may never come, and the files this size are the ones whose second and third copies do
         * not fit (Monica's `content.js`, 28 M).
         */
        const val LARGE_SOURCE_CHARS = 1 shl 20

        /**
         * A `js` entry that is the script's text rather than a path: `userScripts.register` takes
         * `{ code }` entries (Tampermonkey registers every user script that way, Ghostery its
         * scriptlets), and the core carries them in the group's `js` list behind a NUL – a
         * character no path has (`extensionApi.ts`, `inlineScript`).
         */
        const val INLINE_CODE = "\u0000"

        /** A group's fixed text in the script (its function head, the `with` block, the joins) plus room for its mirror. */
        private const val GROUP_ROOM = 256L

        /** The console stub a missing file becomes, near enough. */
        private const val MISSING_STUB_CHARS = 128L

        /**
         * The heap's share one unit may claim, as characters: a unit of N characters costs, at the
         * peak of its assembly, its builder and then its string at two bytes a character each (a
         * UTF-16 text; Latin-1 halves it, and a script of any size has a character outside it) next
         * to the sources being copied in, so at N = heap / 6 the assembly fits within two thirds of
         * the heap. A 192 MB heap (the emulator's, a mid-range phone's without `largeHeap`) puts the
         * line at 32 M: Monica's 28 M-character unit compiles as it did, Total Adblock's 75 M is
         * refused.
         */
        private const val HEAP_SHARE = 6

        /** Under this a unit is always attempted (a 48 MB heap or smaller is not a WebView phone). */
        const val UNIT_BUDGET_FLOOR_CHARS = 8 shl 20

        /**
         * Over this a unit is refused on any heap: 64 M characters is 128 MB of script handed to
         * the WebView for every document it injects into, more than any extension in the sweeps
         * asked for short of the ones the guard is for.
         */
        const val UNIT_BUDGET_CEILING_CHARS = 64 shl 20

        /** The unit budget for a process whose heap may grow to `maxMemoryBytes` (`Runtime.maxMemory()`). */
        fun unitBudgetChars(maxMemoryBytes: Long): Int =
            (maxMemoryBytes / HEAP_SHARE).coerceIn(UNIT_BUDGET_FLOOR_CHARS.toLong(), UNIT_BUDGET_CEILING_CHARS.toLong()).toInt()

        /** `chars` as "12.3 million" (or "0.4 million"), for a console line; locale-free. */
        fun millions(chars: Long): String = "${chars / 1_000_000}.${(chars % 1_000_000) / 100_000} million"

        fun sha256(text: String): String {
            val digest = MessageDigest.getInstance("SHA-256").digest(text.toByteArray())
            val sb = StringBuilder(digest.size * 2)
            for (b in digest) sb.append("%02x".format(b))
            return sb.toString()
        }
    }
}
