package app.zen.chromium.blocking

import java.net.URI

/**
 * Registrable-domain (eTLD+1) helper for third-party checks and domain-list matching. The public
 * suffix table mirrors `src/core/blocking/domain.ts` entry for entry (a vitest cross-checks the
 * two) so both engines agree on what "third party" means.
 */
object Domains {
    // BEGIN MULTI_LABEL_SUFFIXES (mirrors domain.ts)
    private val MULTI_LABEL_SUFFIXES: HashSet<String> = hashSetOf(
        "co.uk", "org.uk", "me.uk", "ltd.uk", "plc.uk", "net.uk",
        "sch.uk", "ac.uk", "gov.uk", "nhs.uk", "co.jp", "ne.jp",
        "or.jp", "ac.jp", "go.jp", "ad.jp", "ed.jp", "gr.jp",
        "lg.jp", "com.au", "net.au", "org.au", "edu.au", "gov.au",
        "id.au", "asn.au", "com.br", "net.br", "org.br", "gov.br",
        "edu.br", "com.cn", "net.cn", "org.cn", "gov.cn", "edu.cn",
        "ac.cn", "com.tw", "net.tw", "org.tw", "edu.tw", "gov.tw",
        "co.kr", "ne.kr", "or.kr", "go.kr", "ac.kr", "re.kr",
        "co.in", "net.in", "org.in", "firm.in", "gen.in", "ind.in",
        "ac.in", "edu.in", "gov.in", "co.za", "org.za", "net.za",
        "gov.za", "ac.za", "web.za", "com.mx", "org.mx", "net.mx",
        "gob.mx", "edu.mx", "com.ar", "net.ar", "org.ar", "gob.ar",
        "edu.ar", "com.tr", "net.tr", "org.tr", "gov.tr", "edu.tr",
        "co.nz", "net.nz", "org.nz", "govt.nz", "ac.nz", "school.nz",
        "com.sg", "net.sg", "org.sg", "edu.sg", "gov.sg", "com.hk",
        "net.hk", "org.hk", "edu.hk", "gov.hk", "com.my", "net.my",
        "org.my", "edu.my", "gov.my", "co.id", "or.id", "ac.id",
        "go.id", "web.id", "my.id", "com.ph", "net.ph", "org.ph",
        "com.vn", "net.vn", "org.vn", "edu.vn", "gov.vn", "co.th",
        "in.th", "or.th", "ac.th", "go.th", "com.pk", "net.pk",
        "org.pk", "edu.pk", "gov.pk", "com.bd", "net.bd", "org.bd",
        "com.eg", "net.eg", "org.eg", "com.sa", "net.sa", "org.sa",
        "edu.sa", "gov.sa", "co.il", "org.il", "net.il", "ac.il",
        "gov.il", "com.ua", "net.ua", "org.ua", "edu.ua", "gov.ua",
        "kiev.ua", "com.pl", "net.pl", "org.pl", "edu.pl", "gov.pl",
        "com.ru", "net.ru", "org.ru", "msk.ru", "spb.ru", "com.es",
        "org.es", "nom.es", "gob.es", "edu.es", "com.pt", "org.pt",
        "edu.pt", "gov.pt", "com.gr", "net.gr", "org.gr", "edu.gr",
        "gov.gr", "com.co", "net.co", "org.co", "edu.co", "gov.co",
        "com.pe", "net.pe", "org.pe", "gob.pe", "com.ve", "net.ve",
        "org.ve", "com.ec", "net.ec", "org.ec", "com.uy", "net.uy",
        "org.uy", "com.py", "net.py", "org.py", "com.bo", "net.bo",
        "org.bo", "com.do", "net.do", "org.do", "com.gt", "net.gt",
        "org.gt", "com.ng", "net.ng", "org.ng", "edu.ng", "gov.ng",
        "co.ke", "or.ke", "ne.ke", "ac.ke", "go.ke", "co.tz",
        "or.tz", "ac.tz", "go.tz", "co.ug", "or.ug", "ac.ug",
        "go.ug", "co.zw", "org.zw", "ac.zw", "co.mz", "org.mz",
        "co.ao", "og.ao", "com.gh", "org.gh", "edu.gh", "gov.gh",
        "co.ma", "net.ma", "org.ma", "ac.ma", "gov.ma", "com.tn",
        "org.tn", "com.dz", "org.dz", "com.lb", "org.lb", "com.jo",
        "org.jo", "com.kw", "org.kw", "com.qa", "org.qa", "com.bh",
        "org.bh", "com.om", "org.om", "co.ae", "net.ae", "org.ae",
        "ac.ae", "gov.ae", "co.at", "or.at", "ac.at", "gv.at",
        "co.hu", "org.hu", "info.hu", "com.ro", "org.ro", "nom.ro",
        "com.mt", "org.mt", "net.mt", "com.cy", "org.cy", "net.cy",
        "com.lv", "org.lv", "edu.lv", "com.ee", "org.ee", "edu.ee",
        "com.lt", "org.lt", "com.by", "org.by", "com.kz", "org.kz",
        "com.uz", "org.uz", "com.ge", "org.ge", "com.am", "org.am",
        "com.az", "org.az", "com.np", "org.np", "edu.np", "com.lk",
        "org.lk", "edu.lk", "com.mm", "org.mm", "com.kh", "org.kh",
        "com.la", "org.la", "com.mn", "org.mn", "com.af", "org.af",
        "com.iq", "org.iq", "com.ye", "org.ye", "co.cr", "or.cr",
        "ac.cr", "com.pa", "org.pa", "com.sv", "org.sv", "com.hn",
        "org.hn", "com.ni", "org.ni", "com.jm", "org.jm", "com.tt",
        "org.tt", "com.bs", "org.bs", "com.bz", "org.bz", "com.cu",
        "org.cu", "com.pr", "org.pr", "com.ai", "com.ag", "com.bb",
        "com.lc", "com.vc", "com.gd", "com.kn", "com.dm", "com.ky",
        "com.vi", "com.gy", "com.sr", "com.fj", "com.pg", "com.sb",
        "com.vu", "com.ws", "com.to", "com.nf", "com.ki", "com.nr",
        "com.tv", "com.fm", "com.pw", "com.mh", "com.pf", "com.nc",
        "com.mu", "com.sc", "com.mv", "com.km", "com.mg", "com.re",
        "com.yt", "github.io", "githubusercontent.com", "gitlab.io", "netlify.app", "vercel.app",
        "pages.dev", "web.app", "firebaseapp.com", "herokuapp.com", "appspot.com", "blogspot.com",
        "wordpress.com", "tumblr.com", "cloudfront.net", "amazonaws.com", "azurewebsites.net", "windows.net",
        "cloudapp.net", "workers.dev", "glitch.me", "repl.co", "surge.sh", "now.sh",
        "fly.dev", "onrender.com", "readthedocs.io", "neocities.org", "myshopify.com", "squarespace.com",
        "wixsite.com", "weebly.com", "webflow.io", "ngrok.io", "ngrok.app", "trycloudflare.com",
        "duckdns.org", "no-ip.org", "dyndns.org", "ddns.net", "hopto.org", "zapto.org",
        "sytes.net", "dynv6.net", "nip.io", "sslip.io", "xip.io", "localhost.run",
        "loca.lt", "lhr.life", "serveo.net", "us-east-1.amazonaws.com", "eu-west-1.amazonaws.com", "s3.amazonaws.com",
        "compute.amazonaws.com", "elb.amazonaws.com",
    )
    // END MULTI_LABEL_SUFFIXES

