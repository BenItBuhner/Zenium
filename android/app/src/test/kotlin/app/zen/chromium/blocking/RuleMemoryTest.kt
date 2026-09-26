package app.zen.chromium.blocking

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.io.FileInputStream
import java.io.InputStreamReader
import java.io.Reader
import java.io.StringReader
import java.lang.reflect.Modifier
import java.util.IdentityHashMap
import java.util.regex.Pattern

/**
 * The DNR engine's resident memory for a rule set of the round-21 extension's shape and size,
 * measured on the JVM ([SyntheticRuleSet]: its census at 61 714 rules by default; `ZEN_DNR_RULES`
 * in the environment sets another count), and each of the reader's economies before and after.
 * Instruments: the heap's settled use before and after holding an object (`System.gc()` ×3,
 * `totalMemory - freeMemory`); the bytes the thread allocated (`ThreadMXBean`); the heap's high
 * water during a pass (a sampler thread reading the heap's use every millisecond, and the heap
 * pools' peaks); and [DeepSize], a walk of the object graph that sums HotSpot's shallow sizes
 * per class (64-bit, compressed references) – the retained size a heap-dump parser would report,
 * with the breakdown by class that says where the bytes are. None is ART's number: ART's object
 * header is 8 bytes to HotSpot's 12 and its `String` holds its characters inline (one object,
 * ~24 bytes less each), so the phone's figures sit some 10–20 % under the JVM's for the same
 * graph; the `Extensions.configure` heap line gives the device figure (44.2 MB for this
 * extension). The measurements print tables (the test report's standard output); the assertions
 * pin what the moves must keep: the rules and the decisions.
 */
class RuleMemoryTest {
    private val runtime = Runtime.getRuntime()

    /**
     * The JVM's management beans, reached by reflection: the unit tests compile against
     * `android.jar`, which has no `java.lang.management`, and run on HotSpot, which has.
     */
    private object Jvm {
        private val factory = Class.forName("java.lang.management.ManagementFactory")
        private val threads: Any = factory.getMethod("getThreadMXBean").invoke(null)
        private val allocatedBytes = Class.forName("com.sun.management.ThreadMXBean").getMethod("getThreadAllocatedBytes", java.lang.Long.TYPE)
        private val poolClass = Class.forName("java.lang.management.MemoryPoolMXBean")
        private val pools: List<Any> = (factory.getMethod("getMemoryPoolMXBeans").invoke(null) as List<*>)
            .filterNotNull()
            .filter { (poolClass.getMethod("getType").invoke(it) as Enum<*>).name == "HEAP" }
        private val resetPeak = poolClass.getMethod("resetPeakUsage")
        private val peakUsage = poolClass.getMethod("getPeakUsage")
        private val usedOf = Class.forName("java.lang.management.MemoryUsage").getMethod("getUsed")

        @Suppress("DEPRECATION")
        fun allocated(): Long = allocatedBytes.invoke(threads, Thread.currentThread().id) as Long

        fun resetPeaks() = pools.forEach { resetPeak.invoke(it) }

        /** The heap pools' peak use since [resetPeaks] (each pool's own peak, summed: an upper bound). */
        fun peak(): Long = pools.sumOf { usedOf.invoke(peakUsage.invoke(it)) as Long }
    }

    /** The heap's use sampled every millisecond while a pass runs: its high water. */
    private class HighWater(private val runtime: Runtime) : Thread("heap-high-water") {
        @Volatile private var running = true
        @Volatile var max = 0L
            private set

        override fun run() {
            while (running) {
                val used = runtime.totalMemory() - runtime.freeMemory()
                if (used > max) max = used
                try { sleep(1) } catch (e: InterruptedException) { return }
            }
        }

        fun finish(): Long {
            running = false
            join()
            return max
        }

        companion object {
            fun start(runtime: Runtime): HighWater = HighWater(runtime).also { it.isDaemon = true; it.start() }
        }
    }

    private fun used(): Long = runtime.totalMemory() - runtime.freeMemory()

