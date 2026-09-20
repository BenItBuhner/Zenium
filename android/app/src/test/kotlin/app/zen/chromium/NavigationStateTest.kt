package app.zen.chromium

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Base64

/**
 * The marshalling and the mapping around the navigation snapshot, without a WebView: the
 * `hostState` string's shape, its 64 KB cap and what is refused as not ours, the list-to-entries
 * mapping (`originalUrl` only when it adds something, the index clamped), the jump arithmetic and
 * the names the internal pages go by. The bundle round trip on a real WebView is
 * `NavigationStateWebViewTest` (instrumentation).
 */
class NavigationStateTest {
    private val bytes = ByteArray(300) { (it * 7).toByte() }

    // --- hostState: encoding, the cap, refusals -------------------------------------------------

    @Test
    fun encodedStateCarriesThePrefixAndDecodesToTheSameBytes() {
        val text = NavigationState.encodeHostState(bytes)!!
        assertTrue(text.startsWith(NavigationState.HOST_STATE_PREFIX))
        assertEquals(Base64.getEncoder().encodeToString(bytes), text.removePrefix(NavigationState.HOST_STATE_PREFIX))
        assertTrue(bytes.contentEquals(NavigationState.decodeHostState(text)))
    }

    @Test
    fun stateOverTheCapIsNeverProduced() {
        // The cap is on the string that leaves the host, prefix included: the largest bundle
        // whose encoding still fits goes out, and three bytes more (one base64 quad) do not.
        val body = NavigationState.HOST_STATE_MAX - NavigationState.HOST_STATE_PREFIX.length
        val underTheCap = ByteArray(body / 4 * 3)
        val text = NavigationState.encodeHostState(underTheCap)!!
        assertTrue(text.length <= NavigationState.HOST_STATE_MAX)
        assertTrue(text.length + 4 > NavigationState.HOST_STATE_MAX)
        assertNull(NavigationState.encodeHostState(ByteArray(body / 4 * 3 + 3)))
        assertNull(NavigationState.encodeHostState(ByteArray(100 * 1024)))
    }

    @Test
    fun stateOverTheCapIsNeverDecodedEither() {
        val text = NavigationState.HOST_STATE_PREFIX + "A".repeat(NavigationState.HOST_STATE_MAX)
        assertNull(NavigationState.decodeHostState(text))
    }

    @Test
    fun foreignStateIsRefusedBeforeItIsRead() {
        assertNull(NavigationState.decodeHostState(null))
        assertNull(NavigationState.decodeHostState(""))
        // Plain base64, as another host or a hand-written snapshot would carry.
        assertNull(NavigationState.decodeHostState(Base64.getEncoder().encodeToString(bytes)))
        // Desktop's per-entry page state shape, and arbitrary text.
        assertNull(NavigationState.decodeHostState("{\"pageState\":\"...\"}"))
        assertNull(NavigationState.decodeHostState("zwv2:AAAA"))
        // Ours by prefix, but with nothing or with something other than base64 behind it.
        assertNull(NavigationState.decodeHostState(NavigationState.HOST_STATE_PREFIX))
        assertNull(NavigationState.decodeHostState(NavigationState.HOST_STATE_PREFIX + "not base64!"))
    }

    // --- the entries -----------------------------------------------------------------------------

    @Test
    fun itemsMapToEntriesWithTheCurrentIndex() {
        val items = listOf(
            NavigationState.Item("https://a.example/", "A", "https://a.example/"),
            NavigationState.Item("https://b.example/landing", "B", "https://b.example/"),
            NavigationState.Item("https://c.example/", null, null)
        )
        val snapshot = NavigationState.snapshotJson(items, 1)
        assertEquals(1, snapshot.getInt("index"))
        val entries = snapshot.getJSONArray("entries")
        assertEquals(3, entries.length())
        assertEquals("https://a.example/", entries.getJSONObject(0).getString("url"))
        assertEquals("A", entries.getJSONObject(0).getString("title"))
        assertEquals(2, entries.getJSONObject(0).length())
        // The address a redirect was asked at is kept; one equal to the URL says nothing.
        assertEquals("https://b.example/", entries.getJSONObject(1).getString("originalUrl"))
        assertFalse(entries.getJSONObject(0).has("originalUrl"))
        // A missing title is the empty string, as the core's entry type wants.
        assertEquals("", entries.getJSONObject(2).getString("title"))
        assertFalse(entries.getJSONObject(2).has("originalUrl"))
    }

