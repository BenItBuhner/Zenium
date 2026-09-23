package app.zen.chromium

import kotlin.random.Random
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/**
 * `StringBuilder.appendJsQuoted` is the one-pass quoting the chrome's `ext.message` host events
 * cross by (`ChromeWebView.hostEventJson`), and its only caller runs in a WebView; these pin it
 * on the JVM against `JSONObject.quote`.
 *
 * The reference is the test classpath's `org.json:json`, which stands in for Android's (the
 * build file). The two `quote`s agree on everything in this corpus once `\/` is read as `/`:
 * Android's escapes every slash, the library's only one after `<`, and the helper none (a JS
 * string literal needs no slash escaped). Where they part – the library escapes U+0080..U+009F
 * and U+2000..U+20FF as `\uXXXX`, Android's passes them – the corpus keeps only U+2028 and
 * U+2029, the two the helper escapes itself because a JS source line ends at them.
 */
class JsonTest {
    private val corpus: List<Pair<String, String>> = listOf(
        "a plain ASCII line" to "The quick brown fox jumps over the lazy dog 0123456789 !#\$%&'()*+,-.:;=?@[]^_`{|}~",
        "quotes and backslashes" to "say \"hi\", then C:\\path\\to\\file, then \\\" and \\\\ and \"\\\" at the end \\",
        "every control character" to String(CharArray(0x20) { it.toChar() }) + " and DEL \u007F",
        "the line and paragraph separators" to "line\u2028paragraph\u2029end",
        "a surrogate pair" to "grin \uD83D\uDE00, a modified one \uD83E\uDDD1\uD83C\uDFFD, then \u00E9, \u00A0 and \uFFFD",
        "a closing script tag and slashes" to "</script><script>alert(1)</script> a/b //c <\\/d> \\/ http://h/p",
        "an empty string" to "",
        "the 300 KB payload" to bigPayload()
    )

    @Test
    fun `the literal body is JSONObject-quote's, without the outer quotes and the slash escapes`() {
        for ((label, text) in corpus) {
            val body = StringBuilder().appendJsQuoted(text).toString()
            assertEquals(label, referenceBody(text), body)
        }
    }

    @Test
    fun `U+2028 and U+2029 leave as escapes, a surrogate pair and a slash as they are`() {
        assertEquals("line\\u2028paragraph\\u2029end", StringBuilder().appendJsQuoted("line\u2028paragraph\u2029end").toString())
        val emoji = StringBuilder().appendJsQuoted("grin \uD83D\uDE00 </script> a/b").toString()
        assertEquals("grin \uD83D\uDE00 </script> a/b", emoji)
        for ((label, text) in corpus) {
            val body = StringBuilder().appendJsQuoted(text).toString()
            assertFalse("$label: a raw line separator", body.any { it == '\u2028' || it == '\u2029' || it == '\n' || it == '\r' })
            assertFalse("$label: a raw control character", body.any { it < ' ' })
            assertEquals("$label: a raw quote", 0, rawQuotes(body))
        }
    }

    @Test
    fun `every control character is the short escape or a lower-case u-escape`() {
        val body = StringBuilder().appendJsQuoted(String(CharArray(0x20) { it.toChar() })).toString()
        val expected = StringBuilder()
        for (c in 0 until 0x20) {
            expected.append(
                when (c.toChar()) {
                    '\b' -> "\\b"
                    '\t' -> "\\t"
                    '\n' -> "\\n"
                    '\u000C' -> "\\f"
                    '\r' -> "\\r"
                    else -> "\\u%04x".format(c)
                }
            )
        }
        assertEquals(expected.toString(), body)
    }

    @Test
    fun `the helper appends after what the builder holds and returns it for chaining`() {
        val builder = StringBuilder("head:")
        assertTrue(builder === builder.appendJsQuoted("a\"b"))
        assertEquals("head:a\\\"b", builder.toString())
        assertEquals("", StringBuilder().appendJsQuoted("").toString())
        val fromBuilder = StringBuilder().appendJsQuoted(StringBuilder("x\ty")).toString()
        assertEquals("x\\ty", fromBuilder)
    }

