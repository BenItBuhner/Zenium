package app.zen.chromium.ext

import org.json.JSONArray
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The per-extension, per-version cache behind `ext.configure`. */
class UnitCompilerTest {
    private val id = "abcdefghijklmnopabcdefghijklmnop"
    private val files = mutableMapOf(
        "cs.js" to "console.log('cs')",
        "extra.js" to "console.log('extra')",
        "style.css" to "body{color:red}"
    )
    private var reads = 0
    private val read: (String) -> String? = { path -> reads++; files[path] }
    /** The file's size on disk, as `File.length()` answers it without a read (the texts here are ASCII, so bytes are chars). */
    private var sizes = 0
    private val size: (String) -> Long? = { path -> sizes++; files[path]?.length?.toLong() }

    private fun units(vararg specs: Pair<String, List<String>>): JSONArray {
        val out = JSONArray()
        for ((key, js) in specs) {
            val groups = JSONArray().put(
                org.json.JSONObject()
                    .put("ext", id).put("index", 0).put("js", JSONArray(js)).put("isolation", "world")
            )
            out.put(
                org.json.JSONObject()
                    .put("key", key)
                    .put("origins", JSONArray(listOf("https://example.com")))
                    .put("world", "zenium-ext-$id")
                    .put("config", """{"kind":"content","token":"t"}""")
                    .put("groups", groups)
                    .put("css", JSONArray().put(org.json.JSONObject().put("ext", id).put("path", "style.css")))
            )
        }
        return out
    }

    @Test
    fun `compiles a unit from its sources and embeds the CSS`() {
        val compiler = UnitCompiler { "/*boot*/" }
        val compiled = compiler.compile(id, "1.0.0", units("isolated:https://example.com" to listOf("cs.js")), true, read, size)
        assertEquals(1, compiled.size)
        val unit = compiled[0]
        assertEquals("isolated:https://example.com", unit.key)
        assertEquals(listOf("https://example.com"), unit.origins)
        assertEquals("zenium-ext-$id", unit.world)
        assertFalse(unit.cached)
        assertTrue(unit.script.contains("console.log('cs')"))
        assertTrue(unit.script.contains("body{color:red}"))
        assertTrue(unit.script.contains("/*boot*/"))
        assertEquals(2, reads)
    }

    @Test
    fun `an unchanged unit comes back from the cache without reading anything`() {
        val compiler = UnitCompiler { "/*boot*/" }
        val first = compiler.compile(id, "1.0.0", units("isolated:https://example.com" to listOf("cs.js")), true, read, size)
        val readsAfterFirst = reads
        val second = compiler.compile(id, "1.0.0", units("isolated:https://example.com" to listOf("cs.js")), true, read, size)
        assertTrue(second[0].cached)
        assertEquals(first[0].script, second[0].script)
        assertEquals(first[0].hash, second[0].hash)
        assertEquals(readsAfterFirst, reads)
    }

    @Test
    fun `a re-plan compiles only what changed and reads only the files its new unit names`() {
        val compiler = UnitCompiler { "/*boot*/" }
        compiler.compile(id, "1.0.0", units("isolated:https://example.com" to listOf("cs.js")), true, read, size)
        val readsAfterFirst = reads
        // registerContentScripts added a second unit: the first is cached and reads nothing, the
        // second reads extra.js and the CSS (the first compile's texts went with it).
        val compiled = compiler.compile(
            id, "1.0.0",
            units("isolated:https://example.com" to listOf("cs.js"), "isolated:https://other.example" to listOf("extra.js")),
            true, read, size
        )
        assertEquals(listOf(true, false), compiled.map { it.cached })
        assertEquals(readsAfterFirst + 2, reads)
        assertEquals(2, compiler.unitsOf(id).size)
        // The plan shrinks again: the dropped unit is forgotten.
        compiler.compile(id, "1.0.0", units("isolated:https://example.com" to listOf("cs.js")), true, read, size)
        assertEquals(listOf("isolated:https://example.com"), compiler.unitsOf(id).map { it.key })
    }

    @Test
    fun `the debug flag and the config are part of a unit's identity`() {
        val compiler = UnitCompiler { "/*boot*/" }
        val debug = compiler.compile(id, "1.0.0", units("k" to listOf("cs.js")), true, read, size)
        val release = compiler.compile(id, "1.0.0", units("k" to listOf("cs.js")), false, read, size)
        assertFalse(release[0].cached)
        assertNotEquals(debug[0].hash, release[0].hash)
        assertTrue(debug[0].script.contains(",debug:true"))
        assertTrue(release[0].script.contains(",debug:false"))
    }

    @Test
    fun `a new version starts from nothing and a detach forgets the extension`() {
        val compiler = UnitCompiler { "/*boot*/" }
        compiler.compile(id, "1.0.0", units("k" to listOf("cs.js")), true, read, size)
        files["cs.js"] = "console.log('cs v2')"
        val next = compiler.compile(id, "1.1.0", units("k" to listOf("cs.js")), true, read, size)
        assertFalse(next[0].cached)
        assertTrue(next[0].script.contains("console.log('cs v2')"))
        compiler.forget(id)
        assertEquals(0, compiler.unitsOf(id).size)
        assertEquals(0, compiler.cachedSources(id))
    }

