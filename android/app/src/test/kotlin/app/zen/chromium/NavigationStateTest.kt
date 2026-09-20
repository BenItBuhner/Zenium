package app.zen.chromium

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
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
    fun entriesGoByTheUrlTheResolverGives() {
        val data = "data:text/html;charset=utf-8,%3Chtml%3E" + "x".repeat(4000)
        val items = listOf(NavigationState.Item("https://a.example/", "A", null), NavigationState.Item(data, "Settings", data))
        val snapshot = NavigationState.snapshotJson(items, 1) { url -> if (url == data) "zen://settings" else url }
        val settings = snapshot.getJSONArray("entries").getJSONObject(1)
        assertEquals("zen://settings", settings.getString("url"))
        // The original URL resolves the same way and so says nothing.
        assertFalse(settings.has("originalUrl"))
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
        val items = listOf("https://a.example/story", "data:text/html;charset=utf-8,%3C!doctype%20html%3E%3Ch1%3EStory%3C%2Fh1%3E")
        assertTrue(NavigationState.restoredMatches(items, 1, listOf("https://a.example/story", reader), 1))
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
    fun theInternalNamesOfARestoredListComeFromTheSnapshot() {
        val doc1 = "data:text/html,one"
        val doc2 = "data:text/html,two"
        val items = listOf("https://a.example/", doc1, doc2, "data:text/html,short")
        val entries = listOf("https://a.example/", "zen://reader?id=1", "zen://image?id=2", "data:text/html,short")
        val names = NavigationState.internalNamesOf(items, entries)
        assertEquals(
            mapOf(NavigationState.dataUrlKey(doc1) to "zen://reader?id=1", NavigationState.dataUrlKey(doc2) to "zen://image?id=2"),
            names
        )
        // What publicUrl then gives the fresh view's list: the names, and the short data: page as itself.
        assertEquals(entries, items.map { NavigationState.publicUrl(it!!) { key -> names[key] } })
        // A data: page named about:blank has no name to remember; a null item is skipped.
        assertTrue(NavigationState.internalNamesOf(listOf(doc1, null), listOf(NavigationState.BLANK_URL, "zen://history")).isEmpty())
    }

    /**
     * The case the names are for: a reader page two entries back, its document longer than a
     * `data:` URL is kept verbatim, in a fresh view that never showed it. Off the snapshot the
     * view's first list names it `zen://reader…`; off nothing it would be `about:blank` until
     * the user went back to it.
     */
    @Test
    fun aNonCurrentInternalEntryIsNamedFromTheSnapshotNotBlank() {
        val readerDoc = "data:text/html," + "<p>the article, read</p>".repeat(200)
        assertTrue(readerDoc.length > NavigationState.DATA_URL_KEEP_MAX)
        val reader = "zen://reader?id=a1&url=https%3A%2F%2Fa.example%2Farticle"
        val items = listOf(readerDoc, "https://b.example/", "https://c.example/")
        val entries = listOf(reader, "https://b.example/", "https://c.example/")
        assertTrue(NavigationState.restoredMatches(items, 2, entries, 2))

        val names = NavigationState.internalNamesOf(items, entries)
        assertEquals(mapOf(NavigationState.dataUrlKey(readerDoc) to reader), names)
        val listItems = items.map { NavigationState.Item(it, "", null) }
        val named = NavigationState.snapshotJson(listItems, 2) { url -> NavigationState.publicUrl(url) { key -> names[key] } }
        assertEquals(entries, urlsOf(named))
        assertEquals(2, named.getInt("index"))
        // Without the seed, the fresh view has no name for an entry it never showed.
        val unnamed = NavigationState.snapshotJson(listItems, 2) { url -> NavigationState.publicUrl(url) { null } }
        assertEquals(listOf(NavigationState.BLANK_URL, "https://b.example/", "https://c.example/"), urlsOf(unnamed))
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
        val known = mapOf(NavigationState.dataUrlKey(long) to "zen://history")
        assertEquals("zen://history", NavigationState.publicUrl(long) { known[it] })
        // A long data: URL nobody remembers would bloat every snapshot of the tab; a short one is the page.
        assertEquals(NavigationState.BLANK_URL, NavigationState.publicUrl(long) { null })
        assertEquals(short, NavigationState.publicUrl(short) { null })
        assertEquals("https://a.example/", NavigationState.publicUrl("https://a.example/") { error("not asked for a web page") })
    }

    @Test
    fun dataUrlKeysTellLengthAndContentApart() {
        val a = "data:text/html,aaaa"
        val b = "data:text/html,aaab"
        assertEquals(NavigationState.dataUrlKey(a), NavigationState.dataUrlKey(a))
        assertNotEquals(NavigationState.dataUrlKey(a), NavigationState.dataUrlKey(b))
        assertNotEquals(NavigationState.dataUrlKey(a), NavigationState.dataUrlKey(a + "a"))
        assertEquals(a.length.toLong(), NavigationState.dataUrlKey(a) ushr 32)
    }
}
