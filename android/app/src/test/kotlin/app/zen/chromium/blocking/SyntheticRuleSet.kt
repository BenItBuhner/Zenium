package app.zen.chromium.blocking

import org.json.JSONObject
import java.util.Random

/**
 * A rule set of the shape of the round-21 extension's ("Adblock Ad Blocker Pro", a uBlock Origin
 * Lite fork; 61 714 rules on the phone), synthesised – the repository holds no real one – so the
 * engine's memory can be measured on the JVM ([RuleMemoryTest]) and the reader's moves pinned
 * against a set of that size. Two sources shape it. Round 21's census of the extension's rules,
 * the count carrying each condition field ([CENSUS]), is reproduced exactly at [CENSUS_RULES]
 * rules and in proportion at any other count, with `stevenblack-hosts`'s 108 195 domains in one
 * rule's `requestDomains` ([HOSTS_RULE_DOMAINS]) and, after uBO Lite's two largest lists (the
 * hostname folds of easylist and easyprivacy, 48 868 and 43 095 domains), two more rules with
 * a list of that order ([MEGA_LIST_DOMAINS]). uBlock Origin Lite's own rulesets (2026.920, 70 285 rules,
 * read once for calibration and not shipped) give the distributions the census has no column
 * for: list sizes (median 1, 90th percentile 4, yet 118 of 13 700 lists exceed 64 domains and
 * hold 84 % of all domain references), how far lists repeat domains (60 % of the references in
 * lists of up to 64 domains are distinct, 94 % of those in larger ones – a hosts file repeats
 * nothing), `urlFilter` shapes (`||host/path` 51 %, `/path` 18 %, a `||host` prefix, a `*` and
 * a `/path` 15 %; a bare `||host^` almost never, since uBO Lite folds hostname filters into `requestDomains` lists),
 * lengths (domains 17.5 chars, filters 30), actions (block 83.5 %, allow 10.8 %, redirect 5.4 %,
 * modifyHeaders 0.2 %) and `resourceTypes` counts (1.4 per list). Deterministic for a seed;
 * `only` narrows the set to one kind of rule for the per-kind measurements.
 */
internal object SyntheticRuleSet {
    /** One kind of rule, for per-kind measurements ([rules] with `only`). */
    enum class Kind { URL_FILTER, URL_FILTER_TYPED, INITIATOR_DOMAINS, REQUEST_DOMAINS, REGEX, HEADERS_OR_REDIRECT }

    /** The extension's rule count on the phone, at which [CENSUS] is reproduced exactly. */
    const val CENSUS_RULES = 61_714

    /** Rules carrying each condition field (round 21's final; `regexFilter`: none). */
    val CENSUS: Map<String, Int> = linkedMapOf(
        "urlFilter" to 60_665,
        "resourceTypes" to 14_416,
        "initiatorDomains" to 7_553,
        "domainType" to 7_021,
        "excludedInitiatorDomains" to 571,
        "excludedRequestDomains" to 429,
        "requestDomains" to 400,
        "excludedResourceTypes" to 214,
        "requestMethods" to 17,
        "responseHeaders" to 4
    )

    /** `stevenblack-hosts`: one rule's `requestDomains`. */
    const val HOSTS_RULE_DOMAINS = 108_195

    /** uBO Lite's largest list after the hosts rule (easylist's hostname fold): two rules carry one this size. */
    const val MEGA_LIST_DOMAINS = 48_868
    private const val MEGA_LISTS = 2

    /** The share of the remaining lists that exceed 64 domains: 116 of 13 698 in uBO Lite. */
    private const val BIG_LIST_SHARE = 116.0 / 13_698

    /** Domains the small lists draw from at [CENSUS_RULES] rules (60 % of their references come out distinct). */
    private const val SITE_POOL = 20_000

    /** Domains the big lists draw from (94 % of their references come out distinct). */
    private const val BIG_POOL = 540_000

