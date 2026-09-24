package app.zen.chromium

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

class BareWindowBracketTest {
    @get:Rule
    val tmp = TemporaryFolder()

    @Test
    fun classicBracketKeepsLineNumbersAndClosesTheBlock() {
        val text = "var a = 1;\nif (typeof window === 'undefined') a = 2; // tail comment"
        val out = BareWindowBracket.bracketClassic(text, "background.js")
        val prefix = out.substring(0, out.length - text.length - BareWindowBracket.CLASSIC_SUFFIX.length)
        assertTrue(prefix.startsWith(BareWindowBracket.MARKER + "with("))
        assertFalse("the prefix stays on the first line", prefix.contains('\n'))
        assertTrue(prefix.contains("try{self.__zenBareWindow={mode:'with',file:'background.js',strict:false,typeofWindow:typeof window,inSelf:('window' in self),inGlobalThis:('window' in globalThis),selfWindow:typeof self.window,at:Date.now()}}"))
        assertTrue(prefix.endsWith("catch(e){self.__zenBareWindow={mode:'with',file:'background.js',strict:false,error:String(e),at:Date.now()}};"))
        assertTrue(out.endsWith(text + "\n}\n"))
        assertEquals(text.count { it == '\n' } + 2, out.count { it == '\n' })
        assertTrue(prefix.contains("has:function(t,k){return k==='window'}"))
        assertTrue(prefix.contains("get:function(t,k){return k==='window'?s.window:undefined}"))
    }

    @Test
    fun strictPrologueIsRecordedInTheProbe() {
        assertTrue(BareWindowBracket.bracketClassic("'use strict';\nfoo()", "a.js").contains("strict:true"))
        assertTrue(BareWindowBracket.bracketClassic("// header\n/* more */ \"use strict\"\nfoo()", "a.js").contains("strict:true"))
        assertTrue(BareWindowBracket.bracketClassic("(function(){'use strict';})()", "a.js").contains("strict:false"))
    }

    @Test
    fun strictPrologueScanIsLinearAndExact() {
        assertTrue(BareWindowBracket.hasStrictPrologue("\uFEFF\n\t'use strict'"))
        assertTrue(BareWindowBracket.hasStrictPrologue("/*! license */\n// note\n\"use strict\";(()=>{})()"))
        assertFalse("a directive in an inner function is not the script's", BareWindowBracket.hasStrictPrologue("(()=>{\"use strict\";x()})()"))
        assertFalse("the quotes must match", BareWindowBracket.hasStrictPrologue("'use strict\";"))
        assertFalse("a different string first", BareWindowBracket.hasStrictPrologue("'use client';'use strict';"))
        assertFalse(BareWindowBracket.hasStrictPrologue("/* unterminated"))
        assertFalse(BareWindowBracket.hasStrictPrologue(""))
        // A bundle of many comment closes after a licence header: the pathological input for the regex form.
        val bundle = StringBuilder("/*! For license information please see x.LICENSE.txt */\n!function(){")
        repeat(20_000) { bundle.append("/* c */a();") }
        val started = System.nanoTime()
        assertFalse(BareWindowBracket.hasStrictPrologue(bundle))
        assertFalse(BareWindowBracket.scanText(bundle).strict)
        assertTrue("the scan finished in well under a second", System.nanoTime() - started < 1_000_000_000L)
    }

    @Test
    fun importedFilesRecordIntoTheFilesList() {
        val out = BareWindowBracket.bracketClassic("x()", "lib/b.js", main = false)
        assertTrue(out.contains("self.__zenBareWindowFiles=(self.__zenBareWindowFiles||[]).concat([{mode:'with',file:'lib/b.js'"))
        assertFalse(out.contains("self.__zenBareWindow="))
    }

    @Test
    fun modulePrefixIsOneLine() {
        val text = "import { a } from './a.js'\nexport const b = typeof window\n"
        val out = BareWindowBracket.bracketModule(text, "sw.js")
        assertTrue(out.startsWith(BareWindowBracket.MARKER + "var window;try{self.__zenBareWindow={mode:'module',file:'sw.js',strict:false,"))
        assertTrue(out.endsWith(text))
        assertEquals(text.count { it == '\n' }, out.count { it == '\n' })
    }

