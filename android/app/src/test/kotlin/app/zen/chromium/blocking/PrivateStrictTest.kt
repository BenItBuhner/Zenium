package app.zen.chromium.blocking

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotSame
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * "Always use Strict in private windows" (services pass 16, PS-49) on the phone: the core enables
 * the strict-only lists as sets scoped to the `private` partition and, at level Off, keeps the
 * allow-all out of it (`excludedPartitions`); the engine matches a private tab's requests against
 * the private partition's own text engine ([Blocking.textEngines], [EngineSnapshot]).
 */
class PrivateStrictTest {
    private fun list(id: String, partitions: Set<String>? = null, excluded: Set<String>? = null, updatedAt: Long = 1L, enabled: Boolean = true): RuleSetInfo =
        RuleSetInfo(
            id = id, source = "filter-list", priority = 1, enabled = enabled, compiled = CompiledRules.NONE,
            hasFilterText = true, file = "$id.json", updatedAt = updatedAt, filterCount = 1,
            partitions = partitions, excludedPartitions = excluded
        )

    private val texts = mapOf(
        "easylist" to "||ads.example^",
        "ubo-privacy" to "||fingerprint.example^",
        "custom" to "||custom.example^"
    )

    private fun request(url: String, partition: String?): Request =
        Request(url, ResourceType.SCRIPT, "https://news.example/story", partition = partition)

    private val allowAll = RuleSetInfo.parse(
        JSONObject(
            """{"id":"builtin:global-off","source":"builtin","priority":1000,"enabled":true,"excludedPartitions":["private"],
                "rules":[{"id":1,"action":{"type":"allow"},"condition":{}}]}"""
        )
    )!!

    @Test
    fun excludedPartitionsKeepASetOutOfTheNamedPartitionsOnly() {
        assertEquals(setOf("private"), allowAll.excludedPartitions)
        assertNull(allowAll.partitions)
        assertFalse(allowAll.appliesTo("private"))
        assertTrue(allowAll.appliesTo("default"))
        assertTrue(allowAll.appliesTo("work"))
        // A request of no known partition is excluded from nothing, as `excludedTabIds` excludes no tabless request.
        assertTrue(allowAll.appliesTo(null))
        // Both scopes on one set: the allow-list admits, the exclusion overrides it.
        val both = list("both", partitions = setOf("default", "private"), excluded = setOf("private"))
        assertTrue(both.appliesTo("default"))
        assertFalse(both.appliesTo("private"))
        assertFalse(both.appliesTo("work"))
        assertFalse(both.appliesTo(null))
        // Without either, everywhere; an empty exclusion excludes nothing.
        val plain = RuleSetInfo.parse(JSONObject("""{"id":"x","priority":1,"excludedPartitions":[],"rules":[]}"""))!!
        assertEquals(emptySet<String>(), plain.excludedPartitions)
        assertTrue(plain.appliesTo("private"))
        assertTrue(plain.appliesTo(null))
    }

    @Test
    fun theIndexReaderCarriesExcludedPartitionsAsItCarriesPartitions() {
        val index = """{"version":2,"sets":[
            {"id":"builtin:global-off","source":"builtin","priority":1000,"enabled":true,"excludedPartitions":["private"],
             "ruleCount":1,"document":"sets/builtin_global-off-00000000.json","tag":"1-0000000000000000","hasFilterText":false,"filterCount":0},
            {"id":"ubo-privacy","source":"filter-list","priority":1,"enabled":true,"partitions":["private"],"updatedAt":7,
             "ruleCount":0,"hasFilterText":true,"filterCount":1,"file":"ubo-privacy.json"},
            {"id":"easylist","source":"filter-list","priority":1,"enabled":true,"updatedAt":7,
             "ruleCount":0,"hasFilterText":true,"filterCount":1,"file":"easylist.json"}]}"""
        val documents = mapOf(
            "sets/builtin_global-off-00000000.json" to """{"id":"builtin:global-off","rules":[{"id":1,"action":{"type":"allow"},"condition":{}}]}"""
        )
        val sets = IndexReader().read(index) { documents[it] }
        assertEquals(listOf("builtin:global-off", "ubo-privacy", "easylist"), sets.map { it.id })
        assertEquals(setOf("private"), sets[0].excludedPartitions)
        assertNull(sets[0].partitions)
        assertEquals(setOf("private"), sets[1].partitions)
        assertNull(sets[1].excludedPartitions)
        assertNull(sets[2].partitions)
        assertNull(sets[2].excludedPartitions)
        assertFalse(sets[0].appliesTo("private"))
        assertTrue(sets[0].appliesTo("default"))
        assertTrue(sets[1].appliesTo("private"))
        assertFalse(sets[1].appliesTo("default"))
        // The same summaries through the document parser agree.
        val arr = JSONObject(index).getJSONArray("sets")
        val parsed = (0 until arr.length()).map { RuleSetInfo.parse(arr.getJSONObject(it), documents[arr.getJSONObject(it).optString("document")]?.let { d -> JSONObject(d).getJSONArray("rules") })!! }
        assertEquals(parsed.map { it.excludedPartitions }, sets.map { it.excludedPartitions })
        assertEquals(parsed.map { it.partitions }, sets.map { it.partitions })
    }