    @Test
    fun emptyListIsTheNoListAnswer() {
        assertEquals("""{"entries":[],"index":-1}""", NavigationState.emptySnapshot().toString())
        assertEquals("""{"entries":[],"index":-1}""", NavigationState.snapshotJson(emptyList(), 0).toString())
    }

    @Test
    fun indexIsClampedIntoTheList() {
        val items = listOf(NavigationState.Item("https://a.example/", "A", null), NavigationState.Item("https://b.example/", "B", null))
        assertEquals(1, NavigationState.snapshotJson(items, 5).getInt("index"))
        assertEquals(0, NavigationState.snapshotJson(items, -1).getInt("index"))
    }

    @Test
    fun entriesGoByTheNamesAtTheirPositions() {
        val items = listOf(NavigationState.Item("https://a.example/", "A", null), NavigationState.Item(PLACEHOLDER, "Settings", PLACEHOLDER))
        val snapshot = NavigationState.snapshotJson(items, 1, mapOf(1 to "zen://settings"))
        val settings = snapshot.getJSONArray("entries").getJSONObject(1)
        assertEquals("zen://settings", settings.getString("url"))
        // The original URL (the same placeholder) goes by the same name and so says nothing.
        assertFalse(settings.has("originalUrl"))
        // A name at a web page's position is not consulted.
        assertEquals(listOf("https://a.example/", NavigationState.BLANK_URL), urlsOf(NavigationState.snapshotJson(items, 1, mapOf(0 to "zen://history"))))
    }

    @Test
    fun currentUrlOfARestorePayload() {
        val entries = JSONArray().put(JSONObject().put("url", "https://a.example/").put("title", "A")).put(JSONObject().put("url", "https://b.example/"))
        assertEquals("https://b.example/", NavigationState.currentUrl(entries, 1))
        assertEquals("https://a.example/", NavigationState.currentUrl(entries, 0))
        assertNull(NavigationState.currentUrl(entries, 2))
        assertNull(NavigationState.currentUrl(entries, -1))
        assertNull(NavigationState.currentUrl(JSONArray().put(JSONObject().put("url", "")), 0))
        assertNull(NavigationState.currentUrl(JSONArray().put("not an entry"), 0))
    }

    // --- traversal and matching ------------------------------------------------------------------

    @Test
    fun stepsToAnIndexAreRelativeToTheCurrentOne() {
        assertEquals(-2, NavigationState.stepsTo(0, 2, 3))
        assertEquals(1, NavigationState.stepsTo(2, 1, 3))
        assertEquals(0, NavigationState.stepsTo(1, 1, 3))
        assertNull(NavigationState.stepsTo(3, 1, 3))
        assertNull(NavigationState.stepsTo(-1, 1, 3))
        assertNull(NavigationState.stepsTo(0, -1, 0))
    }

    // --- the restored list against the snapshot ---------------------------------------------------

