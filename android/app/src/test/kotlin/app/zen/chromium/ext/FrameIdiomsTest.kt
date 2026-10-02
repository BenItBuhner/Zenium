package app.zen.chromium.ext

import org.junit.Assert.assertEquals
import org.junit.Test

/** The frame-tree reading of a content script's text, and the literal's name it decides. */
class FrameIdiomsTest {
    /** Save Page WE's `content-frame.js` (v33.9): the walk from a DOM-handed window against `window.top`. */
    private val savePageWalk = """
        case "requestFrames":
            identifyFrames(0,window,document.documentElement);
            key = "";
            win = document.defaultView;
            parentwin = win.parent;
            while (win != window.top)
            {
                for (i = 0; i < parentwin.frames.length; i++)
                {
                    if (parentwin.frames[i] == win) break;
                }
                key = "-" + i + key;
                win = parentwin;
                parentwin = parentwin.parent;
            }
    """.trimIndent()

    @Test
    fun `the idiom in each of its spellings names the literal for the scope`() {
        for (text in listOf(
            "if (window === window.top) init();",
            "if (window.top !== window) return;",
            "var isTop = self == top;",
            "if (top != self) { /* framed */ }",
            "var t = window; if (t === t.parent) run();",
            "if (globalThis===globalThis.top) go()",
            "const framed = window.self !== window.top;",
            "if(window.top!=window.self){x()}",
            "e&&e.parent===e.window&&f()",
        )) {
            assertEquals(text, FrameIdioms.IDIOM, FrameIdioms.scan(text) and FrameIdioms.IDIOM)
            assertEquals(text, FrameIdioms.SCOPE, FrameIdioms.nameOf(FrameIdioms.scan(text)))
        }
    }

    @Test
    fun `the chain walk against window top without the idiom names the literal for the page`() {
        val flags = FrameIdioms.scan(savePageWalk)
        assertEquals(FrameIdioms.WALK or FrameIdioms.COMPARE, flags)
        assertEquals(FrameIdioms.PAGE, FrameIdioms.nameOf(flags))
        // The pair in one file of the group with the idiom in another: the idiom's name wins.
        assertEquals(FrameIdioms.SCOPE, FrameIdioms.nameOf(flags or FrameIdioms.IDIOM))
    }

    @Test
    fun `the chain assignment alone or the comparison alone decides nothing`() {
        // A framework's tree walk (Vue's effect scopes, stylis, React's fibers): `.parent` chains everywhere, no `window.top`.
        for (text in listOf(
            "e.prototype.off=function(){St=this.parent}",
            "for(var n=e.parent;n&&\"rule\"!==n.type;)if(!(n=n.parent))return;",
            "let s=o;(o=o.parent)||i(r),delete s.parent",
            "x = y.parent.child",
            "x = y.parent()",
        )) {
            assertEquals(text, 0, FrameIdioms.scan(text) and (FrameIdioms.IDIOM or FrameIdioms.COMPARE))
            assertEquals(text, "", FrameIdioms.nameOf(FrameIdioms.scan(text)))
        }
        // A frame-messaging check (`e.source !== window.top`): the scope's reading is what it needs, no walk.
        for (text in listOf(
            "window.addEventListener('message', e => { if (e.source !== window.top) return; })",
            "if (window.location !== window.parent.location) return null;",
            "if (frame === window.parent.frames[0]) go()",
        )) {
            assertEquals(text, 0, FrameIdioms.scan(text) and (FrameIdioms.IDIOM or FrameIdioms.WALK))
            assertEquals(text, "", FrameIdioms.nameOf(FrameIdioms.scan(text)))
        }
        // The pair flags only when both are there; `a == b.parent` is a comparison, not an assignment.
        assertEquals(0, FrameIdioms.scan("if (a == b.parent && c != window.top) go()") and FrameIdioms.WALK)
        assertEquals("", FrameIdioms.nameOf(FrameIdioms.scan("if (a == b.parent && c != window.top) go()")))
    }

    @Test
    fun `top and parent inside longer words, and text without them, read as nothing`() {
        for (text in listOf(
            "var desktop = stop === window.desktop; node.parentNode === window.parentNode;",
            "const r = a.top === b.top && a.left === b.left;",
            "",
            "function f(){}",
        )) {
            assertEquals(text, 0, FrameIdioms.scan(text))
        }
    }

    @Test
    fun `a range of a builder is scanned as a text is, and a hit at the window's edge is still seen`() {
        val sb = StringBuilder("if (window === window.top) a();\n;\n").append(savePageWalk).append("\n;\n")
        val idiomEnd = "if (window === window.top) a();".length
        // `window === window.top` is an idiom and, read alone, a comparison against `window.top` too.
        assertEquals(FrameIdioms.IDIOM or FrameIdioms.COMPARE, FrameIdioms.scan(sb, 0, idiomEnd))
        assertEquals(FrameIdioms.WALK or FrameIdioms.COMPARE, FrameIdioms.scan(sb, idiomEnd, sb.length))
        assertEquals(FrameIdioms.IDIOM or FrameIdioms.WALK or FrameIdioms.COMPARE, FrameIdioms.scan(sb))
        // The patterns run on a window around each `top` / `parent` word: a long identifier before the
        // operator and a comparison far from any other hit are both inside it.
        val longName = "a".repeat(60)
        assertEquals(FrameIdioms.IDIOM, FrameIdioms.scan("if ($longName === $longName.top) x()"))
        val padded = "x".repeat(500) + "\n" + savePageWalk + "\n" + "y".repeat(500)
        assertEquals(FrameIdioms.PAGE, FrameIdioms.nameOf(FrameIdioms.scan(padded)))
    }

    @Test
    fun `the names are the bootstrap's, and the longer bounds a builder's room`() {
        assertEquals("__zenScopeFrames", FrameIdioms.SCOPE)
        assertEquals("__zenPageFrames", FrameIdioms.PAGE)
        assertEquals(FrameIdioms.SCOPE.length, FrameIdioms.MAX_NAME_LENGTH)
    }
}
