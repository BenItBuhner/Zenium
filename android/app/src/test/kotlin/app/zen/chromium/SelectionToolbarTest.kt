package app.zen.chromium

import app.zen.chromium.SelectionToolbar.Item
import app.zen.chromium.SelectionToolbar.SystemItem
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The selection toolbar's view-free half: the core's item list off the bridge, the plan for the
 * system's menu (after Copy, one Share) across the WebView versions' item orders, and the touch's
 * host event. The menu work itself runs on the emulator (`SelectionDemo`).
 */
class SelectionToolbarTest {
    private val strings = SelectionToolbar.Strings(copy = "Copy", share = "Share")
    private val ours = listOf(Item("search", "Search Zenium"), Item("share", "Share"))

    /** Chromium's default group, whatever resource id the WebView build gave it. */
    private val defaults = 0x7f0a0042
    /** Another group of the WebView's: a text-processing app's item. */
    private val processText = 0x7f0a0043

    // --- the bridge's list -------------------------------------------------------------------------

    @Test
    fun parsesTheCoreListInOrder() {
        val items = SelectionToolbar.parseItems(
            """[{"id":"search","title":"Search Zenium"},{"id":"share","title":"Share"}]"""
        )
        assertEquals(ours, items)
    }

    @Test
    fun nothingForNoAnswerOrAMalformedOne() {
        assertEquals(emptyList<Item>(), SelectionToolbar.parseItems(null))
        assertEquals(emptyList<Item>(), SelectionToolbar.parseItems("null"))
        assertEquals(emptyList<Item>(), SelectionToolbar.parseItems(""))
        assertEquals(emptyList<Item>(), SelectionToolbar.parseItems("[]"))
        assertEquals(emptyList<Item>(), SelectionToolbar.parseItems("{\"id\":\"search\"}"))
        assertEquals(emptyList<Item>(), SelectionToolbar.parseItems("[{\"id\":\"search\""))
    }

    @Test
    fun dropsEntriesWithoutAnIdOrTitleAndRepeatedIds() {
        val items = SelectionToolbar.parseItems(
            """[{"id":"search","title":" Search Zenium "},{"id":"","title":"Nameless"},{"title":"No id"},
               {"id":"glance","title":"  "},7,null,{"id":"search","title":"Search Again"},{"id":"share","title":"Share"}]"""
        )
        assertEquals(ours, items)
    }

    @Test
    fun readsTheSelectionOutOfTheScriptAnswer() {
        assertEquals("quantum foam", SelectionToolbar.selectionText("\"quantum foam\""))
        assertEquals("", SelectionToolbar.selectionText("\"\""))
        assertEquals("", SelectionToolbar.selectionText("null"))
        assertEquals("", SelectionToolbar.selectionText(null))
        assertEquals("", SelectionToolbar.selectionText("[1]"))
        assertTrue(SelectionToolbar.SELECTION_SCRIPT.contains("getSelection()"))
        assertTrue(SelectionToolbar.SELECTION_SCRIPT.contains("slice(0,${SelectionToolbar.SELECTION_MAX_CHARS})"))
    }

    // --- the plan ----------------------------------------------------------------------------------

    @Test
    fun itemsFollowCopyAndReplaceTheWebViewShareOnAnOlderWebView() {
        // Consecutive orders: Copy 12, Share 14, Select all 15, Web search 17 (a read-only selection).
        val system = listOf(
            SystemItem(defaults, 12, "Copy"),
            SystemItem(defaults, 14, "Share"),
            SystemItem(defaults, 15, "Select all"),
            SystemItem(defaults, 17, "Web search")
        )
        val plan = SelectionToolbar.plan(system, ours, strings)
        assertTrue(plan.anchored)
        assertEquals(12, plan.order)
        assertEquals(ours, plan.items)
        assertEquals(listOf(1), plan.hidden)
    }

    @Test
    fun itemsFollowCopyOnAWebViewThatSpacesItsItemsAndPutsShareLast() {
        // Spaced orders with Share after Web search: Copy 20, Select all 50, Web search 60, Share 70.
        val system = listOf(
            SystemItem(defaults, 20, "Copy"),
            SystemItem(defaults, 50, "Select all"),
            SystemItem(defaults, 60, "Web search"),
            SystemItem(defaults, 70, "Share")
        )
        val plan = SelectionToolbar.plan(system, ours, strings)
        assertEquals(20, plan.order)
        assertEquals(listOf(3), plan.hidden)
    }

    @Test
    fun anEditableSelectionAnchorsOnCopyAmongCutAndPaste() {
        val system = listOf(
            SystemItem(defaults, 11, "Cut"),
            SystemItem(defaults, 12, "Copy"),
            SystemItem(defaults, 13, "Paste"),
            SystemItem(defaults, 14, "Share"),
            SystemItem(defaults, 15, "Select all"),
            SystemItem(defaults, 16, "Paste as plain text"),
            SystemItem(defaults, 17, "Web search")
        )
        val plan = SelectionToolbar.plan(system, ours, strings)
        assertTrue(plan.anchored)
        assertEquals(12, plan.order)
        assertEquals(listOf(3), plan.hidden)
    }

