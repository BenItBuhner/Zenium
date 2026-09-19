package app.zen.chromium.blocking

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.util.zip.GZIPInputStream
import kotlin.random.Random

/**
 * The indexed resolution ([EngineSnapshot.decide]) against the reference scan
 * ([EngineSnapshot.decideLinear]) over what a device carries: the seven bundled filter lists
 * through [TextEngine.parse], the connectivity-probes golden fixture, two `ext:` sets shaped
 * like uBlock Origin Lite's static and dynamic rules (big `requestDomains`, `||host^`, regexes
 * with optional separators, initiator-only and excluded-only conditions, tab ids, methods, case
 * sensitivity, `|` literals, partitions), a `user` set and `builtin:site-exceptions`; the index
 * loaded through [IndexReader] as the engine loads it and through [RuleSetInfo.parse] as the
 * fixtures do. Every decision must be the same rule, target and filter, not just the same
 * effect: `matchedRule` feeds `getMatchedRules` and `onRuleMatchedDebug`, and two equal
 * redirects must name the target the desktop names. Adopted from the services review of #164.
 */
class IndexDifferentialTest {
    private fun repoRoot(): File {
        var dir: File? = File(".").absoluteFile
        while (dir != null) {
            if (File(dir, "resources/blocking/manifest.json").exists()) return dir
            dir = dir.parentFile
        }
        error("repo root with resources/blocking not found from ${File(".").absolutePath}")
    }

    private fun readGz(f: File): String = GZIPInputStream(f.inputStream()).bufferedReader().readText()

    private fun hostsOf(text: String, limit: Int): List<String> {
        val out = LinkedHashSet<String>()
        val re = Regex("""^\|\|([a-z0-9][a-z0-9.-]*\.[a-z]{2,})\^(\$.*)?$""")
        for (line in text.lineSequence()) {
            val m = re.find(line) ?: continue
            out.add(m.groupValues[1])
            if (out.size >= limit) break
        }
        return out.toList()
    }

    private fun same(a: Decision, b: Decision): Boolean =
        a.action == b.action && a.redirectUrl == b.redirectUrl && a.matchedSet == b.matchedSet &&
            a.matchedRule == b.matchedRule && a.matchedFilter == b.matchedFilter

    private fun show(d: Decision) = "${d.action} url=${d.redirectUrl} set=${d.matchedSet} rule=${d.matchedRule} filter=${d.matchedFilter}"

    private fun rule(id: Int, action: String, condition: JSONObject, priority: Int = 1, redirect: String? = null): JSONObject {
        val a = JSONObject().put("type", action)
        if (redirect != null) a.put("redirect", JSONObject().put("url", redirect))
        return JSONObject().put("id", id).put("priority", priority).put("action", a).put("condition", condition)
    }

    private fun entry(id: String, source: String, priority: Int, rules: JSONArray, partitions: List<String>? = null, updatedAt: Long = 0L): JSONObject {
        val o = JSONObject().put("id", id).put("source", source).put("priority", priority).put("enabled", true)
        if (updatedAt != 0L) o.put("updatedAt", updatedAt)
        o.put("hasFilterText", false).put("filterCount", 0)
        if (partitions != null) o.put("partitions", JSONArray(partitions))
        o.put("rules", rules)
        return o
    }

