package app.zen.chromium.ext

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/** The injected script is assembled by string work; these tests pin its shape and syntax. */
class ExtensionScriptsTest {
    private val group = ExtensionScripts.Group.of(
        extensionId = "abcdefghijklmnopabcdefghijklmnop",
        index = 0,
        sources = listOf("var shared = 1 // trailing comment", "(function(){ return shared })()"),
        isolation = "shadow"
    )

    @Test
    fun `document-start script embeds config, css, sources and the bootstrap in that order`() {
        // org.json on the JVM leaves `/` alone; Android's escapes it as `\/`. Both read the same in JS.
        val script = ExtensionScripts.documentStart(
            bootstrap = "/*bootstrap*/",
            configJson = """{"kind":"content","token":"t"}""",
            groups = listOf(group),
            css = mapOf("abcdefghijklmnopabcdefghijklmnop/style.css" to "body{color:red}"),
            debug = true
        ).replace("\\/", "/")
        val config = script.indexOf("""config:{"kind":"content","token":"t"}""")
        val css = script.indexOf(""""abcdefghijklmnopabcdefghijklmnop/style.css":"body{color:red}"""")
        val source = script.indexOf(""""abcdefghijklmnopabcdefghijklmnop/0":function(window,self,globalThis,chrome,browser){""")
        val bootstrap = script.indexOf("/*bootstrap*/")
        assertTrue(config in 0 until css)
        assertTrue(css in 0 until source)
        assertTrue(source in 0 until bootstrap)
        assertTrue(script.contains(",debug:true"))
        assertTrue(script.startsWith("(function(){var __zenExtBoot={"))
        assertTrue(script.trimEnd().endsWith("})();\n//# sourceURL=zenium-ext://content-scripts/boot.js"))
    }

    @Test
    fun `main-world scripts are named with a location no page script can have, after every file`() {
        // A file's own magic comment comes first in the text; V8 keeps the last one, the host's.
        val spoofing = ExtensionScripts.Group.of(group.extensionId, 3, listOf("void 0;\n//# sourceURL=https://page.example/own.js"), "with")
        val script = ExtensionScripts.documentStart("void 0;", "{}", listOf(spoofing), emptyMap(), false)
        assertTrue(script.lastIndexOf("//# sourceURL=https://page.example/own.js") < script.lastIndexOf("//# sourceURL=${ExtensionScripts.SOURCE_URL}"))
        assertTrue(script.endsWith("\n//# sourceURL=${ExtensionScripts.SOURCE_URL}"))
        assertFalse(ExtensionScripts.SOURCE_URL.startsWith("http"))
        // The executeScript wrapper gets the same name when the host evaluates it in the main world.
        val call = ExtensionScripts.guarded(ExtensionScripts.exec("tok", group.extensionId, "js", JSONObject(), "document.title", null, null))
        assertEquals(call + "\n//# sourceURL=${ExtensionScripts.SOURCE_URL}", ExtensionScripts.named(call))
    }

    @Test
    fun `files of one group share a scope and a trailing comment cannot swallow the next file`() {
        val sb = StringBuilder()
        ExtensionScripts.appendGroupFunction(sb, group)
        val fn = sb.toString()
        // The first file ends in a line comment; the newline before the `;` and the next file keeps them separate.
        assertTrue(fn.contains("var shared = 1 // trailing comment\n;\n(function(){ return shared })()\n;"))
        assertFalse(fn.contains("with(window)"))
        val withMode = StringBuilder().also { ExtensionScripts.appendGroupFunction(it, ExtensionScripts.Group(group.extensionId, 1, group.sources, "with")) }.toString()
        assertTrue(withMode.startsWith("function(window,self,globalThis,chrome,browser){with(window){"))
        assertTrue(withMode.endsWith("}\n}"))
    }

    @Test
    fun `assembled script keeps its braces balanced around every embedded text`() {
        // Sources and CSS with unbalanced braces travel as JSON strings, never as raw text.
        val hostile = ExtensionScripts.Group.of(group.extensionId, 2, listOf("var s = '}}}'; // {"), "shadow")
        val script = ExtensionScripts.documentStart("void 0;", "{}", listOf(group, hostile), mapOf("a/b.css" to "a{{{"), false)
        val stripped = script.replace(Regex("\"(?:[^\"\\\\]|\\\\.)*\""), "\"\"").replace(Regex("'(?:[^'\\\\]|\\\\.)*'"), "''").replace(Regex("//[^\n]*"), "")
        var depth = 0
        for (ch in stripped) {
            if (ch == '{') depth++
            if (ch == '}') depth--
            assertTrue(depth >= 0)
        }
        assertEquals(0, depth)
    }

    @Test
    fun `page bootstrap carries only the config`() {
        val script = ExtensionScripts.page("BOOT", """{"kind":"page","context":"popup"}""")
        assertEquals("""(function(){var __zenExtBoot={config:{"kind":"page","context":"popup"},debug:false,css:{},sources:{}};""" + "\nBOOT\n})();", script)
    }

    @Test
    fun `executeScript wrapper turns func plus args into a call and code into a body`() {
        val withFunc = ExtensionScripts.exec("tok", "abcdefghijklmnopabcdefghijklmnop", "js", JSONObject("""{"world":"MAIN"}"""), null, "(a, b) => a + b", "[1,2]")
        // A document without the bootstrap answers with Chrome's refusal, not a TypeError about the bridge.
        assertTrue(withFunc.startsWith("""(typeof __zenExtExec==="function"?__zenExtExec:function(){throw new Error("${ExtensionScripts.NO_ACCESS}")})("tok","abcdefghijklmnopabcdefghijklmnop","js",{"world":"MAIN"},function(window,self,globalThis,chrome,browser){"""))
        assertTrue(ExtensionScripts.NO_ACCESS.startsWith("Cannot access contents of the page."))
        assertTrue(withFunc.contains("return ((a, b) => a + b).apply(null,[1,2]);"))
        val withCode = ExtensionScripts.exec("tok", "abcdefghijklmnopabcdefghijklmnop", "js", JSONObject(), "document.title", null, null)
        assertTrue(withCode.contains("{\ndocument.title\n})"))
        val css = ExtensionScripts.exec("tok", "abcdefghijklmnopabcdefghijklmnop", "css", JSONObject("""{"code":"a{}"}"""), null, null, null)
        assertTrue(css.contains(""""css",{"code":"a{}"},function"""))
    }

    @Test
    fun `an injection into the extension's with scope is a with block, as a content script's group is`() {
        val id = "abcdefghijklmnopabcdefghijklmnop"
        // A Lit-built file: the write goes to globalThis, the read is the bare name; both must be the scope's.
        val lit = "globalThis.litPropertyMetadata = new WeakMap(); litPropertyMetadata.get(1)"
        val scoped = ExtensionScripts.exec("tok", id, "js", JSONObject(), lit, null, null, scoped = true)
        assertTrue(scoped.contains("function(window,self,globalThis,chrome,browser){with(window){\n$lit\n}})"))
        val func = ExtensionScripts.exec("tok", id, "js", JSONObject(), null, "() => litPropertyMetadata", "[]", scoped = true)
        assertTrue(func.contains("{with(window){\nreturn (() => litPropertyMetadata).apply(null,[]);\n}})"))
        // Unscoped (an isolated world, a MAIN-world injection): the bare function body.
        val plain = ExtensionScripts.exec("tok", id, "js", JSONObject("""{"world":"MAIN"}"""), lit, null, null)
        assertTrue(plain.contains("function(window,self,globalThis,chrome,browser){\n$lit\n})"))
        assertFalse(plain.contains("with(window)"))
        // The streamed form composes the same text, with a file in place of the code.
        val dir = createTempDir("ext-scripts-scoped")
        try {
            val file = File(dir, "lit.js").apply { writeText(lit) }
            val streamed = ExtensionScripts.execScript("tok", id, "js", JSONObject(), null, listOf(file), null, null, null, true, scoped = true)
            assertEquals(ExtensionScripts.named(ExtensionScripts.guarded(scoped)), streamed)
        } finally {
            dir.deleteRecursively()
        }
    }

    @Test
    fun `execScript streams the extension's files into one guarded, named script equal to the old composition`() {
        val dir = createTempDir("ext-scripts")
        try {
            // A multi-byte file: its size in bytes bounds its length in chars, so the builder is presized and never grows.
            val a = File(dir, "a.js").apply { writeText("var shared = 'héllo — ✓' // trailing comment") }
            val b = File(dir, "b.js").apply { writeText("(function(){ return shared })()") }
            val id = "abcdefghijklmnopabcdefghijklmnop"
            val payload = JSONObject("""{"world":"MAIN"}""")
            val joined = a.readText() + "\n;\n" + b.readText()
            val expected = ExtensionScripts.named(ExtensionScripts.guarded(ExtensionScripts.exec("tok", id, "js", payload, joined, null, null)))
            val script = ExtensionScripts.execScript("tok", id, "js", payload, null, listOf(a, b), null, null, null, true)
            assertEquals(expected, script)
            // A late boot in front, and the isolated-world form (no name): the same pieces.
            val withPrefix = ExtensionScripts.execScript("tok", id, "js", payload, null, listOf(a, b), null, null, "/*boot*/", false)
            assertEquals("/*boot*/\n" + ExtensionScripts.guarded(ExtensionScripts.exec("tok", id, "js", payload, joined, null, null)), withPrefix)
            // Code and func take the same path, with no files.
            val code = ExtensionScripts.execScript("tok", id, "js", JSONObject(), "document.title", emptyList(), null, null, null, false)
            assertEquals(ExtensionScripts.guarded(ExtensionScripts.exec("tok", id, "js", JSONObject(), "document.title", null, null)), code)
            val func = ExtensionScripts.execScript("tok", id, "js", JSONObject(), null, emptyList(), "(a, b) => a + b", "[1,2]", null, true)
            assertEquals(ExtensionScripts.named(ExtensionScripts.guarded(ExtensionScripts.exec("tok", id, "js", JSONObject(), null, "(a, b) => a + b", "[1,2]"))), func)
            // Code before files: joined like two files.
            val both = ExtensionScripts.execScript("tok", id, "js", JSONObject(), "first()", listOf(b), null, null, null, false)
            assertTrue(both.contains("{\nfirst()\n;\n(function(){ return shared })()\n})"))
        } finally {
            dir.deleteRecursively()
        }
    }

    @Test
    fun `mime types by extension`() {
        assertEquals("text/javascript", ExtensionScripts.mimeType("js/content.js"))
        assertEquals("text/javascript", ExtensionScripts.mimeType("lib/module.mjs"))
        assertEquals("text/html", ExtensionScripts.mimeType("popup.html"))
        assertEquals("application/json", ExtensionScripts.mimeType("_locales/en/messages.json"))
        assertEquals("image/svg+xml", ExtensionScripts.mimeType("icons/x.SVG"))
        assertEquals("application/wasm", ExtensionScripts.mimeType("a.wasm"))
        assertEquals("application/octet-stream", ExtensionScripts.mimeType("noext"))
    }

    /** The module bracket for one-realm WebViews, in the shape `extensionModuleChrome.test.ts` pins for the bootstrap's side. */
    @Test
    fun moduleChromeWrapBracketsTheTextWithoutMovingItsLines() {
        val id = "oldceeleldhonbafppcapldpdifcinji"
        val text = "import x from \"./x.js\";\nexport const y = x + 1;\n//# sourceMappingURL=content.js.map"
        val wrapped = ExtensionScripts.moduleChromeWrap(text, id)
        assertTrue(wrapped.startsWith("globalThis.__zenExtModule&&globalThis.__zenExtModule(\"$id\");import x from"))
        assertTrue(wrapped.endsWith("\n;globalThis.__zenExtModuleEnd&&globalThis.__zenExtModuleEnd(\"$id\");"))
        val lines = wrapped.lines()
        assertEquals(text.lines().size + 1, lines.size)
        assertEquals(text.lines().drop(1), lines.drop(1).dropLast(1))
        assertTrue(ExtensionScripts.isScriptPath("content.js"))
        assertTrue(ExtensionScripts.isScriptPath("chunks/a.MJS"))
        assertFalse(ExtensionScripts.isScriptPath("content.json"))
        assertFalse(ExtensionScripts.isScriptPath("styles.css"))
    }
}