    @Test
    fun `the texts read for a plan are shared by its units and let go once every unit is compiled - memoryOf reads none after`() {
        // Compat round 22 (R22-1): Adblock Ad Blocker Pro's 651 sources – 15.8 million characters,
        // 24.7 MB – stood soft-held on the 192 MB heap through every row after its configure, and
        // ART clears a soft referent only in the collection after an allocation has failed.
        val compiler = UnitCompiler { "/*boot*/" }
        // Two units of one plan list cs.js: read once, and the CSS once, for the both of them.
        val compiled = compiler.compile(id, "1.0.0", units("k" to listOf("cs.js"), "k2" to listOf("extra.js", "cs.js")), true, read, size)
        assertEquals(3, reads) // cs.js, style.css, extra.js
        assertTrue(compiled[1].script.contains("console.log('extra')") && compiled[1].script.contains("console.log('cs')"))
        // Nothing held once the plan is compiled: the units carry every text themselves.
        assertEquals(0, compiler.cachedSources(id))
        val memory = compiler.memoryOf(id)
        assertEquals(2, memory.getInt("units"))
        assertEquals(compiled.sumOf { it.script.length.toLong() }, memory.getLong("unitChars"))
        assertEquals(0, memory.getInt("sources"))
        assertEquals(0L, memory.getLong("sourceChars"))
        assertEquals(0L, memory.getLong("sourceBytes"))
        // The units themselves are cached: the same plan needs no source.
        val same = compiler.compile(id, "1.0.0", units("k" to listOf("cs.js"), "k2" to listOf("extra.js", "cs.js")), true, read, size)
        assertEquals(listOf(true, true), same.map { it.cached })
        assertEquals(3, reads)
        // A re-plan that adds a unit reads the files it names again, and holds nothing after either.
        val more = compiler.compile(id, "1.0.0", units("k" to listOf("cs.js"), "k2" to listOf("extra.js", "cs.js"), "k3" to listOf("cs.js")), true, read, size)
        assertEquals(listOf(true, true, false), more.map { it.cached })
        assertEquals(5, reads) // cs.js and style.css for k3
        assertEquals(0, compiler.cachedSources(id))
        assertEquals(0, compiler.memoryOf(id).getInt("sources"))
    }

    @Test
    fun `a text is let go at the last unit of the plan that names it - a file listed once goes in transient - so an assembly stands over what the plan still needs alone`() {
        // Compat round 23 (R23-1): the peak step of Adblock Ad Blocker Pro's configure was its
        // 10.6 million character carrier's assembly – 42 MB of builder and string – over the 237
        // texts of the unit held through it (10.3 million characters; 45 of them named again by
        // one later unit, the rest by none), and the plan's compile died at 72 MB of heap on the
        // JVM measure. Here k names extra.js (its only use) and cs.js (k2 names it again), k2
        // names cs.js and later.js, k3 only the CSS every unit shares.
        val compiler = UnitCompiler { "/*boot*/" }
        files["later.js"] = "console.log('later')"
        val heldAtRead = ArrayList<Pair<String, Int>>()
        val counting: (String) -> String? = { path -> heldAtRead.add(path to compiler.cachedSources(id)); reads++; files[path] }
        val compiled = compiler.compile(
            id, "1.0.0",
            units("k" to listOf("extra.js", "cs.js"), "k2" to listOf("cs.js", "later.js"), "k3" to emptyList()),
            true, counting, size
        )
        assertEquals(3, compiled.size)
        assertTrue(compiled[0].script.contains("console.log('extra')") && compiled[0].script.contains("console.log('cs')"))
        assertTrue(compiled[1].script.contains("console.log('cs')") && compiled[1].script.contains("console.log('later')"))
        assertTrue(compiled[2].script.contains("body{color:red}"))
        // Every file read once; what was held when each read happened: extra.js is k's alone and
        // is never held; cs.js is held for k2 (1 when the CSS is read); k2 takes cs.js out as it
        // copies it in, so at later.js's read the CSS alone is held – not cs.js and extra.js too.
        assertEquals(listOf("extra.js" to 0, "cs.js" to 0, "style.css" to 1, "later.js" to 1), heldAtRead)
        assertEquals(4, reads)
        assertEquals(0, compiler.cachedSources(id))
        assertEquals(0, compiler.memoryOf(id).getInt("sources"))
    }

    @Test
    fun `a text whose last use is a cached unit goes when that unit comes round, not at the end of the plan`() {
        val compiler = UnitCompiler { "/*boot*/" }
        files["later.js"] = "console.log('later')"
        // k2 compiled once, so the re-plan answers it from the cache: it reads nothing, and cs.js
        // – held by k for it – is let go when k2's turn comes, before k3 reads its own file.
        compiler.compile(id, "1.0.0", units("k2" to listOf("cs.js")), true, read, size)
        val heldAtRead = ArrayList<Pair<String, Int>>()
        val counting: (String) -> String? = { path -> heldAtRead.add(path to compiler.cachedSources(id)); reads++; files[path] }
        val compiled = compiler.compile(
            id, "1.0.0",
            units("k" to listOf("cs.js", "extra.js"), "k2" to listOf("cs.js"), "k3" to listOf("later.js")),
            true, counting, size
        )
        assertEquals(listOf(false, true, false), compiled.map { it.cached })
        // k reads cs.js (held for k2), extra.js (its own) and the CSS (held for k3); k2 is cached
        // and releases cs.js; k3 reads later.js with the CSS alone still held, then takes the CSS.
        assertEquals(listOf("cs.js" to 0, "extra.js" to 1, "style.css" to 1, "later.js" to 1), heldAtRead)
        assertEquals(0, compiler.cachedSources(id))
    }

    @Test
    fun `a unit is 16-bit for its sources alone - the config and the glue are Latin-1 - and memoryOf counts it`() {
        // Compat round 22 (R22-2): the width the lanes read on every unit of Adblock Ad Blocker Pro
        // was the extension's own text – a U+205D in each uBlock scriptlet's `makeLogPrefix`, the
        // filter lists' CJK and Cyrillic – not the bootstrap's, the boot config's or the assembly's.
        files["wide.js"] = "console.log('\u205D')"
        val compiler = UnitCompiler { "/*boot*/" }
        val compiled = compiler.compile(id, "1.0.0", units("k" to listOf("cs.js"), "k2" to listOf("wide.js")), true, read, size)
        assertFalse(compiled[0].script.any { it > '\u00FF' })
        assertTrue(compiled[1].script.any { it > '\u00FF' })
        val memory = compiler.memoryOf(id)
        assertEquals(2, memory.getInt("units"))
        assertEquals(1, memory.getInt("wideUnits"))
        assertEquals(compiled[0].script.length.toLong() + 2L * compiled[1].script.length, memory.getLong("unitBytes"))
        assertFalse(memory.getBoolean("compiling"))
        assertEquals(0, memory.getInt("refused"))
    }