    /** Hostnames the `||host/path` patterns are built on. */
    private const val PATTERN_HOSTS = 24_000

    /** Where the hosts and mega lists' domains start: their own range, so they repeat nothing. */
    private const val FOLDED_FROM = 1_000_000

    private val SYLLABLES = arrayOf(
        "ad", "trk", "pix", "stat", "cdn", "media", "serve", "click", "banner", "metric",
        "tag", "sync", "beacon", "promo", "yield", "bid", "count", "log", "track", "img"
    )
    private val TLDS = arrayOf("com", "com", "com", "com", "net", "org", "io", "co", "de", "fr", "ru", "info")
    private val TYPES = arrayOf("script", "image", "xmlhttprequest", "sub_frame", "media", "font", "stylesheet", "other", "websocket", "ping")

    /** The domain at `index` of the shared name space: distinct per index, 13–20 characters, as hosts files' names run. */
    private fun domain(index: Int): String {
        val sb = StringBuilder(24)
        sb.append(SYLLABLES[index % SYLLABLES.size]).append(SYLLABLES[(index / SYLLABLES.size) % SYLLABLES.size])
        if (index % 3 == 0) sb.append(SYLLABLES[(index / 400) % SYLLABLES.size])
        return sb.append(index).append('.').append(TLDS[(index / 7) % TLDS.size]).toString()
    }

    /** The `i`th domain of the hosts rule's list (the folded range): for requests that must meet it. */
    fun foldedDomain(i: Int): String = domain(FOLDED_FROM + i)

    private fun syllable(random: Random): String = SYLLABLES[random.nextInt(SYLLABLES.size)]

    /** `count` of `total` marked at random (a partial Fisher–Yates shuffle). */
    private fun marks(random: Random, total: Int, count: Int): BooleanArray {
        val out = BooleanArray(total)
        if (count <= 0) return out
        val indices = IntArray(total) { it }
        for (j in 0 until minOf(count, total)) {
            val k = j + random.nextInt(total - j)
            val t = indices[j]
            indices[j] = indices[k]
            indices[k] = t
            out[indices[j]] = true
        }
        return out
    }

    /** A list's size other than the hosts and mega lists': uBO Lite's distribution. */
    private fun listSize(random: Random): Int {
        val u = random.nextDouble()
        return when {
            // 0.85 %: over 64, mean ≈ 465, about one in eleven over 1 024.
            u < BIG_LIST_SHARE -> 65 + (-Math.log(1 - random.nextDouble()) * 400).toInt()
            // 2 %: 8–64.
            u < 0.03 -> 8 + random.nextInt(57)
            // The rest: median 1, 90th percentile 4.
            else -> 1 + (-Math.log(1 - random.nextDouble()) * 1.3).toInt()
        }
    }

    /** A domain list's JSON text: `size` distinct domains, small lists from the site pool, big ones from the big pool. */
    private fun list(random: Random, size: Int, sitePool: Int): String {
        val picked = LinkedHashSet<String>(size * 2)
        val pool = if (size > 64) BIG_POOL else sitePool
        while (picked.size < size) picked.add(domain(random.nextInt(pool)))
        return picked.joinToString(",", "[", "]") { "\"$it\"" }
    }

    /** `size` consecutive domains of the folded range, from `from`. */
    private fun folded(from: Int, size: Int): String {
        val sb = StringBuilder(size * 20).append('[')
        for (i in 0 until size) {
            if (i > 0) sb.append(',')
            sb.append('"').append(domain(from + i)).append('"')
        }
        return sb.append(']').toString()
    }