    /** Two-letter TLDs where any of these labels is a public suffix (`<sld>.<cc>`). */
    private val GENERIC_CC_SLDS = hashSetOf("co", "com", "org", "net", "gov", "edu", "ac", "or", "ne", "go")

    private val IPV4 = Regex("^\\d{1,3}(?:\\.\\d{1,3}){3}$")

    /** Hostname of `url`, lowercased and without a trailing dot; null when it has none. */
    fun hostnameOf(url: String): String? {
        var start = url.indexOf("://")
        if (start == -1) {
            val host = runCatching { URI(url).host }.getOrNull() ?: return null
            return if (host.isEmpty()) null else host.lowercase()
        }
        start += 3
        var end = url.length
        for (i in start until url.length) {
            val c = url[i]
            if (c == '/' || c == '?' || c == '#') {
                end = i
                break
            }
        }
        var authority = url.substring(start, end)
        val at = authority.lastIndexOf('@')
        if (at != -1) authority = authority.substring(at + 1)
        if (authority.startsWith("[")) {
            val close = authority.indexOf(']')
            return if (close == -1) null else authority.substring(0, close + 1).lowercase()
        }
        val colon = authority.indexOf(':')
        if (colon != -1) authority = authority.substring(0, colon)
        if (authority.endsWith(".")) authority = authority.dropLast(1)
        return if (authority.isEmpty()) null else authority.lowercase()
    }

