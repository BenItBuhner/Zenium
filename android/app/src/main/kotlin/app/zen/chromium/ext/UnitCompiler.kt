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
 *  - every other extension's cache is untouched, and a new version starts from nothing.
 *
 * Pure string work over an injected reader, so the JVM unit tests cover it.
 */
class UnitCompiler(private val bootstrap: () -> String) {
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
        val cached: Boolean
    )

    private class ExtensionCache(val version: String) {
        /** Extension-relative path → the file's text behind a [SoftReference], or [MISSING] (unreadable). */
        val sources = HashMap<String, Any>()
        val units = HashMap<String, Compiled>()
    }

    private val cache = HashMap<String, ExtensionCache>()

    /**
     * Compile `units` (`[{ key, origins, world, config, groups: [{ ext, index, js, isolation }],
     * css: [{ ext, path }] }]`) for one extension. `read` answers an extension-relative path with
     * the file's text, or null.
     */
    @Synchronized
    fun compile(id: String, version: String, units: JSONArray, debug: Boolean, read: (String) -> String?): List<Compiled> {
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
                val kept = Compiled(id, key, origins, world, previous.script, hash, cached = true)
                entry.units[key] = kept
                out.add(kept)
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

        fun sha256(text: String): String {
            val digest = MessageDigest.getInstance("SHA-256").digest(text.toByteArray())
            val sb = StringBuilder(digest.size * 2)
            for (b in digest) sb.append("%02x".format(b))
            return sb.toString()
        }
    }
}