    private fun urlFilter(random: Random, id: Int): String {
        val host = domain(random.nextInt(PATTERN_HOSTS))
        val u = random.nextInt(100)
        return when {
            u < 51 -> "||$host/${syllable(random)}/${syllable(random)}$id."
            u < 69 -> "/${syllable(random)}/${syllable(random)}$id."
            u < 84 -> "||$host*/${syllable(random)}$id"
            u < 89 -> "${syllable(random)}-${syllable(random)}$id"
            u < 93 -> "||$host"
            u < 96 -> "||$host^"
            u < 98 -> "*/${syllable(random)}$id/*"
            else -> "|https://$host/${syllable(random)}$id|"
        }
    }

    private fun types(random: Random): String {
        val n = when (random.nextInt(10)) {
            in 0..6 -> 1
            in 7..8 -> 2
            else -> 3
        }
        val picked = LinkedHashSet<String>()
        while (picked.size < n) picked.add(TYPES[random.nextInt(TYPES.size)])
        return picked.joinToString(",", "[", "]") { "\"$it\"" }
    }

    private fun action(random: Random): String = when (random.nextInt(1000)) {
        in 0..834 -> """{"type":"block"}"""
        in 835..942 -> """{"type":"allow"}"""
        in 943..997 -> """{"type":"redirect","redirect":{"url":"https://ext.example/noop.js"}}"""
        998 -> """{"type":"modifyHeaders","requestHeaders":[{"header":"cookie","operation":"remove"},{"header":"referer","operation":"remove"}]}"""
        else -> """{"type":"modifyHeaders","responseHeaders":[{"header":"set-cookie","operation":"remove"}]}"""
    }

    /** `census` of [CENSUS_RULES] rules, in proportion for `count` (never below one when the census has any). */
    private fun scaled(census: Int, count: Int): Int =
        if (census == 0) 0 else maxOf(1, Math.round(census.toDouble() * count / CENSUS_RULES).toInt())