    @Test
    fun `memoryOf does not wait on a compile in flight - it says compiling and counts nothing - and counts the settled plan after`() {
        // Compat round 22's `[lane]` run: the heap split's reading on the main thread stood on the
        // compiler's lock for the compile's last 1.5 s (Choreographer's 92 skipped frames) and got
        // the plan being compiled counted against the one still installed.
        val compiler = UnitCompiler { "/*boot*/" }
        compiler.compile(id, "1.0.0", units("k" to listOf("cs.js")), true, read, size)
        val entered = java.util.concurrent.CountDownLatch(1)
        val release = java.util.concurrent.CountDownLatch(1)
        val blockingRead: (String) -> String? = { path ->
            if (path == "extra.js") {
                entered.countDown()
                release.await(10, java.util.concurrent.TimeUnit.SECONDS)
            }
            files[path]
        }
        val worker = Thread {
            compiler.compile(id, "1.0.0", units("k" to listOf("cs.js"), "k2" to listOf("extra.js")), true, blockingRead, size)
        }
        worker.start()
        assertTrue(entered.await(10, java.util.concurrent.TimeUnit.SECONDS))
        val t0 = System.nanoTime()
        val during = compiler.memoryOf(id)
        assertTrue("memoryOf waited ${(System.nanoTime() - t0) / 1_000_000} ms", System.nanoTime() - t0 < 2_000_000_000L)
        assertTrue(during.getBoolean("compiling"))
        assertFalse(during.has("units"))
        release.countDown()
        worker.join(10_000)
        assertFalse(worker.isAlive)
        val after = compiler.memoryOf(id)
        assertFalse(after.getBoolean("compiling"))
        assertEquals(2, after.getInt("units"))
        assertEquals(0, after.getInt("sources"))
    }

    @Test
    fun `memoryOf counts a refused unit apart from the compiled ones - its empty script in no total`() {
        val vendor = "/* vendor */ " + "v".repeat(2_000)
        files["vendor.js"] = vendor
        val compiler = UnitCompiler(budgetChars = 10_000) { "/*boot*/" }
        val groups = JSONArray()
        for (g in 0 until 8) {
            groups.put(org.json.JSONObject().put("ext", id).put("index", g).put("js", JSONArray(listOf("vendor.js", "cs.js"))).put("isolation", "with"))
        }
        val plan = units("small:https://example.com" to listOf("cs.js"))
        plan.put(
            org.json.JSONObject().put("key", "big:*").put("origins", JSONArray(listOf("*"))).put("world", org.json.JSONObject.NULL)
                .put("config", "{}").put("groups", groups).put("css", JSONArray())
        )
        val compiled = compiler.compile(id, "1.0.0", plan, true, read, size)
        val memory = compiler.memoryOf(id)
        // Two entries in the cache, one of them the refusal: the runtime installs one unit, and the count here matches it.
        assertEquals(2, memory.getInt("units"))
        assertEquals(1, memory.getInt("refused"))
        assertEquals(compiled[0].script.length.toLong(), memory.getLong("unitChars"))
        assertEquals(compiled[0].script.length.toLong(), memory.getLong("unitBytes"))
        assertEquals(0, memory.getInt("wideUnits"))
        assertEquals(1, memory.getInt("units") - memory.getInt("refused"))
    }

    @Test
    fun `a missing file becomes a console error instead of a broken unit and stays cached as missing`() {
        val compiler = UnitCompiler { "/*boot*/" }
        val compiled = compiler.compile(id, "1.0.0", units("k" to listOf("gone.js")), true, read, size)
        assertTrue(compiled[0].script.contains("missing content script gone.js"))
        val readsAfterFirst = reads
        // The mark outlives the compile where the texts do not: a re-plan reads the CSS again and does not try gone.js twice.
        compiler.compile(id, "1.0.0", units("k2" to listOf("gone.js")), true, read, size)
        assertEquals(readsAfterFirst + 1, reads)
        assertEquals(1, compiler.cachedSources(id))
    }

    @Test
    fun `an inline code entry is the script itself, in its place among the files, and reads nothing`() {
        // `userScripts.register({ js: [{ code }] })`: the core sends the text behind a NUL.
        val compiler = UnitCompiler { "/*boot*/" }
        val inline = UnitCompiler.INLINE_CODE + "window.tm_scripts = null; /* a user script */"
        val compiled = compiler.compile(id, "1.0.0", units("user:*" to listOf("cs.js", inline, "extra.js")), true, read, size)
        val script = compiled[0].script
        val cs = script.indexOf("console.log('cs')")
        val code = script.indexOf("window.tm_scripts = null; /* a user script */")
        val extra = script.indexOf("console.log('extra')")
        assertTrue(cs in 0 until code && code < extra)
        assertFalse(script.contains(UnitCompiler.INLINE_CODE))
        assertFalse(script.contains("missing content script"))
        assertEquals(3, reads) // cs.js, extra.js and the CSS; the code entry is not a file
    }

    @Test
    fun `a large file goes into the script once and is not held even for the plan's next unit, which reads it again`() {
        // Monica's content.js: 28 million characters; the held copy and the assembly's third copy did not fit the heap.
        val large = "/* big */ " + "x".repeat(UnitCompiler.LARGE_SOURCE_CHARS)
        files["big.js"] = large
        val compiler = UnitCompiler { "/*boot*/" }
        // Two units of one plan name it: cs.js, extra.js and the CSS are read once for the both, big.js once per unit.
        val compiled = compiler.compile(id, "1.0.0", units("k" to listOf("cs.js", "big.js", "extra.js"), "k2" to listOf("big.js", "cs.js")), true, read, size)
        val script = compiled[0].script
        assertEquals(1, Regex("/\\* big \\*/").findAll(script).count())
        val cs = script.indexOf("console.log('cs')")
        val big = script.indexOf("/* big */")
        val extra = script.indexOf("console.log('extra')")
        assertTrue(cs in 0 until big && big < extra)
        assertTrue(compiled[1].script.contains("/* big */"))
        assertEquals(5, reads) // cs.js, big.js, extra.js and the CSS for k; big.js again for k2
        assertEquals(0, compiler.cachedSources(id))
        // A re-plan that adds a unit over it reads big.js and the CSS again.
        val more = compiler.compile(id, "1.0.0", units("k" to listOf("cs.js", "big.js", "extra.js"), "k2" to listOf("big.js", "cs.js"), "k3" to listOf("big.js")), true, read, size)
        assertEquals(listOf(true, true, false), more.map { it.cached })
        assertEquals(7, reads)
        assertTrue(more[2].script.contains("/* big */"))
    }

