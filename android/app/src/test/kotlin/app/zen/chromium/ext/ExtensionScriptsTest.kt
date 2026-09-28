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
        val source = script.indexOf(""""abcdefghijklmnopabcdefghijklmnop/0":function(window,self,globalThis,chrome,browser,__zenMirror){""")
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
        assertTrue(withMode.startsWith("function(window,self,globalThis,chrome,browser,__zenMirror){with(window){"))
        assertTrue(withMode.endsWith("}\n}"))
    }

    @Test
    fun `a group's top-level declarations are mirrored onto the scope after its files, inside the with block, each name once`() {
        val files = listOf(
            "var readAloudDoc = new function() { this.x = 1 }\nfunction getTexts() { return [] }",
            "var readAloudDoc = { y: 2 }; const brapi = chrome; let count = 0, total\nclass Player {}\nvar $ = 1"
        )
        val shadow = StringBuilder().also { ExtensionScripts.appendGroupFunction(it, ExtensionScripts.Group.of(group.extensionId, 0, files, "shadow")) }.toString()
        val tail = "\n;" + listOf("readAloudDoc", "getTexts", "brapi", "count", "total", "Player", "$").joinToString("") { """try{__zenMirror("$it",$it)}catch(e){}""" }
        assertTrue(shadow.endsWith(files[1] + "\n;" + tail + "\n}"))
        assertEquals(1, shadow.split("\"readAloudDoc\"").size - 1)
        val withMode = StringBuilder().also { ExtensionScripts.appendGroupFunction(it, ExtensionScripts.Group.of(group.extensionId, 0, files, "with")) }.toString()
        assertTrue(withMode.endsWith(files[1] + "\n;" + tail + "}\n}"))
        // The same tail after an executeScript's code or files; a func has none (its declarations are its own in Chrome too).
        val id = group.extensionId
        val code = ExtensionScripts.exec("tok", id, "js", JSONObject(), files[0], null, null)
        assertTrue(code.contains(files[0] + "\n;" + """try{__zenMirror("readAloudDoc",readAloudDoc)}catch(e){}try{__zenMirror("getTexts",getTexts)}catch(e){}""" + "\n})"))
        val func = ExtensionScripts.exec("tok", id, "js", JSONObject(), null, "() => { var local = 1; return local }", "[]")
        assertFalse(func.contains("__zenMirror(\""))
        val dir = createTempDir("ext-scripts-mirror")
        try {
            val a = File(dir, "a.js").apply { writeText(files[0]) }
            val b = File(dir, "b.js").apply { writeText(files[1]) }
            val streamed = ExtensionScripts.execScript("tok", id, "js", JSONObject(), null, listOf(a, b), null, null, null, false)
            assertEquals(ExtensionScripts.guarded(ExtensionScripts.exec("tok", id, "js", JSONObject(), files[0] + "\n;\n" + files[1], null, null)), streamed)
            assertTrue(streamed.contains(tail + "\n})"))
        } finally {
            dir.deleteRecursively()
        }
        // The document-start script is sized for the tails: no growth past the presized builder.
        val script = ExtensionScripts.documentStart("/*bootstrap*/", "{}", listOf(ExtensionScripts.Group.of(id, 0, files, "shadow")), emptyMap(), false)
        assertTrue(script.contains(tail))
    }

    @Test
    fun `assembled script keeps its braces balanced around every embedded text`() {
        // Sources and CSS with unbalanced braces travel as JSON strings, never as raw text.
        val hostile = ExtensionScripts.Group.of(group.extensionId, 2, listOf("var s = '}}}'; // {"), "shadow")
        for (shape in listOf(ExtensionScripts.SHAPE_WHOLE, ExtensionScripts.SHAPE_CARRIER, ExtensionScripts.SHAPE_HOLDER, ExtensionScripts.SHAPE_THIN)) {
            val script = ExtensionScripts.documentStart("void 0;", "{}", listOf(group, hostile), mapOf("a/b.css" to "a{{{"), false, shape)
            val stripped = script.replace(Regex("\"(?:[^\"\\\\]|\\\\.)*\""), "\"\"").replace(Regex("'(?:[^'\\\\]|\\\\.)*'"), "''").replace(Regex("//[^\n]*"), "")
            var depth = 0
            for (ch in stripped) {
                if (ch == '{') depth++
                if (ch == '}') depth--
                assertTrue(shape, depth >= 0)
            }
            assertEquals(shape, 0, depth)
        }
    }

    @Test
    fun `a carrier wraps the bootstrap as the world's function of the boot and runs its own, a holder only defines it, a thin unit only calls it`() {
        // The unit's head (config, CSS, sources) is the same in every shape; the tail is the shape.
        val head = """(function(){var __zenExtBoot={config:{"kind":"content","token":"t"},debug:false,css:{},sources:{"abcdefghijklmnopabcdefghijklmnop/0":function(window,self,globalThis,chrome,browser,__zenMirror){"""
        val tail = "\n})();\n//# sourceURL=zenium-ext://content-scripts/boot.js"
        val config = """{"kind":"content","token":"t"}"""
        val whole = ExtensionScripts.documentStart("/*bootstrap*/", config, listOf(group), emptyMap(), false)
        val carrier = ExtensionScripts.documentStart("/*bootstrap*/", config, listOf(group), emptyMap(), false, ExtensionScripts.SHAPE_CARRIER)
        val holder = ExtensionScripts.documentStart("/*bootstrap*/", config, listOf(group), emptyMap(), false, ExtensionScripts.SHAPE_HOLDER)
        val thin = ExtensionScripts.documentStart("/*bootstrap*/", config, listOf(group), emptyMap(), false, ExtensionScripts.SHAPE_THIN)
        for (script in listOf(whole, carrier, holder, thin)) {
            assertTrue(script.startsWith(head))
            assertTrue(script.endsWith(tail))
        }
        val sources = whole.indexOf("}};\n") + 4
        assertEquals("/*bootstrap*/", whole.substring(sources, whole.length - tail.length))
        assertEquals(
            "var __zenExtCarry=globalThis.__zenExtCarrier=function(__zenExtBoot){\n/*bootstrap*/\n};\n__zenExtCarry(__zenExtBoot);",
            carrier.substring(sources, carrier.length - tail.length)
        )
        assertEquals(
            "var __zenExtCarry=globalThis.__zenExtCarrier=function(__zenExtBoot){\n/*bootstrap*/\n};\n",
            holder.substring(sources, holder.length - tail.length)
        )
        val thinTail = thin.substring(sources, thin.length - tail.length)
        assertFalse(thinTail.contains("/*bootstrap*/"))
        assertTrue(thinTail.startsWith("var __zenExtCarry=globalThis.__zenExtCarrier;if(typeof __zenExtCarry===\"function\")__zenExtCarry(__zenExtBoot);else console.error("))
        assertTrue(thinTail.contains("a set of its content scripts found no bootstrap in its world"))
        // The shapes' measure, the one the compiler's budget uses: the bootstrap once or not at
        // all, and the shape's own room, which covers the shape's fixed text.
        assertTrue(thinTail.length < ExtensionScripts.bootstrapChars(0, ExtensionScripts.SHAPE_THIN))
        assertTrue(carrier.length - whole.length < ExtensionScripts.bootstrapChars(0, ExtensionScripts.SHAPE_CARRIER))
        assertEquals(13 + 512, ExtensionScripts.bootstrapChars(13, ExtensionScripts.SHAPE_WHOLE))
        assertEquals(13 + 512, ExtensionScripts.bootstrapChars(13, ExtensionScripts.SHAPE_CARRIER))
        assertEquals(13 + 512, ExtensionScripts.bootstrapChars(13, ExtensionScripts.SHAPE_HOLDER))
        assertEquals(512, ExtensionScripts.bootstrapChars(13, ExtensionScripts.SHAPE_THIN))
        // An unknown shape is assembled whole.
        assertEquals(whole, ExtensionScripts.documentStart("/*bootstrap*/", config, listOf(group), emptyMap(), false, "later"))
    }

    /**
     * The builder is sized by an exact count of the text, so no append grows it (a builder that
     * grows doubles, and the doubling of a 10.6 million character carrier was the 42 MB
     * allocation that took the app down – compat round 21b). Over the round's plan shape: Adblock
     * Ad Blocker Pro's second boot, 650 single-source groups of the ruleset scriptlets (16-29 K
     * characters each, an isolated world's groups, some with top-level declarations for the
     * mirror, a few with characters over U+00FF so the builder is UTF-16) with the extension's
     * static groups (one of two files, one of 34, one of 41) and a 165 K bootstrap as a carrier.
     */
    @Test
    fun `the document-start builder is sized by an exact count of the round's plan shape and no append grows it`() {
        val id = "abcdefghijklmnopabcdefghijklmnop"
        val random = java.util.Random(21)
        fun scriptlet(index: Int, chars: Int): String {
            val sb = StringBuilder(chars + 256)
            when (index % 5) {
                0 -> sb.append("var scriptlet$index = 1;\nfunction run$index() { return scriptlet$index }\n")
                1 -> sb.append("const names$index = ['a', \"b\", `c`]; let count$index = 0;\n")
                else -> Unit
            }
            sb.append("(function(){\n  'use strict';\n  const args = [\"selector \\\"quoted\\\"\", '/path/with/slashes', \"</script>\"];\n")
            if (index % 97 == 0) sb.append("  const mark = '✓ — é'; // a character over U+00FF\n")
            while (sb.length < chars) sb.append("  if (args[").append(index % 3).append("] === document.title) { console.log(\"x\", ").append(random.nextInt(1000)).append("); }\n")
            sb.append("})(); // scriptlet ").append(index)
            return sb.toString()
        }
        val groups = ArrayList<ExtensionScripts.Group>()
        groups.add(ExtensionScripts.Group.of(id, 0, listOf(scriptlet(1000, 139_000), scriptlet(1001, 900)), "world"))
        groups.add(ExtensionScripts.Group.of(id, 1, List(34) { scriptlet(2000 + it, 2_000 + random.nextInt(20_000)) }, "world"))
        groups.add(ExtensionScripts.Group.of(id, 2, List(41) { scriptlet(3000 + it, 2_000 + random.nextInt(14_000)) }, "world"))
        for (i in 0 until 650) groups.add(ExtensionScripts.Group.of(id, 3 + i, listOf(scriptlet(i, 16_000 + random.nextInt(13_000))), "world"))
        val bootstrap = StringBuilder(165_000).also { sb -> while (sb.length < 165_000) sb.append("/* bootstrap */ (function(b){ b.config; b.css; b.sources; })(__zenExtBoot);\n") }.toString()
        val config = """{"kind":"content","token":"t","extension":{"id":"$id","name":"Adblock Ad Blocker Pro","hosts":[${List(200) { "\"https://*.site$it.example/*\"" }.joinToString(",")}]}}"""
        val assembled = ExtensionScripts.documentStartSized(bootstrap, config, groups, emptyMap(), false, ExtensionScripts.SHAPE_CARRIER)
        assertTrue("a carrier of the round's size: ${assembled.script.length}", assembled.script.length in 10_000_000..20_000_000)
        assertTrue("UTF-16, as the round's builder was", assembled.script.any { it > '\u00FF' })
        assertEquals("the count is the script, exactly", assembled.script.length, assembled.presized)
        assertFalse(assembled.grown)
        // The same text through the String form, and the whole shape.
        assertEquals(assembled.script, ExtensionScripts.documentStart(bootstrap, config, groups, emptyMap(), false, ExtensionScripts.SHAPE_CARRIER))
        val whole = ExtensionScripts.documentStartSized(bootstrap, config, groups, emptyMap(), true)
        assertEquals(whole.script.length, whole.presized)
    }

    @Test
    fun `every shape's document-start script is exactly its count, and a group's function exactly its own`() {
        val config = """{"kind":"content","token":"t"}"""
        val withMode = ExtensionScripts.Group(group.extensionId, 1, group.sources, "with")
        for (shape in listOf(ExtensionScripts.SHAPE_WHOLE, ExtensionScripts.SHAPE_CARRIER, ExtensionScripts.SHAPE_HOLDER, ExtensionScripts.SHAPE_THIN, "later")) {
            for (debug in listOf(true, false)) {
                val assembled = ExtensionScripts.documentStartSized("/*bootstrap*/", config, listOf(group, withMode), emptyMap(), debug, shape)
                assertEquals("$shape debug=$debug", assembled.script.length, assembled.presized)
                assertFalse(assembled.grown)
            }
        }
        // No groups, no css: the fixed text alone.
        val bare = ExtensionScripts.documentStartSized("", "{}", emptyList(), emptyMap(), false)
        assertEquals(bare.script.length, bare.presized)
        // A group's count is what its append writes, with and without the with block and the mirror.
        for (g in listOf(group, withMode, ExtensionScripts.Group.of(group.extensionId, 2, listOf("var a = 1", "function f() {}"), "with"), ExtensionScripts.Group.of(group.extensionId, 3, emptyList(), "shadow"))) {
            val mirror = ExtensionScripts.mirrorOf(g)
            val sb = StringBuilder()
            ExtensionScripts.appendGroupFunction(sb, g, mirror)
            assertEquals(sb.length, ExtensionScripts.groupFunctionChars(g, mirror))
            assertEquals(sb.toString(), StringBuilder().also { ExtensionScripts.appendGroupFunction(it, g) }.toString())
        }
    }

    @Test
    fun `the document-start script written through a sink is the sized assembly's text, character for character, in every shape, and its count is the sink's`() {
        val config = """{"kind":"content","token":"t"}"""
        val withMode = ExtensionScripts.Group(group.extensionId, 1, group.sources, "with")
        val css = linkedMapOf("${group.extensionId}/a.css" to "body{color:red}", "${group.extensionId}/b.css" to "p{margin:0}")
        for (shape in listOf(ExtensionScripts.SHAPE_WHOLE, ExtensionScripts.SHAPE_CARRIER, ExtensionScripts.SHAPE_HOLDER, ExtensionScripts.SHAPE_THIN)) {
            for (debug in listOf(true, false)) {
                val assembled = ExtensionScripts.documentStartSized("/*bootstrap*/", config, listOf(group, withMode), css, debug, shape)
                val sink = StringBuilder()
                val written = ExtensionScripts.documentStartTo(sink, "/*bootstrap*/", config, listOf(group, withMode), css, debug, shape)
                assertEquals("$shape debug=$debug", assembled.script, sink.toString())
                assertEquals(assembled.presized, written.presized)
                assertEquals(sink.length, written.chars)
                assertFalse(written.grown)
            }
        }
        // A transient source is appended once, through whichever sink: a second assembly over it throws.
        val once = ExtensionScripts.Group(group.extensionId, 0, listOf(ExtensionScripts.Source.transient("var t = 1")), "with")
        val first = StringBuilder()
        ExtensionScripts.documentStartTo(first, "", "{}", listOf(once), emptyMap(), false)
        assertTrue(first.contains("var t = 1"))
        assertTrue(runCatching { ExtensionScripts.documentStartTo(StringBuilder(), "", "{}", listOf(once), emptyMap(), false) }.isFailure)
        // A relative import is rewritten on the way through the sink as it is through the builder.
        val edits = RelativeImports.edits("""import("./chunk.js");""", group.extensionId, "dir/cs.js")
        val rewritten = ExtensionScripts.Group(group.extensionId, 0, listOf(RelativeImports.source("""import("./chunk.js");""", edits, true)), "world")
        val viaSink = StringBuilder().also { ExtensionScripts.documentStartTo(it, "", "{}", listOf(rewritten), emptyMap(), false) }.toString()
        assertTrue(viaSink.contains("""import("https://${group.extensionId}.ext.zenium.invalid/dir/chunk.js")"""))
    }

    @Test
    fun `the quoted CSS is bounded from above for both org json implementations, and the builder with it never grows`() {
        // Every class of character the two `JSONObject.quote`s treat differently or escape: the
        // backslash escapes, `/` (Android's always, the public one's after `<`), the controls, the
        // U+0080-U+009F and U+2000-U+20FF ranges the public one writes as `\uXXXX`, and plain text
        // (Latin-1, a wide character, a surrogate pair) that both write as is.
        val classes = listOf(
            "plain{color:red}", "quote\"mark", "back\\slash", "slash/es", "close</style>", "tab\tnl\nret\rff\u000Cbs\b",
            "\u0000nul", "\u001Fus", "\u007Fdel", "\u0080pad", "\u009Fapc", "\u00A0nbsp", "\u2000sp", "\u2028ls", "\u20FFend", "\u2100next",
            "héllo", "✓", "\uD83D\uDE00emoji", ""
        )
        for (text in classes) {
            assertTrue("'${text.replace("\n", "\\n")}': ${ExtensionScripts.quotedChars(text)} < ${JSONObject.quote(text).length}", ExtensionScripts.quotedChars(text) >= JSONObject.quote(text).length)
        }
        val everything = classes.joinToString("")
        assertTrue(ExtensionScripts.quotedChars(everything) >= JSONObject.quote(everything).length)
        // Text neither implementation escapes is counted exactly.
        assertEquals(JSONObject.quote("body{color:red}").length, ExtensionScripts.quotedChars("body{color:red}"))
        assertEquals(JSONObject.quote("a\"b\\c\td").length, ExtensionScripts.quotedChars("a\"b\\c\td"))
        val id = group.extensionId
        val css = linkedMapOf("$id/a.css" to everything, "$id/b\"c.css" to "x{}", "$id/plain.css" to "body{color:red}")
        val assembled = ExtensionScripts.documentStartSized("/*bootstrap*/", "{}", listOf(group), css, false)
        assertTrue(assembled.presized >= assembled.script.length)
        assertFalse(assembled.grown)
        // The over-count is the quoting bound's alone: the rest of the text is exact.
        val bound = css.entries.sumOf { (k, t) -> (ExtensionScripts.quotedChars(k) - JSONObject.quote(k).length) + (ExtensionScripts.quotedChars(t) - JSONObject.quote(t).length) }
        assertEquals(bound, assembled.presized - assembled.script.length)
        // What the script carries is still every entry, quoted by the implementation at hand.
        assertTrue(assembled.script.contains(JSONObject.quote("$id/a.css") + ":" + JSONObject.quote(everything)))
    }

    @Test
    fun `page bootstrap carries only the config, and the debug flag when asked`() {
        val script = ExtensionScripts.page("BOOT", """{"kind":"page","context":"popup"}""")
        assertEquals("""(function(){var __zenExtBoot={config:{"kind":"page","context":"popup"},debug:false,css:{},sources:{}};""" + "\nBOOT\n})();", script)
        val debug = ExtensionScripts.page("BOOT", """{"kind":"page","context":"background"}""", debug = true)
        assertEquals("""(function(){var __zenExtBoot={config:{"kind":"page","context":"background"},debug:true,css:{},sources:{}};""" + "\nBOOT\n})();", debug)
    }

    @Test
    fun `executeScript wrapper turns func plus args into a call and code into a body`() {
        val withFunc = ExtensionScripts.exec("tok", "abcdefghijklmnopabcdefghijklmnop", "js", JSONObject("""{"world":"MAIN"}"""), null, "(a, b) => a + b", "[1,2]")
        // A document without the bootstrap answers with Chrome's refusal, not a TypeError about the bridge.
        assertTrue(withFunc.startsWith("""(typeof __zenExtExec==="function"?__zenExtExec:function(){throw new Error("${ExtensionScripts.NO_ACCESS}")})("tok","abcdefghijklmnopabcdefghijklmnop","js",{"world":"MAIN"},function(window,self,globalThis,chrome,browser,__zenMirror,__zenCompletion){"""))
        assertTrue(ExtensionScripts.NO_ACCESS.startsWith("Cannot access contents of the page."))
        assertTrue(withFunc.contains("return ((a, b) => a + b).apply(null,[1,2]);"))
        assertFalse(withFunc.contains("__zenCompletion="))
        val withCode = ExtensionScripts.exec("tok", "abcdefghijklmnopabcdefghijklmnop", "js", JSONObject(), "document.title", null, null)
        assertTrue(withCode.contains("{\n__zenCompletion=document.title\n;return __zenCompletion\n})"))
        val css = ExtensionScripts.exec("tok", "abcdefghijklmnopabcdefghijklmnop", "css", JSONObject("""{"code":"a{}"}"""), null, null, null)
        assertTrue(css.contains(""""css",{"code":"a{}"},function"""))
    }

    @Test
    fun `a script injection's completion value is its last expression statement's, kept past the mirror, and a declaration's end or a func has none`() {
        val id = "abcdefghijklmnopabcdefghijklmnop"
        // Imageye's scraper shape: declarations, then an IIFE whose value is the script's.
        val scraper = "var seen = new Set();\nfunction collect() { return [...document.images].map(i => i.src) }\n(function() { collect().forEach(s => seen.add(s)); return [...seen] })()"
        val code = ExtensionScripts.exec("tok", id, "js", JSONObject(), scraper, null, null)
        val mirror = """try{__zenMirror("seen",seen)}catch(e){}try{__zenMirror("collect",collect)}catch(e){}"""
        assertTrue(code.contains("var seen = new Set();\nfunction collect() { return [...document.images].map(i => i.src) }\n__zenCompletion=(function() { collect().forEach(s => seen.add(s)); return [...seen] })()\n;" + mirror + "\n;return __zenCompletion\n})"))
        // In the with scope the assignment and the return sit inside the block, where the bare name resolves to the parameter.
        val scoped = ExtensionScripts.exec("tok", id, "js", JSONObject(), "document.title", null, null, scoped = true)
        assertTrue(scoped.contains(",__zenCompletion){with(window){\n__zenCompletion=document.title\n;return __zenCompletion\n}})"))
        // A script ending in a declaration answers undefined, as Chrome's does: nothing written, nothing returned.
        val declaration = ExtensionScripts.exec("tok", id, "js", JSONObject(), "foo();\nfunction f() {}", null, null)
        assertFalse(declaration.contains("__zenCompletion="))
        assertFalse(declaration.contains("return __zenCompletion"))
        assertTrue(declaration.contains("{\nfoo();\nfunction f() {}\n;" + """try{__zenMirror("f",f)}catch(e){}""" + "\n})"))
        // A func returns what it returns; a CSS injection has no completion.
        val func = ExtensionScripts.exec("tok", id, "js", JSONObject(), null, "async () => document.title", "[]")
        assertFalse(func.contains("__zenCompletion="))
        assertTrue(func.contains("{\nreturn (async () => document.title).apply(null,[]);\n})"))
        val css = ExtensionScripts.exec("tok", id, "css", JSONObject("""{"code":"a{}"}"""), null, null, null)
        assertFalse(css.contains("__zenCompletion="))
        // Streamed files: the last file's last expression statement, written in place, the same text as the composed form.
        val dir = createTempDir("ext-scripts-completion")
        try {
            val a = File(dir, "a.js").apply { writeText("var helper = 1") }
            val b = File(dir, "b.js").apply { writeText(scraper) }
            val streamed = ExtensionScripts.execScript("tok", id, "js", JSONObject(), null, listOf(a, b), null, null, null, false)
            assertEquals(ExtensionScripts.guarded(ExtensionScripts.exec("tok", id, "js", JSONObject(), "var helper = 1\n;\n" + scraper, null, null)), streamed)
            assertTrue(streamed.contains("\n;\nvar seen = new Set();\n"))
            assertTrue(streamed.contains("\n__zenCompletion=(function() {"))
            assertEquals(1, streamed.split("__zenCompletion=").size - 1)
            // A first file ending in an expression gives no value when the last file ends in a declaration.
            val streamedDeclaration = ExtensionScripts.execScript("tok", id, "js", JSONObject(), null, listOf(b, a), null, null, null, false)
            assertFalse(streamedDeclaration.contains("__zenCompletion="))
            assertFalse(streamedDeclaration.contains("return __zenCompletion"))
        } finally {
            dir.deleteRecursively()
        }
    }

    @Test
    fun `an injection into the extension's with scope is a with block, as a content script's group is`() {
        val id = "abcdefghijklmnopabcdefghijklmnop"
        // A Lit-built file: the write goes to globalThis, the read is the bare name; both must be the scope's.
        val lit = "globalThis.litPropertyMetadata = new WeakMap(); litPropertyMetadata.get(1)"
        val scoped = ExtensionScripts.exec("tok", id, "js", JSONObject(), lit, null, null, scoped = true)
        // The script's last statement is an expression, so its value is kept for the return (the completion value).
        val captured = "globalThis.litPropertyMetadata = new WeakMap(); __zenCompletion=litPropertyMetadata.get(1)\n;return __zenCompletion"
        assertTrue(scoped.contains("function(window,self,globalThis,chrome,browser,__zenMirror,__zenCompletion){with(window){\n$captured\n}})"))
        val func = ExtensionScripts.exec("tok", id, "js", JSONObject(), null, "() => litPropertyMetadata", "[]", scoped = true)
        assertTrue(func.contains("{with(window){\nreturn (() => litPropertyMetadata).apply(null,[]);\n}})"))
        // Unscoped (an isolated world, a MAIN-world injection): the bare function body.
        val plain = ExtensionScripts.exec("tok", id, "js", JSONObject("""{"world":"MAIN"}"""), lit, null, null)
        assertTrue(plain.contains("function(window,self,globalThis,chrome,browser,__zenMirror,__zenCompletion){\n$captured\n})"))
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
            assertTrue(both.contains("{\nfirst()\n;\n__zenCompletion=(function(){ return shared })()\n;return __zenCompletion\n})"))
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
        assertTrue(wrapped.startsWith("let chrome=globalThis.__zenExtModule?globalThis.__zenExtModule(\"$id\"):globalThis.chrome;import x from"))
        assertTrue(wrapped.endsWith("\n;globalThis.__zenExtModuleEnd&&globalThis.__zenExtModuleEnd(\"$id\");"))
        val lines = wrapped.lines()
        assertEquals(text.lines().size + 1, lines.size)
        assertEquals(text.lines().drop(1), lines.drop(1).dropLast(1))
        assertTrue(ExtensionScripts.isScriptPath("content.js"))
        assertTrue(ExtensionScripts.isScriptPath("chunks/a.MJS"))
        assertFalse(ExtensionScripts.isScriptPath("content.json"))
        assertFalse(ExtensionScripts.isScriptPath("styles.css"))
    }

    @Test
    fun aWebpackChunkGetsTheModuleScopedChromeAndSelfInItsPrologueAndAnyOtherModuleTheChromeAlone() {
        val id = "ajphlblkfpppdpkgokiejbjfohfohhmk"
        // Mote's sidebar.bundle.js: a polyfill line, a directive, then the registration.
        val mote = "\"undefined\"!=typeof browser&&(chrome=browser);\"use strict\";(self.webpackChunk_mote_plugin=self.webpackChunk_mote_plugin||[]).push([[6380],{83325(e,t,i){}}]);"
        assertTrue(ExtensionScripts.isWebpackChunk(mote))
        assertTrue(ExtensionScripts.isWebpackChunk("/*! chunk */\n(globalThis.webpackChunk=globalThis.webpackChunk||[]).push([[1],{}]);"))
        assertTrue(ExtensionScripts.isWebpackChunk("(window.webpackChunkapp = window.webpackChunkapp || []).push([[2], {}]);"))
        assertFalse(ExtensionScripts.isWebpackChunk("(self.webpackChunkA=self.webpackChunkB||[]).push([[1],{}]);"))
        assertFalse(ExtensionScripts.isWebpackChunk("import x from \"./x.js\";\nexport const y = x + 1;"))
        assertFalse(ExtensionScripts.isWebpackChunk("/".repeat(600) + "(self.webpackChunk=self.webpackChunk||[]).push([[1],{}]);"))

        val chunkOpen = ExtensionScripts.moduleChromeOpen(id, mote)
        val chrome = "let chrome=globalThis.__zenExtModule?globalThis.__zenExtModule(\"$id\"):globalThis.chrome"
        assertEquals("$chrome,self=globalThis.__zenExtModuleSelf?globalThis.__zenExtModuleSelf(\"$id\"):globalThis.self;", chunkOpen)
        // Buyhatke's Vite chunk: `chrome` read from its handlers later, none declared: the module-scoped `chrome`.
        val vite = "import{c as F,a6 as Be}from\"./utility_all2-CnXvRtz4.js\";const Ke=e=>F({type:\"GOODIE_SPIN_LIST\",goodieId:e}),de=async e=>{const a=await chrome.storage.local.get([e]);return a[e]};export{Ke as a,de as b};"
        assertEquals("$chrome;", ExtensionScripts.moduleChromeOpen(id, vite))
        assertEquals("$chrome;", ExtensionScripts.moduleChromeOpen(id, "export const a = 1;"))
        assertEquals("$chrome;", ExtensionScripts.moduleChromeOpen(id))
        // A module declaring `chrome` itself keeps the bare entry.
        val bare = "globalThis.__zenExtModule&&globalThis.__zenExtModule(\"$id\");"
        assertEquals(bare, ExtensionScripts.moduleChromeOpen(id, "const chrome = globalThis.chrome ?? browser; export { chrome };"))
        assertEquals(bare, ExtensionScripts.moduleChromeOpen(id, "import chrome from \"./polyfill.js\";"))
        // The wrap chooses by the text, on the first line either way; ASCII, as the file's prefix.
        val wrapped = ExtensionScripts.moduleChromeWrap(mote, id)
        assertTrue(wrapped.startsWith(chunkOpen + "\"undefined\"!=typeof browser"))
        assertEquals(mote.lines().size + 1, wrapped.lines().size)
        assertTrue(chunkOpen.all { it.code < 128 })
        assertTrue(ExtensionScripts.moduleChromeWrap(vite, id).startsWith("$chrome;import{c as F"))
    }

    @Test
    fun aModuleDeclaringChromeItselfIsToldByItsFirstMiBConservatively() {
        for (text in listOf(
            "let chrome = globalThis.chrome;",
            "var chrome=browser;",
            "class chrome {}",
            "function chrome(){}",
            "async function chrome(){}",
            "function* chrome(){}",
            "import chrome from \"./polyfill.js\";",
            "import * as chrome from \"./polyfill.js\";",
            "import{x as chrome}from\"./polyfill.js\";",
            "import{a,chrome}from\"./polyfill.js\";",
            "const{chrome}=globalThis;",
            "const {runtime, chrome = browser} = globalThis;",
            // Conservative: a match inside a string or a function body costs only the binding.
            "const s = \"let chrome\";",
            "function f(){const chrome=1;return chrome}"
        )) assertTrue(text, ExtensionScripts.declaresChrome(text))
        for (text in listOf(
            "chrome.runtime.getURL(\"x\");",
            "const c = window.chrome, d = globalThis.chrome;",
            "const o = {chrome: 1, chromeVersion: 2};",
            "let chromeX = 1, unchrome = 2;",
            "if (chrome === browser) {}",
            "import{c as F,a6 as Be}from\"./utility_all2-CnXvRtz4.js\";import\"./preload-helper-DwIMeJeZ.js\";"
        )) assertFalse(text, ExtensionScripts.declaresChrome(text))
        // Beyond the first MiB the host does not look: a declaration there is the documented limit.
        assertEquals(1 shl 20, ExtensionScripts.MODULE_SCAN_HEAD)
        assertFalse(ExtensionScripts.declaresChrome("x".repeat(ExtensionScripts.MODULE_SCAN_HEAD) + ";let chrome = 1;"))
        assertTrue(ExtensionScripts.declaresChrome("x".repeat(ExtensionScripts.MODULE_SCAN_HEAD - 16) + ";let chrome = 1;"))
    }

    @Test
    fun aPageModuleGraphIsToldByTheDocumentAndTheOriginHeaderNeverByTheReferer() {
        val origin = "https://becfinhbfclcgokjlobojlnldbfillpf.ext.zenium.invalid/"
        val page = "https://example.com/article"
        // The entry a content script `import()`ed, and its static dependency (whose Referer is the
        // entry, on the extension origin: the same answer, the Referer is not an input).
        assertTrue(ExtensionScripts.isPageModuleGraph("assets/content.js", false, page, origin, true, false))
        assertTrue(ExtensionScripts.isPageModuleGraph("assets/polyfill.js", false, page, origin, true, false))
        assertTrue(ExtensionScripts.isPageModuleGraph("chunks/6380.mjs", false, null, origin, true, false))
        // An extension page open in a tab (an options page) has its own `chrome`: served plain.
        assertFalse(ExtensionScripts.isPageModuleGraph("assets/options.js", false, origin + "options.html", origin, true, false))
        // The document itself, a classic `<script src>` (no `Origin`), a non-script, isolated worlds.
        assertFalse(ExtensionScripts.isPageModuleGraph("options.html", true, page, origin, true, false))
        assertFalse(ExtensionScripts.isPageModuleGraph("assets/content.js", false, page, origin, false, false))
        assertFalse(ExtensionScripts.isPageModuleGraph("assets/styles.css", false, page, origin, true, false))
        assertFalse(ExtensionScripts.isPageModuleGraph("assets/content.js", false, page, origin, true, true))
    }

    @Test
    fun aWebpackChunkOfAPageGraphIsServedAsTheStubThatRunsItInTheScopeOrImportsItPlain() {
        val id = "ajphlblkfpppdpkgokiejbjfohfohhmk"
        val url = "https://$id.ext.zenium.invalid/chunks/6380.js"
        val stub = ExtensionScripts.chunkStub(id, url)
        assertEquals(
            "if(!(globalThis.__zenExtChunk&&await globalThis.__zenExtChunk(\"$id\",\"$url\")))await import(\"$url?zenium-plain=1\");\n",
            stub
        )
        // A URL with a query of its own keeps it, the plain mark appended.
        assertTrue(ExtensionScripts.chunkStub(id, "$url?v=3").contains("await import(\"$url?v=3&zenium-plain=1\")"))
        assertEquals("zenium-plain", ExtensionScripts.PLAIN_QUERY)
        // ASCII, one line: the module the WebView evaluates as the chunk's own text.
        assertTrue(stub.all { it.code < 128 })
        assertEquals(1, stub.trimEnd().lines().size)
    }

    @Test
    fun theWorkerPageAloneIsServedCrossOriginIsolatedAsADocument() {
        // The MV3 worker's page, asked for as the background view's document: the pair that gives
        // the realm `SharedArrayBuffer` (compat round 24, R24-2 – Paperpile's worker).
        val worker = ExtensionScripts.backgroundDocumentHeaders(isolated = true, mainFrame = true)
        assertEquals(
            mapOf("Cross-Origin-Opener-Policy" to "same-origin", "Cross-Origin-Embedder-Policy" to "credentialless"),
            worker
        )
        // `credentialless`, never `require-corp`: the web's no-cors resources send no CORP.
        assertFalse(worker.values.any { it.contains("require-corp") })
        // The worker script asked for as the page's own sub-resource: none of it.
        assertEquals(emptyMap<String, String>(), ExtensionScripts.backgroundDocumentHeaders(isolated = true, mainFrame = false))
        // The MV2 generated page and every other document the core does not mark: served as before.
        assertEquals(emptyMap<String, String>(), ExtensionScripts.backgroundDocumentHeaders(isolated = false, mainFrame = true))
        assertEquals(emptyMap<String, String>(), ExtensionScripts.backgroundDocumentHeaders(isolated = false, mainFrame = false))
    }
}