    /** Structured sets shaped like what the runtime persists (`ext:` sets) and the builtins. */
    private fun generatedIndex(hosts: List<String>, random: Random): JSONObject {
        val words = listOf("pixel", "track", "ad", "ads", "banner", "js", "img", "api", "beacon", "lib", "main", "generate_204", "collect", "stats")
        val types = ResourceType.entries.map { it.dnrName }
        val methods = listOf("get", "post", "head", "put")
        fun pick(list: List<String>) = list[random.nextInt(list.size)]
        fun host() = pick(hosts)
        fun rx(h: String) = h.replace(".", "\\.")

        // Set A: a uBOL-like static set: big requestDomains rule, ||host^ rules, regexes, wildcards.
        val a = JSONArray()
        var id = 1
        a.put(rule(id++, "block", JSONObject().put("requestDomains", JSONArray(hosts.take(300))).put("resourceTypes", JSONArray(listOf("script", "image", "xmlhttprequest", "sub_frame", "ping", "other")))))
        a.put(rule(id++, "block", JSONObject().put("requestDomains", JSONArray(hosts.drop(3000).take(300))).put("excludedRequestDomains", JSONArray(hosts.drop(3000).take(50))).put("excludedInitiatorDomains", JSONArray(hosts.take(20)))))
        a.put(rule(id++, "block", JSONObject().put("excludedRequestDomains", JSONArray(hosts.take(40))).put("resourceTypes", JSONArray(listOf("ping")))))  // excluded-only
        a.put(rule(id++, "block", JSONObject().put("excludedInitiatorDomains", JSONArray(hosts.take(40))).put("resourceTypes", JSONArray(listOf("websocket", "media")))))  // excluded-only initiators
        a.put(rule(id++, "block", JSONObject().put("urlFilter", "*").put("resourceTypes", JSONArray(listOf("ping")))))  // unscoped by type
        a.put(rule(id++, "block", JSONObject().put("resourceTypes", JSONArray(listOf("csp_report", "webtransport")))))  // type-only
        a.put(rule(id++, "block", JSONObject().put("excludedResourceTypes", JSONArray(listOf("main_frame", "sub_frame", "script", "image", "stylesheet", "font", "media", "xmlhttprequest"))).put("domainType", "thirdParty")))
        a.put(rule(id++, "block", JSONObject().put("urlFilter", "/ads/?").put("resourceTypes", JSONArray(listOf("script")))))  // urlFilter, `?` literal
        a.put(rule(id++, "block", JSONObject().put("regexFilter", "/ads/?").put("resourceTypes", JSONArray(listOf("script")))))  // regex, optional separator
        a.put(rule(id++, "block", JSONObject().put("regexFilter", "\\/(track|pixel)\\/[a-z]+\\.js").put("resourceTypes", JSONArray(listOf("script")))))
        a.put(rule(id++, "block", JSONObject().put("regexFilter", "^https?://[^/]+/collect\\?").put("resourceTypes", JSONArray(listOf("xmlhttprequest", "ping", "other")))))
        a.put(rule(id++, "block", JSONObject().put("regexFilter", "/beacon-?[0-9]*\\.gif").put("resourceTypes", JSONArray(listOf("image")))))
        a.put(rule(id++, "block", JSONObject().put("regexFilter", "/stats/{0,1}[a-z]+").put("excludedResourceTypes", JSONArray(listOf("main_frame")))))
        a.put(rule(id++, "block", JSONObject().put("regexFilter", "^http://[^/?#]*\\.[^/?#]*").put("resourceTypes", JSONArray(listOf("main_frame")))))
        a.put(rule(id++, "upgradeScheme", JSONObject().put("regexFilter", "^http://[^/?#]*\\.[^/?#]*").put("excludedRequestDomains", JSONArray(listOf("localhost")))))
        a.put(rule(id++, "block", JSONObject().put("urlFilter", "||ADS.example/Banner").put("isUrlFilterCaseSensitive", true)))
        a.put(rule(id++, "block", JSONObject().put("urlFilter", "|https://").put("requestMethods", JSONArray(listOf("post"))).put("resourceTypes", JSONArray(listOf("xmlhttprequest")))))
        a.put(rule(id++, "block", JSONObject().put("urlFilter", "^track|pixel^")))  // `|` literal inside a filter
        a.put(rule(id++, "block", JSONObject().put("urlFilter", "*/img/*banner*").put("excludedNonUniqueHosts", true)))
        for (i in 0 until 1200) {
            val h = host()
            val cond = JSONObject()
            when (random.nextInt(12)) {
                0 -> cond.put("urlFilter", "||$h^")
                1 -> cond.put("urlFilter", "||$h/${pick(words)}")
                2 -> cond.put("urlFilter", "||$h^*${pick(words)}=")
                3 -> cond.put("urlFilter", "/${pick(words)}/${pick(words)}^")
                4 -> cond.put("urlFilter", "${pick(words)}.${pick(words)}|")
                5 -> cond.put("regexFilter", "^https?://([^/]+\\.)?${rx(h)}/")
                6 -> cond.put("regexFilter", "/${pick(words)}/?[a-z]*\\.${pick(words)}")  // optional separator
                7 -> cond.put("initiatorDomains", JSONArray(listOf(h, host())))
                8 -> cond.put("requestDomains", JSONArray(listOf(h, host(), host())))
                9 -> cond.put("urlFilter", "|http://$h")
                10 -> { cond.put("urlFilter", "||$h^"); cond.put("initiatorDomains", JSONArray(listOf(host()))) }
                else -> cond.put("urlFilter", "*${pick(words)}*")
            }
            if (random.nextInt(3) == 0) cond.put("resourceTypes", JSONArray(listOf(pick(types), pick(types))))
            if (random.nextInt(7) == 0) cond.put("excludedResourceTypes", JSONArray(listOf(pick(types))))
            if (random.nextInt(6) == 0) cond.put("domainType", if (random.nextBoolean()) "thirdParty" else "firstParty")
            if (random.nextInt(8) == 0) cond.put("requestMethods", JSONArray(listOf(pick(methods))))
            if (random.nextInt(10) == 0) cond.put("excludedRequestMethods", JSONArray(listOf(pick(methods))))
            if (random.nextInt(10) == 0) cond.put("excludedInitiatorDomains", JSONArray(listOf(host())))
            if (random.nextInt(10) == 0) cond.put("excludedRequestDomains", JSONArray(listOf(host())))
            if (random.nextInt(12) == 0) cond.put("tabIds", JSONArray(listOf(7)))
            if (random.nextInt(12) == 0) cond.put("excludedNonUniqueHosts", true)
            val action = listOf("block", "block", "block", "allow", "redirect", "upgradeScheme")[random.nextInt(6)]
            a.put(rule(id++, action, cond, 1 + random.nextInt(3), if (action == "redirect") "https://safe.example/${pick(words)}/$i" else null))
        }
        // Set B: a dynamic set scoped to partitions, with allowAllRequests.
        val b = JSONArray()
        id = 1
        for (i in 0 until 300) {
            val h = host()
            val cond = JSONObject()
            when (random.nextInt(4)) {
                0 -> cond.put("urlFilter", "||$h^")
                1 -> cond.put("urlFilter", "|https://$h/").put("resourceTypes", JSONArray(listOf("main_frame", "sub_frame")))
                2 -> cond.put("requestDomains", JSONArray(listOf(h)))
                else -> cond.put("regexFilter", "^https://${rx(h)}/(ads|track)/?")
            }
            val action = listOf("allow", "allowAllRequests", "block", "redirect")[random.nextInt(4)]
            if (action == "allowAllRequests") cond.put("resourceTypes", JSONArray(listOf("main_frame", "sub_frame")))
            b.put(rule(id++, action, cond, 1 + random.nextInt(3), if (action == "redirect") "https://safe.example/b/$i" else null))
        }
        val sets = JSONArray()
        sets.put(JSONObject(File(repoRoot(), "android/app/src/test/resources/blocking/connectivity-probes.json").readText()))
        sets.put(entry("ext:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:static:ruleset_1", "dnr", 2999, a, partitions = listOf("default", "work"), updatedAt = 1789633817801L))
        sets.put(entry("ext:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:_dynamic", "dnr", 2999, b, partitions = listOf("default", "work", "private"), updatedAt = 1789633817802L))
        sets.put(entry("user", "user", 10, JSONArray().put(rule(1, "block", JSONObject().put("urlFilter", "||${hosts[7]}^"))).put(rule(2, "allow", JSONObject().put("urlFilter", "||${hosts[0]}^")))))
        sets.put(entry("builtin:site-exceptions", "builtin", 900, JSONArray().put(rule(1, "allowAllRequests", JSONObject().put("urlFilter", "|https://${hosts[11]}/").put("resourceTypes", JSONArray(listOf("main_frame", "sub_frame")))))))
        return JSONObject().put("version", 1).put("sets", sets)
    }