    @Test
    fun resolveFollowsThePackage() {
        assertEquals("dir/a.js", BareWindowBracket.resolve("dir/b.js", "./a.js"))
        assertEquals("a.js", BareWindowBracket.resolve("dir/b.js", "../a.js"))
        assertEquals("lib/x.js", BareWindowBracket.resolve("dir/b.js", "/lib/x.js"))
        assertEquals("dir/a.js", BareWindowBracket.resolve("dir/b.js", "./a.js?v=2"))
        assertEquals("background.js", BareWindowBracket.resolve("", "/./background.js"))
        assertNull(BareWindowBracket.resolve("dir/b.js", "https://cdn.example/x.js"))
        assertNull("a bare module specifier is not a package file", BareWindowBracket.resolve("dir/b.js", "lodash", url = false))
        assertEquals("an importScripts URL without a prefix is relative to the importer", "dir/lib/x.js", BareWindowBracket.resolve("dir/b.js", "lib/x.js"))
        assertEquals("js/w.js", BareWindowBracket.resolve("dir/b.js", "chrome-extension://abcdefghijklmnopabcdefghijklmnop/js/w.js"))
        assertNull(BareWindowBracket.resolve("b.js", "../../x.js"))
    }

    @Test
    fun importScriptsArgumentsAreRead() {
        val text = "importScripts('a.js', \"lib/b.js\");\nself.importScripts(`t.js`);\nimportScripts(chrome.runtime.getURL('c.js'))"
        assertEquals(listOf("a.js", "lib/b.js", "c.js"), BareWindowBracket.importScriptsOf(text))
    }

    @Test
    fun staticImportsAreReadInEveryShape() {
        val text = """
            import a from './a.js';
            import { b as c } from "../b.js";
            import * as d from './d.js'
            import './side.js'
            export * from './e.js';
            export { f } from './f.js';
            export * as g from './g.js';
            const h = await import('./dynamic.js');
            import{i}from"./min.js";import j from"./min2.js"
        """.trimIndent()
        assertEquals(
            listOf("./a.js", "../b.js", "./d.js", "./side.js", "./e.js", "./f.js", "./g.js", "./min.js", "./min2.js"),
            BareWindowBracket.staticImportsOf(text)
        )
        assertEquals(1, BareWindowBracket.scanText(text).dynamicImports)
    }

    @Test
    fun scanTextCountsWhatTheBracketCaresAbout() {
        val scan = BareWindowBracket.scanText("'use strict';\nlet x = window.a; const y = self.window; class Z {}\nif (typeof window !== 'undefined') {}\nlet window = self;")
        assertTrue(scan.strict)
        assertEquals(3, scan.bareReads)
        assertTrue(scan.declaresWindow)
        assertEquals("let x and let window start a line; const and class are mid-line", 2, scan.lexicalAtLineStart)
        assertFalse(scan.already)
        assertTrue(BareWindowBracket.scanText(BareWindowBracket.MARKER + "with(x){}").already)
    }

    @Test
    fun scanFileAgreesWithScanTextAcrossChunks() {
        val line = "if (typeof window === 'undefined') { self.x = 1 } else { window.y = 2 }\n"
        val sb = StringBuilder()
        while (sb.length < BareWindowBracket.CHUNK * 2 + 777) sb.append(line)
        sb.append("importScripts('tail.js')\n")
        val file = tmp.newFile("big.js")
        file.writeText(sb.toString())
        val whole = BareWindowBracket.scanText(sb)
        val chunked = BareWindowBracket.scanFile(file)
        assertEquals(whole.bareReads, chunked.bareReads)
        assertEquals(whole.lexicalAtLineStart, chunked.lexicalAtLineStart)
        assertEquals(whole.importScripts, chunked.importScripts)
        assertEquals(whole.strict, chunked.strict)
    }

