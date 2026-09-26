package app.zen.chromium.blocking

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.lang.reflect.Modifier
import java.util.IdentityHashMap
import java.util.regex.Pattern

/**
 * The DNR engine's resident memory for a rule set of the round-21 extension's size, measured on
 * the JVM ([SyntheticRuleSet], 61 K rules by default; `ZEN_DNR_RULES` in the environment sets
 * another count). Two instruments: the heap's settled use before and after holding an object
 * (`System.gc()` ×3, `totalMemory - freeMemory`), and [DeepSize], a walk of the object graph
 * that sums HotSpot's shallow sizes per class (64-bit, compressed references) – the retained
 * size a heap-dump parser would report, with the breakdown by class that says where the bytes
 * are. Neither is ART's number: ART's object header is 8 bytes to HotSpot's 12 and its `String`
 * holds its characters inline (one object, ~24 bytes less each), so the phone's figures sit
 * some 10–20 % under the JVM's for the same graph; the `Extensions.configure` heap line gives
 * the device figure. The measurements print a table (the test report's standard output); the
 * assertions pin what the moves must keep: the reader's rules and decisions.
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
            .filter { poolClass.getMethod("getType").invoke(it).toString() == "HEAP" }
        private val resetPeak = poolClass.getMethod("resetPeakUsage")
        private val peakUsage = poolClass.getMethod("getPeakUsage")
        private val usedOf = Class.forName("java.lang.management.MemoryUsage").getMethod("getUsed")

        @Suppress("DEPRECATION")
        fun allocated(): Long = allocatedBytes.invoke(threads, Thread.currentThread().id) as Long

        fun resetPeaks() = pools.forEach { resetPeak.invoke(it) }

        /** The heap pools' peak use since [resetPeaks] (each pool's own peak, summed: an upper bound). */
        fun peak(): Long = pools.sumOf { usedOf.invoke(peakUsage.invoke(it)) as Long }
    }

    private fun used(): Long = runtime.totalMemory() - runtime.freeMemory()

    /** The heap's use once the garbage is collected. */
    private fun settled(): Long {
        repeat(3) {
            System.gc()
            System.runFinalization()
            Thread.sleep(30)
        }
        return used()
    }

    private fun allocated(): Long = Jvm.allocated()

    private fun resetPeaks() = Jvm.resetPeaks()

    private fun peak(): Long = Jvm.peak()

    private fun mb(bytes: Long): String = String.format("%.1f MB", bytes / 1048576.0)

    private fun perRule(bytes: Long, rules: Int): String = String.format("%d B/rule", bytes / rules.coerceAtLeast(1))

    private val count = System.getenv("ZEN_DNR_RULES")?.toIntOrNull() ?: 61_000

    private fun index(id: String, tag: String) =
        """{"version":2,"sets":[{"id":"$id","source":"dnr","priority":2999,"enabled":true,"hasFilterText":false,"filterCount":0,"updatedAt":1,"document":"sets/$id.json","tag":"$tag"}]}"""

    private fun sampleRequests(): List<Request> = listOf(
        Request("https://adtrk1.com/x.js", ResourceType.SCRIPT, "https://news.example/"),
        Request("https://cdn.pixstat77.net/ad/ad77.png", ResourceType.IMAGE, "https://news.example/"),
        Request("https://static.site.example/banner/-tag-9.js", ResourceType.SCRIPT, "https://adtrk12.com/"),
        Request("https://sub.servebid5.org/ads12/abcd.js", ResourceType.SCRIPT, "https://news.example/"),
        Request("https://ok.example/page", ResourceType.MAIN_FRAME, null)
    )

    private fun decisions(snapshot: EngineSnapshot): List<String> = sampleRequests().map { snapshot.decide(it).let { d -> "${d.action}:${d.matchedRule}" } }

    @Test
    fun residentCostOfARealShapedSet() {
        val out = StringBuilder("\n=== DNR engine memory, $count synthesised rules of uBO Lite's shape (HotSpot, compressed oops) ===\n")
        val document = SyntheticRuleSet.document("ext:test:static:ads", count)
        val rulesText = document.substring(document.indexOf("\"rules\":") + 8, document.length - 1)
        out.append("document text: ${document.length} chars (${mb(document.length.toLong())} as Latin-1 bytes; ${mb(2L * document.length)} as a char[])\n")

        // --- The tree parse (the legacy version-1 path, `CompiledRules.parse(JSONArray)`) ---
        val base = settled()
        resetPeaks()
        var alloc0 = allocated()
        var tree: JSONArray? = JSONArray(rulesText)
        val treeTop = used() - base
        val treeAlloc = allocated() - alloc0
        var compiledTree: CompiledRules? = CompiledRules.parse(tree, 2999, "fp")
        val treePeak = peak() - base
        val treeAllocAll = allocated() - alloc0
        tree = null
        val treeRetained = settled() - base
        val treeRules = compiledTree!!.rules.size
        out.append("tree parse: org.json tree at the top of the parse ${mb(treeTop)} (allocated ${mb(treeAlloc)}); peak over base ${mb(treePeak)}; allocated in all ${mb(treeAllocAll)}; retained CompiledRules ${mb(treeRetained)} = ${perRule(treeRetained, treeRules)}\n")
        val treeDecisions = decisions(EngineSnapshot(listOf(RuleSetInfo("ext:test:static:ads", "dnr", 2999, true, compiledTree!!, false, null, 1, 0)), null))
        compiledTree = null
        settled()

        // --- The reader's path on main (IndexReader over the document's text) ---
        val reader = IndexReader()
        val base2 = settled()
        resetPeaks()
        alloc0 = allocated()
        var sets: List<RuleSetInfo>? = reader.read(index("ext:test:static:ads", "t1-0000000000000001")) { document }
        val readerPeak = peak() - base2
        val readerAlloc = allocated() - alloc0
        val readerRetained = settled() - base2
        val compiled = sets!![0].compiled
        assertEquals(treeRules, compiled.rules.size)
        assertEquals(treeDecisions, decisions(EngineSnapshot(sets!!, null)))
        out.append("IndexReader (main): peak over base ${mb(readerPeak)}; allocated ${mb(readerAlloc)}; retained ${mb(readerRetained)} = ${perRule(readerRetained, compiled.rules.size)}\n")

        // --- Rules against index ---
        var rules: List<DnrRule>? = compiled.rules
        sets = null
        val rulesOnly = settled() - base2
        var ruleIndex: RuleIndex? = RuleIndex(rules!!)
        val withIndex = settled() - base2
        out.append("of which rules ${mb(rulesOnly)} = ${perRule(rulesOnly, rules!!.size)}; the RuleIndex ${mb(withIndex - rulesOnly)} = ${perRule(withIndex - rulesOnly, rules!!.size)} (hosts ${ruleIndex!!.hostCount}, initiators ${ruleIndex!!.initiatorCount}, token-indexed ${ruleIndex!!.tokenIndexedCount}, wildcard ${ruleIndex!!.wildcardCount})\n")

        // --- The graph walk: retained size by class ---
        val deep = DeepSize()
        deep.add(rules)
        val rulesDeep = deep.total
        deep.add(ruleIndex)
        out.append("graph walk: rules ${mb(rulesDeep)} = ${perRule(rulesDeep, rules!!.size)}; with the index ${mb(deep.total)} = ${perRule(deep.total, rules!!.size)}; ${deep.opaque} opaque objects\n")
        out.append(deep.table(14))

        // --- The strings' share ---
        out.append(census(rulesText, rules!!))
        ruleIndex = null
        rules = null
        settled()

        // --- Per condition kind, 10 000 rules each through the reader ---
        for (kind in SyntheticRuleSet.Kind.entries) {
            val n = 10_000
            val doc = SyntheticRuleSet.document("ext:test:$kind", n, seed = 7, only = kind)
            val b = settled()
            var s: List<RuleSetInfo>? = IndexReader().read(index("ext:test:$kind", "t2-0000000000000002")) { doc }
            val retained = settled() - b
            val walk = DeepSize().also { it.add(s!![0].compiled.rules) }
            out.append(String.format("%-20s %6d rules: retained %s = %s (rules alone by the walk %s; %d chars of document per rule)\n", kind, s!![0].rules.size, mb(retained), perRule(retained, s[0].rules.size), perRule(walk.total, s[0].rules.size), doc.length / n))
            s = null
        }
        println(out)
        assertTrue(treeRules > count * 9 / 10)
    }

    /** Domain strings and lists, and `||host^` hostnames: total references against distinct values – the interning headroom. */
    private fun census(rulesText: String, rules: List<DnrRule>): String {
        val arr = JSONArray(rulesText)
        val keys = listOf("initiatorDomains", "excludedInitiatorDomains", "requestDomains", "excludedRequestDomains", "topDomains", "excludedTopDomains")
        var refs = 0
        var chars = 0L
        val distinct = HashSet<String>()
        var lists = 0
        val distinctLists = HashSet<String>()
        var listedRules = 0
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
                items.sort()
                distinctLists.add(items.joinToString(","))
            }
            if (listed) listedRules++
        }
        var hosts = 0
        val distinctHosts = HashSet<String>()
        for (rule in rules) {
            val p = rule.pattern ?: continue
            if (p.isHostnameOnly) {
                hosts++
                distinctHosts.add(p.hostname)
            }
        }
        return "strings: $refs domain references ($chars chars) in $lists lists on $listedRules rules; ${distinct.size} distinct domains; ${distinctLists.size} distinct lists by content; " +
            "$hosts hostname-only patterns, ${distinctHosts.size} distinct hostnames\n"
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
