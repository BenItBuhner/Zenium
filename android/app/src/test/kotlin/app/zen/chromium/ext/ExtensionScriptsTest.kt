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
}
