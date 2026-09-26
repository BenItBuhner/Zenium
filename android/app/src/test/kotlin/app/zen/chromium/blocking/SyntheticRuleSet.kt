package app.zen.chromium.blocking

import org.json.JSONObject
import java.util.Random

/**
 * A rule set of the shape of a uBlock Origin Lite default ruleset – the round-21 extension's
 * 61 K rules ("Adblock Ad Blocker Pro", a uBO Lite fork) – synthesised, since the repository
 * holds no real one, so the engine's memory can be measured on the JVM ([RuleMemoryTest]) and
 * the reader's moves pinned against a set of that size. The mix follows the brief: ≈ 70 %
 * `urlFilter`-only rules (three quarters of them `||host^`, the rest path patterns), ≈ 20 % with
 * an `initiatorDomains` / `excludedInitiatorDomains` list of 1–30 domains drawn from a pool of
 * 5 000 (the lists themselves from a pool of [DOMAIN_LISTS], as one `$domain=` list serves many
 * filter lines), ≈ 5 % `requestDomains`, ≈ 3 % `regexFilter`, ≈ 2 % `modifyHeaders` / `redirect`.
 * Deterministic for a seed; `only` narrows the set to one kind for per-kind measurements.
 */
internal object SyntheticRuleSet {
    enum class Kind { URL_FILTER, INITIATOR_DOMAINS, REQUEST_DOMAINS, REGEX, HEADERS_OR_REDIRECT }

    const val DOMAIN_POOL = 5_000
    const val DOMAIN_LISTS = 3_000

    private val SYLLABLES = arrayOf("ad", "trk", "pix", "stat", "cdn", "media", "serve", "click", "banner", "metric", "tag", "sync", "beacon", "promo", "yield", "bid")
    private val TLDS = arrayOf("com", "com", "com", "net", "org", "io", "co", "de", "fr", "ru")
    private val TYPE_LISTS = arrayOf(
        null,
        """["script"]""",
        """["image"]""",
        """["script","image"]""",
        """["script","xmlhttprequest"]""",
        """["sub_frame"]""",
        """["image","media","font"]""",
        """["script","image","xmlhttprequest","sub_frame","other"]"""
    )

    /** The kind of rule `k` in the default mix (the proportions above, interleaved per hundred so any prefix of the set keeps the mix). */
    fun kindOf(k: Int): Kind = when (k % 100) {
        in 0..69 -> Kind.URL_FILTER
        in 70..89 -> Kind.INITIATOR_DOMAINS
        in 90..94 -> Kind.REQUEST_DOMAINS
        in 95..97 -> Kind.REGEX
        else -> Kind.HEADERS_OR_REDIRECT
    }

    private fun domain(random: Random, index: Int): String =
        SYLLABLES[random.nextInt(SYLLABLES.size)] + SYLLABLES[random.nextInt(SYLLABLES.size)] + index + "." + TLDS[random.nextInt(TLDS.size)]

    private fun host(random: Random, index: Int): String {
        val sub = if (random.nextInt(3) == 0) SYLLABLES[random.nextInt(SYLLABLES.size)] + "." else ""
        return sub + SYLLABLES[random.nextInt(SYLLABLES.size)] + index + "." + TLDS[random.nextInt(TLDS.size)]
    }

    /** 1–30, mostly small (a geometric tail), as `$domain=` lists are. */
    private fun listSize(random: Random): Int = (1 + (-Math.log(1 - random.nextDouble()) * 4).toInt()).coerceAtMost(30)

