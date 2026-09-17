package app.zen.chromium

import org.json.JSONArray

/**
 * Pure cookie-jar arithmetic for the site-information sheet; the WebView half is [SiteData].
 *
 * Android's `CookieManager` only answers "which `name=value` pairs would a request to this URL
 * carry?", so everything else is inferred by asking for related URLs: the plain-http variant
 * leaves out `Secure` cookies, a parent domain's URL still carries the cookies scoped to that
 * domain. Removal works the same way round – there is no delete, only setting an already expired
 * cookie over the existing one, for every domain and path it may live under.
 */
object CookieJar {
    data class Cookie(val name: String, val value: String)

    /** Where a page lives: `Target.of("https://www.google.com/search?q=x")`. */
    class Target private constructor(val scheme: String, val host: String, val path: String) {
        /** The page's own address (scheme, host and path only). */
        val pageUrl: String get() = "$scheme://$host$path"

        /** Same page over the other scheme; secure cookies are missing from the http reading. */
        val httpUrl: String get() = "http://$host$path"

        /** The host and its parent domains down to the registrable one. */
        val hosts: List<String> get() = hostsOf(host)

        /** The parent domains' URLs, nearest first (the same path, over https). */
        val parentUrls: List<String> get() = hosts.drop(1).map { "https://$it$path" }

        companion object {
            fun of(url: String): Target? {
                val match = URL_RE.matchEntire(url.trim()) ?: return null
                val scheme = match.groupValues[1].lowercase()
                // Cookies ignore ports and credentials: `user@host:8443` is the host `host`.
                val authority = match.groupValues[2].substringAfterLast('@')
                val host = (if (authority.startsWith("[")) authority.substringBefore(']') + "]" else authority.substringBefore(':')).lowercase()
                if (host.isEmpty()) return null
                // Strip a fragment (never sent) and keep the query, which cookie paths ignore anyway.
                val rest = match.groupValues[3].substringBefore('#')
                val path = if (rest.isEmpty()) "/" else rest
                return Target(scheme, host, path)
            }
        }
    }

    /** One cookie the page receives, with what the readings could tell about it. */
    data class Classified(
        val name: String,
        /** The broadest domain that still carries it (leading dot), or the host itself. */
        val domain: String,
        /** Null when the page is http: its own reading is the plain one, there is no other. */
        val secure: Boolean?,
        /** Bytes of name plus value. */
        val size: Int
    ) {
        fun toJson() = json("name" to name, "domain" to domain, "secure" to secure, "size" to size)
    }

    /** Parse the `Cookie`-header form `CookieManager.getCookie` returns (`a=1; b=2`). */
    fun parse(header: String?): List<Cookie> {
        if (header.isNullOrBlank()) return emptyList()
        val out = ArrayList<Cookie>()
        for (raw in header.split(';')) {
            val part = raw.trim()
            if (part.isEmpty()) continue
            val eq = part.indexOf('=')
            // A bare token is a cookie with an empty name (Chromium keeps it as `=token`).
            if (eq < 0) out += Cookie("", part) else out += Cookie(part.substring(0, eq).trim(), part.substring(eq + 1))
        }
        return out
    }

    /**
     * The host and every parent domain down to the registrable one (the eTLD+1, approximated
     * like the browser core does): `mail.google.com` → `[mail.google.com, google.com]`,
     * `www.bbc.co.uk` → `[www.bbc.co.uk, bbc.co.uk]`, `google.com` → `[google.com]`.
     */
    fun hostsOf(host: String): List<String> {
        val h = host.lowercase()
        if (h.isEmpty()) return emptyList()
        val site = registrableDomain(h)
        val out = arrayListOf(h)
        var current = h
        while (current != site && current.contains('.')) {
            current = current.substringAfter('.')
            if (!current.endsWith(site)) break
            out += current
        }
        return out
    }

    /** Approximate registrable domain (eTLD+1); mirrors `getDomain` in the shared URL helpers. */
    fun registrableDomain(host: String): String {
        val h = host.lowercase()
        if (h.isEmpty() || h == "localhost" || IPV4_RE.matches(h)) return h
        val labels = h.split('.')
        if (labels.size <= 2) return h
        val tld = labels[labels.size - 1]
        val sld = labels[labels.size - 2]
        return if (tld.length == 2 && sld in SECOND_LEVEL) labels.takeLast(3).joinToString(".") else labels.takeLast(2).joinToString(".")
    }