    /**
     * The heap's use once the garbage is collected: full collections until two readings in a row
     * agree within 64 KB (three at least, eight at most). A phase's "before" and "after" are each
     * built, measured and walked inside their own function so that the other phase's graph is
     * unreachable – not merely dropped – when the baseline is read: a reference lingering in a
     * frame's slot would otherwise settle into the next phase's delta.
     */
    private fun settled(): Long {
        var last = -1L
        repeat(8) { round ->
            System.gc()
            System.runFinalization()
            Thread.sleep(30)
            val now = used()
            if (round >= 2 && Math.abs(now - last) < 64 * 1024) return now
            last = now
        }
        return last
    }

    /** Megabytes to one decimal; a delta within the collector's noise (50 KB either way) prints as zero, not "-0.0". */
    private fun mb(bytes: Long): String = String.format("%.1f MB", (if (Math.abs(bytes) < 52_429) 0L else bytes) / 1048576.0)

    private fun perRule(bytes: Long, rules: Int): String = String.format("%d B/rule", bytes / rules.coerceAtLeast(1))

    private fun per(bytes: Long, n: Int, what: String): String = String.format("%d B/%s", bytes / n.coerceAtLeast(1), what)

    private fun index(id: String, tag: String, enabled: Boolean = true) =
        """{"version":2,"sets":[{"id":"$id","source":"dnr","priority":2999,"enabled":$enabled,"hasFilterText":false,"filterCount":0,"updatedAt":1,"document":"sets/$id.json","tag":"$tag"}]}"""

    private fun sampleRequests(): List<Request> = listOf(
        Request("https://adtrk1.com/x.js", ResourceType.SCRIPT, "https://news.example/"),
        Request("https://cdn.pixstat77.net/ad/ad77.png", ResourceType.IMAGE, "https://news.example/"),
        Request("https://static.site.example/banner/-tag-9.js", ResourceType.SCRIPT, "https://adtrk12.com/"),
        Request("https://sub.servebid5.org/ads12/abcd.js", ResourceType.SCRIPT, "https://news.example/"),
        Request("https://${SyntheticRuleSet.foldedDomain(0)}/a.js", ResourceType.SCRIPT, "https://news.example/"),
        Request("https://cdn.${SyntheticRuleSet.foldedDomain(1_000)}/a.png", ResourceType.IMAGE, "https://news.example/"),
        Request("https://ok.example/page", ResourceType.MAIN_FRAME, null)
    )

    private fun decisions(sets: List<RuleSetInfo>): List<String> =
        EngineSnapshot(sets, null).let { snapshot -> sampleRequests().map { snapshot.decide(it).let { d -> "${d.action}:${d.matchedRule}" } } }

    /** A read of the census set from `documents`, the way `Blocking.readIndex` reads it (a `Reader` per document). */
    private fun read(enabled: Boolean = true, open: (String) -> Reader?): List<RuleSetInfo> =
        IndexReader().read(index(SET, TAG, enabled), IndexReader.Documents { name -> open(name) })

    private fun fromFile(): List<RuleSetInfo> = read { InputStreamReader(FileInputStream(file), Charsets.UTF_8) }

    private fun banner(title: String) = "\n=== $title: $count synthesised rules of the round-21 extension's census (HotSpot, compressed oops) ===\n"

    // ---- Part 1: the resident cost -------------------------------------------------------------