    @Test
    fun classicPlanBracketsTheWorkerAndTheImportsThatReadWindow() {
        val dir = tmp.newFolder("ext")
        File(dir, "sw.js").writeText("importScripts('lib/a.js', '/b.js', 'missing.js');\nconsole.log(typeof window)")
        File(dir, "lib").mkdirs()
        File(dir, "lib/a.js").writeText("'use strict';\nconst A = typeof window === 'undefined';\nimportScripts('./c.js')")
        File(dir, "lib/c.js").writeText("var C = 1; // window in a comment counts as a read: the scan is a regex")
        File(dir, "b.js").writeText("var B = self.location")
        val plan = BareWindowBracket.plan(dir, "/sw.js", module = false)
        assertEquals(listOf("sw.js", "lib/a.js", "b.js", "missing.js", "lib/c.js"), plan.map { it.file })
        val byFile = plan.associateBy { it.file }
        assertTrue(byFile.getValue("sw.js").main)
        assertTrue(byFile.getValue("sw.js").apply)
        assertTrue(byFile.getValue("lib/a.js").apply)
        assertTrue(byFile.getValue("lib/a.js").strict)
        assertEquals(1, byFile.getValue("lib/a.js").lexicalAtLineStart)
        assertTrue(byFile.getValue("lib/c.js").apply)
        assertFalse(byFile.getValue("b.js").apply)
        assertFalse(byFile.getValue("missing.js").exists)
        assertEquals(listOf("lib/a.js", "b.js", "missing.js"), byFile.getValue("sw.js").imports)
    }

    @Test
    fun modulePlanFollowsStaticImportsAndSkipsDeclaredWindow() {
        val dir = tmp.newFolder("mod")
        File(dir, "sw.js").writeText("import './a.js';\nimport { b } from './lib/b.js';\nconsole.log(typeof window)")
        File(dir, "a.js").writeText("let window = self;\nexport const a = window.x")
        File(dir, "lib").mkdirs()
        File(dir, "lib/b.js").writeText("export * from '../c.js';\nimport './d.js';\nexport const b = typeof window")
        File(dir, "c.js").writeText("export const c = 1")
        // Calendly's shape: `const window` inside a function, indented; the module's gate at its top level.
        File(dir, "lib/d.js").writeText("async function f() {\n    const window = await chrome.windows.getCurrent();\n    return window.width;\n}\nexport const d = typeof window === 'undefined';")
        val plan = BareWindowBracket.plan(dir, "sw.js", module = true)
        assertEquals(listOf("sw.js", "a.js", "lib/b.js", "c.js", "lib/d.js"), plan.map { it.file })
        val byFile = plan.associateBy { it.file }
        assertTrue(byFile.getValue("sw.js").apply)
        assertFalse("a module that declares window at its top level gets no prologue", byFile.getValue("a.js").apply)
        assertTrue(byFile.getValue("a.js").declaresWindow)
        assertTrue(byFile.getValue("lib/b.js").apply)
        assertFalse("no bare read, no prologue", byFile.getValue("c.js").apply)
        assertFalse("an indented declaration is a function's own", byFile.getValue("lib/d.js").declaresWindow)
        assertTrue(byFile.getValue("lib/d.js").apply)
        assertTrue(plan.all { it.mode == BareWindowBracket.Mode.MODULE })
    }

    @Test
    fun applyAndRestoreRoundTrip() {
        val dir = tmp.newFolder("rt")
        val backup = tmp.newFolder("rt-backup")
        val original = "\uFEFF'use strict';\nvar w = typeof window;\n// no newline at the end"
        val bytes = original.toByteArray()
        File(dir, "sw.js").writeBytes(bytes)
        File(dir, "lib").mkdirs()
        File(dir, "lib/a.js").writeText("var a = window")
        val plan = BareWindowBracket.plan(dir, "sw.js", module = false)
        val outcomes = BareWindowBracket.apply(dir, plan, backup)
        assertTrue(outcomes.single().second.startsWith("rewritten: "))
        val rewritten = File(dir, "sw.js").readText()
        assertTrue(rewritten.startsWith(BareWindowBracket.MARKER + "with("))
        assertTrue(rewritten.contains("strict:true"))
        assertTrue(rewritten.endsWith(original + "\n}\n"))
        assertEquals("a second apply leaves a bracketed file alone", "already bracketed", BareWindowBracket.apply(dir, BareWindowBracket.plan(dir, "sw.js", module = false), backup).single().second)
        assertArrayEquals(bytes, File(backup, "sw.js").readBytes())
        val (restored, failed) = BareWindowBracket.restore(dir, backup)
        assertEquals(listOf("sw.js"), restored)
        assertTrue(failed.isEmpty())
        assertArrayEquals(bytes, File(dir, "sw.js").readBytes())
        assertEquals("var a = window", File(dir, "lib/a.js").readText())
    }
}