    @Test
    fun `a file's relative import() is resolved to its own served URL, in a held and in a large file, and the CSS is left alone`() {
        // eJOY's Vite loader (compat round 13 row 32): Chrome resolves the specifier against the content script's own URL.
        files["src/pages/contentInject/index.js"] = """c(()=>import("../../../assets/js/inject.Cb-54asq.js").then(n=>n.i),[])"""
        files["big.js"] = """import("./chunk.js");""" + "x".repeat(UnitCompiler.LARGE_SOURCE_CHARS)
        files["style.css"] = """@import url("./x.css"); .a{background:url("./b.png")} import("./not-a-script.js")"""
        val compiler = UnitCompiler { "/*boot*/" }
        val compiled = compiler.compile(id, "1.0.0", units("k" to listOf("src/pages/contentInject/index.js", "big.js", "cs.js")), true, read, size)
        val script = compiled[0].script
        // The content script's own call goes through the bootstrap's helper (compat round 25, Web
        // Scrobbler: the page's policy refused the served origin, and the script awaits its promise).
        val helper = RelativeImports.HELPER
        assertTrue(script.contains("""$helper("https://$id.ext.zenium.invalid/assets/js/inject.Cb-54asq.js").then(n=>n.i)"""))
        assertTrue(script.contains("""$helper("https://$id.ext.zenium.invalid/chunk.js");"""))
        assertFalse(script.contains("""import("../../../assets"""))
        assertFalse(script.contains("""import("https://"""))
        // The CSS travels JSON-quoted; its `import(` and `url(` are as written, nothing of it rewritten.
        assertTrue(script.contains("not-a-script.js") && script.contains("./x.css") && script.contains("./b.png"))
        assertFalse(script.contains("ext.zenium.invalid/not-a-script.js") || script.contains("ext.zenium.invalid/x.css"))
        assertFalse(script.contains("""$helper("./not-a-script.js")"""))
        // The text is rewritten as it goes into a unit, never in the cache: a re-plan reads the file again and rewrites it the same way.
        val again = compiler.compile(id, "1.0.0", units("k2" to listOf("src/pages/contentInject/index.js")), true, read, size)
        assertEquals(6, reads) // index.js and the CSS again
        assertTrue(again[0].script.contains("""$helper("https://$id.ext.zenium.invalid/assets/js/inject.Cb-54asq.js")"""))
        // A `world: "MAIN"` group (isolation "none") is the page's own script in Chrome too: its
        // specifier is still resolved, its keyword stays the native `import(`.
        val main = units("k3" to listOf("src/pages/contentInject/index.js"))
        main.getJSONObject(0).getJSONArray("groups").getJSONObject(0).put("isolation", "none")
        val page = compiler.compile(id, "1.0.0", main, true, read, size)[0].script
        assertTrue(page.contains("""import("https://$id.ext.zenium.invalid/assets/js/inject.Cb-54asq.js").then(n=>n.i)"""))
        assertFalse(page.contains(helper))
    }

    @Test
    fun `another extension's cache is untouched`() {
        val compiler = UnitCompiler { "/*boot*/" }
        val other = "ponmlkjihgfedcbaponmlkjihgfedcba"
        compiler.compile(id, "1.0.0", units("k" to listOf("cs.js")), true, read, size)
        compiler.compile(other, "2.0.0", units("k" to listOf("cs.js")), true, read, size)
        compiler.forget(other)
        assertEquals(1, compiler.unitsOf(id).size)
        assertNull(compiler.unitsOf(other).firstOrNull())
    }

    // --- the unit budget (compat round 13: Total Adblock's 75 M-character unit killed the process at its builder) ---

    @Test
    fun `a unit over the budget is refused from the files' sizes, before any of them is read, and the rest of the plan compiles`() {
        // Eight groups each listing the same "vendor" file: measured as eight copies, the way the script would hold them.
        val vendor = "/* vendor */ " + "v".repeat(2_000)
        files["vendor.js"] = vendor
        val compiler = UnitCompiler(budgetChars = 10_000) { "/*boot*/" }
        val groups = JSONArray()
        for (g in 0 until 8) {
            groups.put(org.json.JSONObject().put("ext", id).put("index", g).put("js", JSONArray(listOf("vendor.js", "cs.js"))).put("isolation", "with"))
        }
        val plan = units("small:https://example.com" to listOf("cs.js"))
        plan.put(
            org.json.JSONObject().put("key", "big:*").put("origins", JSONArray(listOf("*"))).put("world", org.json.JSONObject.NULL)
                .put("config", "{}").put("groups", groups).put("css", JSONArray())
        )
        val compiled = compiler.compile(id, "1.0.0", plan, true, read, size)
        assertEquals(2, compiled.size)
        val small = compiled[0]
        val big = compiled[1]
        // The small unit compiled as ever; the big one was refused with its measure and never read.
        assertNull(small.refused)
        assertTrue(small.script.contains("console.log('cs')"))
        val refused = big.refused!!
        assertEquals("", big.script)
        assertFalse(big.cached)
        assertEquals(8, refused.groups)
        assertEquals(10_000, refused.budgetChars)
        assertTrue("measured ${refused.chars}", refused.chars > 8 * vendor.length && refused.chars < 8 * vendor.length + 8 * 1_000)
        assertEquals(2, reads) // cs.js and style.css, for the small unit only
        // The same plan again: both come from the cache, the refusal with them, nothing read or measured again.
        val readsAfter = reads
        val sizesAfter = sizes
        val again = compiler.compile(id, "1.0.0", plan, true, read, size)
        assertTrue(again[1].cached)
        assertEquals(refused.chars, again[1].refused!!.chars)
        assertEquals(readsAfter, reads)
        assertEquals(sizesAfter, sizes)
        assertEquals(listOf("big:*", "small:https://example.com"), compiler.unitsOf(id).map { it.key })
    }