    @Test
    fun residentCostOfTheCensusShapedSet() {
        val out = StringBuilder(banner("DNR engine memory"))
        out.append("document text: ${document.length} chars (${mb(document.length.toLong())} as Latin-1 bytes; ${mb(2L * document.length)} as a char[]); ${file.length()} bytes on disk\n")
        val base = settled()
        var sets: List<RuleSetInfo>? = fromFile()
        val retained = settled() - base
        val compiled = sets!![0].compiled
        val n = compiled.rules.size
        assertTrue(n > count * 9 / 10)
        out.append("read from the file: retained CompiledRules ${mb(retained)} = ${perRule(retained, n)} for $n rules\n")
        out.append("decisions on the sample requests: ${decisions(sets!!)}\n")

        // --- Rules against index ---
        var rules: List<DnrRule>? = compiled.rules
        sets = null
        val rulesOnly = settled() - base
        var ruleIndex: RuleIndex? = RuleIndex(rules!!)
        val withIndex = settled() - base
        out.append("of which rules ${mb(rulesOnly)} = ${perRule(rulesOnly, n)}; the RuleIndex ${mb(withIndex - rulesOnly)} = ${perRule(withIndex - rulesOnly, n)} " +
            "(hosts ${ruleIndex!!.hostCount}, big-list rules ${ruleIndex!!.bigHostRuleCount}, initiators ${ruleIndex!!.initiatorCount}, token-indexed ${ruleIndex!!.tokenIndexedCount}, wildcard ${ruleIndex!!.wildcardCount})\n")

        // --- The graph walk: retained size by class ---
        val deep = DeepSize()
        deep.add(rules)
        val rulesDeep = deep.total
        deep.add(ruleIndex)
        out.append("graph walk: rules ${mb(rulesDeep)} = ${perRule(rulesDeep, n)}; with the index ${mb(deep.total)} = ${perRule(deep.total, n)}; ${deep.opaque} opaque objects\n")
        out.append(deep.table(14))

        // --- The strings' share ---
        out.append(census(document.substring(document.indexOf("\"rules\":") + 8, document.length - 1), rules!!))
        ruleIndex = null
        rules = null
        settled()

        // --- Per condition kind, through the reader ---
        out.append("per kind (rules of one kind, read from text):\n")
        for (kind in SyntheticRuleSet.Kind.entries) {
            val k = if (kind == SyntheticRuleSet.Kind.REQUEST_DOMAINS) 200 else 10_000
            val doc = SyntheticRuleSet.document("ext:test:$kind", k, seed = 7, only = kind)
            val b = settled()
            var s: List<RuleSetInfo>? = IndexReader().read(index("ext:test:$kind", "t2-0000000000000002"), IndexReader.Documents { StringReader(doc) })
            val retainedKind = settled() - b
            val rs = s!![0].compiled.rules
            val walk = DeepSize().also { it.add(rs) }
            val domains = rs.sumOf { (it.requestDomains?.size ?: 0) + (it.initiatorDomains?.size ?: 0) }
            out.append(String.format("  %-20s %6d rules: retained %s = %s (rules alone by the walk %s; %d chars of document per rule%s)\n",
                kind, rs.size, mb(retainedKind), perRule(retainedKind, rs.size), perRule(walk.total, rs.size), doc.length / k,
                if (domains > 0) "; $domains domains listed, ${per(retainedKind, domains, "domain")}" else ""))
            s = null
        }
        println(out)
    }

