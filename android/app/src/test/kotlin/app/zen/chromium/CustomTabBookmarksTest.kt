package app.zen.chromium

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class CustomTabBookmarksTest {
    private val state = """
        {"version":3,"bookmarkTree":{"nodes":[
          {"id":"1","parentId":null,"index":0,"type":"folder","title":"Bookmarks bar","dateAdded":1},
          {"id":"7","parentId":"1","index":0,"type":"url","title":"Example","url":"https://example.com/","dateAdded":2},
          {"id":"8","parentId":"1","index":1,"type":"url","title":"Docs","url":"https://docs.example.com/a?b=1","dateAdded":3}
        ]}}
    """.trimIndent()

    @Test
    fun theCoresTreeIsReadForItsUrlNodesAlone() {
        assertEquals(setOf("https://example.com/", "https://docs.example.com/a?b=1"), CustomTabBookmarks.bookmarkedUrls(state))
    }

    @Test
    fun anUnreadableOrMissingStateHoldsNoBookmarks() {
        assertEquals(emptySet<String>(), CustomTabBookmarks.bookmarkedUrls(null))
        assertEquals(emptySet<String>(), CustomTabBookmarks.bookmarkedUrls("not json"))
        assertEquals(emptySet<String>(), CustomTabBookmarks.bookmarkedUrls("""{"version":2,"bookmarks":[{"url":"https://old.example/"}]}"""))
    }

    @Test
    fun theMatchIsExactAsTheCoresHasUrlIs() {
        val bookmarked = CustomTabBookmarks.bookmarkedUrls(state)
        assertTrue(CustomTabBookmarks.isBookmarked("https://example.com/", bookmarked, emptyList()))
        assertFalse(CustomTabBookmarks.isBookmarked("https://example.com", bookmarked, emptyList()))
        assertFalse(CustomTabBookmarks.isBookmarked("https://example.com/#top", bookmarked, emptyList()))
    }

    @Test
    fun theStarReadsTheStoreBeforeTheInbox() {
        // Stored: the tap opens the editor in Zenium. Pending: the tap withdraws the filing. Neither: nothing yet.
        val bookmarked = CustomTabBookmarks.bookmarkedUrls(state)
        val filed = CustomTabBookmarks.Entry("https://new.example/page", "New", 10L)
        val pending = CustomTabBookmarks.withEntry(emptyList(), filed)
        assertEquals(CustomTabMenu.Star.Stored, CustomTabBookmarks.starOf("https://example.com/", bookmarked, pending))
        assertEquals(CustomTabMenu.Star.Pending, CustomTabBookmarks.starOf(filed.url, bookmarked, pending))
        assertEquals(CustomTabMenu.Star.None, CustomTabBookmarks.starOf("https://other.example/", bookmarked, pending))
        // A page in both documents is the browser's: the store wins, as the tap's own order does.
        val both = CustomTabBookmarks.withEntry(pending, CustomTabBookmarks.Entry("https://example.com/", "Example", 11L))
        assertEquals(CustomTabMenu.Star.Stored, CustomTabBookmarks.starOf("https://example.com/", bookmarked, both))
    }

    @Test
    fun aFiledEntryCountsAsBookmarkedAndASecondTapWithdrawsIt() {
        val entry = CustomTabBookmarks.Entry("https://new.example/page", "New", 10L)
        val pending = CustomTabBookmarks.withEntry(emptyList(), entry)
        assertTrue(CustomTabBookmarks.isBookmarked(entry.url, emptySet(), pending))
        val withdrawn = CustomTabBookmarks.withoutEntry(pending, entry.url)
        assertFalse(CustomTabBookmarks.isBookmarked(entry.url, emptySet(), withdrawn))
        assertEquals(emptyList<CustomTabBookmarks.Entry>(), withdrawn)
    }

    @Test
    fun theInboxRoundTripsAndFilesEachUrlOnce() {
        val first = CustomTabBookmarks.Entry("https://a.example/", "A", 1L)
        val second = CustomTabBookmarks.Entry("https://b.example/", "B", 2L)
        val again = CustomTabBookmarks.Entry("https://a.example/", "A again", 3L)
        val pending = CustomTabBookmarks.withEntry(CustomTabBookmarks.withEntry(CustomTabBookmarks.withEntry(emptyList(), first), second), again)
        // The newest filing of a URL is the one kept, in filing order.
        assertEquals(listOf(second, again), pending)
        val text = CustomTabBookmarks.serialize(pending)
        assertEquals(pending, CustomTabBookmarks.entries(text))
        assertEquals(emptyList<CustomTabBookmarks.Entry>(), CustomTabBookmarks.entries(null))
        assertEquals(emptyList<CustomTabBookmarks.Entry>(), CustomTabBookmarks.entries("{"))
    }

    @Test
    fun theInboxIsCappedAtTheOldestEnd() {
        var pending = emptyList<CustomTabBookmarks.Entry>()
        for (i in 0 until CustomTabBookmarks.INBOX_CAP + 5) {
            pending = CustomTabBookmarks.withEntry(pending, CustomTabBookmarks.Entry("https://x.example/$i", "$i", i.toLong()))
        }
        assertEquals(CustomTabBookmarks.INBOX_CAP, pending.size)
        assertEquals("https://x.example/5", pending.first().url)
        assertEquals("https://x.example/${CustomTabBookmarks.INBOX_CAP + 4}", pending.last().url)
    }
}
