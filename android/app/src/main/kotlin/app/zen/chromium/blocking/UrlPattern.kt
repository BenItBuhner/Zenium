package app.zen.chromium.blocking

import java.util.regex.Pattern
import java.util.regex.PatternSyntaxException

/**
 * A network-filter URL pattern in the ABP / uBlock Origin syntax, which is also the syntax of
 * `chrome.declarativeNetRequest`'s `urlFilter`: `||` anchors to the start of a (sub)domain, `|`
 * to the start or end of the URL, `^` is a separator (anything but a letter, digit, `_`, `-`,
 * `.`, `%`, or the end of the URL) and `*` a wildcard. `/…/` is a regular expression.
 *
 * Plain patterns are matched without regular expressions: hostname-anchored ones start at label
 * boundaries of the URL's host, the rest with a small backtracking wildcard matcher.
 */
class UrlPattern private constructor(
    private val kind: Kind,
    /** Body after the host part, without anchors; lowercased unless the pattern is case sensitive. */
    private val body: String,
    /** For hostname-anchored patterns: the leading `[a-z0-9.-]` run (a hostname or the start of one). */
    private val hostPart: String,
    private val hostAnchored: Boolean,
    private val leftAnchored: Boolean,
    private val rightAnchored: Boolean,
    private val regex: Pattern?,
    /** Literal every matching URL must contain (a cheap pre-check for regular expressions). */
    private val requiredLiteral: String?,
    val caseSensitive: Boolean
) {
    private enum class Kind { ANY, HOSTNAME, PLAIN, REGEX }

    /** True for `||host^` / `||host` patterns: matched when the request host is `hostname` or a subdomain of it. */
    val isHostnameOnly: Boolean get() = kind == Kind.HOSTNAME

    /** The hostname of a hostname-only pattern (lowercase). */
    val hostname: String get() = hostPart

    val isRegex: Boolean get() = kind == Kind.REGEX

    /**
     * Match against a request. `url` is the raw URL, `urlLower` its lowercased form and `host`
     * its hostname (lowercase) with `hostStart` the index the host begins at in `url`.
     */
    fun matches(url: String, urlLower: String, host: String, hostStart: Int): Boolean {
        return when (kind) {
            Kind.ANY -> true
            Kind.HOSTNAME -> Domains.hostMatchesDomain(host, hostPart)
            Kind.REGEX -> {
                val subject = if (caseSensitive) url else urlLower
                if (requiredLiteral != null && !subject.contains(requiredLiteral)) false
                else regex!!.matcher(subject).find()
            }
            Kind.PLAIN -> matchPlain(if (caseSensitive) url else urlLower, host, hostStart)
        }
    }

    private fun matchPlain(subject: String, host: String, hostStart: Int): Boolean {
        if (hostAnchored) {
            // The host part sits at a label boundary of the host; the body continues right after it.
            var labelStart = hostStart
            val hostEnd = hostStart + host.length
            while (labelStart <= hostEnd) {
                if (subject.regionMatches(labelStart, hostPart, 0, hostPart.length) &&
                    matchAt(subject, labelStart + hostPart.length, body, 0)
                ) return true
                val dot = subject.indexOf('.', labelStart)
                if (dot == -1 || dot >= hostEnd) break
                labelStart = dot + 1
            }
            return false
        }
        if (leftAnchored) return matchAt(subject, 0, body, 0)
        // Unanchored: try every occurrence of the first literal chunk.
        var chunkEnd = body.length
        val firstStar = body.indexOf('*')
        val firstSep = body.indexOf('^')
        if (firstStar != -1) chunkEnd = minOf(chunkEnd, firstStar)
        if (firstSep != -1) chunkEnd = minOf(chunkEnd, firstSep)
        if (chunkEnd == 0) {
            for (i in 0..subject.length) if (matchAt(subject, i, body, 0)) return true
            return false
        }
        val chunk = body.substring(0, chunkEnd)
        var from = 0
        while (true) {
            val at = subject.indexOf(chunk, from)
            if (at == -1) return false
            if (matchAt(subject, at + chunkEnd, body, chunkEnd)) return true
            from = at + 1
        }
    }

    /** Wildcard match of `pat[pi0..]` against `s[si0..]`; honours the right anchor. */
    private fun matchAt(s: String, si0: Int, pat: String, pi0: Int): Boolean {
        var si = si0
        var pi = pi0
        var starPi = -1
        var starSi = -1
        while (true) {
            if (pi == pat.length) {
                if (!rightAnchored || si == s.length) return true
            } else {
                val p = pat[pi]
                if (p == '*') {
                    starPi = pi
                    starSi = si
                    pi++
                    continue
                }
                if (si < s.length) {
                    val c = s[si]
                    if (if (p == '^') isSeparator(c) else c == p) {
                        si++
                        pi++
                        continue
                    }
                } else if (p == '^') {
                    // A separator also matches the end of the URL.
                    pi++
                    continue
                }
            }
            if (starPi == -1) return false
            starSi++
            if (starSi > s.length) return false
            si = starSi
            pi = starPi + 1
        }
    }

    /**
     * Complete tokens of the pattern for indexing: runs of `[a-z0-9]` bounded on both sides by
     * something in the pattern (a separator character or an anchor), never a run next to `*`.
     * Regular expressions yield no tokens.
     */
    fun tokens(): IntArray {
        if (kind == Kind.REGEX || kind == Kind.ANY) return IntArray(0)
        if (kind == Kind.HOSTNAME) return Tokens.tokenize(hostPart)
        val full = (hostPart + body).lowercase()
        val out = ArrayList<Int>(8)
        var i = 0
        val n = full.length
        while (i < n) {
            if (!Tokens.isTokenChar(full[i])) {
                i++
                continue
            }
            val start = i
            while (i < n && Tokens.isTokenChar(full[i])) i++
            val boundedLeft = if (start == 0) leftAnchored || hostAnchored else full[start - 1] != '*'
            val boundedRight = if (i == n) rightAnchored else full[i] != '*'
            if (boundedLeft && boundedRight) out.add(Tokens.hash(full, start, i))
        }
        return out.toIntArray()
    }

    /**
     * A `regexSubstitution` (`\1`-style groups) applied to `url` after this regular expression
     * matched it; null when it does not match or this is not a regular expression.
     */
    fun substitute(url: String, substitution: String): String? {
        val m = (regex ?: return null).matcher(url)
        if (!m.find()) return null
        val out = StringBuilder()
        var i = 0
        while (i < substitution.length) {
            val c = substitution[i]
            if (c == '\\' && i + 1 < substitution.length && substitution[i + 1].isDigit()) {
                val group = substitution[i + 1] - '0'
                if (group <= m.groupCount()) out.append(m.group(group) ?: "")
                i += 2
                continue
            }
            out.append(c)
            i++
        }
        return out.toString()
    }

    override fun toString(): String = when {
        kind == Kind.REGEX -> "/$body/"
        kind == Kind.HOSTNAME -> "||$hostPart^"
        hostAnchored -> "||$hostPart$body" + (if (rightAnchored) "|" else "")
        else -> (if (leftAnchored) "|" else "") + body + (if (rightAnchored) "|" else "")
    }

    companion object {
        fun isSeparator(c: Char): Boolean =
            !(c in 'a'..'z' || c in 'A'..'Z' || c in '0'..'9' || c == '_' || c == '-' || c == '.' || c == '%')

        private fun isHostChar(c: Char): Boolean = c in 'a'..'z' || c in '0'..'9' || c == '.' || c == '-'

        /**
         * Parse a pattern; null when it is an invalid regular expression. ABP filters write
         * regular expressions as `/…/`; a declarativeNetRequest `urlFilter` never is one
         * (`allowRegex = false`), it has `regexFilter` for that.
         */
        fun parse(pattern: String, caseSensitive: Boolean = false, allowRegex: Boolean = true): UrlPattern? {
            var text = pattern
            if (allowRegex && text.length > 2 && text.startsWith("/") && text.endsWith("/")) {
                return regex(text.substring(1, text.length - 1), caseSensitive)
            }
            var left = false
            var host = false
            var right = false
            if (text.startsWith("||")) {
                host = true
                text = text.substring(2)
            } else if (text.startsWith("|")) {
                left = true
                text = text.substring(1)
            }
            if (text.endsWith("|")) {
                right = true
                text = text.dropLast(1)
            }
            // Leading and trailing wildcards mean nothing.
            while (text.startsWith("*") && !host) text = text.substring(1)
            while (text.endsWith("*") && !right) text = text.dropLast(1)
            if (!caseSensitive) text = text.lowercase()
            if (text.isEmpty() && !host) return UrlPattern(Kind.ANY, "", "", false, left, right, null, null, caseSensitive)
            if (!host) return UrlPattern(Kind.PLAIN, text, "", false, left, right, null, null, caseSensitive)
            var i = 0
            while (i < text.length && isHostChar(text[i])) i++
            val hostPart = text.substring(0, i)
            val rest = text.substring(i)
            val pureHost = hostPart.isNotEmpty() && !hostPart.endsWith(".") && !hostPart.startsWith(".") &&
                !hostPart.contains("..") && (rest.isEmpty() || (rest == "^" && !right))
            if (pureHost) return UrlPattern(Kind.HOSTNAME, "", hostPart, true, true, false, null, null, caseSensitive)
            return UrlPattern(Kind.PLAIN, rest, hostPart, true, true, right, null, null, caseSensitive)
        }

        /** A regular expression pattern (`regexFilter`, or an ABP `/…/` filter); null when invalid. */
        fun regex(source: String, caseSensitive: Boolean): UrlPattern? {
            val compiled = try {
                Pattern.compile(source, if (caseSensitive) 0 else Pattern.CASE_INSENSITIVE)
            } catch (e: PatternSyntaxException) {
                return null
            } catch (e: IllegalArgumentException) {
                return null
            }
            val literal = requiredLiteralOf(source)?.let { if (caseSensitive) it else it.lowercase() }
            return UrlPattern(Kind.REGEX, source, "", false, false, false, compiled, literal, caseSensitive)
        }

        /**
         * The longest alphanumeric run (3+ chars) of a regular expression that every match must
         * contain: at group depth 0, outside character classes, not shortened by a quantifier,
         * and not part of a top-level alternation.
         */
        internal fun requiredLiteralOf(source: String): String? {
            var best: String? = null
            var depth = 0
            var inClass = false
            var i = 0
            var runStart = -1
            fun endRun(end: Int, quantified: Boolean) {
                if (runStart == -1) return
                val stop = if (quantified) end - 1 else end
                val current = best
                if (stop - runStart >= 3 && (current == null || stop - runStart > current.length)) {
                    best = source.substring(runStart, stop)
                }
                runStart = -1
            }
            while (i < source.length) {
                val c = source[i]
                if (c == '\\') {
                    endRun(i, false)
                    i += 2
                    continue
                }
                if (inClass) {
                    if (c == ']') inClass = false
                    i++
                    continue
                }
                when (c) {
                    '[' -> { endRun(i, false); inClass = true }
                    '(' -> { endRun(i, false); depth++ }
                    ')' -> { endRun(i, false); depth-- }
                    '?', '*', '+', '{' -> endRun(i, true)
                    '|' -> { endRun(i, false); if (depth == 0) return null }
                    else -> {
                        val alnum = c in 'a'..'z' || c in 'A'..'Z' || c in '0'..'9'
                        if (alnum && depth == 0) {
                            if (runStart == -1) runStart = i
                        } else {
                            endRun(i, false)
                        }
                    }
                }
                i++
            }
            endRun(source.length, false)
            return best
        }
    }
}

/** Token hashing shared by the index and the URL tokenizer: runs of `[a-z0-9]` in lowercase text. */
object Tokens {
    fun isTokenChar(c: Char): Boolean = c in 'a'..'z' || c in '0'..'9'

    fun hash(s: String, start: Int, end: Int): Int {
        var h = 5381
        for (i in start until end) h = (h shl 5) + h + s[i].code
        return h
    }

    /** Hashes of every token of `s` (lowercase input). */
    fun tokenize(s: String): IntArray {
        val out = ArrayList<Int>(16)
        var i = 0
        val n = s.length
        while (i < n) {
            if (!isTokenChar(s[i])) {
                i++
                continue
            }
            val start = i
            while (i < n && isTokenChar(s[i])) i++
            out.add(hash(s, start, i))
        }
        return out.toIntArray()
    }
}
