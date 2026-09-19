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
    /** For regular expressions: the complete URL tokens every match contains (see [requiredTokensOf]). */
    private val requiredTokens: List<String>?,
    val caseSensitive: Boolean
) {
    private enum class Kind { ANY, HOSTNAME, PLAIN, REGEX }

    /** True for `||host^` / `||host` patterns: matched when the request host is `hostname` or a subdomain of it. */
    val isHostnameOnly: Boolean get() = kind == Kind.HOSTNAME

    /** True for `*` and the empty pattern: every URL matches, the filter's options alone select requests. */
    val matchesEveryUrl: Boolean get() = kind == Kind.ANY

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
     * A regular expression yields the runs [requiredTokensOf] can vouch for, none otherwise.
     */
    fun tokens(): IntArray {
        if (kind == Kind.ANY) return IntArray(0)
        if (kind == Kind.REGEX) {
            val required = requiredTokens ?: return IntArray(0)
            return IntArray(required.size) { Tokens.hash(required[it], 0, required[it].length) }
        }
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
            if (text.isEmpty() && !host) return UrlPattern(Kind.ANY, "", "", false, left, right, null, null, null, caseSensitive)
            if (!host) return UrlPattern(Kind.PLAIN, text, "", false, left, right, null, null, null, caseSensitive)
            var i = 0
            while (i < text.length && isHostChar(text[i])) i++
            val hostPart = text.substring(0, i)
            val rest = text.substring(i)
            val pureHost = hostPart.isNotEmpty() && !hostPart.endsWith(".") && !hostPart.startsWith(".") &&
                !hostPart.contains("..") && (rest.isEmpty() || (rest == "^" && !right))
            if (pureHost) return UrlPattern(Kind.HOSTNAME, "", hostPart, true, true, false, null, null, null, caseSensitive)
            return UrlPattern(Kind.PLAIN, rest, hostPart, true, true, right, null, null, null, caseSensitive)
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
            val tokens = requiredTokensOf(source)
            return UrlPattern(Kind.REGEX, source, "", false, false, false, compiled, literal, tokens, caseSensitive)
        }

        /** An alphanumeric run of a regular expression that every match contains; see [requiredRuns]. */
        private class RequiredRun(val text: String, val boundedLeft: Boolean, val boundedRight: Boolean)

        /**
         * The longest alphanumeric run (3+ chars) of a regular expression that every match must
         * contain: at group depth 0, outside character classes, not shortened by a quantifier,
         * and not part of a top-level alternation.
         */
        internal fun requiredLiteralOf(source: String): String? =
            requiredRuns(source)?.maxByOrNull { it.text.length }?.text

        /**
         * The runs of [requiredLiteralOf]'s kind that are also complete tokens of every matching
         * URL – bounded on both sides by an anchor (`^`, `$`) or a character the expression
         * matches literally and the tokenizer does not count (`/`, `.` escaped, `=`, `-`, …) –
         * lowercased for the index. Null when the expression vouches for none.
         */
        internal fun requiredTokensOf(source: String): List<String>? {
            val runs = requiredRuns(source) ?: return null
            val out = runs.filter { it.boundedLeft && it.boundedRight }.map { it.text.lowercase() }
            return out.ifEmpty { null }
        }

        private fun isAlnum(c: Char): Boolean = c in 'a'..'z' || c in 'A'..'Z' || c in '0'..'9'

        /** An unescaped character outside classes that the expression matches literally and the tokenizer does not count. */
        private fun isLiteralSeparator(c: Char): Boolean = !isAlnum(c) && c !in "\\.^$|?*+()[]{}"

        /**
         * Scan `source` for the alphanumeric runs every match must contain: at group depth 0,
         * outside character classes, not shortened by a quantifier, not in a top-level
         * alternation (null then). Each run records whether what the expression puts right
         * before and after it is certainly a token boundary in the URL: an anchor, or a
         * character matched literally that is not alphanumeric (`\.`, `/`, `=`, `-`, …).
         */
        private fun requiredRuns(source: String): List<RequiredRun>? {
            val out = ArrayList<RequiredRun>(4)
            var depth = 0
            var inClass = false
            var i = 0
            var runStart = -1
            var runBoundedLeft = false
            // Whether the last thing scanned certainly ends at a token boundary.
            var boundary = false
            fun endRun(end: Int, boundedRight: Boolean) {
                if (runStart == -1) return
                if (end - runStart >= 3) out.add(RequiredRun(source.substring(runStart, end), runBoundedLeft, boundedRight))
                runStart = -1
            }
            // Whether the element starting at `at` is certainly a token boundary: `$`, an escaped
            // non-alphanumeric character, or an unescaped literal separator.
            fun boundaryAt(at: Int): Boolean {
                if (at >= source.length) return false
                val c = source[at]
                if (c == '$') return true
                if (c == '\\') return at + 1 < source.length && !isAlnum(source[at + 1])
                return isLiteralSeparator(c)
            }
            while (i < source.length) {
                val c = source[i]
                if (inClass) {
                    if (c == '\\') {
                        i += 2
                        continue
                    }
                    if (c == ']') {
                        inClass = false
                        boundary = false
                    }
                    i++
                    continue
                }
                if (c == '\\') {
                    val separator = boundaryAt(i)
                    endRun(i, separator)
                    boundary = separator
                    i += 2
                    continue
                }
                when (c) {
                    '[' -> { endRun(i, false); inClass = true; boundary = false }
                    '(' -> { endRun(i, false); depth++; boundary = false }
                    ')' -> { endRun(i, false); depth--; boundary = false }
                    // A quantifier shortens the run it follows by the character it quantifies, which the URL may repeat.
                    '?', '*', '+' -> { endRun(i - 1, false); boundary = false }
                    '{' -> {
                        // `{n,m}`: its digits are a count, not text of the URL.
                        endRun(i - 1, false)
                        boundary = false
                        val close = source.indexOf('}', i)
                        i = if (close == -1) source.length else close + 1
                        continue
                    }
                    '|' -> { endRun(i, false); if (depth == 0) return null; boundary = false }
                    '^' -> { endRun(i, false); boundary = true }
                    '$' -> { endRun(i, true); boundary = false }
                    else -> {
                        val alnum = isAlnum(c)
                        if (alnum && depth == 0) {
                            if (runStart == -1) {
                                runStart = i
                                runBoundedLeft = boundary
                            }
                        } else {
                            endRun(i, boundaryAt(i))
                            boundary = !alnum && isLiteralSeparator(c)
                        }
                    }
                }
                i++
            }
            endRun(source.length, false)
            return out
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
