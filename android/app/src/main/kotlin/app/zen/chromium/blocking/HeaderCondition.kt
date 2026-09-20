package app.zen.chromium.blocking

import org.json.JSONArray
import org.json.JSONObject
import java.util.Locale

/**
 * One response header condition of a declarativeNetRequest rule (`condition.responseHeaders[]`
 * / `condition.excludedResponseHeaders[]`), compiled the way the desktop engine compiles it
 * (`src/core/blocking/headerCondition.ts`, after Chromium's `MatchesHeaderConditions`): the
 * header name without regard to case, the values as `base::MatchPattern` globs (`*` any run, `?`
 * zero or one character, `\` escapes the next character) compared without regard to case.
 *
 * A condition matches when its header is present in the response and, when it names values,
 * none of `excludedValues` matches a line and (without `values`, or) one of `values` does.
 */
class HeaderCondition(
    /** Lowercase header name. */
    val header: String,
    val values: List<Regex>?,
    val excludedValues: List<Regex>?
) {
    fun matches(headers: Map<String, List<String>>): Boolean {
        val lines = headers[header] ?: return false
        if (values == null && excludedValues == null) return true
        if (excludedValues != null && anyMatches(lines, excludedValues)) return false
        return values == null || anyMatches(lines, values)
    }

    companion object {
        /** `base::MatchPattern` as a regular expression over the value (case-insensitive, `.` spans lines). */
        fun glob(pattern: String): Regex {
            val out = StringBuilder()
            var i = 0
            while (i < pattern.length) {
                val c = pattern[i]
                when {
                    c == '*' -> out.append(".*")
                    c == '?' -> out.append(".?")
                    else -> {
                        val literal = if (c == '\\' && i + 1 < pattern.length) pattern[++i] else c
                        out.append(Regex.escape(literal.toString()))
                    }
                }
                i++
            }
            return Regex("^$out$", setOf(RegexOption.IGNORE_CASE, RegexOption.DOT_MATCHES_ALL))
        }

        private fun anyMatches(lines: List<String>, patterns: List<Regex>): Boolean {
            for (line in lines) for (pattern in patterns) if (pattern.matches(line)) return true
            return false
        }

        private fun globs(o: JSONObject, key: String): List<Regex>? {
            val arr = o.optJSONArray(key) ?: return null
            if (arr.length() == 0) return null
            val out = ArrayList<Regex>(arr.length())
            for (i in 0 until arr.length()) out.add(glob(arr.optString(i)))
            return out
        }

        /** The conditions of a `responseHeaders` / `excludedResponseHeaders` array; null when there are none. */
        fun parse(arr: JSONArray?): List<HeaderCondition>? {
            if (arr == null || arr.length() == 0) return null
            val out = ArrayList<HeaderCondition>(arr.length())
            for (i in 0 until arr.length()) {
                val o = arr.optJSONObject(i) ?: continue
                val name = o.optString("header").lowercase(Locale.ROOT)
                if (name.isEmpty()) continue
                out.add(HeaderCondition(name, globs(o, "values"), globs(o, "excludedValues")))
            }
            return if (out.isEmpty()) null else out
        }

        /**
         * A response's headers indexed by lowercase name, one entry per line (the shape the
         * conditions read; `HttpURLConnection.headerFields` has a null key for the status line).
         */
        fun index(headers: Map<String?, List<String>?>): Map<String, List<String>> {
            val out = HashMap<String, List<String>>(headers.size * 2)
            for ((name, values) in headers) {
                if (name == null || values == null) continue
                val key = name.lowercase(Locale.ROOT)
                val existing = out[key]
                out[key] = if (existing == null) values else existing + values
            }
            return out
        }

        /** At least one of `conditions` matches. */
        fun anyMatches(headers: Map<String, List<String>>, conditions: List<HeaderCondition>): Boolean {
            for (condition in conditions) if (condition.matches(headers)) return true
            return false
        }

        /** The rule's header stage: `excludedResponseHeaders` first, then `responseHeaders` (`matchesHeaderStage` in the desktop engine). */
        fun matchesStage(
            headers: Map<String, List<String>>,
            responseHeaders: List<HeaderCondition>?,
            excludedResponseHeaders: List<HeaderCondition>?
        ): Boolean {
            if (excludedResponseHeaders != null && anyMatches(headers, excludedResponseHeaders)) return false
            if (responseHeaders != null && !anyMatches(headers, responseHeaders)) return false
            return true
        }
    }
}
