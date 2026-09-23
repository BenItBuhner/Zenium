package app.zen.chromium.ext

import app.zen.chromium.str
import org.json.JSONException
import org.json.JSONObject
import org.json.JSONTokener

/**
 * The action calls the flood guard ([BridgeForward]) reads into: which tab a call's details
 * address, and a `setIcon`'s pixels scaled on this side of the bridge.
 *
 * A `setIcon({imageData})` carries its pixels as JSON: `serializeIconDetails` (shim.ts) ships an
 * ImageData as `{width, height, data}` with `data` the pixel bytes one JSON member each
 * (`{"0":255,"1":128,…}`) – some 0.3 M chars for a 96 px icon – and the core, which draws the
 * manifest's icons and no per-tab variant yet, threw them away after parsing them. Here the
 * pixels are read once, straight into an ARGB array, scaled to the slot the chrome draws
 * ([IconScaler]) and handed on as a `path` of one data URL – the form the core resolves icons by
 * anyway – at a few thousand chars. The rest of the details (`tabId`) cross as they were. A
 * message that is not a call in the engine's shape (`{"t":"call","id":…,"ns":…,"method":…,
 * "args":[{…`) is nobody's action state: it goes as it is, under the guard's plain bounds.
 */
object ActionCalls {
    /** The slot the chrome draws action icons in: Chrome's "32" (a 16 dp icon at 2×). */
    const val ICON_SLOT = 32

    class Scaled(val size: Int, val dataUrl: String)

    /** ARGB pixels in, one PNG data URL of at most [ICON_SLOT] px a side out; null when they cannot be drawn. */
    fun interface IconScaler {
        fun scale(width: Int, height: Int, argb: IntArray): Scaled?
    }

    /** The pixels of one image as they were sent, ARGB. */
    class Pixels(val width: Int, val height: Int, val argb: IntArray)

    /**
     * The tab an action call's details address (`args[0].tabId`) as a key: the number's text, ""
     * for the global value (no `tabId`, or null), or null when the text is not a call in the
     * engine's shape or the tab id is not a number (the core answers that one with its error).
     */
    fun detailsTabId(message: JSONObject, text: String): String? {
        val args = message.optJSONArray("args")
        if (args != null) {
            // A small message: the envelope was built whole.
            if (args.length() == 0 || args.isNull(0)) return ""
            val details = args.optJSONObject(0) ?: return null
            return tabKey(details.opt("tabId"))
        }
        return try {
            val cursor = Cursor(text)
            if (!cursor.seekDetails()) return null
            var tabId: Any? = null
            cursor.members { key -> if (key == "tabId") tabId = cursor.scalar() else cursor.skipValue() }
            tabKey(tabId)
        } catch (e: JSONException) {
            null
        } catch (e: IndexOutOfBoundsException) {
            null
        }
    }

    private fun tabKey(tabId: Any?): String? = when (tabId) {
        null, JSONObject.NULL -> ""
        is Number -> tabId.toString()
        else -> null
    }

    /**
     * A `setIcon` call rebuilt with its `imageData` replaced by a `path` of one scaled data URL,
     * the other details as they were. When the pixels cannot be read or drawn the `imageData`
     * is left out instead (the core draws none of them today; the text must not cross as it
     * came). Null when the details carry no `imageData`, or the text is not a call in the
     * engine's shape: then the message goes as it is.
     */
    fun rewriteIcon(message: JSONObject, text: String, scaler: IconScaler): String? {
        val cursor = Cursor(text)
        val kept = ArrayList<String>()
        var pathRaw: String? = null
        var images: List<Pair<Int, IntRange>>? = null
        var chosen: Scaled? = null
        try {
            if (!cursor.seekDetails()) return null
            cursor.members { key ->
                when (key) {
                    "imageData" -> images = cursor.imageSpans()
                    "path" -> pathRaw = cursor.rawMember(key)
                    else -> kept += cursor.rawMember(key)
                }
            }
            val spans = images ?: return null
            val span = choose(spans)
            if (span != null) {
                val pixels = Cursor(text).apply { i = span.first }.image()
                if (pixels != null) chosen = scaler.scale(pixels.width, pixels.height, pixels.argb)
            }
        } catch (e: JSONException) {
            if (images == null) return null
        } catch (e: IndexOutOfBoundsException) {
            if (images == null) return null
        }
        val scaled = chosen
        if (scaled != null) {
            kept += "\"path\":{" + JSONObject.quote(scaled.size.toString()) + ":" + JSONObject.quote(scaled.dataUrl) + "}"
        } else {
            pathRaw?.let { kept += it }
        }
        return rebuild(message, kept)
    }