    /**
     * Classify the cookies a page at `target` receives. `read(url)` is the jar's answer for a
     * URL: the page's own reading lists the cookies, the http variant tells which are `Secure`,
     * the parent domains' readings tell how broadly each one is scoped. Cookies are matched by
     * name and value between readings, so two cookies of the same name on different domains stay
     * apart as long as their values differ.
     */
    fun classify(target: Target, read: (String) -> List<Cookie>): List<Classified> {
        val own = read(target.pageUrl)
        if (own.isEmpty()) return emptyList()
        val https = target.scheme == "https"
        val plain = if (https) read(target.httpUrl).toSet() else emptySet()
        val parents = target.hosts.drop(1)
        val parentReadings = target.parentUrls.map { read(it).toSet() }
        return own.map { cookie ->
            var domain = target.host
            // The broadest parent that still carries the cookie is the domain it is scoped to.
            for (i in parentReadings.indices.reversed()) {
                if (cookie in parentReadings[i]) {
                    domain = "." + parents[i]
                    break
                }
            }
            Classified(
                name = cookie.name,
                domain = domain,
                secure = if (https) cookie !in plain else null,
                size = cookie.name.length + cookie.value.length
            )
        }
    }

    /**
     * The `Set-Cookie` strings that expire `names` under every domain and path they may be
     * scoped to, each paired with the https URL to set it through (a `Secure` cookie can only be
     * overwritten from a secure URL, and a host-only cookie only from its own host). `__Host-`
     * cookies are host-only at `/` by definition and get just that one variant.
     */
    fun expiryHeaders(names: Collection<String>, target: Target): List<Pair<String, String>> {
        val out = ArrayList<Pair<String, String>>()
        val paths = pathsOf(target.path)
        for (name in names.distinct()) {
            if (name.startsWith("__Host-")) {
                out += "https://${target.host}/" to expired(name, null, "/")
                continue
            }
            for (host in target.hosts) {
                val url = "https://$host/"
                for (path in paths) {
                    out += url to expired(name, null, path)
                    out += url to expired(name, host, path)
                }
            }
        }
        return out
    }

    /** `/`, then the directories of the page path: `/a/b/c` → `/`, `/a`, `/a/b`, `/a/b/c`. */
    fun pathsOf(path: String): List<String> {
        val clean = path.substringBefore('?').substringBefore('#').trimEnd('/')
        if (clean.isEmpty() || !clean.startsWith("/")) return listOf("/")
        val out = arrayListOf("/")
        var end = 0
        while (true) {
            end = clean.indexOf('/', end + 1)
            if (end < 0) {
                out += clean
                break
            }
            out += clean.substring(0, end)
            if (out.size >= MAX_PATHS) break
        }
        return out.distinct()
    }

    private fun expired(name: String, domain: String?, path: String): String {
        val sb = StringBuilder("$name=; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=0; Path=$path; Secure")
        if (domain != null) sb.append("; Domain=$domain")
        return sb.toString()
    }

    fun toJson(cookies: List<Classified>): JSONArray = JSONArray().also { arr -> for (c in cookies) arr.put(c.toJson()) }

    /** Does an origin (`https://mail.google.com`) belong to `site` (`google.com`)? */
    fun originBelongsTo(origin: String, site: String): Boolean {
        if (site.isEmpty()) return false
        val host = Target.of(origin)?.host ?: return false
        return host == site.lowercase() || host.endsWith(".${site.lowercase()}")
    }

    private val URL_RE = Regex("^([A-Za-z][A-Za-z0-9+.-]*)://([^/?#]*)(.*)$")
    private val IPV4_RE = Regex("^(\\d{1,3}\\.){3}\\d{1,3}$")
    private val SECOND_LEVEL = setOf("co", "com", "org", "net", "gov", "edu", "ac", "or", "ne", "go")
    /** Deep paths are rare in cookies; a handful of prefixes covers what sites actually set. */
    private const val MAX_PATHS = 4
}