    @Test
    fun `a destroyed runtime's close releases every extension's units, reports them, and the compiler compiles nothing after`() {
        val compiler = UnitCompiler { "/*boot*/" }
        compiler.compile(id, "1.0.0", units("k" to listOf("cs.js"), "k2" to listOf("extra.js")), true, read, size)
        val other = "bcdefghijklmnopqbcdefghijklmnopq"
        compiler.compile(other, "2.0.0", units("k" to listOf("cs.js")), true, read, size)
        val chars = (compiler.unitsOf(id) + compiler.unitsOf(other)).sumOf { it.script.length.toLong() }
        assertTrue(chars > 0)
        // No source is held between compiles; the units are what the close has to let go of.
        assertEquals(0, compiler.cachedSources(id))
        assertEquals(0, compiler.cachedSources(other))
        assertFalse(compiler.isClosed)
        val released = compiler.close()
        assertTrue(compiler.isClosed)
        assertFalse(released.deferred)
        assertEquals(2, released.extensions)
        assertEquals(3, released.units)
        assertEquals(chars, released.unitChars)
        assertEquals(0, released.sources)
        for (ext in listOf(id, other)) {
            assertEquals(0, compiler.unitsOf(ext).size)
            assertEquals(0, compiler.cachedSources(ext))
            assertEquals(0, compiler.memoryOf(ext).getInt("units"))
        }
        // Nothing compiles after the close: no file read, no unit answered, nothing held.
        val readsAfter = reads
        val after = compiler.compile(id, "1.0.0", units("k" to listOf("cs.js")), true, read, size)
        assertTrue(after.isEmpty())
        assertEquals(readsAfter, reads)
        assertEquals(0, compiler.memoryOf(id).getInt("units"))
        // A second close has nothing to report; a forget is harmless.
        val again = compiler.close()
        assertEquals(0, again.extensions + again.units + again.sources)
        assertFalse(again.deferred)
        compiler.forget(id)
    }

    @Test
    fun `a close during a compile in flight does not wait for it - the compile releases at its next unit and answers empty`() {
        val compiler = UnitCompiler { "/*boot*/" }
        compiler.compile(id, "1.0.0", units("k" to listOf("cs.js")), true, read, size)
        val entered = java.util.concurrent.CountDownLatch(1)
        val release = java.util.concurrent.CountDownLatch(1)
        val blockingRead: (String) -> String? = { path ->
            if (path == "extra.js") {
                entered.countDown()
                release.await(10, java.util.concurrent.TimeUnit.SECONDS)
            }
            files[path]
        }
        var result: List<UnitCompiler.Compiled>? = null
        // The first unit is cached, the second reads extra.js and blocks there, the third would compile cs.js again.
        val worker = Thread {
            result = compiler.compile(id, "1.0.0", units("k" to listOf("cs.js"), "k2" to listOf("extra.js"), "k3" to listOf("cs.js")), true, blockingRead, size)
        }
        worker.start()
        assertTrue(entered.await(10, java.util.concurrent.TimeUnit.SECONDS))
        // The close comes back at once with the release deferred to the compile (the main thread
        // must not wait seconds at destroy); the lock is the compile's until it is done.
        val t0 = System.nanoTime()
        val released = compiler.close()
        assertTrue("close waited ${(System.nanoTime() - t0) / 1_000_000} ms", System.nanoTime() - t0 < 5_000_000_000L)
        assertTrue(released.deferred)
        assertEquals(0, released.units)
        assertTrue(compiler.isClosed)
        release.countDown()
        worker.join(10_000)
        assertFalse(worker.isAlive)
        // The compile saw the close at its next unit: the second unit it had assembled went with the first, nothing answered.
        assertTrue(result!!.isEmpty())
        assertEquals(0, compiler.unitsOf(id).size)
        assertEquals(0, compiler.cachedSources(id))
        assertEquals(0, compiler.memoryOf(id).getInt("units"))
    }

    @Test
    fun `a compiled unit carries the size its builder was made with - the script's length exactly - kept through the cache, none for a refusal`() {
        // A CSS text with `/` and a control character, a source with a relative import (its
        // rewritten length is its length) and a character over U+00FF: the count is still the text.
        files["style.css"] = "body{background:url(/img/x.png)}\t/* </style> */"
        files["cs.js"] = """import("./chunk.js"); const mark = '✓'; var top = 1"""
        val compiler = UnitCompiler(budgetChars = 10_000) { "/*boot*/" }
        val plan = units("k" to listOf("cs.js", "extra.js"), "k2" to listOf("cs.js"))
        plan.put(
            org.json.JSONObject().put("key", "big:*").put("origins", JSONArray(listOf("*"))).put("world", org.json.JSONObject.NULL)
                .put("config", "{}").put("groups", JSONArray().put(org.json.JSONObject().put("ext", id).put("index", 0).put("js", JSONArray(listOf(UnitCompiler.INLINE_CODE + "x".repeat(20_000)))).put("isolation", "with"))).put("css", JSONArray())
        )
        val compiled = compiler.compile(id, "1.0.0", plan, true, read, size)
        assertEquals(3, compiled.size)
        for (unit in compiled.take(2)) {
            assertNull(unit.refused)
            assertTrue(unit.script.contains("""${RelativeImports.HELPER}("https://$id.ext.zenium.invalid/chunk.js")"""))
            // The public org.json leaves `/` alone where Android's escapes it; the count covers both, so it may sit over the JVM's text by the CSS's slashes alone.
            assertTrue("${unit.key}: presized ${unit.presized} for ${unit.script.length}", unit.presized >= unit.script.length)
            assertTrue(unit.presized - unit.script.length <= files["style.css"]!!.count { it == '/' })
            assertFalse(unit.grown)
        }
        val refused = compiled[2]
        assertEquals(0, refused.presized)
        assertFalse(refused.grown)
        // The same plan again: the cached units keep their builder's size.
        val again = compiler.compile(id, "1.0.0", plan, true, read, size)
        assertEquals(listOf(true, true, true), again.map { it.cached })
        assertEquals(compiled.map { it.presized }, again.map { it.presized })
        assertEquals(compiled.map { it.script.length }, again.map { it.script.length })
    }