    /** Domain strings and lists, and hostname-anchored patterns: total references against distinct values – the interning headroom. */
    private fun census(rulesText: String, rules: List<DnrRule>): String {
        val arr = JSONArray(rulesText)
        val keys = listOf("initiatorDomains", "excludedInitiatorDomains", "requestDomains", "excludedRequestDomains")
        var refs = 0
        var chars = 0L
        val distinct = HashSet<String>()
        var lists = 0
        var bigLists = 0
        var bigRefs = 0
        val distinctBig = HashSet<String>()
        val distinctSmall = HashSet<String>()
        var smallRefs = 0
        val distinctLists = HashSet<String>()
        var listedRules = 0
        var biggest = 0
        for (i in 0 until arr.length()) {
            val c = arr.getJSONObject(i).optJSONObject("condition") ?: continue
            var listed = false
            for (key in keys) {
                val list = c.optJSONArray(key) ?: continue
                listed = true
                lists++
                val items = ArrayList<String>(list.length())
                for (j in 0 until list.length()) {
                    val d = list.getString(j).lowercase()
                    items.add(d)
                    refs++
                    chars += d.length
                    distinct.add(d)
                }
                if (items.size > biggest) biggest = items.size
                if (items.size > SortedDomainSet.THRESHOLD) {
                    bigLists++
                    bigRefs += items.size
                    distinctBig.addAll(items)
                } else {
                    smallRefs += items.size
                    distinctSmall.addAll(items)
                }
                items.sort()
                distinctLists.add(items.joinToString(","))
            }
            if (listed) listedRules++
        }
        var hosts = 0
        val distinctHosts = HashSet<String>()
        for (rule in rules) {
            val p = rule.pattern ?: continue
            if (p.hostname.isNotEmpty()) {
                hosts++
                distinctHosts.add(p.hostname)
            }
        }
        return "strings: $refs domain references ($chars chars) in $lists lists on $listedRules rules; ${distinct.size} distinct domains; ${distinctLists.size} distinct lists by content; the biggest list $biggest\n" +
            "  $bigLists lists over ${SortedDomainSet.THRESHOLD} hold $bigRefs references naming ${distinctBig.size} distinct domains; the other ${lists - bigLists} lists hold $smallRefs references naming ${distinctSmall.size}\n" +
            "  $hosts patterns anchored to a hostname, ${distinctHosts.size} distinct hostnames\n"
    }

    // ---- (a) a disabled set is not compiled ------------------------------------------------------

    @Test
    fun aDisabledSetCostsNoRuleUntilItIsEnabled() {
        val out = StringBuilder(banner("(a) disabled set"))
        val base = settled()
        var opened = 0
        var disabled: List<RuleSetInfo>? = read(enabled = false) { opened++; InputStreamReader(FileInputStream(file), Charsets.UTF_8) }
        val disabledRetained = settled() - base
        assertEquals(0, disabled!![0].rules.size)
        assertEquals(false, disabled!![0].enabled)
        assertEquals(0, opened)
        var enabled: List<RuleSetInfo>? = read { opened++; InputStreamReader(FileInputStream(file), Charsets.UTF_8) }
        val enabledRetained = settled() - base - disabledRetained
        assertEquals(1, opened)
        assertTrue(enabled!![0].rules.size > count * 9 / 10)
        out.append("before: a disabled set was compiled like an enabled one – ${mb(enabledRetained)} retained for ${enabled!![0].rules.size} rules, its document opened\n")
        out.append("after: the disabled set retains ${mb(disabledRetained)} (0 rules, document not opened); enabling it compiles it: ${mb(enabledRetained)}\n")
        out.append("(on the round-21 extension every set is enabled – 50 of 50 – so this move saves it nothing; it is the pin for the case)\n")
        disabled = null
        enabled = null
        println(out)
    }

    // ---- (b) the document streamed -----------------------------------------------------------------

