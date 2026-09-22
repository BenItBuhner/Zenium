package app.zen.chromium.ext

import java.util.Locale

/**
 * Chrome match patterns (`<all_urls>`, a `*://` scheme, a `*.example.com` host, a `:8443` port, a
 * `/v1/` + `*` path glob) as URL predicates, the semantics `src/core/extensions/api/matchPattern.ts`
 * gives host permissions: `*` as the scheme is http or https only, `*.host` covers the host and its
 * subdomains, the path is a glob where `*` spans any run of characters (`?` is literal: it starts
 * the query), the fragment is ignored. Plain JVM, so the unit tests run it; the CORS proxy asks it
 * which requests an extension's `host_permissions` reach. (Kotlin nests block comments, hence no
 * literal slash-star pattern examples here.)
 */
class MatchPattern private constructor(
    val pattern: String,
    private val schemes: Set<String>?,
    private val hostTest: (String) -> Boolean,
    private val port: String?,
    private val pathTest: Regex?
) {
    fun matches(url: String): Boolean {
        val parsed = parse(url) ?: return false
        if (schemes == null) return parsed.scheme in ALL_URL_SCHEMES
        if (parsed.scheme !in schemes) return false
        if (!hostTest(parsed.host)) return false
        if (port != null && port != "*" && parsed.port != port) return false
        return pathTest == null || pathTest.matches(parsed.path)
    }

    /**
     * Whether `url` is on the pattern's security origin: scheme, host and port, the path left out,
     * as Chrome's CORS allowlist reads an extension's host permission (a `https://mail.google.com/`
     * permission lets its pages fetch the whole origin).
     */
    fun matchesOrigin(url: String): Boolean {
        val parsed = parse(url) ?: return false
        if (schemes == null) return parsed.scheme in ALL_URL_SCHEMES
        if (parsed.scheme !in schemes) return false
        if (!hostTest(parsed.host)) return false
        return port == null || port == "*" || parsed.port == port
    }

    class Parsed(val scheme: String, val host: String, val port: String, val path: String)

    companion object {
        private val ALL_URL_SCHEMES = setOf("http", "https", "ws", "wss", "ftp", "file", "data", "urn")
        private val SCHEME = Regex("^[a-z][a-z0-9+.-]*$")

        /** Compile one pattern; null when it is not a valid match pattern. */
        fun compile(pattern: String): MatchPattern? {
            if (pattern == "<all_urls>") return MatchPattern(pattern, null, { true }, null, null)
            val separator = pattern.indexOf("://")
            if (separator <= 0) return null
            val scheme = pattern.substring(0, separator)
            val rest = pattern.substring(separator + 3)
            val slash = rest.indexOf('/')
            if (slash < 0) return null
            val hostPart = rest.substring(0, slash)
            val pathPart = rest.substring(slash)
            if (scheme == "file") {
                if (hostPart.isNotEmpty()) return null
            } else if (hostPart.isEmpty()) {
                return null
            }
            val schemes = if (scheme == "*") setOf("http", "https") else setOf(scheme)
            val portMatch = Regex(":(\\d+|\\*)$").find(hostPart)
            val port = portMatch?.groupValues?.get(1)
            val hostName = if (portMatch != null) hostPart.substring(0, hostPart.length - portMatch.value.length) else hostPart
            val hostTest: (String) -> Boolean = when {
                hostName == "*" || scheme == "file" -> { _ -> true }
                hostName.startsWith("*.") -> {
                    val suffix = hostName.substring(2).lowercase(Locale.ROOT)
                    ({ host -> host == suffix || host.endsWith(".$suffix") })
                }
                hostName.contains('*') -> return null
                else -> {
                    val exact = hostName.lowercase(Locale.ROOT)
                    ({ host -> host == exact })
                }
            }
            return MatchPattern(pattern, schemes, hostTest, port, pathGlob(pathPart))
        }

        /** Compile a list, dropping what is not a pattern. */
        fun compileAll(patterns: Iterable<String>): List<MatchPattern> = patterns.mapNotNull { compile(it) }

        /** Whether `url` matches any of `patterns`. */
        fun anyMatches(patterns: List<MatchPattern>, url: String): Boolean = patterns.any { it.matches(url) }

        /** Whether `url` is on the security origin of any of `patterns` (see [matchesOrigin]). */
        fun anyMatchesOrigin(patterns: List<MatchPattern>, url: String): Boolean = patterns.any { it.matchesOrigin(url) }

        private fun pathGlob(glob: String): Regex {
            val sb = StringBuilder("^")
            for (ch in glob) {
                if (ch == '*') sb.append(".*") else if (ch in ".+?^\${}()|[]\\") sb.append('\\').append(ch) else sb.append(ch)
            }
            return Regex(sb.append('$').toString(), RegexOption.DOT_MATCHES_ALL)
        }

        fun parse(url: String): Parsed? {
            val colon = url.indexOf(':')
            if (colon <= 0) return null
            val scheme = url.substring(0, colon).lowercase(Locale.ROOT)
            if (!SCHEME.matches(scheme)) return null
            val withoutFragment = url.substringBefore('#')
            val afterScheme = withoutFragment.substring(scheme.length + 1)
            if (!afterScheme.startsWith("//")) return Parsed(scheme, "", "", afterScheme)
            val authorityEnd = afterScheme.indexOf('/', 2)
            val authority = if (authorityEnd < 0) afterScheme.substring(2) else afterScheme.substring(2, authorityEnd)
            val path = if (authorityEnd < 0) "/" else afterScheme.substring(authorityEnd)
            val hostPort = if (authority.contains('@')) authority.substring(authority.lastIndexOf('@') + 1) else authority
            var host = hostPort
            var port = ""
            val ipv6End = if (hostPort.startsWith("[")) hostPort.indexOf(']') else -1
            val portColon = hostPort.lastIndexOf(':')
            if (portColon > ipv6End) {
                host = hostPort.substring(0, portColon)
                port = hostPort.substring(portColon + 1)
            }
            return Parsed(scheme, host.lowercase(Locale.ROOT), port, path)
        }
    }
}
