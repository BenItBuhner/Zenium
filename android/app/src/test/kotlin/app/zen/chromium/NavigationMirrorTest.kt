package app.zen.chromium

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * The host's mirror of each tab's list and state ([NavigationMirror]): what the synchronous
 * `view.navigationEntries` and `view.navigationHostState` answer, the no-list answer for a tab
 * that never pushed, and what goes when – a destroyed view's entry, both halves of a popup's
 * provisional entry on bind, everything on a chrome rebuild – plus the state's age.
 */
class NavigationMirrorTest {
    private var clock = 1_000L
    private val mirror = NavigationMirror { clock }

    @Test
    fun answersTheLastListAndStatePushed() {
        mirror.listChanged("tab_1", list("https://a.example/"))
        mirror.stateChanged("tab_1", "zwv1:AAAA")
        assertEquals(listOf("https://a.example/"), urlsOf(mirror.entries("tab_1")))
        assertEquals("zwv1:AAAA", mirror.hostState("tab_1"))

        mirror.listChanged("tab_1", list("https://a.example/", "https://b.example/"))
        mirror.stateChanged("tab_1", "zwv1:BBBB")
        assertEquals(listOf("https://a.example/", "https://b.example/"), urlsOf(mirror.entries("tab_1")))
        assertEquals("zwv1:BBBB", mirror.hostState("tab_1"))
    }

    @Test
    fun aTabThatPushedNothingHasNoListAndNoState() {
        val none = mirror.entries("tab_none")
        assertEquals(0, none.getJSONArray("entries").length())
        assertEquals(-1, none.getInt("index"))
        assertNull(mirror.hostState("tab_none"))
        assertNull(mirror.stateAge("tab_none"))
    }

    @Test
    fun aStateOfNothingDropsTheStateButKeepsTheList() {
        mirror.listChanged("tab_1", list("https://a.example/"))
        mirror.stateChanged("tab_1", "zwv1:AAAA")
        // A private tab, an empty list, a state over the cap: the list is still the list.
        mirror.stateChanged("tab_1", null)
        assertNull(mirror.hostState("tab_1"))
        assertEquals(listOf("https://a.example/"), urlsOf(mirror.entries("tab_1")))
    }

    @Test
    fun aPopupBoundToItsTabLeavesNothingUnderTheProvisionalId() {
        // The popup's pushes before the core knew its tab id filled both halves under `popup_1`.
        mirror.listChanged("popup_1", list("https://popup.example/"))
        mirror.stateChanged("popup_1", "zwv1:PPPP")
        mirror.listChanged("tab_other", list("https://other.example/"))
        mirror.stateChanged("tab_other", "zwv1:OOOO")

        mirror.forget("popup_1")

        assertEquals(0, mirror.entries("popup_1").getJSONArray("entries").length())
        assertEquals(-1, mirror.entries("popup_1").getInt("index"))
        assertNull(mirror.hostState("popup_1"))
        assertNull(mirror.stateAge("popup_1"))
        // Another tab's entry is not touched.
        assertEquals(listOf("https://other.example/"), urlsOf(mirror.entries("tab_other")))
        assertEquals("zwv1:OOOO", mirror.hostState("tab_other"))
    }

    @Test
    fun aRebuiltChromeStartsWithNothing() {
        mirror.listChanged("tab_1", list("https://a.example/"))
        mirror.stateChanged("tab_1", "zwv1:AAAA")
        mirror.listChanged("tab_2", list("https://b.example/"))
        mirror.clear()
        assertEquals(-1, mirror.entries("tab_1").getInt("index"))
        assertEquals(-1, mirror.entries("tab_2").getInt("index"))
        assertNull(mirror.hostState("tab_1"))
    }

    @Test
    fun theStateAgeCountsFromItsLastRefresh() {
        mirror.stateChanged("tab_1", "zwv1:AAAA")
        clock += 250
        assertEquals(250L, mirror.stateAge("tab_1"))
        mirror.stateChanged("tab_1", "zwv1:BBBB")
        assertEquals(0L, mirror.stateAge("tab_1"))
        mirror.stateChanged("tab_1", null)
        assertNull(mirror.stateAge("tab_1"))
    }

    private fun list(vararg urls: String): JSONObject {
        val entries = JSONArray()
        for (url in urls) entries.put(JSONObject().put("url", url).put("title", ""))
        return JSONObject().put("entries", entries).put("index", urls.size - 1)
    }

    private fun urlsOf(list: JSONObject): List<String> {
        val entries = list.getJSONArray("entries")
        return (0 until entries.length()).map { entries.getJSONObject(it).getString("url") }
    }
}