    @Test
    fun noCopyNoPlan() {
        // A password field's selection or an insertion handle's toolbar: Paste and Select all only.
        val system = listOf(SystemItem(defaults, 13, "Paste"), SystemItem(defaults, 15, "Select all"))
        val plan = SelectionToolbar.plan(system, ours, strings)
        assertFalse(plan.anchored)
        assertTrue(plan.isEmpty)
        assertEquals(emptyList<Int>(), plan.hidden)
        assertFalse(SelectionToolbar.plan(emptyList(), ours, strings).anchored)
    }

    @Test
    fun beforeTheCoreAnswersThePlanIsAnchoredButEmpty() {
        val system = listOf(SystemItem(defaults, 12, "Copy"), SystemItem(defaults, 14, "Share"))
        val plan = SelectionToolbar.plan(system, emptyList(), strings)
        assertTrue(plan.anchored)
        assertTrue(plan.isEmpty)
        assertEquals(emptyList<Int>(), plan.hidden)
    }

    @Test
    fun theWebViewShareStaysWhenZeniumHasNoShare() {
        val system = listOf(SystemItem(defaults, 12, "Copy"), SystemItem(defaults, 14, "Share"))
        val plan = SelectionToolbar.plan(system, listOf(Item("search", "Search Zenium")), strings)
        assertEquals(emptyList<Int>(), plan.hidden)
        assertEquals(listOf(Item("search", "Search Zenium")), plan.items)
    }

    @Test
    fun shareIsToldByTheFrameworkStringInAnotherLanguageAndByZeniumsTitleWithoutIt() {
        val german = SelectionToolbar.Strings(copy = "Kopieren", share = "Teilen")
        val system = listOf(SystemItem(defaults, 12, "Kopieren"), SystemItem(defaults, 14, "Teilen"), SystemItem(defaults, 17, "Websuche"))
        assertEquals(listOf(1), SelectionToolbar.plan(system, ours, german).hidden)
        val noFrameworkString = SelectionToolbar.Strings(copy = "Copy", share = null)
        val english = listOf(SystemItem(defaults, 12, "Copy"), SystemItem(defaults, 14, "Share"))
        assertEquals(listOf(1), SelectionToolbar.plan(english, ours, noFrameworkString).hidden)
    }

    @Test
    fun onlyCopysGroupCanHoldTheWebViewShare() {
        // A text-processing app named Share, in the WebView's other group, is not the item.
        val system = listOf(SystemItem(defaults, 12, "Copy"), SystemItem(processText, 201, "Share"))
        assertEquals(emptyList<Int>(), SelectionToolbar.plan(system, ours, strings).hidden)
    }

    // --- the touch -----------------------------------------------------------------------------------

    @Test
    fun menuItemIdsNameTheItemsInOrder() {
        assertEquals(Item("search", "Search Zenium"), SelectionToolbar.itemAt(ours, SelectionToolbar.FIRST_ITEM_ID))
        assertEquals(Item("share", "Share"), SelectionToolbar.itemAt(ours, SelectionToolbar.FIRST_ITEM_ID + 1))
        assertNull(SelectionToolbar.itemAt(ours, SelectionToolbar.FIRST_ITEM_ID + 2))
        assertNull(SelectionToolbar.itemAt(ours, SelectionToolbar.FIRST_ITEM_ID - 1))
    }

    @Test
    fun theSelectionsPlaceIsAFractionOfTheView() {
        assertEquals(0.25, SelectionToolbar.fraction(100f, 400), 1e-9)
        assertEquals(1.0, SelectionToolbar.fraction(500f, 400), 1e-9)
        assertEquals(0.0, SelectionToolbar.fraction(-5f, 400), 1e-9)
        assertEquals(0.5, SelectionToolbar.fraction(100f, 0), 1e-9)
        assertEquals(0.5, SelectionToolbar.fraction(Float.NaN, 400), 1e-9)
    }

    @Test
    fun theTouchBecomesASelectionActionEvent() {
        val event = JSONObject(SelectionToolbar.action("tab_1", "search", "quantum foam", 0.25, 0.75).toString())
        assertEquals(setOf("tabId", "id", "text", "originX", "originY"), event.keys().asSequence().toSet())
        assertEquals("tab_1", event.getString("tabId"))
        assertEquals("search", event.getString("id"))
        assertEquals("quantum foam", event.getString("text"))
        assertEquals(0.25, event.getDouble("originX"), 1e-9)
        assertEquals(0.75, event.getDouble("originY"), 1e-9)
    }
}