    @Test
    fun decideEqualsDecideLinearOverTheBundledListsAndGeneratedSets() {
        val root = repoRoot()
        val listDir = File(root, "resources/blocking")
        val texts = listOf("easylist", "easyprivacy", "peter-lowe", "ubo-filters", "ubo-privacy", "ubo-badware", "urlhaus").map { readGz(File(listDir, "$it.txt.gz")) }
        val listHosts = (hostsOf(texts[1], 4000) + hostsOf(texts[0], 2000) + hostsOf(texts[2], 1500)).distinct()
        assertTrue("hosts from the lists: ${listHosts.size}", listHosts.size > 5000)
        val random = Random(164)
        val indexJson = generatedIndex(listHosts, random)
        val raw = indexJson.toString(2)

        // Loaded exactly as the engine does (IndexReader) and as the fixtures do (org.json): the
        // same sets, priorities, partitions and rule counts, and every declared rule compiled.
        val streamed = IndexReader().read(raw)
        val setsJson = indexJson.getJSONArray("sets")
        val document = (0 until setsJson.length()).mapNotNull { RuleSetInfo.parse(setsJson.getJSONObject(it)) }
        assertEquals(document.map { it.id }, streamed.map { it.id })
        for ((s, d) in streamed.zip(document)) {
            assertEquals("rule count of ${s.id}", d.rules.size, s.rules.size)
            assertEquals("rule ids of ${s.id}", d.rules.map { it.id }, s.rules.map { it.id })
            assertEquals("partitions of ${s.id}", d.partitions, s.partitions)
            assertEquals("priority of ${s.id}", d.priority, s.priority)
        }
        val declared = (0 until setsJson.length()).sumOf { setsJson.getJSONObject(it).getJSONArray("rules").length() }
        val text = TextEngine.parse(texts)
        val snap = EngineSnapshot(streamed, text)
        assertEquals("every declared rule compiled (declared $declared)", declared, snap.ruleCount)
        assertEquals("the document parser's sets decide the same", declared, EngineSnapshot(document, text).ruleCount)
        assertTrue("filters loaded: ${snap.filterCount}", snap.filterCount > 50_000)

        val words = listOf("pixel", "track", "ad", "ads", "adsx", "banner", "js", "img", "api", "beacon", "beacon-12", "lib", "main", "generate_204", "collect", "stats", "statsx", "Banner", "trackXpixel", "track|pixel")
        val exts = listOf("js", "png", "gif", "css", "html", "json", "woff2", "mp4", "", "php")
        val types = ResourceType.entries
        val partitions = listOf("default", "default", "work", "private", null)
        val tabs = listOf("tab-7", "tab-9", "tab-12", null)
        val methods = listOf("GET", "GET", "POST", "HEAD", "PUT")
        fun pick(list: List<String>) = list[random.nextInt(list.size)]
        val extraHosts = listOf("ads.example", "www.ads.example", "localhost", "127.0.0.1", "intranet", "accounts.google.com", "www.gstatic.com", "x.example", "cdn.x.example")
        val allHosts = listHosts + extraHosts

        var total = 0
        var decidedByRule = 0
        var redirected = 0
        val mismatches = ArrayList<String>()
        repeat(12_000) {
            val h = if (random.nextInt(4) == 0) pick(extraHosts) else allHosts[random.nextInt(allHosts.size)]
            val scheme = if (random.nextInt(5) == 0) "http" else "https"
            val ext = pick(exts)
            val path = "/${pick(words)}/${pick(words)}" + (if (random.nextBoolean()) "/${pick(words)}" else "") + (if (ext.isEmpty()) "" else ".$ext") + (if (random.nextInt(3) == 0) "?x=${random.nextInt(9)}&id=${random.nextInt(99)}" else "")
            val url = "$scheme://$h$path"
            val navigation = random.nextInt(7) == 0
            val known = types[random.nextInt(types.size)]
            val unknown = !navigation && random.nextInt(4) == 0
            val type = if (navigation) ResourceType.MAIN_FRAME else if (unknown) ResourceType.XMLHTTPREQUEST else known
            val mask = if (unknown) ResourceType.AMBIGUOUS_MASK else type.bit
            val doc = when {
                navigation -> null
                random.nextInt(5) == 0 -> null
                random.nextInt(3) == 0 -> "https://$h/${pick(words)}"  // first party
                else -> "https://${allHosts[random.nextInt(allHosts.size)]}/${pick(words)}"  // third party (mostly)
            }
            val req = Request(url, type, doc, pick(methods), tabId = tabs[random.nextInt(tabs.size)], typeMask = mask, partition = partitions[random.nextInt(partitions.size)])
            val indexed = snap.decide(req)
            val linear = snap.decideLinear(req)
            total++
            if (linear.matchedSet != null) decidedByRule++
            if (linear.redirectUrl != null) redirected++
            if (!same(indexed, linear) && mismatches.size < 40) {
                mismatches.add("$url type=$type mask=${Integer.toHexString(mask)} doc=$doc method=${req.method} tab=${req.tabId} partition=${req.partition}\n    index : ${show(indexed)}\n    linear: ${show(linear)}")
            }
        }
        assertTrue("decided something: $decidedByRule of $total", decidedByRule > 500)
        assertTrue("redirected something: $redirected", redirected > 50)
        assertTrue("mismatches:\n" + mismatches.joinToString("\n"), mismatches.isEmpty())
    }