    @Test
    fun streamingTheDocumentFromItsFileCutsTheTransientPeak() {
        val out = StringBuilder(banner("(b) streaming"))
        val rulesText = document.substring(document.indexOf("\"rules\":") + 8, document.length - 1)
        val chars = document.length.toLong()

        // Before (1): the tree parse – the legacy version-1 path, `CompiledRules.parse(JSONArray)`.
        var base = settled()
        var water = HighWater.start(runtime)
        Jvm.resetPeaks()
        var alloc0 = Jvm.allocated()
        var tree: JSONArray? = JSONArray(rulesText)
        val treeTop = used() - base
        var compiledTree: CompiledRules? = CompiledRules.parse(tree, 2999, "fp")
        val treeAlloc = Jvm.allocated() - alloc0
        val treePools = Jvm.peak() - base
        val treeWater = water.finish() - base
        tree = null
        val treeRetained = settled() - base
        val n = compiledTree!!.rules.size
        val treeDecisions = decisions(listOf(RuleSetInfo(SET, "dnr", 2999, true, compiledTree!!, false, null, 1, 0)))
        out.append("tree parse (the version-1 inline path): org.json tree at the top of the parse ${mb(treeTop)}; high water over base ${mb(treeWater)} (pool peaks ${mb(treePools)}); allocated ${mb(treeAlloc)}; retained ${mb(treeRetained)} = ${perRule(treeRetained, n)}; the document String itself is another ${mb(chars)} live\n")
        compiledTree = null
        settled()

        // Before (2): main's reader – the whole document as a String (`Storage.read`) and the cursor's char[] copy of it, both live for the parse.
        base = settled()
        water = HighWater.start(runtime)
        Jvm.resetPeaks()
        alloc0 = Jvm.allocated()
        var copy: CharArray? = document.toCharArray()
        var whole: List<RuleSetInfo>? = read { StringReader(document) }
        val wholeAlloc = Jvm.allocated() - alloc0
        val wholePools = Jvm.peak() - base
        val wholeWater = water.finish() - base
        assertEquals(n, whole!![0].rules.size)
        assertEquals(treeDecisions, decisions(whole!!))
        assertEquals(document.length, copy!!.size)
        copy = null
        val wholeRetained = settled() - base
        out.append("reader over the whole text (main's shape: the String and a char[] of it live, ${mb(chars)} + ${mb(2 * chars)}): high water over base ${mb(wholeWater)} (pool peaks ${mb(wholePools)}); allocated ${mb(wholeAlloc)}; retained ${mb(wholeRetained)}\n")
        whole = null
        settled()

        // After: streamed from the file through the cursor's window; no whole-document String or char[] exists.
        base = settled()
        water = HighWater.start(runtime)
        Jvm.resetPeaks()
        alloc0 = Jvm.allocated()
        var streamed: List<RuleSetInfo>? = fromFile()
        val streamAlloc = Jvm.allocated() - alloc0
        val streamPools = Jvm.peak() - base
        val streamWater = water.finish() - base
        assertEquals(n, streamed!![0].rules.size)
        assertEquals(treeDecisions, decisions(streamed!!))
        val streamRetained = settled() - base
        out.append("streamed from the file (the move): high water over base ${mb(streamWater)} (pool peaks ${mb(streamPools)}); allocated ${mb(streamAlloc)}; retained ${mb(streamRetained)} = ${perRule(streamRetained, n)}\n")
        out.append("(the high water is the heap's use sampled every millisecond over the pass, less the base; garbage the collector had not yet taken is in it, so it is what the process shows, not what is live)\n")
        streamed = null
        println(out)
    }

    // ---- (c) interning ----------------------------------------------------------------------------

    /** One parse of the census set's rules, measured in its own frame. */
    private class Parsed(val retained: Long, val walk: Long, val rules: Int, val decisions: List<String>)

    /**
     * The rules parsed from a tree of the document that is dropped before the reading, so the
     * delta is the rules with the strings they own – as main's reader leaves them, every occurrence
     * of a domain its own `String` (org.json shares nothing) – or, with an [Interner], one per
     * distinct domain and list.
     */
    private fun parsed(rulesText: String, interner: Interner?): Parsed {
        val base = settled()
        var tree: JSONArray? = JSONArray(rulesText)
        val compiled = CompiledRules.parse(tree!!, 2999, "fp", interner)
        tree = null
        val retained = settled() - base
        val decisions = decisions(listOf(RuleSetInfo(SET, "dnr", 2999, true, compiled, false, null, 1, 0)))
        return Parsed(retained, DeepSize().also { it.add(compiled.rules) }.total, compiled.rules.size, decisions)
    }

    @Test
    fun interningSharesTheDomainStringsAndSetsOfARead() {
        val out = StringBuilder(banner("(c) interning"))
        val rulesText = document.substring(document.indexOf("\"rules\":") + 8, document.length - 1)
        val before = parsed(rulesText, null)
        val interner = Interner()
        val after = parsed(rulesText, interner)
        val n = before.rules
        assertEquals(n, after.rules)
        assertEquals(before.decisions, after.decisions)
        out.append("before (each occurrence of a domain its own String, each list its own set): ${mb(before.retained)} retained = ${perRule(before.retained, n)} (walk ${mb(before.walk)})\n")
        out.append("after (one Interner for the read): ${mb(after.retained)} retained = ${perRule(after.retained, n)} (walk ${mb(after.walk)}); the read's table held ${interner.stringCount} distinct strings and ${interner.setCount} distinct sets\n")
        out.append("saved: ${mb(before.retained - after.retained)} by the heap, ${mb(before.walk - after.walk)} by the walk\n")
        println(out)
    }

