package app.zen.chromium.privacy

import app.zen.chromium.blocking.Domains

/**
 * Chrome's content-settings pattern grammar as the cookie and site-data lists use it
 * (`[scheme://][*.]host[:port]`), the twin of `src/shared/sitePatterns.ts`: the same parse, the
 * same match, the same order of specificity, so the header stage's word on a request is the
 * desktop's. `[*.]example.com` covers the host and its subdomains, `example.com` the host alone;
 * a named scheme (`http` / `https`; `*://` says nothing; `ws` / `wss` are matched as the http
 * scheme they ride on) or port narrows a pattern; an IP literal takes no `[*.]`, a port goes with
 * no `[*.]`. Pure, no Android in it.
 */
class SitePattern private constructor(
    /** The canonical text, what the lists store. */
    val text: String,
    /** `http` or `https`; null for any scheme. */
    val scheme: String?,
    /** Lowercase host; an IPv6 literal keeps its brackets. */
    val host: String,
    /** `[*.]`: the host's subdomains are covered too. */
    val subdomains: Boolean,
    /** A fixed port, or null for any. */
    val port: Int?
) : Comparable<SitePattern> {
    /** Whether the pattern covers `address`. */
    fun matches(address: SiteAddress): Boolean {
        if (scheme != null && scheme != address.scheme) return false
        if (port != null && port != address.port) return false
        return coversHost(address.host)
    }

    /** Whether the pattern covers `url`; false for a URL without a host. */
    fun matches(url: String): Boolean = SiteAddress.of(url)?.let { matches(it) } ?: false

    /** Whether the pattern covers `host` alone, whatever the scheme or port. */
    fun coversHost(candidate: String): Boolean {
        val h = candidate.lowercase().removeSuffix(".")
        if (h == host) return true
        if (!subdomains) return false
        return h.length > host.length && h.endsWith(host) && h[h.length - host.length - 1] == '.'
    }

    /**
     * Chrome's order from the most specific to the least (`compareSitePatterns`): an exact host
     * before a subdomain wildcard, a longer host before a shorter one, a named scheme before
     * any, a named port before any; ties by text. Negative when this one is the more specific.
     */
    override fun compareTo(other: SitePattern): Int {
        if (subdomains != other.subdomains) return if (subdomains) 1 else -1
        if (host.length != other.host.length) return other.host.length - host.length
        if ((scheme == null) != (other.scheme == null)) return if (scheme == null) 1 else -1
        if ((port == null) != (other.port == null)) return if (port == null) 1 else -1
        return text.compareTo(other.text)
    }

    override fun equals(other: Any?): Boolean = other is SitePattern && other.text == text
    override fun hashCode(): Int = text.hashCode()
    override fun toString(): String = text

    companion object {
        private const val WILDCARD = "[*.]"
        private val SCHEMES = setOf("http", "https")
        private val HOST_LABEL = Regex("^(?!-)[a-z0-9_-]{1,63}(?<!-)$")
        private val IPV4 = Regex("^\\d+(\\.\\d+){3}$")
        private val PORT = Regex("^(.*?)(?::(\\*|\\d{1,5}))?$")
        private val FORBIDDEN = Regex("[\\s/\\\\?#@]")
        private const val MAX_HOST_LENGTH = 253

        /** Parse `input` as a pattern; null when it is not one. Whitespace and case are forgiven. */
        fun parse(input: String): SitePattern? {
            var text = input.trim().lowercase()
            if (text.isEmpty() || FORBIDDEN.containsMatchIn(text)) return null
            var scheme: String? = null
            val schemeEnd = text.indexOf("://")
            if (schemeEnd != -1) {
                val given = text.substring(0, schemeEnd)
                text = text.substring(schemeEnd + 3)
                if (given != "*") {
                    if (given !in SCHEMES) return null
                    scheme = given
                }
            }
            var subdomains = false
            if (text.startsWith(WILDCARD)) {
                subdomains = true
                text = text.substring(WILDCARD.length)
            }
            if (text.isEmpty() || text.contains('*')) return null
            val portMatch = PORT.matchEntire(text) ?: return null
            var hostText = portMatch.groupValues[1]
            var port: Int? = null
            val portText = portMatch.groups[2]?.value
            if (portText != null && portText != "*") {
                port = portText.toIntOrNull() ?: return null
                if (port < 1 || port > 65535) return null
                // A port narrows one host; Chrome refuses the combination with a domain wildcard.
                if (subdomains) return null
            }
            if (hostText.endsWith(".") && hostText.length > 1) hostText = hostText.dropLast(1)
            val host = canonicalHost(hostText) ?: return null
            // An IP literal names one machine: nothing is under it.
            if (subdomains && (host.startsWith("[") || isIpv4(host))) return null
            return SitePattern(patternText(scheme, host, subdomains, port), scheme, host, subdomains, port)
        }

        /** The canonical text of `input`, or null when it is not a pattern. */
        fun normalize(input: String): String? = parse(input)?.text

        /** The pattern a bare host gets when added from a page: `[*.]host` (an IP literal stays exact). */
        fun forHost(host: String): String? {
            val bare = parse(host) ?: return null
            if (bare.scheme != null || bare.port != null) return null
            if (bare.host.startsWith("[") || isIpv4(bare.host)) return bare.text
            return WILDCARD + bare.host
        }

        /** The most specific of `patterns` (texts; unparsable ones are skipped) covering `address`, or null. */
        fun match(patterns: Iterable<String>, address: SiteAddress): SitePattern? {
            var best: SitePattern? = null
            for (text in patterns) {
                val pattern = parse(text) ?: continue
                if (!pattern.matches(address)) continue
                if (best == null || pattern < best) best = pattern
            }
            return best
        }

        /** The most specific of `patterns` covering `url`, or null (a URL without a host matches nothing). */
        fun match(patterns: Iterable<String>, url: String): SitePattern? =
            SiteAddress.of(url)?.let { match(patterns, it) }

        private fun patternText(scheme: String?, host: String, subdomains: Boolean, port: Int?): String =
            (if (scheme != null) "$scheme://" else "") + (if (subdomains) WILDCARD else "") + host + (if (port != null) ":$port" else "")

        private fun isIpv4(host: String): Boolean = IPV4.matches(host) && NonUniqueHost.parseIpv4(host) != null

        /** A lowercase DNS name, dotted-decimal IPv4 or bracketed IPv6 literal; null for anything else. */
        private fun canonicalHost(text: String): String? {
            if (text.isEmpty()) return null
            if (text.startsWith("[") && text.endsWith("]")) {
                return if (NonUniqueHost.parseIpv6(text.substring(1, text.length - 1)) != null) text else null
            }
            if (NonUniqueHost.parseIpv6(text) != null) return "[$text]"
            if (IPV4.matches(text)) return if (NonUniqueHost.parseIpv4(text) != null) text else null
            if (text.length > MAX_HOST_LENGTH) return null
            val labels = text.split('.')
            if (!labels.all { HOST_LABEL.matches(it) }) return null
            return text
        }
    }
}