    /** The rules of the set, each as a JSON object's text. */
    fun rules(count: Int, seed: Long = 1L, only: Kind? = null): List<String> {
        val random = Random(seed)
        val domains = Array(DOMAIN_POOL) { domain(random, it) }
        val lists = Array(DOMAIN_LISTS) {
            val size = listSize(random)
            val picked = LinkedHashSet<String>()
            while (picked.size < size) picked.add(domains[random.nextInt(DOMAIN_POOL)])
            picked.joinToString(",") { JSONObject.quote(it) }
        }
        val out = ArrayList<String>(count)
        for (k in 0 until count) {
            val kind = only ?: kindOf(k)
            val id = k + 1
            val priority = if (random.nextInt(10) == 0) 2 + random.nextInt(4) else 1
            val types = TYPE_LISTS[random.nextInt(TYPE_LISTS.size)]
            val condition = StringBuilder()
            var action = """{"type":"block"}"""
            when (kind) {
                Kind.URL_FILTER -> {
                    val filter = if (random.nextInt(4) != 0) "||" + host(random, id) + "^" else pathPattern(random, id)
                    condition.append(""""urlFilter":${JSONObject.quote(filter)}""")
                    if (random.nextInt(3) == 0) condition.append(""","domainType":"thirdParty"""")
                    if (random.nextInt(20) == 0) action = """{"type":"allow"}"""
                    if (random.nextInt(500) == 0) {
                        action = """{"type":"allowAllRequests"}"""
                        condition.setLength(0)
                        condition.append(""""urlFilter":${JSONObject.quote("||" + host(random, id) + "^")},"resourceTypes":["main_frame","sub_frame"]""")
                    }
                }
                Kind.INITIATOR_DOMAINS -> {
                    val filter = if (random.nextInt(2) == 0) "||" + host(random, id) + "^" else pathPattern(random, id)
                    val key = if (random.nextInt(10) < 7) "initiatorDomains" else "excludedInitiatorDomains"
                    condition.append(""""urlFilter":${JSONObject.quote(filter)},"$key":[${lists[random.nextInt(DOMAIN_LISTS)]}]""")
                }
                Kind.REQUEST_DOMAINS -> {
                    if (random.nextInt(2) == 0) condition.append(""""urlFilter":${JSONObject.quote(pathPattern(random, id))},""")
                    condition.append(""""requestDomains":[${lists[random.nextInt(DOMAIN_LISTS)]}]""")
                }
                Kind.REGEX -> {
                    val regex = "^https?://[a-z0-9-]+\\." + domains[random.nextInt(DOMAIN_POOL)].replace(".", "\\.") +
                        "/(ads|track|pixel)" + id + "/[a-z0-9]{4,}\\.js"
                    condition.append(""""regexFilter":${JSONObject.quote(regex)}""")
                    if (random.nextInt(4) == 0) condition.append(""","isUrlFilterCaseSensitive":true""")
                }
                Kind.HEADERS_OR_REDIRECT -> {
                    condition.append(""""urlFilter":${JSONObject.quote("||" + host(random, id) + "^")}""")
                    action = if (random.nextInt(2) == 0) {
                        if (random.nextInt(2) == 0) """{"type":"modifyHeaders","requestHeaders":[{"header":"cookie","operation":"remove"},{"header":"referer","operation":"remove"}]}"""
                        else """{"type":"modifyHeaders","responseHeaders":[{"header":"set-cookie","operation":"remove"}]}"""
                    } else """{"type":"redirect","redirect":{"url":"data:text/javascript,"}}"""
                }
            }
            val withTypes = if (types != null && kind != Kind.HEADERS_OR_REDIRECT && !condition.contains("resourceTypes")) {
                (if (condition.isEmpty()) "" else ",") + """"resourceTypes":$types"""
            } else ""
            out.add("""{"id":$id,"priority":$priority,"action":$action,"condition":{$condition$withTypes}}""")
        }
        return out
    }

    private fun pathPattern(random: Random, id: Int): String = when (random.nextInt(4)) {
        0 -> "/" + SYLLABLES[random.nextInt(SYLLABLES.size)] + "/" + SYLLABLES[random.nextInt(SYLLABLES.size)] + id + "."
        1 -> "-" + SYLLABLES[random.nextInt(SYLLABLES.size)] + "-" + id + ".js"
        2 -> "||" + host(random, id) + "/" + SYLLABLES[random.nextInt(SYLLABLES.size)] + "/*"
        else -> "/" + SYLLABLES[random.nextInt(SYLLABLES.size)] + id + "_*.gif"
    }

    /** The `rules` array's text. */
    fun rulesArray(count: Int, seed: Long = 1L, only: Kind? = null): String = "[" + rules(count, seed, only).joinToString(",") + "]"

    /** A set document as `RuleSetStore` writes it (`{"id", "rules"}`, `store.ts`'s `SetDocument`). */
    fun document(id: String, count: Int, seed: Long = 1L, only: Kind? = null): String =
        """{"id":${JSONObject.quote(id)},"rules":${rulesArray(count, seed, only)}}"""
}