    @Test
    fun textEnginesGiveThePrivatePartitionItsOwnEngineOverTheListsThatApplyThere() {
        val reads = ArrayList<String>()
        val read: (RuleSetInfo) -> String? = { set -> reads.add(set.id); texts[set.id] }
        val easylist = list("easylist")
        val privacy = list("ubo-privacy", partitions = setOf("private"))
        val engines = Blocking.textEngines(listOf(easylist, privacy), emptyMap(), read)

        // The general engine reads EasyList alone; the private partition's reads both.
        assertEquals(1, engines.general!!.filterCount)
        assertEquals(setOf("private"), engines.byPartition.keys)
        val private = engines.byPartition["private"]!!
        assertEquals(2, private.filterCount)
        assertNotSame(engines.general, private)
        // A list's text is read once for the build, however many engines it feeds.
        assertEquals(listOf("easylist", "ubo-privacy"), reads)
        assertEquals(2, engines.cache.size)

        // The snapshot matches a private tab's request against its own engine, every other tab's against the general one.
        val snap = EngineSnapshot(listOf(easylist, privacy), engines.general, engines.byPartition)
        assertEquals(setOf("private"), snap.textPartitions)
        assertEquals(1, snap.filterCount)
        assertEquals(1, snap.filterCount("default"))
        assertEquals(1, snap.filterCount(null))
        assertEquals(2, snap.filterCount("private"))
        val fp = "https://fingerprint.example/fp.js"
        val blocked = snap.decide(request(fp, "private"))
        assertEquals(Decision.Action.BLOCK, blocked.action)
        assertEquals(Decision.TEXT_SET_ID, blocked.matchedSet)
        assertEquals("||fingerprint.example^", blocked.matchedFilter)
        assertEquals(Decision.Action.ALLOW, snap.decide(request(fp, "default")).action)
        assertEquals(Decision.Action.ALLOW, snap.decide(request(fp, null)).action)
        // EasyList's entry holds everywhere.
        assertEquals(Decision.Action.BLOCK, snap.decide(request("https://ads.example/a.js", "private")).action)
        assertEquals(Decision.Action.BLOCK, snap.decide(request("https://ads.example/a.js", "default")).action)
        // The linear resolution agrees.
        assertEquals(Decision.Action.BLOCK, snap.decideLinear(request(fp, "private")).action)
        assertEquals(Decision.Action.ALLOW, snap.decideLinear(request(fp, "default")).action)

        // The next build with the same sets reuses both engines, reading nothing.
        reads.clear()
        val again = Blocking.textEngines(listOf(easylist, privacy), engines.cache, read)
        assertSame(engines.general, again.general)
        assertSame(private, again.byPartition["private"])
        assertEquals(emptyList<String>(), reads)

        // The switch off (the list disabled and unscoped) drops the private engine; the general one is still the cached instance.
        val off = Blocking.textEngines(listOf(easylist), engines.cache, read)
        assertSame(engines.general, off.general)
        assertEquals(emptyMap<String, TextEngine?>(), off.byPartition)
        assertEquals(1, off.cache.size)

        // General level Strict: both lists everywhere, one engine, no partition of its own.
        val strict = Blocking.textEngines(listOf(easylist, list("ubo-privacy")), emptyMap(), read)
        assertEquals(2, strict.general!!.filterCount)
        assertEquals(emptyMap<String, TextEngine?>(), strict.byPartition)
    }