    /**
     * A literal separator the expression may leave out (a slash followed by `?`, `*` or
     * `{0,1}`, an escaped dot followed by `?`) is no token boundary: the URL's token runs on
     * (`/adsx`), and a rule indexed under the shorter token is never visited for it.
     */
    @Test
    fun aRegexWhoseSeparatorIsOptionalIsFoundForTheLongerToken() {
        fun set(regexes: List<String>): EngineSnapshot {
            val rules = JSONArray()
            regexes.forEachIndexed { i, r -> rules.put(rule(i + 1, "block", JSONObject().put("regexFilter", r))) }
            val info = RuleSetInfo.parse(entry("ext:x:_session", "dnr", 2999, rules)) ?: error("set")
            return EngineSnapshot(listOf(info), null)
        }
        val cases = listOf(
            listOf("/ads/?") to "https://x.example/adsx",
            listOf("\\/ads\\/?") to "https://x.example/adsx.js",
            listOf("/ads/*") to "https://x.example/adsfoo",
            listOf("/ads/{0,1}") to "https://x.example/adsfoo",
            listOf("/beacon-?[0-9]*\\.gif") to "https://x.example/beacon12.gif",
            listOf("^https://cdn\\.example/lib\\.?js", "^https://cdn\\.example/other") to "https://cdn.example/libjs"
        )
        val failures = ArrayList<String>()
        for ((regexes, url) in cases) {
            val snap = set(regexes)
            val req = Request(url, ResourceType.SCRIPT, "https://news.example/", partition = "default")
            val linear = snap.decideLinear(req)
            val indexed = snap.decide(req)
            assertEquals("the scan blocks $url by ${regexes[0]}", Decision.Action.BLOCK, linear.action)
            if (!same(indexed, linear)) failures.add("regexFilter ${regexes[0]} vs $url: index=${show(indexed)} linear=${show(linear)} (tokens ${UrlPattern.requiredTokensOf(regexes[0])})")
        }
        assertTrue(failures.joinToString("\n"), failures.isEmpty())
    }

