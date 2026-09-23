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
    fun `a re-plan reuses the sources already read and compiles only what changed`() {
        val compiler = UnitCompiler { "/*boot*/" }
        compiler.compile(id, "1.0.0", units("isolated:https://example.com" to listOf("cs.js")), true, read, size)
        val readsAfterFirst = reads
        // registerContentScripts added a second unit: the first is cached, the second reads extra.js only.
        val compiled = compiler.compile(
            id, "1.0.0",
            units("isolated:https://example.com" to listOf("cs.js"), "isolated:https://other.example" to listOf("extra.js")),
            true, read, size
        )
        assertEquals(listOf(true, false), compiled.map { it.cached })
        assertEquals(readsAfterFirst + 1, reads)
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
    fun `sources the GC took back are read again and only they - a cached unit needs none of them`() {
        val compiler = UnitCompiler { "/*boot*/" }
        compiler.compile(id, "1.0.0", units("k" to listOf("cs.js")), true, read, size)
        assertEquals(2, compiler.cachedSources(id))
        compiler.clearSourcesForTest(id)
        assertEquals(0, compiler.cachedSources(id))
        val readsAfterClear = reads
        // The unit itself is still cached: no source is needed for it.
        val same = compiler.compile(id, "1.0.0", units("k" to listOf("cs.js")), true, read, size)
        assertTrue(same[0].cached)
        assertEquals(readsAfterClear, reads)
        // A re-plan that adds a unit reads its files again (cs.js and style.css went; extra.js never was).
        val more = compiler.compile(id, "1.0.0", units("k" to listOf("cs.js"), "k2" to listOf("extra.js", "cs.js")), true, read, size)
        assertEquals(listOf(true, false), more.map { it.cached })
        assertTrue(more[1].script.contains("console.log('extra')") && more[1].script.contains("console.log('cs')"))
        assertEquals(readsAfterClear + 3, reads)
        assertEquals(3, compiler.cachedSources(id))
    }

    @Test
    fun `a missing file becomes a console error instead of a broken unit and stays cached as missing`() {
        val compiler = UnitCompiler { "/*boot*/" }
        val compiled = compiler.compile(id, "1.0.0", units("k" to listOf("gone.js")), true, read, size)
        assertTrue(compiled[0].script.contains("missing content script gone.js"))
        val readsAfterFirst = reads
        compiler.compile(id, "1.0.0", units("k2" to listOf("gone.js")), true, read, size)
        assertEquals(readsAfterFirst, reads)
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
    fun `a large file goes into the script once, is not held for a re-plan, and is read again by one`() {
        // Monica's content.js: 28 million characters; the soft copy and the assembly's third copy did not fit the heap.
        val large = "/* big */ " + "x".repeat(UnitCompiler.LARGE_SOURCE_CHARS)
        files["big.js"] = large
        val compiler = UnitCompiler { "/*boot*/" }
        val compiled = compiler.compile(id, "1.0.0", units("k" to listOf("cs.js", "big.js", "extra.js")), true, read, size)
        val script = compiled[0].script
        assertEquals(1, Regex("/\\* big \\*/").findAll(script).count())
        val cs = script.indexOf("console.log('cs')")
        val big = script.indexOf("/* big */")
        val extra = script.indexOf("console.log('extra')")
        assertTrue(cs in 0 until big && big < extra)
        assertEquals(4, reads) // cs.js, big.js, extra.js and the CSS
        // cs.js, extra.js and the CSS are held; big.js is not.
        assertEquals(3, compiler.cachedSources(id))
        // A re-plan that needs it reads big.js again and nothing else.
        val more = compiler.compile(id, "1.0.0", units("k" to listOf("cs.js", "big.js", "extra.js"), "k2" to listOf("big.js")), true, read, size)
        assertEquals(listOf(true, false), more.map { it.cached })
        assertEquals(5, reads)
        assertTrue(more[1].script.contains("/* big */"))
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
    fun `a unit under the budget compiles as before, its measure taken from the sizes and the held texts`() {
        val compiler = UnitCompiler(budgetChars = 10_000) { "/*boot*/" }
        val compiled = compiler.compile(id, "1.0.0", units("k" to listOf("cs.js", "extra.js")), true, read, size)
        assertNull(compiled[0].refused)
        assertTrue(compiled[0].script.contains("console.log('cs')") && compiled[0].script.contains("console.log('extra')"))
        assertEquals(3, reads) // cs.js, extra.js, style.css
        // A re-plan adding a unit over the same held files measures them by their texts, not the disk.
        sizes = 0
        val more = compiler.compile(id, "1.0.0", units("k" to listOf("cs.js", "extra.js"), "k2" to listOf("cs.js")), true, read, size)
        assertNull(more[1].refused)
        assertEquals(0, sizes)
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
}
