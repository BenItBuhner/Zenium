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

/** Encode any bridge result as JSON text (the JS side `JSON.parse`s it). */
fun encodeResult(value: Any?): String = when (value) {
    null -> "null"
    is Host.RawJson -> value.json
    is String -> JSONObject.quote(value)
    is Boolean, is Int, is Long, is Double, is Float -> value.toString()
    is JSONObject, is JSONArray -> value.toString()
    else -> JSONObject.quote(value.toString())
}