    // ---- (d) big lists as sorted arrays, the folded rule on its own in the index ------------------

    /**
     * A structure over the hosts rule's domains, built and measured in its own frame: the heap's
     * delta (the strings are live already, so the structure's own bytes) and its walk less
     * [shared] – the strings' walk for a list, the rule's for a structure that refers to the rule.
     */
    private fun structure(shared: Long, build: () -> Any): Pair<Long, Long> {
        val base = settled()
        val built = build()
        val retained = settled() - base
        return retained to DeepSize().also { it.add(built) }.total - shared
    }

    @Test
    fun aBigListAsASortedArrayCostsAReferenceADomainAndTheIndexNoEntryPerDomain() {
        val out = StringBuilder(banner("(d) big lists"))
        val sets = fromFile()
        val hostsRule = sets[0].rules.maxBy { it.requestDomains?.size ?: 0 }
        val domains = hostsRule.requestDomains!!.toList()
        val n = domains.size
        assertTrue(n > SortedDomainSet.THRESHOLD)
        out.append("the hosts rule: $n requestDomains\n")
        val stringsWalk = DeepSize().also { it.add(domains.toTypedArray()) }.total - DeepSize().also { it.add(arrayOfNulls<String>(n)) }.total
        val ruleWalk = DeepSize().also { it.add(hostsRule) }.total

        // The list: HashSet (before) against the sorted array (after), over the same String instances.
        val (hashedRetained, hashedStructure) = structure(stringsWalk) { HashSet<String>(n * 2).also { it.addAll(domains) } }
        val (sortedRetained, sortedStructure) = structure(stringsWalk) { SortedDomainSet.of(domains) }
        out.append("the list as a HashSet<String>(n * 2): ${mb(hashedRetained)} = ${per(hashedRetained, n, "domain")} by the heap; the structure by the walk ${mb(hashedStructure)} = ${per(hashedStructure, n, "domain")}\n")
        out.append("the list as a SortedDomainSet: ${mb(sortedRetained)} = ${per(sortedRetained, n, "domain")} by the heap; the structure by the walk ${mb(sortedStructure)} = ${per(sortedStructure, n, "domain")}; the strings themselves ${mb(stringsWalk)} = ${per(stringsWalk, n, "domain")} either way\n")

        // The index: an entry per domain in the host map (before) against the rule on its own (after).
        val (expandedRetained, expandedStructure) = structure(ruleWalk) { HashMap<String, Any>().also { for (d in domains) it[d] = hostsRule } }
        val (indexRetained, indexStructure) = structure(ruleWalk) { RuleIndex(listOf(hostsRule)) }
        out.append("the index for the rule: an entry per domain in the host map ${mb(expandedRetained)} = ${per(expandedRetained, n, "domain")} by the heap (the structure by the walk ${mb(expandedStructure)}); the rule on its own ${mb(indexRetained)} (walk ${mb(indexStructure)})\n")

        // The lookup: the map's suffix walk (before) against the sorted array's (after), per request, hosts in and out of the list.
        val expanded = HashMap<String, Any>().also { for (d in domains) it[d] = hostsRule }
        val sorted: Set<String> = SortedDomainSet.of(domains)
        val index = RuleIndex(listOf(hostsRule))
        assertEquals(1, index.bigHostRuleCount)
        assertEquals(0, index.hostCount)
        val requests = ArrayList<Request>(20_000)
        for (i in 0 until 20_000) {
            val host = when (i % 4) {
                0 -> domains[(i * 7919) % n]
                1 -> "cdn." + domains[(i * 104_729) % n]
                2 -> "h$i.other.example"
                else -> "www.site$i.example"
            }
            requests.add(Request("https://$host/a.js", ResourceType.SCRIPT, "https://news.example/"))
        }
        var mapHits = 0
        var sortedHits = 0
        fun timeMap(): Long {
            val t0 = System.nanoTime()
            for (r in requests) for (key in r.hostSuffixes) if (expanded[key] != null) { mapHits++; break }
            return System.nanoTime() - t0
        }
        fun timeSorted(): Long {
            val t0 = System.nanoTime()
            for (r in requests) if (DnrRule.hasDomainOf(r.hostSuffixes, sorted)) sortedHits++
            return System.nanoTime() - t0
        }
        fun timeIndex(): Int {
            var visited = 0
            for (r in requests) index.forEachCandidate(r) { visited++ }
            return visited
        }
        repeat(3) { timeMap(); timeSorted(); timeIndex() } // warm-up
        mapHits = 0
        sortedHits = 0
        val mapNs = (0 until 5).map { timeMap() }.min() / requests.size
        val sortedNs = (0 until 5).map { timeSorted() }.min() / requests.size
        val t0 = System.nanoTime()
        val visited = timeIndex()
        val indexNs = (System.nanoTime() - t0) / requests.size
        assertEquals(mapHits, sortedHits)
        assertEquals(mapHits / 5, visited)
        out.append("the lookup per request (${requests.size} requests, half of them under a listed domain): host map $mapNs ns; sorted array $sortedNs ns; RuleIndex.forEachCandidate with the rule on its own $indexNs ns\n")

        // Both structures decide alike through the engine.
        val snapshot = EngineSnapshot(sets, null)
        var blocked = 0
        for (r in requests) if (snapshot.decide(r).isBlocked) blocked++
        assertTrue(blocked >= requests.size / 2)
        out.append("the engine blocks $blocked of the ${requests.size} through the set\n")
        println(out)
    }

