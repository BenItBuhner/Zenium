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

    @Test
    fun restoredListMatchesByTheItemOrTheShownUrl() {
        assertTrue(NavigationState.restoredMatches("https://a.example/", "https://a.example/", "https://a.example/"))
        // An internal page: the item is a data: URL, the view shows the zen:// one the core named.
        assertTrue(NavigationState.restoredMatches("data:text/html,x", "zen://settings", "zen://settings"))
        assertFalse(NavigationState.restoredMatches("https://b.example/", "https://b.example/", "https://a.example/"))
        assertFalse(NavigationState.restoredMatches(null, null, "https://a.example/"))
        assertFalse(NavigationState.restoredMatches("", "", ""))
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