    @Test
    fun restoredListMatchesTheSnapshotPositionForPosition() {
        val pages = listOf("https://a.example/", "https://b.example/", "https://c.example/")
        assertTrue(NavigationState.restoredMatches(pages, 2, pages, 2))
        assertTrue(NavigationState.restoredMatches(pages, 0, pages, 0))
        // Not the same current entry, not the same length, not the same pages: not the list described.
        assertFalse(NavigationState.restoredMatches(pages, 1, pages, 2))
        assertFalse(NavigationState.restoredMatches(pages.take(2), 1, pages, 1))
        assertFalse(NavigationState.restoredMatches(pages, 2, pages.take(2), 2))
        assertFalse(NavigationState.restoredMatches(listOf("https://a.example/", "https://x.example/", "https://c.example/"), 2, pages, 2))
        assertFalse(NavigationState.restoredMatches(listOf("https://a.example/", null, "https://c.example/"), 2, pages, 2))
        assertFalse(NavigationState.restoredMatches(listOf("https://a.example/", "", "https://c.example/"), 2, pages, 2))
        assertFalse(NavigationState.restoredMatches(emptyList(), -1, emptyList(), -1))
        assertFalse(NavigationState.restoredMatches(emptyList(), 0, listOf("https://a.example/"), 0))
    }

    @Test
    fun anInternalEntryIsMatchedByItsDataDocumentNotByWhatTheViewShows() {
        // A reader page on top of the article it was made from: the list holds the page as its
        // data: document, the snapshot names it zen://reader?…, and nothing is asked of getUrl().
        val reader = "zen://reader?id=article_1&url=https%3A%2F%2Fa.example%2Fstory"
        val items = listOf("https://a.example/story", PLACEHOLDER)
        assertTrue(NavigationState.restoredMatches(items, 1, listOf("https://a.example/story", reader), 1))
        // A data: page the user opened as one is its own item, and is matched as such.
        assertTrue(NavigationState.restoredMatches(listOf("https://a.example/story", "data:text/html,<h1>Story</h1>"), 1, listOf("https://a.example/story", "data:text/html,<h1>Story</h1>"), 1))
        // An internal page behind the current one, too.
        assertTrue(NavigationState.restoredMatches(items + "https://b.example/", 2, listOf("https://a.example/story", reader, "https://b.example/"), 2))
        // A data: page nobody remembered the name of is about:blank in the snapshot: still its document.
        assertTrue(NavigationState.restoredMatches(items, 1, listOf("https://a.example/story", NavigationState.BLANK_URL), 1))
        // A data: item is not a web page's stand-in, and a web page is not an internal entry's.
        assertFalse(NavigationState.restoredMatches(items, 1, listOf("https://a.example/story", "https://a.example/reader"), 1))
        assertFalse(NavigationState.restoredMatches(listOf("https://a.example/story", "https://a.example/reader"), 1, listOf("https://a.example/story", reader), 1))
    }

    @Test
    fun aDataItemStandsInForAnInternalEntryOrTheBlankOne() {
        assertTrue(NavigationState.standsInForInternal("data:text/html,x", "zen://history"))
        assertTrue(NavigationState.standsInForInternal("data:text/html,x", NavigationState.BLANK_URL))
        assertFalse(NavigationState.standsInForInternal("data:text/html,x", "https://a.example/"))
        assertFalse(NavigationState.standsInForInternal("data:text/html,x", "data:text/html,x"))
        assertFalse(NavigationState.standsInForInternal("https://a.example/", "zen://history"))
        assertFalse(NavigationState.standsInForInternal("", "zen://history"))
    }

    @Test
    fun theInternalNamesOfARestoredListComeFromTheSnapshotByPosition() {
        // Two internal pages: one and the same item URL in the list, two names in the snapshot.
        val items = listOf("https://a.example/", PLACEHOLDER, PLACEHOLDER, "data:text/html,short")
        val entries = listOf("https://a.example/", "zen://reader?id=1", "zen://image?id=2", "data:text/html,short")
        val names = NavigationState.internalNamesOf(items, entries)
        assertEquals(mapOf(1 to "zen://reader?id=1", 2 to "zen://image?id=2"), names)
        // What publicUrl then gives the fresh view's list: the names, and the short data: page as itself.
        assertEquals(entries, items.mapIndexed { i, item -> NavigationState.publicUrl(item!!, names[i]) })
        // A data: page named about:blank has no name to remember; a null item is skipped.
        assertTrue(NavigationState.internalNamesOf(listOf(PLACEHOLDER, null), listOf(NavigationState.BLANK_URL, "zen://history")).isEmpty())
    }