    @Test
    fun `a unit under the budget compiles as before, its measure taken from the sizes and, within a plan, from the texts in hand`() {
        val compiler = UnitCompiler(budgetChars = 10_000) { "/*boot*/" }
        // The plan's second unit is over files its first unit read: measured by their texts, not the disk.
        val compiled = compiler.compile(id, "1.0.0", units("k" to listOf("cs.js", "extra.js"), "k2" to listOf("cs.js")), true, read, size)
        assertNull(compiled[0].refused)
        assertNull(compiled[1].refused)
        assertTrue(compiled[0].script.contains("console.log('cs')") && compiled[0].script.contains("console.log('extra')"))
        assertEquals(3, reads) // cs.js, extra.js, style.css
        assertEquals(3, sizes) // the first unit's three files; the second's two were in hand
        // A re-plan adding a unit measures its files by the disk again (the texts went with the first compile).
        sizes = 0
        val more = compiler.compile(id, "1.0.0", units("k" to listOf("cs.js", "extra.js"), "k2" to listOf("cs.js"), "k3" to listOf("cs.js")), true, read, size)
        assertNull(more[2].refused)
        assertEquals(2, sizes) // cs.js and style.css
    }

    @Test
    fun `a missing file is measured as its console stub and an inline entry as its own text`() {
        // The measure carries the script's fixed parts too (some 4.5 K here), so the budget sits above them.
        val compiler = UnitCompiler(budgetChars = 12_000) { "/*boot*/" }
        val inline = UnitCompiler.INLINE_CODE + "x".repeat(5_000)
        val compiled = compiler.compile(id, "1.0.0", units("k" to listOf("gone.js", inline)), true, read, size)
        assertNull(compiled[0].refused)
        assertTrue(compiled[0].script.contains("missing content script gone.js"))
        val over = UnitCompiler.INLINE_CODE + "x".repeat(9_000)
        val refused = compiler.compile(id, "1.0.0", units("k2" to listOf(over)), true, read, size)
        assertTrue(refused[0].refused != null && refused[0].refused!!.chars > 9_000)
    }

    @Test
    fun `the budget is a sixth of the heap between a floor and a ceiling`() {
        // The emulator's and a mid-range phone's 192 MB growth limit: Monica's unit stays under, Total Adblock's is over.
        val emulator = UnitCompiler.unitBudgetChars(192L shl 20)
        assertEquals(32 shl 20, emulator)
        assertTrue(28_500_000 < emulator)
        assertTrue(75_392_244 > emulator)
        assertEquals(UnitCompiler.UNIT_BUDGET_FLOOR_CHARS, UnitCompiler.unitBudgetChars(32L shl 20))
        assertEquals(UnitCompiler.UNIT_BUDGET_CEILING_CHARS, UnitCompiler.unitBudgetChars(1L shl 30))
        assertEquals(UnitCompiler.UNIT_BUDGET_CEILING_CHARS, UnitCompiler.unitBudgetChars(512L shl 20))
        assertEquals("75.3 million", UnitCompiler.millions(75_392_244))
        assertEquals("0.7 million", UnitCompiler.millions(766_022))
        assertEquals("33.5 million", UnitCompiler.millions((32 shl 20).toLong()))
    }

    @Test
    fun `a unit's shape comes off the wire into its script, its identity and its measure, whole when the plan names none`() {
        // A bootstrap the size of the real one against a budget a thin unit fits and a whole one does not.
        val bootstrap = "/*" + "b".repeat(20_000) + "*/"
        val compiler = UnitCompiler(budgetChars = 16_000) { bootstrap }
        val plan = units("isolated:*" to listOf("cs.js"), "isolated:https://example.com" to listOf("extra.js"))
        plan.getJSONObject(0).put("shape", "carrier")
        plan.getJSONObject(1).put("shape", "thin")
        val compiled = compiler.compile(id, "1.0.0", plan, true, read, size)
        assertEquals(listOf("carrier", "thin"), compiled.map { it.shape })
        // The carrier is over the budget by its bootstrap; the thin unit, measured without one, compiles.
        assertTrue(compiled[0].refused != null && compiled[0].refused!!.chars > 20_000)
        assertNull(compiled[1].refused)
        assertTrue(compiled[1].script.contains("console.log('extra')"))
        assertFalse(compiled[1].script.contains(bootstrap))
        assertTrue(compiled[1].script.contains("globalThis.__zenExtCarrier;"))
        // Room enough: the carrier carries the bootstrap once, wrapped, and runs it.
        val roomy = UnitCompiler(budgetChars = 64_000) { bootstrap }
        val both = roomy.compile(id, "1.0.0", plan, true, read, size)
        assertTrue(both[0].script.contains("=function(__zenExtBoot){\n$bootstrap\n};\n__zenExtCarry(__zenExtBoot);"))
        assertEquals(1, Regex(Regex.escape(bootstrap)).findAll(both[0].script).count())
        // The same unit re-planned in another shape is compiled again: the shape is in the hash.
        plan.getJSONObject(1).put("shape", "whole")
        val reshaped = roomy.compile(id, "1.0.0", plan, true, read, size)
        assertTrue(reshaped[0].cached)
        assertFalse(reshaped[1].cached)
        assertNotEquals(both[1].hash, reshaped[1].hash)
        assertTrue(reshaped[1].script.contains(bootstrap))
        // No shape on the wire (an older plan): whole, as ever.
        plan.getJSONObject(1).remove("shape")
        val plain = roomy.compile(id, "1.0.0", plan, true, read, size)
        assertEquals("whole", plain[1].shape)
        assertTrue(plain[1].cached)
    }

    @Test
    fun `a main-world unit (world null on the wire) has no world`() {
        val compiler = UnitCompiler { "/*boot*/" }
        val unit = org.json.JSONObject().put("key", "k").put("origins", JSONArray().put("https://userstyles.org"))
            .put("world", org.json.JSONObject.NULL).put("config", "{}")
        val compiled = compiler.compile(id, "1.0.0", JSONArray().put(unit), false, read, size)
        assertNull(compiled[0].world)
    }

    @Test
    fun `empty origins fall back to every origin`() {
        val compiler = UnitCompiler { "/*boot*/" }
        val unit = org.json.JSONObject().put("key", "k").put("origins", JSONArray()).put("config", "{}")
        val compiled = compiler.compile(id, "1.0.0", JSONArray().put(unit), false, read, size)
        assertEquals(listOf("*"), compiled[0].origins)
        assertNull(compiled[0].world)
    }

    // --- The unit store (compat round 24, R24-1) ---

