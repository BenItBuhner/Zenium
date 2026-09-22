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
 * sensitivity, `|` literals, partitions, response header conditions), a `user` set and
 * `builtin:site-exceptions`; the index loaded through [IndexReader] as the engine loads it and
 * through [RuleSetInfo.parse] as the fixtures do. Every decision must be the same rule, target
 * and filter, not just the same effect: `matchedRule` feeds `getMatchedRules` and
 * `onRuleMatchedDebug`, and two equal redirects must name the target the desktop names. Adopted
 * from the services review of #164.
 *
 * Both stages are compared, as the desktop's `indexDifferential.test.ts` compares them: the
 * request stage for every probe, and the headers-received stage – `decide(req, headers)` against
 * `decideLinear(req, headers)` with a response's headers indexed as the relay indexes them
 * ([HeaderCondition.index]) – for every probe whose request-stage allow asked for it
 * ([Decision.needsHeaders], the relay's second decision) and for one probe in four regardless.
 * The corpus's three header-conditioned rules (an `x-ads` presence block, a `content-type`
 * -excluded allow, Stylus's `.user.css` redirect on `content-type: text/css*`) sit on hosts and a
 * path shape the generated URLs rarely produce, so a fixed set of targeted probes puts each
 * through every header map, and the pass asserts what it saw: requests decided twice, header-stage
 * decisions by a header-conditioned rule, a block and a redirect among them, a header stage that
 * differs from its request stage and one that is the same (the relay's `sameMatch`), and the
 * stages' contract (section 6.2 of the blocking rule interface note): a header-conditioned rule
 * never decides the request stage, a header stage that names another match names a
 * header-conditioned rule, and a request the request stage did not flag decides the same with
 * any headers.
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
            a.matchedRule == b.matchedRule && a.matchedFilter == b.matchedFilter && a.needsHeaders == b.needsHeaders &&
            a.requestHeaderEdits == b.requestHeaderEdits && a.responseHeaderEdits == b.responseHeaderEdits

    private fun show(d: Decision) =
        "${d.action} url=${d.redirectUrl} set=${d.matchedSet} rule=${d.matchedRule} filter=${d.matchedFilter} headers=${d.needsHeaders} edits=${d.requestHeaderEdits}/${d.responseHeaderEdits}"

    /**
     * Response headers as the relay hands them to the engine (`HeaderStage.relay`): a fetch's
     * `headerFields` – the status line under a null key, names in the wire's case – through
     * [HeaderCondition.index], which drops the status line and lowercases the names. Between them
     * they satisfy and fail each of the corpus's header conditions (`x-ads` present or absent,
     * `content-type` a CSS type, HTML, another type, absent); the last carries both in mixed case.
     */
    private val headerMaps: List<Map<String, List<String>>> = listOf(
        mapOf("X-Ads" to listOf("1")),
        mapOf("Content-Type" to listOf("text/css; charset=utf-8")),
        mapOf("Content-Type" to listOf("text/html")),
        mapOf("Content-Type" to listOf("application/json")),
        emptyMap(),
        mapOf("X-ADS" to listOf("banner"), "CONTENT-type" to listOf("TEXT/CSS"), "Set-Cookie" to listOf("a=1", "b=2")),
        mapOf("Content-Type" to listOf("text/css"), "x-frame-options" to listOf("DENY")),
        mapOf("Content-Type" to listOf("text/html; charset=utf-8"), "X-Frame-Options" to listOf("SAMEORIGIN"))
    ).map { wire ->
        val fields = LinkedHashMap<String?, List<String>?>()
        fields[null] = listOf("HTTP/1.1 200 OK")
        fields.putAll(wire)
        HeaderCondition.index(fields)
    }

    private fun rule(id: Int, action: String, condition: JSONObject, priority: Int = 1, redirect: String? = null): JSONObject {
        val a = JSONObject().put("type", action)
        if (redirect != null) a.put("redirect", JSONObject().put("url", redirect))
        return JSONObject().put("id", id).put("priority", priority).put("action", a).put("condition", condition)
    }

    /** A `modifyHeaders` rule with `requestOps` / `responseOps` as `[header, operation, value?]` triples. */
    private fun headerRule(id: Int, condition: JSONObject, priority: Int = 1, requestOps: List<List<String?>> = emptyList(), responseOps: List<List<String?>> = emptyList()): JSONObject {
        fun ops(list: List<List<String?>>): JSONArray {
            val out = JSONArray()
            for (op in list) {
                val o = JSONObject().put("header", op[0]).put("operation", op[1])
                if (op.size > 2 && op[2] != null) o.put("value", op[2])
                out.put(o)
            }
            return out
        }
        val a = JSONObject().put("type", "modifyHeaders")
        if (requestOps.isNotEmpty()) a.put("requestHeaders", ops(requestOps))
        if (responseOps.isNotEmpty()) a.put("responseHeaders", ops(responseOps))
        return JSONObject().put("id", id).put("priority", priority).put("action", a).put("condition", condition)
    }

    /** One `HeaderCondition` on `header`, on its presence alone or on `values`. */
    private fun headerConditions(header: String, vararg values: String): JSONArray {
        val condition = JSONObject().put("header", header)
        if (values.isNotEmpty()) condition.put("values", JSONArray(values.toList()))
        return JSONArray().put(condition)
    }

    private fun isHeaderConditioned(rule: JSONObject): Boolean {
        val c = rule.optJSONObject("condition") ?: return false
        return c.has("responseHeaders") || c.has("excludedResponseHeaders")
    }

    private fun entry(id: String, source: String, priority: Int, rules: JSONArray, partitions: List<String>? = null, updatedAt: Long = 0L): JSONObject {
        val o = JSONObject().put("id", id).put("source", source).put("priority", priority).put("enabled", true)
        if (updatedAt != 0L) o.put("updatedAt", updatedAt)
        o.put("hasFilterText", false).put("filterCount", 0)
        if (partitions != null) o.put("partitions", JSONArray(partitions))
        o.put("rules", rules)
        return o
    }

    /** The golden fixture – the store's summary and its `sets/` document – as one entry with the rules inline. */
    private fun connectivityProbesEntry(): JSONObject {
        val fixtures = File(repoRoot(), "android/app/src/test/resources/blocking")
        val summary = JSONObject(File(fixtures, "connectivity-probes.json").readText())
        val document = JSONObject(File(fixtures, summary.getString("document")).readText())
        assertEquals(summary.getString("id"), document.getString("id"))
        summary.remove("document")
        summary.remove("tag")
        summary.remove("ruleCount")
        return summary.put("rules", document.getJSONArray("rules"))
    }

    /**
     * The layout the store writes and the engine reads on a device (`store.ts`, version 2): the
     * index as summaries naming one document per set, the rules in those documents. The tag is
     * opaque to the reader (it compares tags, never computes them), so any function of the
     * document's text will do here.
     */
    private fun splitIntoSetDocuments(inline: JSONObject): Pair<String, Map<String, String>> {
        val documents = LinkedHashMap<String, String>()
        val summaries = JSONArray()
        val sets = inline.getJSONArray("sets")
        for (i in 0 until sets.length()) {
            val entry = JSONObject(sets.getJSONObject(i).toString())
            val rules = entry.optJSONArray("rules") ?: JSONArray()
            entry.remove("rules")
            entry.put("ruleCount", rules.length())
            if (rules.length() > 0) {
                val name = "sets/${entry.getString("id").replace(Regex("[^A-Za-z0-9._-]"), "_")}.json"
                val text = JSONObject().put("id", entry.getString("id")).put("rules", rules).toString()
                documents[name] = text
                entry.put("document", name).put("tag", "${Integer.toHexString(text.length)}-${Integer.toHexString(text.hashCode())}")
            }
            summaries.put(entry)
        }
        return JSONObject().put("version", 2).put("sets", summaries).toString(2) to documents
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
        // Header rules, which stack in scan order (the desktop differential's `hdr.example` shapes):
        // on hosts the lists and the generated rules leave alone, and on a list host too.
        a.put(headerRule(id++, JSONObject().put("urlFilter", "||hdr.example^"), priority = 2, requestOps = listOf(listOf("x-a", "set", "1"))))
        a.put(headerRule(id++, JSONObject().put("requestDomains", JSONArray(listOf("hdr.example", "hdr2.example"))).put("resourceTypes", JSONArray(listOf("script", "image", "main_frame"))), priority = 2, responseOps = listOf(listOf("x-b", "remove"))))
        a.put(headerRule(id++, JSONObject().put("regexFilter", "\\.(png|gif)$"), requestOps = listOf(listOf("x-c", "append", "c"))))
        a.put(rule(id++, "allow", JSONObject().put("urlFilter", "||hdr2.example/assets/quiet^")))
        a.put(headerRule(id++, JSONObject().put("urlFilter", "||${hosts[15]}^"), priority = 2, requestOps = listOf(listOf("user-agent", "set", "Zenium-UA-Test/1.0"), listOf("x-requested-with", "remove")), responseOps = listOf(listOf("x-frame-options", "remove"), listOf("content-security-policy", "set", "default-src 'self'"))))
        // Header-conditioned rules: decided at the headers-received stage only (`decide` with the
        // response's headers, which the relay reaches for documents); the request stage marks an
        // allow they could overturn `needsHeaders` and never names them.
        a.put(rule(id++, "block", JSONObject().put("urlFilter", "||${hosts[13]}^").put("responseHeaders", headerConditions("x-ads"))))
        a.put(rule(id++, "allow", JSONObject().put("requestDomains", JSONArray(listOf(hosts[14]))).put("excludedResponseHeaders", headerConditions("content-type", "text/html*")), priority = 3))
        // A header-conditioned edit: its response edit joins the request stage's at the header stage, its request edit is dropped.
        a.put(headerRule(id++, JSONObject().put("requestDomains", JSONArray(listOf("hdr.example", "hdr2.example", hosts[15]))).put("responseHeaders", headerConditions("x-frame-options")), requestOps = listOf(listOf("x-dropped", "set", "1")), responseOps = listOf(listOf("x-frame-options", "remove"))))
        // A header-conditioned allow that caps the request stage's weaker edits once the response is not HTML.
        a.put(rule(id++, "allow", JSONObject().put("urlFilter", "||${hosts[15]}^").put("excludedResponseHeaders", headerConditions("content-type", "text/html*")), priority = 2))
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
            val action = listOf("block", "block", "block", "allow", "redirect", "upgradeScheme", "modifyHeaders")[random.nextInt(7)]
            if (action == "modifyHeaders") {
                // Header edits over the hosts the request stage's rules cover: the index must
                // stack them as the scan does (highest effective priority first, then in scan
                // order), whichever way it reaches them.
                val ops = listOf(listOf("x-gen-$i", "set", "g$i"), listOf("x-shared", "append", "s$i"), listOf("x-requested-with", "remove"), listOf("user-agent", "set", "Zenium-UA-Test/$i"))
                val requestOps = if (random.nextBoolean()) listOf(ops[random.nextInt(ops.size)]) else emptyList()
                val responseOps = if (requestOps.isEmpty() || random.nextInt(3) == 0) listOf(listOf(pick(listOf("x-frame-options", "set-cookie", "x-r-$i")), pick(listOf("remove", "set", "append")), "r$i")) else emptyList()
                a.put(headerRule(id++, cond, 1 + random.nextInt(3), requestOps, responseOps))
            } else {
                a.put(rule(id++, action, cond, 1 + random.nextInt(3), if (action == "redirect") "https://safe.example/${pick(words)}/$i" else null))
            }
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
        // Stylus's `.user.css` install redirect, conditioned on the response's content type.
        b.put(rule(id++, "redirect", JSONObject().put("regexFilter", "\\.user\\.css$").put("resourceTypes", JSONArray(listOf("main_frame"))).put("responseHeaders", headerConditions("content-type", "text/css*")), redirect = "https://safe.example/install-usercss"))
        val sets = JSONArray()
        sets.put(connectivityProbesEntry())
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
        val (summaries, setDocuments) = splitIntoSetDocuments(indexJson)
        assertTrue("the index is summaries only: ${summaries.length} chars", summaries.length < 4_000)

        // Loaded exactly as the engine does (IndexReader over the summaries and the set documents)
        // and as the fixtures do (org.json over the entries with their rules inline): the same
        // sets, priorities, partitions and rule counts, and every declared rule compiled.
        val opened = ArrayList<String>()
        val reader = IndexReader { line -> throw AssertionError("a set was left out: $line") }
        val streamed = reader.read(summaries) { name -> opened.add(name); setDocuments[name] }
        assertEquals("every set document opened once", setDocuments.keys.toList(), opened)
        val setsJson = indexJson.getJSONArray("sets")
        val document = (0 until setsJson.length()).mapNotNull { RuleSetInfo.parse(setsJson.getJSONObject(it)) }
        assertEquals(document.map { it.id }, streamed.map { it.id })
        for ((s, d) in streamed.zip(document)) {
            assertEquals("rule count of ${s.id}", d.rules.size, s.rules.size)
            assertEquals("rule ids of ${s.id}", d.rules.map { it.id }, s.rules.map { it.id })
            assertEquals("partitions of ${s.id}", d.partitions, s.partitions)
            assertEquals("priority of ${s.id}", d.priority, s.priority)
        }
        // The same summaries again: no document opened, every set's compiled rules the previous read's.
        val again = reader.read(summaries) { name -> opened.add(name); setDocuments[name] }
        assertEquals(setDocuments.size, opened.size)
        for ((s, a) in streamed.zip(again)) assertTrue("compiled rules of ${s.id} shared", s.compiled === a.compiled)
        // The inline shape (version 1) still reads to the same sets: the first start after the migration.
        val legacy = IndexReader().read(indexJson.toString(2))
        assertEquals(streamed.map { it.id }, legacy.map { it.id })
        assertEquals(streamed.map { it.rules.map { r -> r.id } }, legacy.map { it.rules.map { r -> r.id } })
        val declared = (0 until setsJson.length()).sumOf { setsJson.getJSONObject(it).getJSONArray("rules").length() }
        // Header-conditioned rules compile like the rest (their header stage is the relay's);
        // `ruleCount` carries them, `headerRuleCount` counts them, through the streaming reader
        // and the document parser alike.
        val headerConditioned = (0 until setsJson.length()).sumOf { s ->
            val rules = setsJson.getJSONObject(s).getJSONArray("rules")
            (0 until rules.length()).count { isHeaderConditioned(rules.getJSONObject(it)) }
        }
        assertEquals("header-conditioned rules in the corpus", 5, headerConditioned)
        val editing = (0 until setsJson.length()).sumOf { s ->
            val rules = setsJson.getJSONObject(s).getJSONArray("rules")
            (0 until rules.length()).count { rules.getJSONObject(it).getJSONObject("action").getString("type") == "modifyHeaders" }
        }
        assertTrue("modifyHeaders rules in the corpus: $editing", editing > 100)
        val text = TextEngine.parse(texts)
        val snap = EngineSnapshot(streamed, text)
        assertEquals("every declared rule compiled (declared $declared)", declared, snap.ruleCount)
        assertEquals("header-conditioned rules counted", headerConditioned, snap.headerRuleCount)
        assertEquals("modifyHeaders rules counted", editing, snap.modifyHeadersRuleCount)
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

        // The corpus's header-conditioned rules by set, from the JSON: the request stage never names one.
        val headerRuleIds = HashMap<String, Set<Int>>()
        for (s in 0 until setsJson.length()) {
            val set = setsJson.getJSONObject(s)
            val rules = set.getJSONArray("rules")
            val ids = (0 until rules.length()).map { rules.getJSONObject(it) }.filter { isHeaderConditioned(it) }.map { it.getInt("id") }.toSet()
            if (ids.isNotEmpty()) headerRuleIds[set.getString("id")] = ids
        }
        assertEquals(headerConditioned, headerRuleIds.values.sumOf { it.size })
        fun byHeaderRule(d: Decision) = d.matchedSet != null && headerRuleIds[d.matchedSet]?.contains(d.matchedRule) == true

        var total = 0
        var decidedByRule = 0
        var redirected = 0
        var edited = 0  // request-stage `modifyHeaders` decisions
        var stacked = 0  // ... with the edits of more than one rule
        var editedTwice = 0  // header-stage `modifyHeaders` decisions whose response edits grew (a header-conditioned edit joined)
        // The header-stage pass: what the linear reference decided (the index agreed, or `mismatches` says where not).
        var decidedTwice = 0  // header-stage decisions after a request-stage allow with `needsHeaders` (the relay's second decision)
        var direct = 0  // header-stage decisions of probes that arrived there regardless of `needsHeaders`
        var headerStageNamed = 0  // header-stage decisions naming a set (a rule or a filter)
        var headerStageByRule = 0  // header-stage decisions naming a header-conditioned rule
        var headerStageBlocks = 0  // ... a block among them
        var headerStageRedirects = 0  // ... a redirect with its target among them
        var differing = 0  // of `decidedTwice`: another match than the request stage's (the relay reports it)
        var sameAsRequestStage = 0  // of `decidedTwice`: the request stage's match again (the relay's `sameMatch`, reported once)
        val mismatches = ArrayList<String>()
        val violations = ArrayList<String>()

        fun describe(req: Request, headers: Map<String, List<String>>?) =
            "${req.url} type=${req.type} mask=${Integer.toHexString(req.typeMask)} doc=${req.documentUrl} method=${req.method} tab=${req.tabId} partition=${req.partition} headers=${headers ?: "none"}"

        /** One stage of one request through both resolutions; `headers` null at the request stage. */
        fun check(req: Request, headers: Map<String, List<String>>?, indexed: Decision, linear: Decision) {
            if (!same(indexed, linear) && mismatches.size < 40) {
                mismatches.add("${describe(req, headers)}\n    index : ${show(indexed)}\n    linear: ${show(linear)}")
            }
            if (headers == null) {
                for (d in listOf(indexed, linear)) {
                    if (byHeaderRule(d) && violations.size < 40) violations.add("a header-conditioned rule decided the request stage: ${describe(req, null)}\n    ${show(d)}")
                }
            }
            for (d in listOf(indexed, linear)) {
                // Edits ride on a `modifyHeaders` decision only (a block, redirect or allow carries none).
                if (violations.size < 40 && d.editsHeaders && d.action != Decision.Action.MODIFY_HEADERS) {
                    violations.add("a decision other than modifyHeaders carries edits: ${describe(req, headers)}\n    ${show(d)}")
                }
            }
        }

        /**
         * One request through the stages as the host takes them: the request stage always; the
         * header stage – for each of `maps`, as the relay would with the response's headers –
         * when the request stage's allow asked for it (`needsHeaders`) or when the probe
         * `arrivesDirectly` at the header stage, `needsHeaders` or not (the desktop differential's
         * one request in four), so the header branch of `Resolution.claim` runs for rules that
         * raised `lateEffective` and for the header-conditioned allow that did not.
         */
        fun probe(req: Request, maps: List<Map<String, List<String>>>, arrivesDirectly: Boolean) {
            val early = snap.decideLinear(req)
            check(req, null, snap.decide(req), early)
            total++
            if (early.matchedSet != null) decidedByRule++
            if (early.redirectUrl != null) redirected++
            if (early.action == Decision.Action.MODIFY_HEADERS) {
                edited++
                if (early.requestHeaderEdits.size + early.responseHeaderEdits.size > 1) stacked++
            }
            if (!early.needsHeaders && !arrivesDirectly) return
            for (headers in maps) {
                val late = snap.decideLinear(req, headers)
                check(req, headers, snap.decide(req, headers), late)
                if (arrivesDirectly) direct++
                if (late.action == Decision.Action.MODIFY_HEADERS && late.responseHeaderEdits.size > early.responseHeaderEdits.size) editedTwice++
                if (late.matchedSet != null) headerStageNamed++
                if (byHeaderRule(late)) {
                    headerStageByRule++
                    if (late.action == Decision.Action.BLOCK) headerStageBlocks++
                    if (late.action == Decision.Action.REDIRECT && late.redirectUrl != null) headerStageRedirects++
                }
                if (early.needsHeaders) {
                    decidedTwice++
                    if (HeaderStage.sameMatch(late, early)) sameAsRequestStage++ else differing++
                }
                if (violations.size < 40) {
                    // The stages' contract (6.2): a header stage that names another match than the
                    // request stage's names a header-conditioned rule (a late allow yields), and a
                    // request the request stage did not flag decides the same with any headers – no
                    // relay is owed where the header stage could change nothing.
                    if (!HeaderStage.sameMatch(late, early) && !byHeaderRule(late)) {
                        violations.add("the header stage named another match than a header-conditioned rule: ${describe(req, headers)}\n    request: ${show(early)}\n    headers: ${show(late)}")
                    }
                    if (!early.needsHeaders && !same(early, late)) {
                        violations.add("the header stage changed a decision the request stage did not flag: ${describe(req, headers)}\n    request: ${show(early)}\n    headers: ${show(late)}")
                    }
                }
            }
        }

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
            // The response's headers, should the header stage be reached, and whether it is reached regardless.
            val headers = headerMaps[random.nextInt(headerMaps.size)]
            probe(req, listOf(headers), arrivesDirectly = random.nextInt(4) == 0)
        }

        // Targeted probes: the header-conditioned rules sit on hosts and a path shape the generated
        // URLs rarely produce – `.user.css` navigations (set B's redirect on `content-type:
        // text/css*`), documents and frames on hosts[13] (set A's `x-ads` block), requests on
        // hosts[14] (set A's allow on everything but HTML) – so each goes through every map: on
        // hosts the other sets speak for too (the user set's allow on hosts[0] and block on
        // hosts[7], the site exception on hosts[11]), in partitions the sets are and are not scoped
        // to, with a query the anchored regex rejects, over `http:` (the request stage blocks the
        // navigation outright), as subresources the relay never carries but the engine decides,
        // and on hosts[13] as a `.user.css` navigation both header rules select (rank breaks the tie).
        val targeted = ArrayList<Request>()
        val adsHost = listHosts[13]
        val allowHost = listHosts[14]
        for (h in listOf("x.example", "cdn.x.example", "intranet", "accounts.google.com", listHosts[0], listHosts[7], listHosts[11], adsHost, allowHost, listHosts[42])) {
            targeted.add(Request("https://$h/hello.user.css", ResourceType.MAIN_FRAME, null, "GET", tabId = "tab-7", partition = "default"))
            targeted.add(Request("https://$h/themes/Dark.user.css", ResourceType.MAIN_FRAME, null, "GET", partition = "work"))
        }
        targeted.add(Request("https://x.example/hello.user.css", ResourceType.MAIN_FRAME, null, "GET", partition = "private"))
        targeted.add(Request("https://x.example/hello.user.css", ResourceType.MAIN_FRAME, null, "GET", partition = null))
        targeted.add(Request("https://x.example/hello.user.css?v=3", ResourceType.MAIN_FRAME, null, "GET", partition = "default"))
        targeted.add(Request("http://x.example/hello.user.css", ResourceType.MAIN_FRAME, null, "GET", partition = "default"))
        targeted.add(Request("https://x.example/hello.user.css", ResourceType.MAIN_FRAME, null, "POST", partition = "default"))
        targeted.add(Request("https://x.example/hello.user.css", ResourceType.SUB_FRAME, "https://news.example/", partition = "default"))
        targeted.add(Request("https://x.example/hello.user.css", ResourceType.STYLESHEET, "https://x.example/", partition = "default"))
        for (partition in listOf("default", "work", "private", null)) {
            targeted.add(Request("https://$adsHost/", ResourceType.MAIN_FRAME, null, "GET", partition = partition))
        }
        targeted.add(Request("https://$adsHost/news/story.html?id=7", ResourceType.MAIN_FRAME, null, "GET", tabId = "tab-9", partition = "default"))
        targeted.add(Request("https://www.$adsHost/index.html", ResourceType.MAIN_FRAME, null, "GET", partition = "default"))
        targeted.add(Request("http://$adsHost/", ResourceType.MAIN_FRAME, null, "GET", partition = "default"))
        targeted.add(Request("https://$adsHost/frame.html", ResourceType.SUB_FRAME, "https://news.example/story", partition = "default"))
        targeted.add(Request("https://$adsHost/frame.html", ResourceType.SUB_FRAME, "https://$adsHost/", partition = "default"))
        targeted.add(Request("https://$adsHost/a.js", ResourceType.SCRIPT, "https://news.example/story", partition = "default"))
        targeted.add(Request("https://$adsHost/site.css", ResourceType.STYLESHEET, "https://news.example/story", partition = "default"))
        targeted.add(Request("https://$adsHost/font.woff2", ResourceType.FONT, "https://$adsHost/", partition = "work"))
        targeted.add(Request("https://$allowHost/", ResourceType.MAIN_FRAME, null, "GET", partition = "default"))
        targeted.add(Request("https://$allowHost/frame.html", ResourceType.SUB_FRAME, "https://news.example/story", partition = "default"))
        targeted.add(Request("https://$allowHost/lib.js", ResourceType.SCRIPT, "https://news.example/story", partition = "default"))
        targeted.add(Request("https://$allowHost/style.css", ResourceType.STYLESHEET, "https://$allowHost/", partition = "default"))
        // The header rules' hosts: the quiet ones and hosts[15], where the UA edit, the
        // header-conditioned edit and the header-conditioned allow that caps the weaker edits meet
        // the generated rules of the same host.
        val uaHost = listHosts[15]
        for (h in listOf("hdr.example", "hdr2.example", "cdn.hdr.example", uaHost, "www.$uaHost")) {
            for (partition in listOf("default", "work", null)) {
                targeted.add(Request("https://$h/", ResourceType.MAIN_FRAME, null, "GET", tabId = "tab-7", partition = partition))
                targeted.add(Request("https://$h/index.html", ResourceType.MAIN_FRAME, null, "GET", partition = partition))
            }
            targeted.add(Request("https://$h/assets/quiet/style.css", ResourceType.STYLESHEET, "https://$h/", partition = "default"))
            targeted.add(Request("https://$h/assets/quiet/index.html", ResourceType.SUB_FRAME, "https://$h/", partition = "default"))
            targeted.add(Request("https://$h/frame.html", ResourceType.SUB_FRAME, "https://news.example/story", partition = "default"))
            targeted.add(Request("https://$h/img/pixel.gif", ResourceType.IMAGE, "https://news.example/story", partition = "default"))
            targeted.add(Request("https://$h/img/banner.png", ResourceType.IMAGE, "https://$h/", partition = "work"))
            targeted.add(Request("https://$h/a.js", ResourceType.SCRIPT, "https://$h/", partition = "default"))
            targeted.add(Request("https://$h/api/collect", ResourceType.XMLHTTPREQUEST, "https://$h/", "POST", partition = "default", typeMask = ResourceType.AMBIGUOUS_MASK))
            targeted.add(Request("http://$h/", ResourceType.MAIN_FRAME, null, "GET", partition = "default"))
        }
        for (req in targeted) probe(req, headerMaps, arrivesDirectly = true)

        assertTrue("decided something: $decidedByRule of $total", decidedByRule > 500)
        assertTrue("redirected something: $redirected", redirected > 50)
        assertTrue("decided twice (needsHeaders, then with headers): $decidedTwice", decidedTwice > 20)
        assertTrue("arrived at the header stage directly: $direct", direct > 20)
        assertTrue("header-stage decisions naming a rule: $headerStageNamed", headerStageNamed > 20)
        assertTrue("header-stage decisions by a header-conditioned rule: $headerStageByRule", headerStageByRule > 20)
        assertTrue("header-stage blocks by a header-conditioned rule: $headerStageBlocks", headerStageBlocks >= 1)
        assertTrue("header-stage redirects by a header-conditioned rule: $headerStageRedirects", headerStageRedirects >= 1)
        assertTrue("header stage differing from the request stage: $differing", differing >= 1)
        assertTrue("header stage the same as the request stage (the relay's sameMatch): $sameAsRequestStage", sameAsRequestStage >= 1)
        assertTrue("header rules applied: $edited", edited > 10)
        assertTrue("the edits of more than one rule stacked: $stacked", stacked > 5)
        assertTrue("a header-conditioned edit joined at the header stage: $editedTwice", editedTwice >= 1)
        // The run's numbers, for the record (the JUnit report's system-out).
        println(
            "IndexDifferential: $total request-stage probes, $decidedByRule decided by a rule, $redirected redirected, " +
                "$decidedTwice decided twice (needsHeaders), $direct at the header stage directly, $headerStageNamed header-stage decisions naming a rule " +
                "($headerStageByRule by a header-conditioned rule: $headerStageBlocks blocks, $headerStageRedirects redirects), " +
                "$differing differing from / $sameAsRequestStage the same as the request stage, " +
                "$edited modifyHeaders decisions ($stacked with more than one rule's edits, $editedTwice whose response edits grew at the header stage), " +
                "${mismatches.size} mismatches, ${violations.size} invariant violations"
        )
        assertTrue("mismatches:\n" + mismatches.joinToString("\n"), mismatches.isEmpty())
        assertTrue("invariants:\n" + violations.joinToString("\n"), violations.isEmpty())
    }

    // --- The modifyHeaders golden fixture, shared with the desktop's `indexDifferential.test.ts` ---

    /** A decision in the fixture's shape (the desktop `Decision`'s field names; empty edit lists written, `needsHeaders` only when true). */
    private fun fixtureShape(d: Decision): JSONObject {
        val out = JSONObject()
        out.put(
            "action",
            when (d.action) {
                Decision.Action.ALLOW -> "allow"
                Decision.Action.BLOCK -> "block"
                Decision.Action.REDIRECT -> "redirect"
                Decision.Action.UPGRADE -> "upgrade"
                Decision.Action.MODIFY_HEADERS -> "modifyHeaders"
            }
        )
        if (d.redirectUrl != null) out.put("redirectUrl", d.redirectUrl)
        if (d.matchedSet != null) {
            val matched = JSONObject().put("setId", d.matchedSet)
            if (d.matchedFilter != null) matched.put("filter", d.matchedFilter) else matched.put("ruleId", d.matchedRule)
            out.put("matched", matched)
        }
        if (d.action == Decision.Action.MODIFY_HEADERS) {
            fun ops(list: List<HeaderOp>): JSONArray {
                val arr = JSONArray()
                for (op in list) {
                    val o = JSONObject().put("header", op.header).put("operation", op.operation.dnrName)
                    if (op.value != null) o.put("value", op.value)
                    arr.put(o)
                }
                return arr
            }
            out.put("requestHeaders", ops(d.requestHeaderEdits))
            out.put("responseHeaders", ops(d.responseHeaderEdits))
        }
        if (d.needsHeaders) out.put("needsHeaders", true)
        return out
    }

    /** `org.json` has no deep equality: compare the canonical text of the two. */
    private fun canonical(o: Any?): String = when (o) {
        is JSONObject -> o.keys().asSequence().sorted().joinToString(",", "{", "}") { "\"$it\":${canonical(o.get(it))}" }
        is JSONArray -> (0 until o.length()).joinToString(",", "[", "]") { canonical(o.get(it)) }
        is String -> JSONObject.quote(o)
        else -> o.toString()
    }

    /**
     * Both engines read `modify-headers.json` – User-Agent Switcher's session rule, two more
     * extensions' header edits, the user's and the site exceptions' sets – and must decide each
     * probe as the fixture says: the same action, the same match, the same edits in the same
     * order, `needsHeaders` alike; the header stage with the fixture's response headers where it
     * gives them. The desktop's `indexDifferential.test.ts` asserts the same file; a change to
     * either engine's stacking shows up here first.
     */
    @Test
    fun bothEnginesProduceTheSameEditsForTheModifyHeadersFixture() {
        val fixture = JSONObject(File(repoRoot(), "android/app/src/test/resources/blocking/modify-headers.json").readText())
        val setsJson = fixture.getJSONArray("sets")
        val sets = (0 until setsJson.length()).map { RuleSetInfo.parse(setsJson.getJSONObject(it)) ?: error("set ${it} did not parse") }
        val snap = EngineSnapshot(sets, null)
        assertEquals(setsJson.length(), sets.size)
        assertTrue("modifyHeaders rules in the fixture: ${snap.modifyHeadersRuleCount}", snap.modifyHeadersRuleCount >= 10)
        val probes = fixture.getJSONArray("probes")
        assertTrue("probes: ${probes.length()}", probes.length() >= 15)
        val failures = ArrayList<String>()
        var stages = 0
        for (i in 0 until probes.length()) {
            val probe = probes.getJSONObject(i)
            val r = probe.getJSONObject("request")
            val type = ResourceType.fromDnrName(r.getString("type")) ?: error("type ${r.getString("type")}")
            val req = Request(
                r.getString("url"), type, r.optString("documentUrl").ifEmpty { null }, r.optString("method", "GET"),
                thirdParty = if (r.has("thirdParty")) r.getBoolean("thirdParty") else null,
                partition = r.optString("partition").ifEmpty { null }
            )
            fun stage(expectedKey: String, headers: Map<String, List<String>>?) {
                val expected = probe.optJSONObject(expectedKey) ?: return
                stages++
                val linear = snap.decideLinear(req, headers)
                val indexed = snap.decide(req, headers)
                if (!same(indexed, linear)) failures.add("${probe.getString("name")}: index ${show(indexed)} / linear ${show(linear)}")
                val actual = canonical(fixtureShape(linear))
                if (actual != canonical(expected)) failures.add("${probe.getString("name")} ($expectedKey):\n    expected ${canonical(expected)}\n    actual   $actual")
            }
            stage("expected", null)
            probe.optJSONObject("responseHeaders")?.let { wire ->
                val fields = LinkedHashMap<String?, List<String>?>()
                fields[null] = listOf("HTTP/1.1 200 OK")
                for (name in wire.keys()) {
                    val values = wire.getJSONArray(name)
                    fields[name] = (0 until values.length()).map { values.getString(it) }
                }
                stage("expectedWithHeaders", HeaderCondition.index(fields))
            }
        }
        println("IndexDifferential fixture: ${probes.length()} probes, $stages stages decided through decide and decideLinear, ${failures.size} failures")
        assertTrue("stages decided: $stages", stages >= 20)
        assertTrue(failures.joinToString("\n"), failures.isEmpty())
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