    /**
     * The case the names are for: a reader page two entries back, in a fresh view that never
     * showed it, with another internal page current. Their items are the same placeholder, so
     * nothing in the list tells them apart: off the snapshot the view's first list names each
     * by its position; off nothing both would be `about:blank` until the user went back to them.
     */
    @Test
    fun nonCurrentInternalEntriesAreNamedFromTheSnapshotNotBlankAndNotEachOther() {
        val reader = "zen://reader?id=a1&url=https%3A%2F%2Fa.example%2Farticle"
        val items = listOf(PLACEHOLDER, "https://b.example/", PLACEHOLDER)
        val entries = listOf(reader, "https://b.example/", "zen://history")
        assertTrue(NavigationState.restoredMatches(items, 2, entries, 2))

        val names = NavigationState.internalNamesOf(items, entries)
        assertEquals(mapOf(0 to reader, 2 to "zen://history"), names)
        val listItems = items.map { NavigationState.Item(it, "", null) }
        val named = NavigationState.snapshotJson(listItems, 2, names)
        assertEquals(entries, urlsOf(named))
        assertEquals(2, named.getInt("index"))
        // Without the seed, the fresh view has no name for an entry it never showed.
        val unnamed = NavigationState.snapshotJson(listItems, 2)
        assertEquals(listOf(NavigationState.BLANK_URL, "https://b.example/", NavigationState.BLANK_URL), urlsOf(unnamed))
    }

    /**
     * How a view keeps the names across commits: a position keeps its name while its item is a
     * `data:` document; one pruned with the entries past the current page, or taken by a web
     * page, loses it; the commit of another internal page at a position names it anew.
     */
    @Test
    fun namesStandWhileTheirPositionsHoldInternalPages() {
        val names = mapOf(1 to "zen://newtab", 3 to "zen://history")
        // Nothing changed: nothing goes.
        assertEquals(names, NavigationState.keptNames(names, listOf("https://a.example/", PLACEHOLDER, "https://b.example/", PLACEHOLDER)))
        // Back to position 1 and on to a web page: the entries past it went, position 3 with them.
        assertEquals(mapOf(1 to "zen://newtab"), NavigationState.keptNames(names, listOf("https://a.example/", PLACEHOLDER, "https://c.example/")))
        // Back to position 0 and on to a web page: position 1 is that page's now.
        assertTrue(NavigationState.keptNames(names, listOf("https://a.example/", "https://c.example/")).isEmpty())
        // Position 1 taken by another internal page: the name stands until that page's commit replaces it.
        assertEquals(mapOf(1 to "zen://newtab"), NavigationState.keptNames(names, listOf("https://a.example/", PLACEHOLDER)))
        // A list gone empty keeps nothing; a null item is not an internal page.
        assertTrue(NavigationState.keptNames(names, emptyList()).isEmpty())
        assertTrue(NavigationState.keptNames(names, listOf("https://a.example/", null)).isEmpty())
    }

    @Test
    fun aNewEntryFromTheEndOfAFullListDroppedTheOldest() {
        val full = NavigationState.LIST_MAX
        // A load or a pushState from the last position of a full list: as long, last position current.
        assertTrue(NavigationState.listDroppedAnEntry(full - 1, full, full - 1, full, reload = false))
        // A reload of that position moves nothing.
        assertFalse(NavigationState.listDroppedAnEntry(full - 1, full, full - 1, full, reload = true))
        // From anywhere before the end, the entries past it go instead, and the list is no longer than it was.
        assertFalse(NavigationState.listDroppedAnEntry(full - 2, full, full - 1, full, reload = false))
        assertFalse(NavigationState.listDroppedAnEntry(10, full, 11, 12, reload = false))
        // A list under the cap grows instead; a traversal within a full list changes the position.
        assertFalse(NavigationState.listDroppedAnEntry(full - 2, full - 1, full - 1, full, reload = false))
        assertFalse(NavigationState.listDroppedAnEntry(full - 1, full, full - 2, full, reload = false))
        assertFalse(NavigationState.listDroppedAnEntry(-1, 0, 0, 1, reload = false))
    }