    /** A unit of `chars` inline characters under `key` (its estimate is the text plus the fixed room, over `STORE_LINE` from a few thousand). */
    private fun inlineUnit(key: String, chars: Int, config: String = "{}", css: Boolean = false): org.json.JSONObject =
        org.json.JSONObject().put("key", key).put("origins", JSONArray(listOf("https://example.com"))).put("world", org.json.JSONObject.NULL)
            .put("config", config)
            .put("groups", JSONArray().put(org.json.JSONObject().put("ext", id).put("index", 0).put("js", JSONArray(listOf(UnitCompiler.INLINE_CODE + "var big = '" + "✓x".repeat(chars / 2) + "';"))).put("isolation", "with")))
            .put("css", if (css) JSONArray().put(org.json.JSONObject().put("ext", id).put("path", "style.css")) else JSONArray())

    private fun storeRoot(): java.io.File = java.nio.file.Files.createTempDirectory("ext-units-test").toFile()

    /** The compiler's own directories under the root (`<owner>-<n>`). */
    private fun dirsOf(root: java.io.File, owner: String): List<java.io.File> = root.listFiles().orEmpty().filter { it.isDirectory && it.name.startsWith("$owner-") }.sortedBy { it.name }

    @Test
    fun `a unit of the store's size is written to a file as it is assembled and holds no script - its text read back is the sized assembly's - and a smaller unit is held as before`() {
        val root = storeRoot()
        try {
            val compiler = UnitCompiler(store = root, owner = "t", fileUnitChars = STORE_LINE) { "/*boot*/" }
            val plan = JSONArray().put(inlineUnit("big", 40_000, css = true)).put(inlineUnit("small", 10, css = true))
            val compiled = compiler.compile(id, "1.0.0", plan, true, read, size)
            assertEquals(2, compiled.size)
            val (big, small) = compiled
            // The big unit: a file of the compiler's own directory, no string of it, its count exact.
            assertTrue(big.file != null && big.file!!.isFile)
            assertEquals("", big.script)
            assertTrue(big.chars > 40_000)
            // The count is the text's but for the quoting bound on the CSS key's one `/` (Android's `quote` escapes it, the public one's does not).
            assertTrue("presized ${big.presized} for ${big.chars}", big.presized >= big.chars && big.presized - big.chars <= 1)
            assertFalse(big.grown)
            assertEquals(1, dirsOf(root, "t").size)
            assertEquals(dirsOf(root, "t")[0], big.file!!.parentFile)
            // What comes back is what a compiler without a store assembles for the same plan.
            val held = UnitCompiler { "/*boot*/" }.compile(id, "1.0.0", JSONArray().put(inlineUnit("big", 40_000, css = true)), true, read, size)[0]
            assertEquals(held.script, big.text())
            assertEquals(held.script.length, big.chars)
            assertTrue(big.text()!!.contains("✓x✓x"))
            assertTrue(big.text()!!.contains("body{color:red}"))
            // The small unit: held, its text its script.
            assertNull(small.file)
            assertTrue(small.script.isNotEmpty())
            assertEquals(small.script, small.text())
            assertEquals(small.script.length, small.chars)
            // The instrumentation counts the stored unit apart and in no heap figure.
            val memory = compiler.memoryOf(id)
            assertEquals(2, memory.getInt("units"))
            assertEquals(1, memory.getInt("storedUnits"))
            assertEquals(big.chars.toLong(), memory.getLong("storedChars"))
            assertEquals(small.script.length.toLong(), memory.getLong("unitChars"))
            assertEquals(1, memory.getInt("wideUnits"))
            // Without a store the same line keeps every unit in memory.
            val inMemory = UnitCompiler(fileUnitChars = STORE_LINE) { "/*boot*/" }.compile(id, "1.0.0", JSONArray().put(inlineUnit("big", 40_000)), true, read, size)[0]
            assertNull(inMemory.file)
            assertTrue(inMemory.script.length > 40_000)
        } finally {
            root.deleteRecursively()
        }
    }

    @Test
    fun `a stored unit keeps its file through a cached re-plan, gets a new one when its inputs change, and loses it when the plan drops it, the extension is forgotten or the compiler closes`() {
        val root = storeRoot()
        try {
            val compiler = UnitCompiler(store = root, owner = "t", fileUnitChars = STORE_LINE) { "/*boot*/" }
            val first = compiler.compile(id, "1.0.0", JSONArray().put(inlineUnit("big", 40_000)), true, read, size)[0]
            val file = first.file!!
            assertTrue(file.isFile)
            // The same plan: cached, the same file, still there.
            val again = compiler.compile(id, "1.0.0", JSONArray().put(inlineUnit("big", 40_000)), true, read, size)[0]
            assertTrue(again.cached)
            assertEquals(file, again.file)
            assertEquals(first.chars, again.chars)
            assertTrue(file.isFile)
            assertEquals(first.text(), again.text())
            // The config changed: the old file goes, a new one is written.
            val changed = compiler.compile(id, "1.0.0", JSONArray().put(inlineUnit("big", 40_000, config = """{"k":2}""")), true, read, size)[0]
            assertFalse(changed.cached)
            assertNotEquals(file, changed.file)
            assertFalse(file.exists())
            assertTrue(changed.file!!.isFile)
            assertTrue(changed.text()!!.contains(""""k":2"""))
            // The plan without it: its file goes with it.
            compiler.compile(id, "1.0.0", JSONArray().put(inlineUnit("other", 40_000)), true, read, size)
            assertFalse(changed.file!!.exists())
            assertEquals(1, compiler.unitsOf(id).size)
            val other = compiler.unitsOf(id)[0].file!!
            assertTrue(other.isFile)
            // A new version starts from nothing: the old version's files go (a unit of the new
            // version with the same key and inputs would be written to the same name again).
            val v2 = compiler.compile(id, "2.0.0", JSONArray().put(inlineUnit("renamed", 40_000)), true, read, size)[0]
            assertFalse(other.exists())
            assertTrue(v2.file!!.isFile)
            assertNotEquals(other, v2.file)
            // Forgotten: the file goes.
            compiler.forget(id)
            assertFalse(v2.file!!.exists())
            // Closed: every file and the compiler's directory go, the stored ones counted.
            val last = compiler.compile(id, "2.0.0", JSONArray().put(inlineUnit("big", 40_000)).put(inlineUnit("small", 10)), true, read, size)
            val dir = last[0].file!!.parentFile!!
            assertTrue(dir.isDirectory)
            val released = compiler.close()
            assertEquals(2, released.units)
            assertEquals(1, released.storedUnits)
            assertEquals(last.sumOf { it.chars.toLong() }, released.unitChars)
            assertFalse(last[0].file!!.exists())
            assertFalse(dir.exists())
            assertTrue(root.isDirectory)
        } finally {
            root.deleteRecursively()
        }
    }