    /** Of the images sent, the one for the slot: the smallest at least [ICON_SLOT] a side, else the largest. */
    private fun choose(spans: List<Pair<Int, IntRange>>): IntRange? {
        if (spans.isEmpty()) return null
        val fitting = spans.filter { it.first >= ICON_SLOT }.minByOrNull { it.first }
        return (fitting ?: spans.maxByOrNull { it.first })?.second
    }

    private fun rebuild(message: JSONObject, details: List<String>): String {
        val id = message.opt("id")
        val out = StringBuilder(160 + details.sumOf { it.length + 1 })
        out.append("{\"t\":\"call\",\"id\":")
        when (id) {
            is Number -> out.append(id.toString())
            is String -> out.append(JSONObject.quote(id))
            else -> out.append("null")
        }
        out.append(",\"ns\":").append(JSONObject.quote(message.str("ns")))
            .append(",\"method\":").append(JSONObject.quote(message.str("method")))
            .append(",\"args\":[{")
        details.forEachIndexed { index, member ->
            if (index > 0) out.append(',')
            out.append(member)
        }
        return out.append("}],\"ep\":").append(JSONObject.quote(message.str("ep"))).append('}').toString()
    }

    /** A reader over a message's text that builds only what it is asked for. */
    private class Cursor(private val s: String) {
        var i = 0

        private fun peek(): Char = s[i]

        private fun space() {
            while (i < s.length) {
                val c = s[i]
                if (c != ' ' && c != '\t' && c != '\n' && c != '\r') return
                i++
            }
        }

        private fun expect(c: Char) {
            if (s[i++] != c) throw JSONException("'$c' at ${i - 1}")
        }

        /**
         * To the `{` of `args[0]` of a call in the engine's shape: true with the cursor on it,
         * false when the text is something else (`args` is the fifth member of a call).
         */
        fun seekDetails(): Boolean {
            space()
            expect('{')
            space()
            if (peek() == '}') return false
            var members = 0
            while (true) {
                space()
                if (peek() != '"') return false
                val key = string()
                space()
                expect(':')
                space()
                if (key == "args") {
                    if (peek() != '[') return false
                    i++
                    space()
                    return peek() == '{'
                }
                skipValue()
                space()
                when (s[i++]) {
                    ',' -> if (++members > 8) return false
                    else -> return false
                }
            }
        }

        /** At `{`: [member] at each value in turn, the value consumed by it. */
        fun members(member: (String) -> Unit) {
            space()
            expect('{')
            space()
            if (peek() == '}') {
                i++
                return
            }
            while (true) {
                space()
                if (peek() != '"') throw JSONException("a member name at $i")
                val key = string()
                space()
                expect(':')
                space()
                member(key)
                space()
                when (s[i++]) {
                    ',' -> continue
                    '}' -> return
                    else -> throw JSONException("',' or '}' at ${i - 1}")
                }
            }
        }