    /**
     * The origin of an `http(s)` (or `ws(s)`) URL as Chromium spells it – lowercase scheme and
     * host, the port when it is not the scheme's default; null for other schemes and for URLs
     * without a host (the desktop's `originOf` answers null for opaque origins the same way).
     */
    fun originOf(url: String): String? {
        val schemeEnd = url.indexOf("://")
        if (schemeEnd == -1) return null
        val scheme = url.substring(0, schemeEnd).lowercase()
        if (scheme != "http" && scheme != "https" && scheme != "ws" && scheme != "wss") return null
        val host = hostnameOf(url) ?: return null
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
        val port = if (colon == -1) null else authority.substring(colon + 1).toIntOrNull()
        val default = if (scheme == "http" || scheme == "ws") 80 else 443
        return if (port == null || port == default) "$scheme://$host" else "$scheme://$host:$port"
    }

    /**
     * The registrable domain of a hostname (`a.b.example.co.uk` → `example.co.uk`). IP literals
     * and single-label hosts are returned unchanged.
     */
    fun registrableDomain(hostname: String): String {
        val host = hostname.lowercase().removeSuffix(".")
        if (host.isEmpty() || IPV4.matches(host) || host.startsWith("[") || !host.contains('.')) return host
        val labels = host.split('.')
        // Longest matching multi-label suffix wins (`s3.amazonaws.com` over `amazonaws.com`).
        var take = minOf(4, labels.size - 1)
        while (take >= 2) {
            val suffix = labels.subList(labels.size - take, labels.size).joinToString(".")
            if (MULTI_LABEL_SUFFIXES.contains(suffix)) {
                return labels.subList(labels.size - take - 1, labels.size).joinToString(".")
            }
            take--
        }
        if (labels.size >= 3) {
            val tld = labels[labels.size - 1]
            val sld = labels[labels.size - 2]
            if (tld.length == 2 && GENERIC_CC_SLDS.contains(sld)) return labels.subList(labels.size - 3, labels.size).joinToString(".")
        }
        return labels.subList(labels.size - 2, labels.size).joinToString(".")
    }

    /** Registrable domain of a URL, or null for URLs without a host. */
    fun domainOf(url: String): String? = hostnameOf(url)?.let(::registrableDomain)

    /** `host` equals `domain` or is one of its subdomains. */
    fun hostMatchesDomain(host: String, domain: String): Boolean {
        if (host == domain) return true
        return host.length > domain.length && host.endsWith(domain) && host[host.length - domain.length - 1] == '.'
    }

    /**
     * Whether `url` is third party to `initiator` (an origin or URL). A request without an
     * initiator is first party (top-level navigations); one from a non-http(s) initiator is third party.
     */
    fun isThirdParty(url: String, initiator: String?): Boolean {
        if (initiator.isNullOrEmpty()) return false
        val a = domainOf(url)
        val b = domainOf(initiator)
        if (a == null || b == null) return true
        return a != b
    }
}
