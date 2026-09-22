package app.zen.chromium.ext

import org.json.JSONException
import org.json.JSONObject
import org.json.JSONTokener

/**
 * A bridge message's envelope: the top-level scalar members of its JSON object, with the nested
 * values (objects, arrays) skipped over rather than built.
 *
 * Every bridge message crosses the host's main thread, which reads a few top-level fields of it
 * (`token`, `ep`, `t`, and per type an id, a URL, a size) and hands the text on whole: to the
 * chrome's core as it came, or to a frame's reply proxy. Building the whole document as a
 * `JSONObject` costs an object per value and a copy per string; an extension's state broadcast
 * on a port at a few hundred KB several times a second (Trust Wallet's redux store to its two
 * pages) did that on every hop of every message until the heap was gone (compat round 9, row
 * 33). The scan reads the text once, decodes the scalars it keeps through `JSONTokener`, and
 * checks the structure of what it skips (string escapes, matching brackets); text that is not a
 * JSON object is refused as `JSONObject(text)` refuses it.
 */
object BridgeEnvelope {
    /**
     * Texts at least this long are read as envelopes on the bridge; shorter ones are built whole,
     * their nested values being cheap and some instrumentation reading them (the trace's `type=`).
     */
    const val BIG_MESSAGE = 8 * 1024

    /** The top-level scalar members of [text], or null when it is not a JSON object. */
    fun parse(text: String): JSONObject? = try {
        Scanner(text).envelope()
    } catch (e: JSONException) {
        null
    } catch (e: IndexOutOfBoundsException) {
        null
    }

    /**
     * [text] as the host reads a bridge message: whole below [BIG_MESSAGE], the envelope from
     * there. Null when it is not a JSON object.
     */
    fun read(text: String): JSONObject? =
        if (text.length >= BIG_MESSAGE) parse(text) else runCatching { JSONObject(text) }.getOrNull()

    private class Scanner(private val s: String) {
        private var i = 0

        fun envelope(): JSONObject {
            val out = JSONObject()
            space()
            expect('{')
            space()
            if (peek() == '}') i++
            else while (true) {
                space()
                if (peek() != '"') throw JSONException("a member name at $i")
                val key = string()
                space()
                expect(':')
                space()
                when (peek()) {
                    '"' -> out.put(key, string())
                    '{', '[' -> nested()
                    else -> out.put(key, literal())
                }
                space()
                when (next()) {
                    ',' -> continue
                    '}' -> break
                    else -> throw JSONException("',' or '}' at ${i - 1}")
                }
            }
            space()
            if (i != s.length) throw JSONException("text after the object at $i")
            return out
        }

        private fun peek(): Char = s[i]

        private fun next(): Char = s[i++]

        private fun expect(c: Char) {
            if (next() != c) throw JSONException("'$c' at ${i - 1}")
        }

        private fun space() {
            while (i < s.length) {
                val c = s[i]
                if (c != ' ' && c != '\t' && c != '\n' && c != '\r') return
                i++
            }
        }

        /** At the opening quote: the decoded string, through the library's own escape handling. */
        private fun string(): String {
            val start = i
            skipString()
            return JSONTokener(s.substring(start, i)).nextValue() as? String ?: throw JSONException("a string at $start")
        }

        private fun skipString() {
            i++
            while (i < s.length) {
                when (s[i]) {
                    '\\' -> i += 2
                    '"' -> {
                        i++
                        return
                    }
                    else -> i++
                }
            }
            throw JSONException("an unterminated string")
        }

        /** At the first character of a number, `true`, `false` or `null`. */
        private fun literal(): Any {
            val start = i
            while (i < s.length) {
                val c = s[i]
                if (c == ',' || c == '}' || c == ']' || c == ' ' || c == '\t' || c == '\n' || c == '\r') break
                i++
            }
            if (i == start) throw JSONException("a value at $start")
            val value = JSONTokener(s.substring(start, i)).nextValue()
            if (value is String || value is JSONObject) throw JSONException("a literal at $start")
            return value
        }

        /** At `{` or `[`: past the matching close, every bracket on the way matched to its kind. */
        private fun nested() {
            val closers = StringBuilder()
            while (i < s.length) {
                when (val c = s[i]) {
                    '"' -> {
                        skipString()
                        continue
                    }
                    '{' -> closers.append('}')
                    '[' -> closers.append(']')
                    '}', ']' -> {
                        val last = closers.length - 1
                        if (last < 0 || closers[last] != c) throw JSONException("'$c' at $i")
                        closers.setLength(last)
                        if (last == 0) {
                            i++
                            return
                        }
                    }
                }
                i++
            }
            throw JSONException("an unterminated value")
        }
    }
}
