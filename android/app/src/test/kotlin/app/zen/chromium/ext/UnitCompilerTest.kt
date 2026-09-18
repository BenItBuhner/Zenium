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
        val compiled = compiler.compile(id, "1.0.0", units("isolated:https://example.com" to listOf("cs.js")), true, read)
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
        val first = compiler.compile(id, "1.0.0", units("isolated:https://example.com" to listOf("cs.js")), true, read)
        val readsAfterFirst = reads
        val second = compiler.compile(id, "1.0.0", units("isolated:https://example.com" to listOf("cs.js")), true, read)
        assertTrue(second[0].cached)
        assertEquals(first[0].script, second[0].script)
        assertEquals(first[0].hash, second[0].hash)
        assertEquals(readsAfterFirst, reads)
    }

    @Test
    fun `a re-plan reuses the sources already read and compiles only what changed`() {
        val compiler = UnitCompiler { "/*boot*/" }
        compiler.compile(id, "1.0.0", units("isolated:https://example.com" to listOf("cs.js")), true, read)
        val readsAfterFirst = reads
        // registerContentScripts added a second unit: the first is cached, the second reads extra.js only.
        val compiled = compiler.compile(
            id, "1.0.0",
            units("isolated:https://example.com" to listOf("cs.js"), "isolated:https://other.example" to listOf("extra.js")),
            true, read
        )
        assertEquals(listOf(true, false), compiled.map { it.cached })
        assertEquals(readsAfterFirst + 1, reads)
        assertEquals(2, compiler.unitsOf(id).size)
        // The plan shrinks again: the dropped unit is forgotten.
        compiler.compile(id, "1.0.0", units("isolated:https://example.com" to listOf("cs.js")), true, read)
        assertEquals(listOf("isolated:https://example.com"), compiler.unitsOf(id).map { it.key })
    }

    @Test
    fun `the debug flag and the config are part of a unit's identity`() {
        val compiler = UnitCompiler { "/*boot*/" }
        val debug = compiler.compile(id, "1.0.0", units("k" to listOf("cs.js")), true, read)
        val release = compiler.compile(id, "1.0.0", units("k" to listOf("cs.js")), false, read)
        assertFalse(release[0].cached)
        assertNotEquals(debug[0].hash, release[0].hash)
        assertTrue(debug[0].script.contains(",debug:true"))
        assertTrue(release[0].script.contains(",debug:false"))
    }

    @Test
    fun `a new version starts from nothing and a detach forgets the extension`() {
        val compiler = UnitCompiler { "/*boot*/" }
        compiler.compile(id, "1.0.0", units("k" to listOf("cs.js")), true, read)
        files["cs.js"] = "console.log('cs v2')"
        val next = compiler.compile(id, "1.1.0", units("k" to listOf("cs.js")), true, read)
        assertFalse(next[0].cached)
        assertTrue(next[0].script.contains("console.log('cs v2')"))
        compiler.forget(id)
        assertEquals(0, compiler.unitsOf(id).size)
        assertEquals(0, compiler.cachedSources(id))
    }

    @Test
    fun `a missing file becomes a console error instead of a broken unit and stays cached as missing`() {
        val compiler = UnitCompiler { "/*boot*/" }
        val compiled = compiler.compile(id, "1.0.0", units("k" to listOf("gone.js")), true, read)
        assertTrue(compiled[0].script.contains("missing content script gone.js"))
        val readsAfterFirst = reads
        compiler.compile(id, "1.0.0", units("k2" to listOf("gone.js")), true, read)
        assertEquals(readsAfterFirst, reads)
    }

    @Test
    fun `another extension's cache is untouched`() {
        val compiler = UnitCompiler { "/*boot*/" }
        val other = "ponmlkjihgfedcbaponmlkjihgfedcba"
        compiler.compile(id, "1.0.0", units("k" to listOf("cs.js")), true, read)
        compiler.compile(other, "2.0.0", units("k" to listOf("cs.js")), true, read)
        compiler.forget(other)
        assertEquals(1, compiler.unitsOf(id).size)
        assertNull(compiler.unitsOf(other).firstOrNull())
    }

    @Test
    fun `a main-world unit (world null on the wire) has no world`() {
        val compiler = UnitCompiler { "/*boot*/" }
        val unit = org.json.JSONObject().put("key", "k").put("origins", JSONArray().put("https://userstyles.org"))
            .put("world", org.json.JSONObject.NULL).put("config", "{}")
        val compiled = compiler.compile(id, "1.0.0", JSONArray().put(unit), false, read)
        assertNull(compiled[0].world)
    }

    @Test
    fun `empty origins fall back to every origin`() {
        val compiler = UnitCompiler { "/*boot*/" }
        val unit = org.json.JSONObject().put("key", "k").put("origins", JSONArray()).put("config", "{}")
        val compiled = compiler.compile(id, "1.0.0", JSONArray().put(unit), false, read)
        assertEquals(listOf("*"), compiled[0].origins)
        assertNull(compiled[0].world)
    }
}