    /**
     * The rules of the set, each as a JSON object's text. Without `only`, the extension's census
     * in proportion: rule ids run from 1; the hosts rule is the first `requestDomains` rule, the
     * two mega lists the next two.
     */
    fun rules(count: Int, seed: Long = 1L, only: Kind? = null): List<String> {
        val random = Random(seed)
        val sitePool = maxOf(64, SITE_POOL.toLong() * count / CENSUS_RULES).toInt()
        val out = ArrayList<String>(count)
        if (only != null) {
            for (k in 0 until count) out.add(ofKind(only, random, k + 1, sitePool))
            return out
        }
        val has = CENSUS.mapValues { (_, n) -> marks(random, count, scaled(n, count)) }
        val requestDomains = has.getValue("requestDomains")
        var hostsAt = requestDomains.indexOfFirst { it }
        if (hostsAt < 0) {
            hostsAt = 0
            requestDomains[0] = true
        }
        var megaLeft = MEGA_LISTS
        var nextFolded = FOLDED_FROM
        for (k in 0 until count) {
            val id = k + 1
            val condition = ArrayList<String>(6)
            val folded = requestDomains[k] && (k == hostsAt || megaLeft > 0 && k > hostsAt)
            if (folded) {
                val size = if (k == hostsAt) scaled(HOSTS_RULE_DOMAINS, count) else scaled(MEGA_LIST_DOMAINS, count).also { megaLeft-- }
                condition.add(""""requestDomains":${folded(nextFolded, size)}""")
                nextFolded += size
            } else {
                if (has.getValue("urlFilter")[k]) condition.add(""""urlFilter":${JSONObject.quote(urlFilter(random, id))}""")
                if (requestDomains[k]) condition.add(""""requestDomains":${list(random, listSize(random), sitePool)}""")
            }
            if (has.getValue("initiatorDomains")[k]) condition.add(""""initiatorDomains":${list(random, listSize(random), sitePool)}""")
            if (has.getValue("excludedInitiatorDomains")[k]) condition.add(""""excludedInitiatorDomains":${list(random, listSize(random), sitePool)}""")
            if (has.getValue("excludedRequestDomains")[k]) condition.add(""""excludedRequestDomains":${list(random, listSize(random), sitePool)}""")
            if (has.getValue("resourceTypes")[k]) condition.add(""""resourceTypes":${types(random)}""")
            if (has.getValue("excludedResourceTypes")[k]) condition.add(""""excludedResourceTypes":["main_frame"]""")
            if (has.getValue("domainType")[k]) condition.add(""""domainType":"${if (random.nextInt(10) == 0) "firstParty" else "thirdParty"}"""")
            if (has.getValue("requestMethods")[k]) condition.add(""""requestMethods":["${if (random.nextBoolean()) "get" else "post"}"]""")
            if (has.getValue("responseHeaders")[k]) condition.add(""""responseHeaders":[{"header":"content-type","values":["text/html*"]}]""")
            val priority = if (random.nextInt(10) == 0) 2 + random.nextInt(4) else 1
            out.add("""{"id":$id,"priority":$priority,"action":${action(random)},"condition":{${condition.joinToString(",")}}}""")
        }
        return out
    }

    private fun ofKind(kind: Kind, random: Random, id: Int, sitePool: Int): String {
        val condition = StringBuilder()
        var action = """{"type":"block"}"""
        when (kind) {
            Kind.URL_FILTER -> condition.append(""""urlFilter":${JSONObject.quote(urlFilter(random, id))}""")
            Kind.URL_FILTER_TYPED ->
                condition.append(""""urlFilter":${JSONObject.quote(urlFilter(random, id))},"resourceTypes":${types(random)},"domainType":"thirdParty"""")
            Kind.INITIATOR_DOMAINS -> {
                val key = if (random.nextInt(10) < 9) "initiatorDomains" else "excludedInitiatorDomains"
                condition.append(""""urlFilter":${JSONObject.quote(urlFilter(random, id))},"$key":${list(random, listSize(random), sitePool)}""")
            }
            // A `requestDomains`-only rule with a big list (uBO Lite's fold of hostname filters): 65 up, mean ≈ 465.
            Kind.REQUEST_DOMAINS ->
                condition.append(""""requestDomains":${list(random, 65 + (-Math.log(1 - random.nextDouble()) * 400).toInt(), sitePool)}""")
            Kind.REGEX -> {
                val regex = "^https?://[a-z0-9-]+\\." + domain(random.nextInt(PATTERN_HOSTS)).replace(".", "\\.") +
                    "/(ads|track|pixel)" + id + "/[a-z0-9]{4,}\\.js"
                condition.append(""""regexFilter":${JSONObject.quote(regex)}""")
                if (random.nextInt(4) == 0) condition.append(""","isUrlFilterCaseSensitive":true""")
            }
            Kind.HEADERS_OR_REDIRECT -> {
                condition.append(""""urlFilter":${JSONObject.quote(urlFilter(random, id))}""")
                action = if (random.nextInt(2) == 0) {
                    if (random.nextInt(2) == 0) """{"type":"modifyHeaders","requestHeaders":[{"header":"cookie","operation":"remove"},{"header":"referer","operation":"remove"}]}"""
                    else """{"type":"modifyHeaders","responseHeaders":[{"header":"set-cookie","operation":"remove"}]}"""
                } else """{"type":"redirect","redirect":{"url":"https://ext.example/noop.js"}}"""
            }
        }
        val priority = if (random.nextInt(10) == 0) 2 + random.nextInt(4) else 1
        return """{"id":$id,"priority":$priority,"action":$action,"condition":{$condition}}"""
    }

    /** The `rules` array's text. */
    fun rulesArray(count: Int, seed: Long = 1L, only: Kind? = null): String = rules(count, seed, only).joinToString(",", "[", "]")

    /** A set document as `RuleSetStore` writes it (`{"id", "rules"}`, `store.ts`'s `SetDocument`). */
    fun document(id: String, count: Int, seed: Long = 1L, only: Kind? = null): String =
        """{"id":${JSONObject.quote(id)},"rules":${rulesArray(count, seed, only)}}"""
}