/** The parts of a URL a pattern is matched against (`SiteAddress` in `sitePatterns.ts`). */
class SiteAddress(val scheme: String, val host: String, val port: Int?) {
    companion object {
        private val DEFAULT_PORTS = mapOf("http" to 80, "https" to 443)
        private val SCHEME_ALIASES = mapOf("ws" to "http", "wss" to "https")

        /** `url`'s scheme, host and port (the scheme's default without one); null for a URL without a host. */
        fun of(url: String): SiteAddress? {
            val schemeEnd = url.indexOf("://")
            if (schemeEnd <= 0) return null
            val raw = url.substring(0, schemeEnd).lowercase()
            val scheme = SCHEME_ALIASES[raw] ?: raw
            val host = Domains.hostnameOf(url) ?: return null
            var end = url.length
            for (i in schemeEnd + 3 until url.length) {
                val c = url[i]
                if (c == '/' || c == '?' || c == '#') {
                    end = i
                    break
                }
            }
            var authority = url.substring(schemeEnd + 3, end)
            val at = authority.lastIndexOf('@')
            if (at != -1) authority = authority.substring(at + 1)
            val portStart = if (authority.startsWith("[")) authority.indexOf(']') + 1 else 0
            val colon = authority.indexOf(':', portStart)
            val port = if (colon == -1) DEFAULT_PORTS[scheme] else authority.substring(colon + 1).toIntOrNull() ?: DEFAULT_PORTS[scheme]
            return SiteAddress(scheme, host, port)
        }
    }
}
