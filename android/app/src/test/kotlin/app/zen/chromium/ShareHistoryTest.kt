package app.zen.chromium

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** SH-03: the share panel's own ranking of where the user shares. */
class ShareHistoryTest {
    private class MemoryStore(var value: String? = null) : ShareHistory.Store {
        var writes = 0
        override fun read(): String? = value
        override fun write(value: String) {
            this.value = value
            writes++
        }
    }

    private val day = 24L * 60 * 60 * 1000
    private val messages = "com.example.messages/.SendActivity"
    private val mail = "com.example.mail/.ComposeActivity"
    private val notes = "com.example.notes/.ShareActivity"
    private val given = listOf(mail, messages, notes)

    @Test
    fun aNeverUsedRowKeepsTheGivenOrder() {
        val history = ShareHistory(MemoryStore())
        assertEquals(given, history.rank(ShareHistory.TYPE_TEXT, given))
        assertNull(history.use(ShareHistory.TYPE_TEXT, messages))
    }

    @Test
    fun sharingToATargetTwiceLeadsTheRowNextOpen() {
        var clock = 1_000_000L
        val store = MemoryStore()
        val history = ShareHistory(store) { clock }
        history.record(ShareHistory.TYPE_TEXT, messages)
        clock += 1_000
        history.record(ShareHistory.TYPE_TEXT, messages)
        clock += 1_000
        history.record(ShareHistory.TYPE_TEXT, notes)
        // Messages twice, notes once, mail never: that is the row.
        assertEquals(listOf(messages, notes, mail), history.rank(ShareHistory.TYPE_TEXT, given))
        assertEquals(2, history.use(ShareHistory.TYPE_TEXT, messages)?.count)
        assertEquals(2, history.use(ShareHistory.TYPE_TEXT, messages)?.recent?.size)
        // Every record is persisted at once (the panel may not open again this process).
        assertEquals(3, store.writes)
        // A fresh instance over the same store sees the same rank.
        assertEquals(listOf(messages, notes, mail), ShareHistory(store) { clock }.rank(ShareHistory.TYPE_TEXT, given))
    }

    @Test
    fun tiesKeepTheGivenOrder() {
        var clock = 1_000_000L
        val history = ShareHistory(MemoryStore()) { clock }
        history.record(ShareHistory.TYPE_TEXT, notes)
        clock += 1_000
        history.record(ShareHistory.TYPE_TEXT, mail)
        // Same recent count, same all-time count: the later use wins; mail never-used stays last.
        assertEquals(listOf(mail, notes, messages), history.rank(ShareHistory.TYPE_TEXT, given))
        // Recorded at the same instant: the given order decides.
        val same = ShareHistory(MemoryStore()) { clock }
        same.record(ShareHistory.TYPE_TEXT, notes)
        same.record(ShareHistory.TYPE_TEXT, mail)
        assertEquals(listOf(mail, notes, messages), same.rank(ShareHistory.TYPE_TEXT, given))
    }

    @Test
    fun theLastSevenDaysOutrankAllTime() {
        var clock = 100 * day
        val history = ShareHistory(MemoryStore()) { clock }
        // Mail was the favourite a month ago.
        repeat(5) {
            history.record(ShareHistory.TYPE_TEXT, mail)
            clock += 1_000
        }
        clock += 30 * day
        // Messages was used once this week.
        history.record(ShareHistory.TYPE_TEXT, messages)
        clock += 1_000
        assertEquals(listOf(messages, mail, notes), history.rank(ShareHistory.TYPE_TEXT, given))
        // Beyond the window the recent list no longer counts, but the all-time count still orders.
        clock += 8 * day
        assertEquals(listOf(mail, messages, notes), history.rank(ShareHistory.TYPE_TEXT, given))
    }

    @Test
    fun textAndImageSharesRankSeparately() {
        val history = ShareHistory(MemoryStore()) { 5_000L }
        history.record(ShareHistory.TYPE_IMAGE, notes)
        assertEquals(given, history.rank(ShareHistory.TYPE_TEXT, given))
        assertEquals(listOf(notes, mail, messages), history.rank(ShareHistory.TYPE_IMAGE, given))
    }

    @Test
    fun theRecentListIsBounded() {
        var clock = 1_000_000L
        val history = ShareHistory(MemoryStore()) { clock }
        repeat(ShareHistory.MAX_RECENT + 10) {
            history.record(ShareHistory.TYPE_TEXT, messages)
            clock += 1
        }
        val use = history.use(ShareHistory.TYPE_TEXT, messages)!!
        assertEquals(ShareHistory.MAX_RECENT + 10, use.count)
        assertEquals(ShareHistory.MAX_RECENT, use.recent.size)
        assertEquals(clock - 1, use.lastUsed)
    }

    @Test
    fun forgettingAnUninstalledTargetDropsItEverywhere() {
        val store = MemoryStore()
        val history = ShareHistory(store) { 5_000L }
        history.record(ShareHistory.TYPE_TEXT, notes)
        history.record(ShareHistory.TYPE_IMAGE, notes)
        history.record(ShareHistory.TYPE_TEXT, mail)
        history.forget(notes)
        assertNull(history.use(ShareHistory.TYPE_TEXT, notes))
        assertNull(history.use(ShareHistory.TYPE_IMAGE, notes))
        assertEquals(1, history.use(ShareHistory.TYPE_TEXT, mail)?.count)
        // Forgetting something unknown writes nothing.
        val writes = store.writes
        history.forget("com.example.gone/.Nothing")
        assertEquals(writes, store.writes)
    }

    @Test
    fun theJsonRoundTrips() {
        val all = mapOf(
            ShareHistory.TYPE_TEXT to mapOf(
                messages to ShareHistory.Use(3, listOf(10L, 20L, 30L), 30L),
                mail to ShareHistory.Use(1, emptyList(), 5L),
            ),
            ShareHistory.TYPE_IMAGE to mapOf(notes to ShareHistory.Use(2, listOf(40L), 40L)),
        )
        assertEquals(all, ShareHistory.parse(ShareHistory.serialise(all)))
    }

    @Test
    fun aBrokenStoreStartsEmpty() {
        assertTrue(ShareHistory.parse(null).isEmpty())
        assertTrue(ShareHistory.parse("").isEmpty())
        assertTrue(ShareHistory.parse("not json").isEmpty())
        // A malformed entry is skipped, the rest read.
        val parsed = ShareHistory.parse("""{"text":{"$messages":{"count":2,"recent":[1,2],"lastUsed":2},"bad":"x"}}""")
        assertEquals(ShareHistory.Use(2, listOf(1L, 2L), 2L), parsed[ShareHistory.TYPE_TEXT]?.get(messages))
        assertNull(parsed[ShareHistory.TYPE_TEXT]?.get("bad"))
    }
}
