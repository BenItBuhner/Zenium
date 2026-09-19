package app.zen.chromium.ext

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** The injected script is assembled by string work; these tests pin its shape and syntax. */
class ExtensionScriptsTest {
    private val group = ExtensionScripts.Group(
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
        val spoofing = ExtensionScripts.Group(group.extensionId, 3, listOf("void 0;\n//# sourceURL=https://page.example/own.js"), "with")
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
        val hostile = ExtensionScripts.Group(group.extensionId, 2, listOf("var s = '}}}'; // {"), "shadow")
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
        assertTrue(withFunc.startsWith("""__zenExtExec("tok","abcdefghijklmnopabcdefghijklmnop","js",{"world":"MAIN"},function(window,self,globalThis,chrome,browser){"""))
        assertTrue(withFunc.contains("return ((a, b) => a + b).apply(null,[1,2]);"))
        val withCode = ExtensionScripts.exec("tok", "abcdefghijklmnopabcdefghijklmnop", "js", JSONObject(), "document.title", null, null)
        assertTrue(withCode.contains("{\ndocument.title\n})"))
        val css = ExtensionScripts.exec("tok", "abcdefghijklmnopabcdefghijklmnop", "css", JSONObject("""{"code":"a{}"}"""), null, null, null)
        assertTrue(css.contains(""""css",{"code":"a{}"},function"""))
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
}
