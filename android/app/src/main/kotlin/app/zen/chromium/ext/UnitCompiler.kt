package app.zen.chromium.ext

import app.zen.chromium.strOrNull
import org.json.JSONArray
import org.json.JSONObject
import java.io.BufferedWriter
import java.io.File
import java.io.FileOutputStream
import java.io.OutputStreamWriter
import java.io.Writer
import java.lang.ref.SoftReference
import java.security.MessageDigest
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock

/**
 * Compiles the content-script units the core plans for one extension (`ext.configure`) into the
 * document-start scripts the WebView injects, and remembers them per extension and version:
 *
 *  - the sources of an extension's files are read once per compile, however many units and
 *    groups of the plan copy them (a file a plan lists in several units – Adblock Ad Blocker
 *    Pro's generic cosmetic filters sit in its every-origin unit and in its `css-generic-some`
 *    unit alike – is read once), and let go at the LAST unit of the plan that names them
 *    ([lastUses]): a text is held for the units after this one that still copy it and no longer,
 *    and a file at its last use – most files of a plan are listed once – travels into the script
 *    as a [ExtensionScripts.Source.transient] text, released as it is copied in, so the
 *    assembly's peak (the builder and the string it is copied out to, four bytes a character for
 *    a 16-bit script) stands over the texts the plan still needs and not over every text of the
 *    unit. Compat round 23 (R23-1) measured Adblock Ad Blocker Pro's plan on the JVM with the
 *    real compiler and bundle (11 units, 19.7 million characters, all 16-bit; the serial
 *    collector with a 4 MB young generation, so the old generation is nearly the heap as ART's
 *    is): its peak step is the 10.6 million character carrier's assembly – 42 MB of builder and
 *    string over the 237 texts of the unit, 10.3 million characters that were strongly held
 *    through the `Source` closures until the assembly returned and softly to the plan's end. The
 *    collection before the string's allocation left 42 MB live, 12 MB of it those texts, and the
 *    compile survived a 72 MB heap and died at 64; with the texts let go at their last use the
 *    same collection leaves 30 MB – the builder, the plan and the 45 generic files the
 *    `css-generic-some` unit still needs – and the compile survives 64 MB, the floor below which
 *    [unitBudgetChars] refuses the carrier (§4.2 of the round's report has both sweeps and the
 *    collections). Every source is inside the assembled
 *    scripts once the plan is compiled, and a re-plan (a `registerContentScripts` call re-plans
 *    the extension's units, it does not change its files) answers its unchanged units from the
 *    unit cache without a read and reads only the files its changed units name – file IO on the
 *    runtime's io executor, off the main thread. Between compiles the texts were held softly
 *    until compat round 22: ART keeps a soft referent as it keeps a strong one and clears it only
 *    in the collection it runs after an allocation has failed, so the 651 sources of Adblock Ad
 *    Blocker Pro's plan – 15.8 million characters, 24.7 MB beside its 37.7 MB of units – stood on
 *    the 192 MB heap through every row after it and went only at the edge of the allocation
 *    failure the soft hold was meant to spare, while the lanes' second configure of an extension
 *    compiled every unit anew (`0 cached`) and the hold bought nothing. A file of
 *    [LARGE_SOURCE_CHARS] or more is not held even for the compile's duration: it goes into the
 *    script as a transient text whatever its later uses, and a later unit of the plan reads it
 *    from disk again (Monica's 28 million characters of `content.js`: a held copy of it kept the
 *    heap at its limit, and the assembly's third copy of it was the allocation that failed);
 *  - a unit of [fileUnitChars] characters or more is not held in the heap at all when the
 *    runtime gives the compiler a [store]: it is written to a file of the compiler's own
 *    directory AS IT IS ASSEMBLED ([ExtensionScripts.documentStartTo] into a buffered UTF-8
 *    writer – no builder of it and no string of it, the sources alone at the peak, each let go
 *    as it is copied through) and read back for each install ([Compiled.text]: the file's bytes
 *    and the string decoded from them, two allocations for the moment of the install, nothing
 *    retained). Compat round 24 (R24-1): the 10.6 million character carrier's assembly was the
 *    peak's step at 42 MB of builder and string, and the string then stood through every row
 *    after it – Adblock Ad Blocker Pro's 11 units, 37.7 MB retained – where Chrome holds one
 *    copy of a content script in shared memory outside any heap limit and the WebView takes
 *    its own native copy per view at the handoff in any case. A unit under the size is held
 *    as it was: a small unit's string is cheaper than a read per install;
 *  - a unit whose inputs (config, groups, CSS, debug flag) did not change keeps its assembled
 *    script (or its file), so a reconfigure that re-sends an unchanged unit costs a hash, not
 *    an assembly;
 *  - a unit the heap cannot hold as one script is refused before any of it is read
 *    ([budgetChars], [Compiled.refused]): the extension's other units, its pages and its
 *    background go on, the refused unit's content scripts do not run. Total Adblock lists a
 *    9.3 million character `vendor.min.js` ahead of every one of its eight content-script
 *    entries, and a unit copies a file once per group it is in: 75 million characters, whose
 *    builder – Latin-1 until the first character outside it, then twice the size – was a 150 MB
 *    allocation on a 192 MB heap, and the process died under it (compat round 13);
 *  - a file's relative `import()` specifiers are resolved to the file's own served URL as it is
 *    copied in ([RelativeImports]): Chrome resolves them against the content script's own URL,
 *    a unit of ours would resolve them against the page;
 *  - every other extension's cache is untouched, and a new version starts from nothing;
 *  - the runtime that owns the compiler releases everything it holds when it is destroyed
 *    ([close]): a browser restarted in the same process (a second `MainActivity` over the old
 *    one) builds a new runtime whose configure compiles the same extensions again while the old
 *    runtime is still referenced for some seconds – and the old compiler's units and sources
 *    were the largest part of it (compat round 21b: 66 MB of a 192 MB heap, and the new
 *    carrier's builder found 25 MB free).
 *
 * Pure string work over an injected reader, so the JVM unit tests cover it. One lock guards the
 * cache ([lock], not the monitor: [close] must not wait on a compile in flight – the main thread
 * calls it at destroy – so it tries the lock and, when the compile holds it, leaves the release
 * to the compile, which checks [closed] between units).
 */