    private fun urlsOf(snapshot: JSONObject): List<String> {
        val entries = snapshot.getJSONArray("entries")
        return (0 until entries.length()).map { entries.getJSONObject(it).getString("url") }
    }

    @Test
    fun theUrlsOfARestorePayload() {
        val entries = JSONArray()
            .put(JSONObject().put("url", "https://a.example/").put("title", "A"))
            .put(JSONObject().put("title", "no url"))
            .put("not an entry")
            .put(JSONObject().put("url", "zen://history"))
        assertEquals(listOf("https://a.example/", "", "", "zen://history"), NavigationState.entryUrls(entries))
        assertEquals(emptyList<String>(), NavigationState.entryUrls(JSONArray()))
    }

    // --- the internal pages ----------------------------------------------------------------------

    @Test
    fun aDataItemStandsInForThePageTheViewShows() {
        assertTrue(NavigationState.standsInFor("data:text/html,x", "zen://settings"))
        assertFalse(NavigationState.standsInFor("https://a.example/", "https://a.example/"))
        assertFalse(NavigationState.standsInFor("data:text/html,x", "data:text/html,x"))
        assertFalse(NavigationState.standsInFor("data:text/html,x", null))
        assertFalse(NavigationState.standsInFor("data:text/html,x", ""))
    }

    @Test
    fun publicUrlNamesInternalPagesAndKeepsShortDataUrls() {
        val long = "data:text/html," + "y".repeat(NavigationState.DATA_URL_KEEP_MAX + 1)
        val short = "data:text/html,<p>hi</p>"
        assertEquals("zen://history", NavigationState.publicUrl(PLACEHOLDER, "zen://history"))
        assertEquals("zen://history", NavigationState.publicUrl(long, "zen://history"))
        // An internal page's placeholder nobody has a name for says nothing about the page; a long
        // data: URL would bloat every snapshot of the tab; a short one is the page.
        assertEquals(NavigationState.BLANK_URL, NavigationState.publicUrl(PLACEHOLDER, null))
        assertEquals(NavigationState.BLANK_URL, NavigationState.publicUrl(long, null))
        assertEquals(short, NavigationState.publicUrl(short, null))
        // A web page goes by its URL, whatever name its position has.
        assertEquals("https://a.example/", NavigationState.publicUrl("https://a.example/", "zen://history"))
        assertEquals("https://a.example/", NavigationState.publicUrl("https://a.example/", null))
    }

    @Test
    fun theDocumentPlaceholderIsADataHeaderWithNothingBehindTheComma() {
        assertTrue(NavigationState.isDocumentPlaceholder(PLACEHOLDER))
        assertTrue(NavigationState.isDocumentPlaceholder("data:text/html,"))
        assertFalse(NavigationState.isDocumentPlaceholder("data:text/html,<p>hi</p>"))
        assertFalse(NavigationState.isDocumentPlaceholder("data:text/html;charset=utf-8;base64,PHA+"))
        assertFalse(NavigationState.isDocumentPlaceholder("https://a.example/?q=a,"))
        assertFalse(NavigationState.isDocumentPlaceholder(""))
    }

    private companion object {
        /** What every `loadDataWithBaseURL` document's list item carries: the `data:` header the document was loaded under. */
        private const val PLACEHOLDER = "data:text/html;charset=utf-8;base64,"
    }
}