    @Test
    fun `hostEventJson's script decodes back to the name and the text`() {
        for ((label, text) in corpus) {
            val script = ChromeWebView.hostEventScript("ext.message", text)
            val prefix = "window.__zenHost&&__zenHost.hostEvent(\"ext.message\",\""
            assertTrue(label, script.startsWith(prefix))
            assertTrue(label, script.endsWith("\")"))
            val body = script.substring(prefix.length, script.length - 2)
            assertEquals("$label: the reference unescaper", text, unescapeJs(body))
            assertEquals("$label: org.json's tokener", text, JSONArray("[\"$body\"]").getString(0))
            assertFalse("$label: the script is one source line", script.any { it == '\n' || it == '\r' || it == '\u2028' || it == '\u2029' })
        }
        val named = ChromeWebView.hostEventScript("ev\"il\\name", "x")
        assertEquals("window.__zenHost&&__zenHost.hostEvent(" + JSONObject.quote("ev\"il\\name") + ",\"x\")", named)
    }

    /** `JSONObject.quote(text)` without its outer quotes, every `\/` read as `/` (escape-aware). */
    private fun referenceBody(text: String): String {
        val quoted = JSONObject.quote(text)
        assertTrue(quoted.length >= 2 && quoted.first() == '"' && quoted.last() == '"')
        val inner = quoted.substring(1, quoted.length - 1)
        val out = StringBuilder(inner.length)
        var i = 0
        while (i < inner.length) {
            val c = inner[i]
            if (c == '\\') {
                val d = inner[i + 1]
                if (d == '/') out.append('/') else out.append(c).append(d)
                i += 2
            } else {
                out.append(c)
                i++
            }
        }
        return out.toString()
    }

    /** A JS string literal's body back to its text; fails on an escape the literal grammar has not. */
    private fun unescapeJs(body: String): String {
        val out = StringBuilder(body.length)
        var i = 0
        while (i < body.length) {
            val c = body[i]
            if (c != '\\') {
                out.append(c)
                i++
                continue
            }
            when (val d = body[i + 1]) {
                '"' -> out.append('"')
                '\\' -> out.append('\\')
                '/' -> out.append('/')
                'n' -> out.append('\n')
                'r' -> out.append('\r')
                't' -> out.append('\t')
                'b' -> out.append('\b')
                'f' -> out.append('\u000C')
                'u' -> {
                    out.append(body.substring(i + 2, i + 6).toInt(16).toChar())
                    i += 6
                    continue
                }
                else -> fail("an escape the reference does not know: \\$d at $i")
            }
            i += 2
        }
        return out.toString()
    }

    /** Quotes in [body] that no backslash escapes (an even run of backslashes before one). */
    private fun rawQuotes(body: String): Int {
        var count = 0
        var backslashes = 0
        for (c in body) {
            when (c) {
                '\\' -> backslashes++
                '"' -> {
                    if (backslashes % 2 == 0) count++
                    backslashes = 0
                }
                else -> backslashes = 0
            }
        }
        return count
    }

    /**
     * A bridge message's shape at the size that filled the heap: a JSON document of 300 K
     * characters and more, its keys and values quoted, the values carrying every kind of
     * character the corpus has – so the text itself is full of `\"`, `\\`, `\n` and `\u2028`
     * escapes, quotes by the thousand and a few surrogate pairs.
     */
    private fun bigPayload(): String {
        val random = Random(0x11b)
        val alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 -_.:/<>"
        val data = JSONObject()
        var i = 0
        var atLeast = 0 // the document's length without the escapes org.json adds
        while (atLeast < 300_000) {
            val value = StringBuilder()
            repeat(40) { value.append(alphabet[random.nextInt(alphabet.length)]) }
            when (i % 7) {
                0 -> value.append(" \"quoted\" ")
                1 -> value.append(" back\\slash ")
                2 -> value.append("\n\t")
                3 -> value.append("\u2028")
                4 -> value.append(" \uD83D\uDE00 ")
                5 -> value.append(" </script> ")
                else -> value.append('/')
            }
            val key = "k$i"
            data.put(key, value.toString())
            atLeast += key.length + value.length + 6 // the quotes, the colon, the comma
            i++
        }
        val text = JSONObject().put("t", "portMsg").put("portId", "p-1").put("data", data).toString()
        assertTrue(text.length >= 300_000)
        assertTrue(text.count { it == '"' } > 4_000)
        return text
    }
}