class UnitCompiler(
    /** The most characters one unit may run to; [unitBudgetChars] of this process's heap unless a test says otherwise. */
    val budgetChars: Int = unitBudgetChars(Runtime.getRuntime().maxMemory()),
    /**
     * The unit store's root, or null to hold every unit in memory (the JVM tests' default): a
     * unit of [fileUnitChars] characters or more is written to a file of this compiler's own
     * directory under it as it is assembled and read back at each install ([Compiled.text]),
     * so that no `String` of it stands in the Java heap between installs and no builder of it
     * at its assembly (compat round 24, R24-1: Adblock Ad Blocker Pro's 10.6 million character
     * carrier was a 21 MB builder and a 21 MB string at its copy-out, then the string through
     * every row after – 37.7 MB of units retained on a 192 MB heap, round 23 §4.2).
     */
    private val store: File? = null,
    /**
     * The process's tag on this compiler's store directory (`<owner>-<n>`): at construction the
     * directories of OTHER owners – a process that died with its store – are removed, and the
     * directories of this owner are left (a runtime destroyed a moment ago in the same process,
     * a browser restarted over the old one, releases its own in [close]).
     */
    private val owner: String = "jvm",
    /** From this many characters a unit goes to the store rather than the heap; [FILE_UNIT_CHARS] unless a test says otherwise. */
    val fileUnitChars: Int = FILE_UNIT_CHARS,
    private val bootstrap: () -> String
) {
    /** One compiled unit: what the WebView gets and what the core is told about it. */
    class Compiled(
        val extensionId: String,
        val key: String,
        val origins: List<String>,
        /** The isolated world to inject into, or null for the page's main world. */
        val world: String?,
        /** How much of the bootstrap the script carries ([ExtensionScripts.SHAPE_WHOLE] and the others). */
        val shape: String,
        /** The script's text when the unit is held in memory; empty for a refused unit and for one in the store ([file]). */
        val script: String,
        val hash: String,
        /** Whether the script came from the cache rather than being assembled now. */
        val cached: Boolean,
        /** Why the unit was not assembled, when it was not: its size against the budget. The script is then empty. */
        val refused: Refused? = null,
        /**
         * The size the script's builder was made with ([ExtensionScripts.Assembled.presized]);
         * [chars] over it means an append grew the builder, which the assembly's count
         * is written not to allow. Kept with a cached unit, zero for a refused one.
         */
        val presized: Int = script.length,
        /** The unit's file in the store, when it was written there rather than held ([UnitCompiler.fileUnitChars]); null otherwise. */
        val file: File? = null,
        /** The script's characters, whichever its store. */
        val chars: Int = script.length
    ) {
        /** Whether the assembly's builder grew past its size (never, when the count is right). */
        val grown: Boolean get() = chars > presized

        /**
         * The script's text: as held, or read from its file – the file's UTF-8 bytes in one
         * array sized by its length and the string decoded from them, two allocations for the
         * moment of an install and nothing retained, where a held unit is its string for as
         * long as it is configured. Not `File.readText()`: that reads through a `StringWriter`
         * whose buffer doubles as it fills and is copied out at the end – three copies of a
         * 16-bit text at the peak, more than the builder and string the store is there to
         * spare. `String(bytes, UTF_8)` is ART's own decoder (native from Android 12, straight
         * into the string; a char array of the byte count on the way before that). Null for a
         * refused unit, and for a stored one whose file is gone (the store lives under the
         * app's files; a runtime that finds a unit's file missing installs the extension's
         * other units and says so).
         */
        fun text(): String? {
            val stored = file
            return when {
                refused != null -> null
                stored != null -> runCatching { String(stored.readBytes(), Charsets.UTF_8) }.getOrNull()
                else -> script
            }
        }
    }

    /** A unit over the budget: what it would have run to (from the files' sizes), over how many groups, against what. */
    class Refused(val chars: Long, val groups: Int, val budgetChars: Int)

    private class ExtensionCache(val version: String) {
        /**
         * Extension-relative path → the file's text behind a [SoftReference] while a compile
         * runs and a later unit of the plan still names it, or [MISSING] (unreadable, not read
         * again for the version). [releaseUsedThrough] after every unit and [releaseSources] at
         * the end of every compile leave the [MISSING] marks alone.
         */
        val sources = HashMap<String, Any>()
        val units = HashMap<String, Compiled>()

        /** Let go of every text held for the compile that ends; the [MISSING] marks stay. Answers how many texts were still there. */
        fun releaseSources(): Int {
            var held = 0
            val it = sources.entries.iterator()
            while (it.hasNext()) {
                val entry = it.next()
                if (entry.value === MISSING) continue
                if ((entry.value as SoftReference<*>).get() != null) held++
                it.remove()
            }
            return held
        }

        /**
         * Unit `index` of the plan is done: let go of every text no unit after it names
         * (`lastUse`, [lastUses]). A compiled unit takes its last-use texts out as it copies them
         * in ([source], [text]); this is the turn of a cached or refused unit, which reads nothing
         * and was the last to name what an earlier unit held for it.
         */
        fun releaseUsedThrough(index: Int, lastUse: Map<String, Int>) {
            val it = sources.entries.iterator()
            while (it.hasNext()) {
                val entry = it.next()
                if (entry.value === MISSING) continue
                if ((lastUse[entry.key] ?: -1) <= index) it.remove()
            }
        }
    }

    private val cache = HashMap<String, ExtensionCache>()
    private val lock = ReentrantLock()

    /** Set by [close], read between units by a compile in flight; a closed compiler compiles nothing and holds nothing. */
    @Volatile private var closed = false

    /**
     * This compiler's own directory of the unit store (`<store>/<owner>-<n>`, `n` counting the
     * compilers of the process), made when the first unit goes to it; [close] removes it. Null
     * without a store.
     */
    private val storeDir: File? = store?.let { root -> File(root, "$owner-${STORE_DIRS.incrementAndGet()}") }

    /** Whether the store has been looked over for other owners' leavings ([sweepStore]); once per compiler, at its first compile. */
    private var swept = false

    /**
     * The store as this process finds it, at the first compile (the io thread, not the
     * construction on the main one): a directory of another owner is a process's that died
     * with its units – a destroyed runtime removes its own – and goes; this owner's other
     * directories belong to the process's other runtimes, live or releasing, and stay.
     */
    private fun sweepStore() {
        if (swept) return
        swept = true
        store?.listFiles()?.forEach { dir ->
            if (dir.isDirectory && !dir.name.startsWith("$owner-")) dir.deleteRecursively()
        }
    }

    /** Where unit `key` of `hash` goes in the store: named by both, so two units of one text keep their own files. */
    private fun unitFile(key: String, hash: String): File? = storeDir?.let { File(it, "${sha256(key).take(16)}-${hash.take(24)}.js") }

    /**
     * A [Writer] as the assembly's sink: a `String` segment goes through
     * `write(String, off, len)` – copied into the writer's buffer a chunk at a time, no
     * substring of it made on the way – where `Appendable.append(csq, start, end)` would cut one.
     */
    private class WriterSink(private val w: Writer) : Appendable {
        override fun append(csq: CharSequence?): Appendable {
            val s = csq ?: "null"
            if (s is String) w.write(s) else w.append(s)
            return this
        }

        override fun append(csq: CharSequence?, start: Int, end: Int): Appendable {
            val s = csq ?: "null"
            if (s is String) w.write(s, start, end - start) else w.append(s, start, end)
            return this
        }

        override fun append(c: Char): Appendable {
            w.write(c.code)
            return this
        }
    }

    /** Whether [close] was called: no unit compiles after it, and nothing is held. */
    val isClosed: Boolean get() = closed

    /**
     * What [close] let go of, for the runtime's destroy line: the extensions cached, their
     * compiled units and those units' characters (held and stored alike; [storedUnits] of them
     * were files of the store, removed with the compiler's directory), the source texts still
     * held (none between compiles since compat round 22 – a count here is a compile the close
     * cut short). [deferred] when a compile held the lock: the figures are then zero here, and
     * that compile releases everything at its next unit boundary.
     */
    class Released(val extensions: Int, val units: Int, val unitChars: Long, val sources: Int, val deferred: Boolean, val storedUnits: Int = 0)

    /**
     * Compile `units` (`[{ key, origins, world, shape, config, groups: [{ ext, index, js,
     * isolation }], css: [{ ext, path }] }]`) for one extension. `read` answers an
     * extension-relative path with the file's text, or null; `size` with the file's length in
     * bytes without reading it, or null. A unit is measured from the sizes before any of its
     * files is read: a UTF-8 file has at most as many characters as bytes, so the sum bounds the
     * script, and a unit over the budget is [Compiled.refused] with nothing of it allocated. The
     * shape (whole when the plan names none) is part of the unit's identity and of its measure:
     * a thin unit is its sources without the bootstrap. The files read for the plan are held
     * while its units compile and let go when the last one has (the units hold every text
     * already; [memoryOf] reads no source after a compile). After [close] nothing is compiled:
     * an empty list, and a compile that was in flight at the close releases the cache and
     * answers the same (its runtime is gone; the configure that asked drops the answer).
     */
    fun compile(
        id: String,
        version: String,
        units: JSONArray,
        debug: Boolean,
        read: (String) -> String?,
        size: (String) -> Long?
    ): List<Compiled> = lock.withLock {
        if (closed) return@withLock emptyList()
        sweepStore()
        var entry = cache[id]
        if (entry == null || entry.version != version) {
            // A new version starts from nothing: the old version's stored units go with its cache.
            entry?.units?.values?.forEach { it.file?.delete() }
            entry = ExtensionCache(version)
            cache[id] = entry
        }
        val out = ArrayList<Compiled>(units.length())
        val keysNow = HashSet<String>()
        val lastUse = lastUses(units)
        for (i in 0 until units.length()) {
            // Closed while this compile ran (the runtime was destroyed): what was compiled so
            // far goes with the rest, and nothing more is read or assembled.
            if (closed) {
                releaseLocked()
                return@withLock emptyList()
            }
            val u = units.optJSONObject(i) ?: continue
            val key = u.optString("key")
            keysNow.add(key)
            // How many times this unit names each path: its last naming of a path no later unit
            // names is the text's last use in the plan, and the text goes with that copy.
            val usesLeft = usesWithin(u)
            val lastUseHere = { path: String ->
                val left = (usesLeft[path] ?: 1) - 1
                usesLeft[path] = left
                left <= 0 && lastUse[path] == i
            }
            val origins = u.optJSONArray("origins").let { a -> if (a == null) emptyList() else List(a.length()) { k -> a.optString(k, "*") } }
                .toSet().ifEmpty { setOf("*") }.toList()
            // A main-world unit comes with `world: null`, which `optString` would read as "null".
            val world = u.strOrNull("world")?.takeIf { it.isNotEmpty() }
            val shape = u.optString("shape", ExtensionScripts.SHAPE_WHOLE).ifEmpty { ExtensionScripts.SHAPE_WHOLE }
            val config = u.optString("config", "{}")
            val groupsJson = u.optJSONArray("groups") ?: JSONArray()
            val cssJson = u.optJSONArray("css") ?: JSONArray()
            val hash = sha256("$config\u0000$groupsJson\u0000$cssJson\u0000$debug\u0000${world ?: ""}\u0000$shape")
            val previous = entry.units[key]
            if (previous != null && previous.hash == hash) {
                val kept = Compiled(id, key, origins, world, shape, previous.script, hash, cached = true, refused = previous.refused, presized = previous.presized, file = previous.file, chars = previous.chars)
                entry.units[key] = kept
                out.add(kept)
                entry.releaseUsedThrough(i, lastUse)
                continue
            }
            // The unit's inputs changed: what the key held before – a stored file – goes.
            previous?.file?.delete()
            val estimate = estimateChars(entry, config, groupsJson, cssJson, size, shape)
            if (estimate > budgetChars) {
                // Refused the way a compiled unit is kept: the same plan sent again answers from
                // the cache, so the extension's console hears of it once per plan.
                val refused = Compiled(id, key, origins, world, shape, "", hash, cached = false, refused = Refused(estimate, groupsJson.length(), budgetChars), presized = 0)
                entry.units[key] = refused
                out.add(refused)
                entry.releaseUsedThrough(i, lastUse)
                continue
            }
            // The unit's groups and CSS over the files as the assembly takes them: read here,
            // once, for the one assembly – a second call (the store's fallback below) reads them
            // again from disk.
            fun inputs(): Pair<List<ExtensionScripts.Group>, Map<String, String>> {
                val groups = ArrayList<ExtensionScripts.Group>()
                for (j in 0 until groupsJson.length()) {
                    val g = groupsJson.optJSONObject(j) ?: continue
                    val ext = g.optString("ext", id)
                    val files = g.optJSONArray("js") ?: JSONArray()
                    val sources = List(files.length()) { k ->
                        val path = files.optString(k, "")
                        if (path.startsWith(INLINE_CODE)) ExtensionScripts.Source(path.substring(INLINE_CODE.length))
                        else source(entry, ext, path, read, lastUseHere(path))
                            ?: ExtensionScripts.Source("console.error(${JSONObject.quote("[Zenium] extension $ext: missing content script $path")});")
                    }
                    groups.add(ExtensionScripts.Group(ext, g.optInt("index"), sources, g.optString("isolation", "with")))
                }
                val css = LinkedHashMap<String, String>()
                for (j in 0 until cssJson.length()) {
                    val c = cssJson.optJSONObject(j) ?: continue
                    val path = c.optString("path")
                    val text = text(entry, path, read, hold = !lastUseHere(path)) ?: continue
                    css["${c.optString("ext", id)}/${path.trimStart('/')}"] = text
                }
                return groups to css
            }
            // A unit of the store's size is written to its file as it is assembled – no builder
            // of it, no string of it (the sources alone stand at the peak; they go as they are
            // copied through) – and read back at each install. A file the store cannot take (an
            // IOException: the disk full) leaves the unit to the heap, as every unit was.
            val file = if (estimate >= fileUnitChars) unitFile(key, hash) else null
            val stored = file?.let { f ->
                runCatching {
                    f.parentFile?.mkdirs()
                    val (groups, css) = inputs()
                    BufferedWriter(OutputStreamWriter(FileOutputStream(f), Charsets.UTF_8), STORE_BUFFER_CHARS).use { w ->
                        ExtensionScripts.documentStartTo(WriterSink(w), bootstrap(), config, groups, css, debug, shape)
                    }
                }.onFailure { f.delete() }.getOrNull()
            }
            val compiled = if (stored != null) {
                Compiled(id, key, origins, world, shape, "", hash, cached = false, presized = stored.presized, file = file, chars = stored.chars)
            } else {
                val (groups, css) = inputs()
                val assembled = ExtensionScripts.documentStartSized(bootstrap(), config, groups, css, debug, shape)
                Compiled(id, key, origins, world, shape, assembled.script, hash, cached = false, presized = assembled.presized)
            }
            entry.units[key] = compiled
            out.add(compiled)
            entry.releaseUsedThrough(i, lastUse)
        }
        if (closed) {
            releaseLocked()
            return@withLock emptyList()
        }
        // Units the plan no longer has are not kept around (a registered script that went away),
        // their stored files with them.
        entry.units.entries.removeAll { (key, unit) ->
            (key !in keysNow).also { gone -> if (gone) unit.file?.delete() }
        }
        // Every unit of the plan is compiled: the texts read for them go, the units keep their own.
        entry.releaseSources()
        out
    }

    /** The compiled units of one extension as last configured (empty when not configured). */
    fun unitsOf(id: String): List<Compiled> = lock.withLock { cache[id]?.units?.values?.sortedBy { it.key } ?: emptyList() }

    /** Drop everything remembered for an extension (it was detached), its stored units' files with it. */
    fun forget(id: String) {
        lock.withLock { cache.remove(id)?.units?.values?.forEach { it.file?.delete() } }
    }

    /**
     * The runtime that owns this compiler is destroyed: let go of every extension's compiled
     * units (and the sources of a compile in flight), and compile nothing from now on. Does not wait: when a
     * compile holds the lock (a configure in flight at destroy) the release is [Released.deferred]
     * to it – it sees [closed] at its next unit boundary, releases and answers empty – and the
     * figures here are zero; else the release is done here, with what it came to.
     */
    fun close(): Released {
        closed = true
        if (!lock.tryLock()) return Released(0, 0, 0L, 0, deferred = true)
        try {
            return releaseLocked()
        } finally {
            lock.unlock()
        }
    }

    /** Under [lock]: every entry emptied and dropped, counted; the compiler's store directory removed with its files. */
    private fun releaseLocked(): Released {
        var units = 0
        var unitChars = 0L
        var sources = 0
        var stored = 0
        for (entry in cache.values) {
            units += entry.units.size
            for (unit in entry.units.values) {
                unitChars += unit.chars
                if (unit.file != null) stored++
            }
            for (held in entry.sources.values) if (held is SoftReference<*> && held.get() != null) sources++
            entry.units.clear()
            entry.sources.clear()
        }
        val extensions = cache.size
        cache.clear()
        storeDir?.let { runCatching { it.deleteRecursively() } }
        return Released(extensions, units, unitChars, sources, deferred = false, storedUnits = stored)
    }

    /**
     * The number of source files remembered for an extension, for instrumentation: between
     * compiles the [MISSING] marks alone (a text the GC took back never counted; the texts read
     * for a plan go when its units are compiled).
     */
    fun cachedSources(id: String): Int = lock.withLock { cache[id]?.sources?.values?.count { it === MISSING || (it as SoftReference<*>).get() != null } ?: 0 }

    /**
     * What the compiler holds for an extension, for instrumentation: its compiled scripts'
     * characters and the bytes ART keeps them in (a script with a character over U+00FF is two
     * bytes a character, else one – the string's own compact form), how many of them are 16-bit,
     * and the source texts still held (none after a compile), their characters and bytes the
     * same way. The width is the sources' own: the bootstrap, the boot config the core
     * serializes and the assembly's glue are Latin-1 (compat round 22 read Adblock Ad Blocker
     * Pro's every unit 16-bit for one U+205D in each uBlock scriptlet's `makeLogPrefix` and the
     * filter lists' CJK, Cyrillic and Arabic text – theirs to carry as they are). The units a
     * plan refused ([Compiled.refused], kept with an empty script) are counted apart, so the
     * count installed on the tabs has its match here. The units in the store ([Compiled.file])
     * are counted apart too – `storedUnits` and their `storedChars` – and are in no heap
     * figure: their text is on disk between installs. Does not wait: the lock is a compile's for
     * its whole run (seconds for a plan of Adblock Ad Blocker Pro's size), and what the reading
     * would count under it is the plan being replaced – `compiling: true` and nothing else says
     * so (compat round 22's `[lane]` run read a heap split off such a wait: the instrumentation's
     * main-thread reading stood on the lock for the compile's last 1.5 s and the count it got
     * was the old plan's beside the new plan's units, landed a moment later).
     */
    fun memoryOf(id: String): JSONObject {
        if (!lock.tryLock()) return JSONObject().put("compiling", true)
        try {
            val entry = cache[id] ?: return JSONObject().put("compiling", false).put("units", 0).put("refused", 0)
            var unitChars = 0L
            var unitBytes = 0L
            var wideUnits = 0
            var refused = 0
            var storedUnits = 0
            var storedChars = 0L
            for (unit in entry.units.values) {
                if (unit.refused != null) {
                    refused++
                    continue
                }
                if (unit.file != null) {
                    storedUnits++
                    storedChars += unit.chars
                    continue
                }
                val wide = unit.script.any { it > '\u00FF' }
                if (wide) wideUnits++
                unitChars += unit.script.length
                unitBytes += unit.script.length.toLong() * (if (wide) 2 else 1)
            }
            var sources = 0
            var sourceChars = 0L
            var sourceBytes = 0L
            for (held in entry.sources.values) {
                val text = (held as? SoftReference<*>)?.get() as? String ?: continue
                sources++
                sourceChars += text.length
                sourceBytes += text.length.toLong() * (if (text.any { it > '\u00FF' }) 2 else 1)
            }
            return JSONObject()
                .put("compiling", false)
                .put("units", entry.units.size).put("refused", refused).put("unitChars", unitChars).put("unitBytes", unitBytes).put("wideUnits", wideUnits)
                .put("storedUnits", storedUnits).put("storedChars", storedChars)
                .put("sources", sources).put("sourceChars", sourceChars).put("sourceBytes", sourceBytes)
        } finally {
            lock.unlock()
        }
    }

    /**
     * What the unit's script would run to, in characters, from what is known without reading a
     * file: the sizes on disk (a file listed in several groups counts once per group, as the
     * script copies it), an inline entry's own length, a source already held in the cache by
     * its real length, and room for the fixed parts (the bootstrap by the unit's shape,
     * [ExtensionScripts.bootstrapChars]). A file that is not there costs its console stub. This
     * is the refusal's measure, not the builder's: the builder is sized by an exact count of the
     * text once the files are in hand ([ExtensionScripts.documentStartSized]).
     */
    private fun estimateChars(entry: ExtensionCache, config: String, groupsJson: JSONArray, cssJson: JSONArray, size: (String) -> Long?, shape: String): Long {
        var total = ExtensionScripts.bootstrapChars(bootstrap().length, shape).toLong() + config.length + 4096
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

    /**
     * A script file as the assembly takes it: held (small, soft-cached, a later unit of the plan
     * names it) or transient (large, or at its last use in the plan – released as it is copied
     * in), its relative `import()` specifiers resolved to the file's own served URL on the way in
     * ([RelativeImports]; the cached text stays as read, so the same file under another path or
     * extension is not confused). The refusal estimate does not count the rewrite's few dozen
     * characters per call; a loader's handful sits inside the estimate's room.
     */
    private fun source(entry: ExtensionCache, ext: String, path: String, read: (String) -> String?, lastUse: Boolean): ExtensionScripts.Source? {
        val text = text(entry, path, read, hold = !lastUse) ?: return null
        val transient = lastUse || text.length >= LARGE_SOURCE_CHARS
        val edits = RelativeImports.edits(text, ext, path)
        if (edits.isNotEmpty()) return RelativeImports.source(text, edits, transient)
        return if (transient) ExtensionScripts.Source.transient(text) else ExtensionScripts.Source(text)
    }

    /**
     * The file's text: from the compile's cache, or read now. Held for the units after this one
     * while `hold` (and under [LARGE_SOURCE_CHARS]); at a text's last use (`hold` false) the
     * cache lets go of it as it is handed over, so the copy in the script is the only one left.
     */
    private fun text(entry: ExtensionCache, path: String, read: (String) -> String?, hold: Boolean = true): String? {
        if (path.isEmpty()) return null
        when (val held = entry.sources[path]) {
            MISSING -> return null
            is SoftReference<*> -> (held.get() as String?)?.let {
                if (!hold) entry.sources.remove(path)
                return it
            }
        }
        val text = runCatching { read(path) }.getOrNull()
        when {
            text == null -> entry.sources[path] = MISSING
            hold && text.length < LARGE_SOURCE_CHARS -> entry.sources[path] = SoftReference(text)
        }
        return text
    }

    /** How many times one unit's groups and CSS name each path (an inline entry is no path). */
    private fun usesWithin(unit: JSONObject): HashMap<String, Int> {
        val uses = HashMap<String, Int>()
        forEachPath(unit) { path -> uses[path] = (uses[path] ?: 0) + 1 }
        return uses
    }

    /** The index of the last unit of the plan that names each path: where its text's last use is. */
    private fun lastUses(units: JSONArray): HashMap<String, Int> {
        val last = HashMap<String, Int>()
        for (i in 0 until units.length()) {
            val u = units.optJSONObject(i) ?: continue
            forEachPath(u) { path -> last[path] = i }
        }
        return last
    }

    private inline fun forEachPath(unit: JSONObject, visit: (String) -> Unit) {
        val groups = unit.optJSONArray("groups") ?: JSONArray()
        for (j in 0 until groups.length()) {
            val files = groups.optJSONObject(j)?.optJSONArray("js") ?: continue
            for (k in 0 until files.length()) {
                val path = files.optString(k, "")
                if (path.isNotEmpty() && !path.startsWith(INLINE_CODE)) visit(path)
            }
        }
        val css = unit.optJSONArray("css") ?: JSONArray()
        for (j in 0 until css.length()) {
            val path = css.optJSONObject(j)?.optString("path") ?: continue
            if (path.isNotEmpty()) visit(path)
        }
    }

    companion object {
        /** Marks a path whose file is missing or unreadable, so it is not read again for the version. */
        private val MISSING = Any()

        /**
         * From this many characters a file is not held even for the compile and travels into the
         * script as a transient source: a megabyte of text is two megabytes of heap beside the
         * builder that copies it, and the files this size are the ones whose second and third
         * copies do not fit (Monica's `content.js`, 28 M).
         */
        const val LARGE_SOURCE_CHARS = 1 shl 20

        /**
         * From this many characters a unit goes to the store when the compiler has one: a
         * megabyte of 16-bit text is two megabytes of heap held through every row for a unit a
         * page may never match, and the read per install of a unit this size (its bytes and its
         * string, a few tens of milliseconds) is the cost of not holding it. Adblock Ad Blocker
         * Pro's plan has three units over it – the 10.6 million character carrier and two of
         * 1.9 and 2.0 million, 14.5 million characters and 29 MB of the 39.5 MB its units held
         * – and eight under (0.4 to 0.7 million each, 5.2 million together), held as before.
         */
        const val FILE_UNIT_CHARS = 1 shl 20

        /** The store writer's buffer, in characters: the file is written in chunks of this, never the unit at once. */
        private const val STORE_BUFFER_CHARS = 1 shl 16

        /** Counts the compilers of the process, for their store directories' names (`<owner>-<n>`). */
        private val STORE_DIRS = AtomicInteger()

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
