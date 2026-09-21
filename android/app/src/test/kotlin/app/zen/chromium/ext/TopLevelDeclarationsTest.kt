package app.zen.chromium.ext

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** The scan is a tokenizer over real content-script shapes; these pin what it takes and what it leaves. */
class TopLevelDeclarationsTest {
    private fun scan(text: String) = TopLevelDeclarations.scan(text)

    @Test
    fun `var, let, const, function, class and async function at the top level, in order, each once`() {
        val script = """
            var readAloudDoc = new function() { var self = this; this.getTexts = function() { return [] } }
            let count = 0, total
            const brapi = chrome, ${'$'} = window.jQuery;
            function getTexts() { function inner() {} return [] }
            async function load() { await 1 }
            class Player extends EventTarget { static x = 1 }
            var readAloudDoc = 2;
            function* gen() {}
            async function* agen() {}
        """.trimIndent()
        assertEquals(
            listOf("readAloudDoc", "count", "total", "brapi", "$", "getTexts", "load", "Player", "gen", "agen"),
            scan(script)
        )
    }

    @Test
    fun `a declaration inside a function, a class, an object literal or an IIFE is not the top level's`() {
        val script = """
            (function() { var hidden = 1; function alsoHidden() {} })();
            !function() { let none = 2 }();
            const outer = { var: 1, let: 2, function: 3, class: 4, method() { var inner = 5 } };
            for (var i = 0; i < 3; i++) { const loopConst = i }
            x = function namedExpression() {};
            new function Ctor() {}();
            obj.var = 1; obj.function = 2; obj?.let = 3
            typeof function probe() {}
            function f()
            {
              var inBody = 1
            }
            class C
            {
              m() { var inMethod = 1 }
            }
            const g = (a) =>
            {
              var inArrow = a
            }
            foo(() => { var inCallback = 1 }, function() { var inArgument = 2 })
        """.trimIndent()
        assertEquals(listOf("outer", "f", "C", "g"), scan(script))
    }

    @Test
    fun `a var or a function inside a statement block at the top level is the script's, a let, const or class is the block's`() {
        val script = """
            if (a) { var inIf = 1; let notInIf = 2; const norThis = 3; class NorThis {} }
            else { var inElse = 4 }
            try { var inTry = 5; function inTryFn() {} } catch (e) { var inCatch = 6 } finally { var inFinally = 7 }
            try { } catch { var inBareCatch = 8 }
            switch (x) { case 1: var inCase = 9; break; default: { var inDefault = 10 } }
            do { var inDo = 11 } while (0)
            while (y) { for (const k of z) { var inFor = 12 } }
            label: { var labeled = 13 }
            x = 1
            { var bare = 14 }
            with (o) { var inWith = 15 }
        """.trimIndent()
        assertEquals(
            listOf(
                "inIf", "inElse", "inTry", "inTryFn", "inCatch", "inFinally", "inBareCatch", "inCase", "inDefault", "inDo",
                "inFor", "labeled", "bare", "inWith"
            ),
            scan(script)
        )
    }

    @Test
    fun `strings, comments, template literals and regular expressions hide their braces and keywords`() {
        val script = """
            var s = "var notThis = 1; }", t = 'function nor(){} {', u = `class Nope {} ${'$'}{ { a: `${'$'}{ 1 }` } } var deep`;
            // var lineComment = 1
            /* function blockComment() {} { */ var afterComment = 2
            var re = /var notARegexDecl = 1[/]}/g, div = a / b / c, ternary = x ? /}{/ : y
            function after() {}
            const html = `<div class="x">${'$'}{items.map(i => `<b>${'$'}{i}</b>`).join('')}</div>`
            let last = 1
        """.trimIndent()
        assertEquals(listOf("s", "t", "u", "afterComment", "re", "div", "ternary", "after", "html", "last"), scan(script))
    }

    @Test
    fun `a statement's end by a line break is read as JavaScript reads it`() {
        val script = """
            var a = 1
            var b = a
            .toString()
            var c = b
            (function() {})
            var d = [1, 2]
            [0]
            var e = () => {
              return 1
            }
            var f = a ++
            var g
            function h() {}
        """.trimIndent()
        // `b` continues onto `.toString()`, `c` onto the call, `d` onto the index, `e` past its body: JavaScript's ASI.
        assertEquals(listOf("a", "b", "c", "d", "e", "f", "g", "h"), scan(script))
    }