    /**
     * On equal effective priority and action the first rule in the set's order wins, however
     * the index reaches it: the desktop engine's scan meets it first, so `matchedRule` and a
     * redirect's target agree with the desktop.
     */
    @Test
    fun aFullTieGoesToTheRuleTheScanMeetsFirst() {
        val rules = JSONArray()
        // Reached through the wildcard list (a regex with no complete token), the host map and
        // a token bucket respectively – the index visits them in the reverse of their positions.
        rules.put(rule(10, "redirect", JSONObject().put("regexFilter", "banner\\.js$"), redirect = "https://safe.example/wildcard"))
        rules.put(rule(11, "redirect", JSONObject().put("urlFilter", "||ads.example^"), redirect = "https://safe.example/host"))
        rules.put(rule(12, "redirect", JSONObject().put("urlFilter", "/banner.js"), redirect = "https://safe.example/token"))
        rules.put(rule(13, "block", JSONObject().put("urlFilter", "||ads.example^")))
        val info = RuleSetInfo.parse(entry("ext:x:_session", "dnr", 2999, rules)) ?: error("set")
        assertEquals(1, info.index.wildcardCount)
        assertEquals(1, info.index.tokenIndexedCount)
        val snap = EngineSnapshot(listOf(info), null)
        val req = Request("https://ads.example/banner.js", ResourceType.SCRIPT, "https://news.example/", partition = "default")
        val linear = snap.decideLinear(req)
        val indexed = snap.decide(req)
        // `block` outranks `redirect` at the same priority; among equals the lowest position wins.
        assertEquals(Decision.Action.BLOCK, linear.action)
        assertEquals(13, linear.matchedRule)
        assertTrue(show(indexed), same(indexed, linear))

        val redirects = JSONArray()
        for (i in 0 until 3) redirects.put(rules.getJSONObject(i))
        val onlyRedirects = RuleSetInfo.parse(entry("ext:x:_session", "dnr", 2999, redirects)) ?: error("set")
        val snap2 = EngineSnapshot(listOf(onlyRedirects), null)
        val linear2 = snap2.decideLinear(req)
        val indexed2 = snap2.decide(req)
        assertEquals("https://safe.example/wildcard", linear2.redirectUrl)
        assertEquals(10, linear2.matchedRule)
        assertTrue(show(indexed2), same(indexed2, linear2))

        // Across sets of one priority the ids order them, as the desktop orders its sets.
        val other = RuleSetInfo.parse(entry("ext:w:_session", "dnr", 2999, JSONArray().put(rule(1, "redirect", JSONObject().put("urlFilter", "||ads.example^"), redirect = "https://safe.example/w")))) ?: error("set")
        val snap3 = EngineSnapshot(listOf(onlyRedirects, other), null)
        val linear3 = snap3.decideLinear(req)
        val indexed3 = snap3.decide(req)
        assertEquals("ext:w:_session", linear3.matchedSet)
        assertEquals("https://safe.example/w", linear3.redirectUrl)
        assertTrue(show(indexed3), same(indexed3, linear3))
    }
}