    @Test
    fun `at its first compile the compiler sweeps another owner's directories from the store - a process that died with its units - and leaves this owner's and the root's files`() {
        val root = storeRoot()
        try {
            val dead = java.io.File(root, "p123-1").also { it.mkdirs(); java.io.File(it, "old.js").writeText("x") }
            val sibling = java.io.File(root, "t-77").also { it.mkdirs(); java.io.File(it, "live.js").writeText("y") }
            val stray = java.io.File(root, "note.txt").also { it.writeText("z") }
            val compiler = UnitCompiler(store = root, owner = "t", fileUnitChars = STORE_LINE) { "/*boot*/" }
            // Nothing is touched at construction (the main thread builds the runtime).
            assertTrue(dead.isDirectory)
            compiler.compile(id, "1.0.0", JSONArray().put(inlineUnit("small", 10)), true, read, size)
            assertFalse(dead.exists())
            assertTrue(java.io.File(sibling, "live.js").isFile)
            assertTrue(stray.isFile)
            compiler.close()
            assertTrue(java.io.File(sibling, "live.js").isFile)
        } finally {
            root.deleteRecursively()
        }
    }

    @Test
    fun `a stored unit whose file is gone answers no text, a held unit still its own, and a refused unit none`() {
        val root = storeRoot()
        try {
            val compiler = UnitCompiler(budgetChars = 100_000, store = root, owner = "t", fileUnitChars = STORE_LINE) { "/*boot*/" }
            val plan = JSONArray().put(inlineUnit("big", 40_000)).put(inlineUnit("small", 10)).put(inlineUnit("huge", 200_000))
            val (big, small, huge) = compiler.compile(id, "1.0.0", plan, true, read, size)
            assertTrue(big.file!!.delete())
            assertNull(big.text())
            val gone = big.read()
            assertTrue(gone is UnitCompiler.Read.Gone)
            assertEquals(big.file, (gone as UnitCompiler.Read.Gone).file)
            assertEquals(small.script, small.text())
            assertTrue(huge.refused != null)
            assertNull(huge.text())
            assertTrue(huge.read() === UnitCompiler.Read.Refused)
            assertNull(huge.file)
        } finally {
            root.deleteRecursively()
        }
    }

    @Test
    fun `a stored unit's read says whether it came from the disk or the soft hold - the hold is counted apart, can be dropped, and outlives the file until it is`() {
        val root = storeRoot()
        try {
            val compiler = UnitCompiler(store = root, owner = "t", fileUnitChars = STORE_LINE) { "/*boot*/" }
            val (big, small) = compiler.compile(id, "1.0.0", JSONArray().put(inlineUnit("big", 40_000)).put(inlineUnit("small", 10)), true, read, size)
            // Nothing is held before the first read: the compile wrote the file and kept no string.
            assertFalse(big.softHeld)
            assertEquals(0, compiler.memoryOf(id).getInt("softHeldUnits"))
            // The first read decodes the file and holds the text softly; the next takes the hold.
            val first = big.read() as UnitCompiler.Read.Text
            assertTrue(first.fromDisk)
            assertTrue(big.softHeld)
            val memory = compiler.memoryOf(id)
            assertEquals(1, memory.getInt("storedUnits"))
            assertEquals(1, memory.getInt("softHeldUnits"))
            assertEquals(big.chars.toLong(), memory.getLong("softHeldChars"))
            val second = big.read() as UnitCompiler.Read.Text
            assertFalse(second.fromDisk)
            assertTrue(first.text === second.text)
            // A held unit's read is its own string, never from the disk and never soft-held.
            val held = small.read() as UnitCompiler.Read.Text
            assertFalse(held.fromDisk)
            assertTrue(small.script === held.text)
            assertFalse(small.softHeld)
            assertEquals(1, compiler.memoryOf(id).getInt("softHeldUnits"))
            // The hold dropped (what the collector does under pressure): the next read is from the disk again.
            big.dropSoftText()
            assertFalse(big.softHeld)
            assertTrue((big.read() as UnitCompiler.Read.Text).fromDisk)
            assertEquals(first.text, big.text())
            // The soft-held text answers after the file is gone (the same text); the dropped hold does not.
            assertTrue(big.file!!.delete())
            assertTrue(big.read() is UnitCompiler.Read.Text)
            big.dropSoftText()
            assertTrue(big.read() is UnitCompiler.Read.Gone)
            assertNull(big.text())
            assertEquals(0, compiler.memoryOf(id).getInt("softHeldUnits"))
        } finally {
            root.deleteRecursively()
        }
    }

    @Test
    fun `two compilers of one owner keep their own directories, the way two runtimes of one process do`() {
        val root = storeRoot()
        try {
            val a = UnitCompiler(store = root, owner = "t", fileUnitChars = STORE_LINE) { "/*boot*/" }
            val b = UnitCompiler(store = root, owner = "t", fileUnitChars = STORE_LINE) { "/*boot*/" }
            val ua = a.compile(id, "1.0.0", JSONArray().put(inlineUnit("big", 40_000)), true, read, size)[0]
            val ub = b.compile(id, "1.0.0", JSONArray().put(inlineUnit("big", 40_000)), true, read, size)[0]
            assertNotEquals(ua.file!!.parentFile, ub.file!!.parentFile)
            assertEquals(2, dirsOf(root, "t").size)
            a.close()
            assertFalse(ua.file!!.exists())
            assertTrue(ub.file!!.isFile)
            assertEquals(UnitCompiler { "/*boot*/" }.compile(id, "1.0.0", JSONArray().put(inlineUnit("big", 40_000)), true, read, size)[0].script, ub.text())
            b.close()
            assertEquals(0, dirsOf(root, "t").size)
        } finally {
            root.deleteRecursively()
        }
    }

    private companion object {
        /** A store line the inline units straddle: a 40 000 character unit goes to the store, a unit of a few dozen (its estimate a few thousand with the fixed room) is held. */
        const val STORE_LINE = 20_000
    }
}
