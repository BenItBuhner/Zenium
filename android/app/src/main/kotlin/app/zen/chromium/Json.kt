package app.zen.chromium

import org.json.JSONArray
import org.json.JSONObject

/** Small helpers around org.json so bridge code stays readable. */
fun json(vararg pairs: Pair<String, Any?>): JSONObject {
    val o = JSONObject()
    for ((k, v) in pairs) o.put(k, v ?: JSONObject.NULL)
    return o
}

fun JSONObject.str(key: String, default: String = ""): String =
    if (has(key) && !isNull(key)) optString(key, default) else default

fun JSONObject.strOrNull(key: String): String? =
    if (has(key) && !isNull(key)) optString(key) else null

fun JSONObject.num(key: String, default: Double = 0.0): Double =
    if (has(key) && !isNull(key)) optDouble(key, default) else default

fun JSONObject.bool(key: String, default: Boolean = false): Boolean =
    if (has(key) && !isNull(key)) optBoolean(key, default) else default

fun JSONObject.obj(key: String): JSONObject = optJSONObject(key) ?: JSONObject()

fun JSONObject.arr(key: String): JSONArray = optJSONArray(key) ?: JSONArray()

/**
 * Appends [text] as the body of a double-quoted JavaScript string literal (the quotes are the
 * caller's), escaping what `JSONObject.quote` escapes – the quote, the backslash, the control
 * characters – plus U+2028 and U+2029, in one pass and without an intermediate string.
 */
fun StringBuilder.appendJsQuoted(text: CharSequence): StringBuilder {
    var from = 0
    val n = text.length
    for (i in 0 until n) {
        val c = text[i]
        val escaped = when {
            c == '"' -> "\\\""
            c == '\\' -> "\\\\"
            c == '\n' -> "\\n"
            c == '\r' -> "\\r"
            c == '\t' -> "\\t"
            c == '\b' -> "\\b"
            c == '\u000C' -> "\\f"
            c < ' ' || c == '\u2028' || c == '\u2029' -> String.format("\\u%04x", c.code)
            else -> continue
        }
        append(text, from, i).append(escaped)
        from = i + 1
    }
    return append(text, from, n)
}

/** Encode any bridge result as JSON text (the JS side `JSON.parse`s it). */
fun encodeResult(value: Any?): String = when (value) {
    null -> "null"
    is Host.RawJson -> value.json
    is String -> JSONObject.quote(value)
    is Boolean, is Int, is Long, is Double, is Float -> value.toString()
    is JSONObject, is JSONArray -> value.toString()
    else -> JSONObject.quote(value.toString())
}