    @Test
    fun `a destructuring pattern ends the reading, let as a name is not a declaration, keywords are not names`() {
        assertEquals(listOf("first"), scan("var first = 1, { a, b } = obj, notReached = 2"))
        assertEquals(emptyList<String>(), scan("let = 5; let\n= 6"))
        assertEquals(listOf("x"), scan("let x = 1; let [p, q] = pair"))
        assertEquals(emptyList<String>(), scan("var = 1; function () {}; class extends Base {}; function if() {}"))
        assertEquals(emptyList<String>(), scan("var \\u0061bc = 1"))
    }

    @Test
    fun `the read aloud content scripts declare what the next injection reads`() {
        val htmlDoc = "\nvar readAloudDoc = new function() {\n  var self = this;\n  this.ignoreTags = \"select, textarea\";\n  this.getTexts = async function(index) {\n    if (index == 0) { const math = await getMath(); try { return parse() } finally { if (math) math.hide() } }\n    else return null;\n  }\n  function parse() { return [] }\n}\n"
        assertEquals(listOf("readAloudDoc"), scan(htmlDoc))
        val kindle = "\nvar readAloudDoc = location.pathname.startsWith(\"/sample/\") ? new KindleSample() : new KindleDoc()\n\n\nfunction KindleDoc() {\n  this.x = 1\n}\n\nfunction KindleSample() {\n}\nfunction makeOcr() {\n  return /x/.test(y)\n}\n"
        assertEquals(listOf("readAloudDoc", "KindleDoc", "KindleSample", "makeOcr"), scan(kindle))
        val wwnorton = "\nvar rad = readAloudDoc\nvar prevBtn = document.getElementById(\"control_previous_page\")\nvar currentIndex = 0\n\nfunction waitFrameChange(oldUrl) {\n  return new Promise(function(fulfill) { setTimeout(fulfill, 100) })\n}\n"
        assertEquals(listOf("rad", "prevBtn", "currentIndex", "waitFrameChange"), scan(wwnorton))
    }

    @Test
    fun `the mirror tail is one guarded call per name, led by a statement break, nothing for none`() {
        assertEquals("", TopLevelDeclarations.mirror(emptyList()))
        assertEquals(
            "\n;try{__zenMirror(\"a\",a)}catch(e){}try{__zenMirror(\"b2\",b2)}catch(e){}",
            TopLevelDeclarations.mirror(listOf("a", "b2"))
        )
        assertEquals("__zenMirror", TopLevelDeclarations.MIRROR_PARAM)
    }

    @Test
    fun `the scan is bounded to a thousand names, a name of sixty-four characters, a file under a million characters`() {
        val many = (0 until 1200).joinToString("\n") { "var v$it = $it" }
        val names = scan(many)
        assertEquals(TopLevelDeclarations.MAX_NAMES, names.size)
        assertEquals("v0", names.first())
        assertEquals("v999", names.last())
        assertTrue(TopLevelDeclarations.mirror(names).length <= TopLevelDeclarations.MIRROR_ROOM)
        val long = "x".repeat(TopLevelDeclarations.MAX_NAME_CHARS)
        assertEquals(listOf(long), scan("var $long = 1, ${long}y = 2"))
        val big = StringBuilder(TopLevelDeclarations.MAX_SCAN_CHARS + 16).append("var first = 1;\n")
        while (big.length < TopLevelDeclarations.MAX_SCAN_CHARS) big.append("// padding to a million characters\n")
        assertEquals(emptyList<String>(), TopLevelDeclarations.scanSource(big))
        assertEquals(listOf("first"), TopLevelDeclarations.scanSource(big, 0, 15))
        assertEquals(listOf("first"), TopLevelDeclarations.scanSource("junk; var first = 1", 6))
    }

    @Test
    fun `an unterminated string, comment, template or regular expression does not stop the scan from ending`() {
        assertEquals(listOf("a", "b"), scan("var a = 1; var b = \"never closed"))
        assertEquals(listOf("a"), scan("var a = 1; /* never closed"))
        assertEquals(listOf("a", "t"), scan("var a = 1; var t = `never closed"))
        assertEquals(listOf("a", "c"), scan("var a = 1; x = /never closed on this line\nvar c = 2"))
        assertEquals(emptyList<String>(), scan(""))
        assertEquals(listOf("afterUnbalanced"), scan("}}}))]] var afterUnbalanced = 1"))
    }
}