        /** At the opening quote: the decoded string, through the library's own escape handling. */
        fun string(): String {
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

        private fun literalEnd(): Int {
            var end = i
            while (end < s.length) {
                val c = s[end]
                if (c == ',' || c == '}' || c == ']' || c == ' ' || c == '\t' || c == '\n' || c == '\r') break
                end++
            }
            if (end == i) throw JSONException("a value at $i")
            return end
        }

        /** At a value: the decoded scalar, or [NESTED] past an object or array. */
        fun scalar(): Any? = when (peek()) {
            '"' -> string()
            '{', '[' -> {
                nested()
                NESTED
            }
            else -> {
                val end = literalEnd()
                val value = JSONTokener(s.substring(i, end)).nextValue()
                i = end
                value
            }
        }

        /** At a value: past it. */
        fun skipValue() {
            when (peek()) {
                '"' -> skipString()
                '{', '[' -> nested()
                else -> i = literalEnd()
            }
        }

        /** At a value: `"key":<the value's text as it was>`, for the rebuild. */
        fun rawMember(key: String): String {
            val start = i
            skipValue()
            return JSONObject.quote(key) + ":" + s.substring(start, i)
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

        /**
         * At the `{` of an `imageData` value: the images in it by slot with the span of each –
         * one image (`{width, height, data}`, slot from its width) or a dictionary of them by
         * pixel size (`{"16": …, "32": …}`). Nothing is decoded here; [image] decodes the chosen one.
         */
        fun imageSpans(): List<Pair<Int, IntRange>> {
            val out = ArrayList<Pair<Int, IntRange>>()
            val start = i
            var single = false
            var width = -1
            members { key ->
                when {
                    key == "width" || key == "height" || key == "data" -> {
                        single = true
                        val value = scalar()
                        if (key == "width" && value is Number) width = value.toInt()
                    }
                    else -> {
                        val slot = key.toIntOrNull()
                        val from = i
                        skipValue()
                        if (slot != null && peekBack(from) == '{') out += slot to (from until i)
                    }
                }
            }
            if (single) return listOf(width to (start until i))
            return out
        }

        private fun peekBack(at: Int): Char = s[at]

        /**
         * At the `{` of one image (`{width, height, data}`): its pixels, or null when its shape
         * is not an ImageData's. `data` is the RGBA bytes as `Uint8ClampedArray` stringifies
         * (`{"0":255,…}`) or as a plain array; each byte is read from its digits into the array.
         */
        fun image(): Pixels? {
            var width = -1
            var height = -1
            var bytes: IntArray? = null
            var dataAt = -1
            members { key ->
                when (key) {
                    "width" -> width = (scalar() as? Number)?.toInt() ?: -1
                    "height" -> height = (scalar() as? Number)?.toInt() ?: -1
                    "data" -> {
                        dataAt = i
                        skipValue()
                    }
                    else -> skipValue()
                }
            }
            if (width <= 0 || height <= 0 || width > MAX_SIDE || height > MAX_SIDE || dataAt < 0) return null
            val count = width * height * 4
            val end = i
            i = dataAt
            bytes = IntArray(count)
            readBytes(bytes, count)
            i = end
            val argb = IntArray(width * height)
            for (p in argb.indices) {
                val o = p * 4
                argb[p] = (bytes[o + 3] shl 24) or (bytes[o] shl 16) or (bytes[o + 1] shl 8) or bytes[o + 2]
            }
            return Pixels(width, height, argb)
        }

        /** At the `data` value: its bytes into [into] (indices beyond [count] are ignored, missing ones stay 0). */
        private fun readBytes(into: IntArray, count: Int) {
            space()
            when (peek()) {
                '{' -> members { key ->
                    val index = key.toIntOrNull()
                    val value = byte()
                    if (index != null && index in 0 until count) into[index] = value
                }
                '[' -> {
                    i++
                    space()
                    if (peek() == ']') {
                        i++
                        return
                    }
                    var index = 0
                    while (true) {
                        space()
                        val value = byte()
                        if (index < count) into[index] = value
                        index++
                        space()
                        when (s[i++]) {
                            ',' -> continue
                            ']' -> return
                            else -> throw JSONException("',' or ']' at ${i - 1}")
                        }
                    }
                }
                else -> throw JSONException("pixel bytes at $i")
            }
        }

        /** At a number: its value as a byte (clamped as `Uint8ClampedArray` clamps), digits read in place. */
        private fun byte(): Int {
            val end = literalEnd()
            var value = 0
            var simple = true
            for (k in i until end) {
                val c = s[k]
                if (c < '0' || c > '9') {
                    simple = false
                    break
                }
                if (value < 1000) value = value * 10 + (c - '0')
            }
            if (!simple) {
                val parsed = JSONTokener(s.substring(i, end)).nextValue() as? Number ?: throw JSONException("a byte at $i")
                value = Math.round(parsed.toDouble()).toInt()
            }
            i = end
            return value.coerceIn(0, 255)
        }

        companion object {
            val NESTED = Any()
            /** Chrome caps setIcon images well below this; anything larger is not an icon. */
            const val MAX_SIDE = 1024
        }
    }
}