    companion object {
        private const val SET = "ext:test:static:ads"
        private const val TAG = "t1-0000000000000001"

        val count: Int = System.getenv("ZEN_DNR_RULES")?.toIntOrNull() ?: SyntheticRuleSet.CENSUS_RULES

        /** The census set's document, generated once for the class. */
        val document: String by lazy { SyntheticRuleSet.document(SET, count) }

        /** The document on disk, as `blocking/sets/<name>.json` is on the phone. */
        val file: File by lazy {
            File.createTempFile("zen-dnr-", ".json").also {
                it.deleteOnExit()
                it.writeText(document, Charsets.UTF_8)
            }
        }
    }
}

/**
 * The retained size of an object graph as a heap-dump parser would report it: every object once
 * (by identity), HotSpot's shallow sizes for a 64-bit JVM with compressed references (12-byte
 * headers, 4-byte references, 8-byte alignment; a `String` as its object plus its `byte[]` of
 * Latin-1 characters), with a count and a total per class. Shared objects that are not the
 * graph's own (enum constants, classes) are left out; JDK collections are sized by their known
 * layouts rather than reflected (their fields are sealed off since JDK 16); a `Pattern` is
 * estimated from its text (the JVM's compiled regex graph, not ART's ICU one).
 */
internal class DeepSize {
    private val seen = IdentityHashMap<Any, Boolean>()
    private val byClass = HashMap<String, LongArray>()
    var total = 0L
        private set
    var opaque = 0
        private set

    fun add(root: Any?) {
        val stack = ArrayDeque<Any>()
        push(root, stack)
        while (stack.isNotEmpty()) visit(stack.removeLast(), stack)
    }

    private fun push(o: Any?, stack: ArrayDeque<Any>) {
        if (o == null || o is Enum<*> || o is Class<*>) return
        if (seen.put(o, true) != null) return
        stack.addLast(o)
    }

    private fun account(o: Any, bytes: Long, name: String = o.javaClass.name) {
        total += bytes
        val slot = byClass.getOrPut(name) { LongArray(2) }
        slot[0]++
        slot[1] += bytes
    }