    @Test
    fun levelOffWithTheSwitchOnLeavesThePrivatePartitionToItsLists() {
        // The core's index at level Off with the switch on: every list scoped to private, the allow-all everywhere else.
        val easylist = list("easylist", partitions = setOf("private"))
        val privacy = list("ubo-privacy", partitions = setOf("private"))
        val engines = Blocking.textEngines(listOf(easylist, privacy), emptyMap()) { texts[it.id] }
        // No list applies to the unscoped scope: no general engine, and the private partition's holds both.
        assertNull(engines.general)
        assertEquals(2, engines.byPartition["private"]!!.filterCount)
        val snap = EngineSnapshot(listOf(allowAll, easylist, privacy), engines.general, engines.byPartition)
        val ad = "https://ads.example/a.js"
        val normal = snap.decide(request(ad, "default"))
        assertEquals(Decision.Action.ALLOW, normal.action)
        assertEquals("builtin:global-off", normal.matchedSet)
        assertEquals("builtin:global-off", snap.decide(request(ad, null)).matchedSet)
        assertEquals("builtin:global-off", snap.decide(request(ad, "work")).matchedSet)
        val private = snap.decide(request(ad, "private"))
        assertEquals(Decision.Action.BLOCK, private.action)
        assertEquals(Decision.TEXT_SET_ID, private.matchedSet)
        assertEquals(Decision.Action.BLOCK, snap.decide(request("https://fingerprint.example/fp.js", "private")).action)
        assertEquals(snap.decide(request(ad, "private")).action, snap.decideLinear(request(ad, "private")).action)
        assertEquals(snap.decide(request(ad, "default")).matchedSet, snap.decideLinear(request(ad, "default")).matchedSet)
    }

    @Test
    fun aPartitionASetStandsAsideFromGetsAnEngineWithoutIt() {
        // A text set excluded from one partition: that partition's engine is the others' minus it.
        val easylist = list("easylist")
        val custom = list("custom", excluded = setOf("banking"))
        val engines = Blocking.textEngines(listOf(easylist, custom), emptyMap()) { texts[it.id] }
        assertEquals(2, engines.general!!.filterCount)
        assertEquals(setOf("banking"), engines.byPartition.keys)
        assertEquals(1, engines.byPartition["banking"]!!.filterCount)
        val snap = EngineSnapshot(listOf(easylist, custom), engines.general, engines.byPartition)
        assertEquals(Decision.Action.BLOCK, snap.decide(request("https://custom.example/c.js", "default")).action)
        assertEquals(Decision.Action.ALLOW, snap.decide(request("https://custom.example/c.js", "banking")).action)
        assertEquals(Decision.Action.BLOCK, snap.decide(request("https://ads.example/a.js", "banking")).action)
    }

    @Test
    fun aSnapshotWithoutPartitionEnginesReadsTheGeneralOneEverywhere() {
        val text = TextEngine.parse(listOf("||ads.example^"))
        val snap = EngineSnapshot(emptyList(), text)
        assertEquals(emptySet<String>(), snap.textPartitions)
        assertEquals(1, snap.filterCount("private"))
        assertEquals(Decision.Action.BLOCK, snap.decide(request("https://ads.example/a.js", "private")).action)
        assertEquals(Decision.Action.BLOCK, snap.decide(request("https://ads.example/a.js", null)).action)
        // A partition keyed to no engine has no lists at all.
        val none = EngineSnapshot(emptyList(), text, mapOf("kiosk" to null))
        assertEquals(0, none.filterCount("kiosk"))
        assertEquals(Decision.Action.ALLOW, none.decide(request("https://ads.example/a.js", "kiosk")).action)
        assertEquals(Decision.Action.BLOCK, none.decide(request("https://ads.example/a.js", "default")).action)
    }
}