    private fun align(n: Long): Long = (n + 7) and 7L.inv()

    private fun tableBytes(size: Int): Long {
        var capacity = 16
        while (capacity * 3 / 4 < size) capacity *= 2
        return align(16 + 4L * capacity)
    }

    private fun visit(o: Any, stack: ArrayDeque<Any>) {
        when (o) {
            is String -> account(o, 24 + align(16L + o.length))
            is Pattern -> account(o, 64 + 2 * (24 + align(16L + o.pattern().length)) + 40L * o.pattern().length)
            is Int, is Float, is Short, is Byte, is Char, is Boolean -> account(o, 16)
            is Long, is Double -> account(o, 24)
            is IntArray -> account(o, align(16 + 4L * o.size))
            is CharArray -> account(o, align(16 + 2L * o.size))
            is ByteArray -> account(o, align(16L + o.size))
            is Array<*> -> {
                account(o, align(16 + 4L * o.size))
                for (e in o) push(e, stack)
            }
            is java.util.LinkedHashMap<*, *> -> {
                account(o, 56 + tableBytes(o.size) + 40L * o.size)
                for ((k, v) in o) {
                    push(k, stack)
                    push(v, stack)
                }
            }
            is java.util.HashMap<*, *> -> {
                account(o, 48 + tableBytes(o.size) + 32L * o.size)
                for ((k, v) in o) {
                    push(k, stack)
                    push(v, stack)
                }
            }
            is java.util.LinkedHashSet<*> -> {
                account(o, 16 + 56 + tableBytes(o.size) + 40L * o.size)
                for (e in o) push(e, stack)
            }
            is java.util.HashSet<*> -> {
                account(o, 16 + 48 + tableBytes(o.size) + 32L * o.size)
                for (e in o) push(e, stack)
            }
            is java.util.ArrayList<*> -> {
                account(o, 24 + align(16 + 4L * o.size))
                for (e in o) push(e, stack)
            }
            is SortedDomainSet -> reflect(o, stack)
            is Collection<*> -> {
                // Singleton / unmodifiable / Arrays.asList wrappers: the wrapper and, for a list over an array, the array.
                account(o, if (o.size <= 1) 16 else 16 + align(16 + 4L * o.size))
                for (e in o) push(e, stack)
            }
            is Map<*, *> -> {
                account(o, 16 + align(16 + 8L * o.size))
                for ((k, v) in o) {
                    push(k, stack)
                    push(v, stack)
                }
            }
            else -> reflect(o, stack)
        }
    }

    private fun reflect(o: Any, stack: ArrayDeque<Any>) {
        var bytes = 12L
        var cls: Class<*>? = o.javaClass
        var accessible = true
        while (cls != null && cls != Any::class.java) {
            for (field in cls.declaredFields) {
                if (Modifier.isStatic(field.modifiers)) continue
                val type = field.type
                bytes += when (type) {
                    java.lang.Long.TYPE, java.lang.Double.TYPE -> 8
                    java.lang.Integer.TYPE, java.lang.Float.TYPE -> 4
                    java.lang.Short.TYPE, java.lang.Character.TYPE -> 2
                    java.lang.Byte.TYPE, java.lang.Boolean.TYPE -> 1
                    else -> 4
                }
                if (!type.isPrimitive && accessible) {
                    try {
                        field.isAccessible = true
                        push(field.get(o), stack)
                    } catch (e: RuntimeException) {
                        accessible = false
                    }
                }
            }
            cls = cls.superclass
        }
        if (!accessible) opaque++
        account(o, align(bytes))
    }

    /** The `top` classes by bytes, one line each. */
    fun table(top: Int): String = buildString {
        for ((name, slot) in byClass.entries.sortedByDescending { it.value[1] }.take(top)) {
            append(String.format("  %-60s %9d objects %10.2f MB\n", name.removePrefix("app.zen.chromium.blocking."), slot[0], slot[1] / 1048576.0))
        }
    }
}
