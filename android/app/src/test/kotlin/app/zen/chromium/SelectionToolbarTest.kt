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
 * system's menu (after the last of Copy and Paste, one Share) across the WebView versions' item
 * orders, the listing kept current across one mode's selection changes, and the touch's host
 * event. The menu work itself runs on the emulator (`SelectionDemo`).
 */
class SelectionToolbarTest {
    private val strings = SelectionToolbar.Strings(copy = "Copy", share = "Share", paste = "Paste")
    private val ours = listOf(Item("search", "Search DuckDuckGo"), Item("share", "Share"))

    /** Chromium's default group, whatever resource id the WebView build gave it. */
    private val defaults = 0x7f0a0042
    /** Another group of the WebView's: a text-processing app's item. */
    private val processText = 0x7f0a0043
    /** The WebView's `select_action_menu_share` id, as resolved in its package. */
    private val shareId = 0x02090017

    // --- the bridge's list -------------------------------------------------------------------------

    @Test
    fun parsesTheCoreListInOrder() {
        val items = SelectionToolbar.parseItems(
            """[{"id":"search","title":"Search DuckDuckGo"},{"id":"share","title":"Share"}]"""
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
            """[{"id":"search","title":" Search DuckDuckGo "},{"id":"","title":"Nameless"},{"title":"No id"},
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
    fun aThirdItemFromTheCoreNeedsNothingHereAndFollowsTheOthersAheadOfTheSystemsRest() {
        // The core lists Translate after Share (#106's services core on the phone): the plan
        // carries it in the same anchored run, before Select all, so the bar fills in the core's order.
        val three = SelectionToolbar.parseItems(
            """[{"id":"search","title":"Search DuckDuckGo"},{"id":"share","title":"Share"},{"id":"translate","title":"Translate"}]"""
        )
        assertEquals(ours + Item("translate", "Translate"), three)
        val system = listOf(
            SystemItem(defaults, 12, "Copy"),
            SystemItem(defaults, 14, "Share"),
            SystemItem(defaults, 15, "Select all"),
            SystemItem(defaults, 17, "Web search")
        )
        val plan = SelectionToolbar.plan(system, three, strings)
        assertTrue(plan.anchored)
        assertEquals(12, plan.order)
        assertEquals(listOf("search", "share", "translate"), plan.items.map { it.id })
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
    fun anEditableSelectionAnchorsOnPasteSoCutCopyPasteStayAheadOfOurs() {
        // Chromium's editable order: Cut, Copy, Paste, Paste as plain text, Select all, Web search, Share.
        val system = listOf(
            SystemItem(defaults, 0, "Cut"),
            SystemItem(defaults, 10, "Copy"),
            SystemItem(defaults, 20, "Paste"),
            SystemItem(defaults, 30, "Paste as plain text"),
            SystemItem(defaults, 40, "Select all"),
            SystemItem(defaults, 50, "Web search"),
            SystemItem(defaults, 60, "Share")
        )
        val plan = SelectionToolbar.plan(system, ours, strings)
        assertTrue(plan.anchored)
        assertEquals(20, plan.order)
        assertEquals(listOf(6), plan.hidden)
    }

    @Test
    fun anEditableSelectionWithNothingToPasteAnchorsOnCopy() {
        // An empty clipboard: no Paste item, so Copy is the last of the two.
        val system = listOf(
            SystemItem(defaults, 0, "Cut"),
            SystemItem(defaults, 10, "Copy"),
            SystemItem(defaults, 40, "Select all"),
            SystemItem(defaults, 60, "Share")
        )
        assertEquals(10, SelectionToolbar.plan(system, ours, strings).order)
        // A WebView without the Paste string known, or with Paste ahead of Copy: Copy anchors.
        val noPasteString = SelectionToolbar.Strings(copy = "Copy", share = "Share")
        val editable = listOf(SystemItem(defaults, 10, "Copy"), SystemItem(defaults, 20, "Paste"))
        assertEquals(10, SelectionToolbar.plan(editable, ours, noPasteString).order)
        val pasteFirst = listOf(SystemItem(defaults, 5, "Paste"), SystemItem(defaults, 10, "Copy"))
        assertEquals(10, SelectionToolbar.plan(pasteFirst, ours, strings).order)
        // A Paste in another group (a text-processing app of that name) is not the anchor.
        val other = listOf(SystemItem(defaults, 10, "Copy"), SystemItem(processText, 200, "Paste"))
        assertEquals(10, SelectionToolbar.plan(other, ours, strings).order)
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
        val system = listOf(SystemItem(defaults, 12, "Copy"), SystemItem(defaults, 14, "Share", shareId))
        val withId = SelectionToolbar.Strings(copy = "Copy", share = "Share", paste = "Paste", shareItemId = shareId)
        val plan = SelectionToolbar.plan(system, listOf(Item("search", "Search DuckDuckGo")), withId)
        assertEquals(emptyList<Int>(), plan.hidden)
        assertEquals(listOf(Item("search", "Search DuckDuckGo")), plan.items)
    }

    @Test
    fun shareIsToldByItsIdFirstWhateverItsTitleOrGroup() {
        // The WebView's Share under a translation the framework's string does not share, and
        // out of the default group: the id names it all the same, and nothing else is hidden.
        val system = listOf(
            SystemItem(defaults, 12, "Copy"),
            SystemItem(processText, 90, "Compartir", shareId),
            SystemItem(defaults, 14, "Share", 0x02090021)
        )
        val withId = SelectionToolbar.Strings(copy = "Copy", share = "Share", paste = "Paste", shareItemId = shareId)
        assertEquals(listOf(1), SelectionToolbar.plan(system, ours, withId).hidden)
    }

    @Test
    fun shareFallsBackToTitlesWhenTheIdIsUnknownOrAbsent() {
        // No id resolved (0): the title, in Copy's group.
        val english = listOf(SystemItem(defaults, 12, "Copy", 0x02090011), SystemItem(defaults, 14, "Share", 0x02090017))
        assertEquals(listOf(1), SelectionToolbar.plan(english, ours, strings).hidden)
        // An id resolved but on no item (a WebView that renamed it): the title again.
        val renamed = SelectionToolbar.Strings(copy = "Copy", share = "Share", paste = "Paste", shareItemId = 0x0209ffff)
        assertEquals(listOf(1), SelectionToolbar.plan(english, ours, renamed).hidden)
        // The framework string in another language, and Zenium's own title without the string.
        val german = SelectionToolbar.Strings(copy = "Kopieren", share = "Teilen")
        val system = listOf(SystemItem(defaults, 12, "Kopieren"), SystemItem(defaults, 14, "Teilen"), SystemItem(defaults, 17, "Websuche"))
        assertEquals(listOf(1), SelectionToolbar.plan(system, ours, german).hidden)
        val noFrameworkString = SelectionToolbar.Strings(copy = "Copy", share = null)
        assertEquals(listOf(1), SelectionToolbar.plan(english, ours, noFrameworkString).hidden)
    }

    @Test
    fun onlyCopysGroupCanHoldTheWebViewShareByTitle() {
        // A text-processing app named Share, in the WebView's other group, is not the item.
        val system = listOf(SystemItem(defaults, 12, "Copy"), SystemItem(processText, 201, "Share"))
        assertEquals(emptyList<Int>(), SelectionToolbar.plan(system, ours, strings).hidden)
    }

    // --- the listing across one mode's selection changes ---------------------------------------------

    /** The view's side of a `Listing`, replies held back until the test lets them through. */
    private class Bridge {
        val reads = ArrayList<(String) -> Unit>()
        val lists = ArrayList<Pair<String, (String?) -> Unit>>()
        var invalidations = 0
        val listing = SelectionToolbar.Listing(
            readSelection = { onText -> reads += onText },
            listItems = { text, onJson -> lists += text to onJson },
            invalidate = { invalidations++ }
        )

        /** The page answers the oldest read with `text`, then the core the list asked for (if one was) with `json`. */
        fun answer(text: String, json: String?) {
            reads.removeAt(0)(text)
            if (lists.isEmpty()) return
            val (asked, onJson) = lists.removeAt(0)
            assertEquals(text, asked)
            onJson(json)
        }
    }

    private val textItems = """[{"id":"search","title":"Search DuckDuckGo"},{"id":"share","title":"Share"}]"""
    private val addressItems = """[{"id":"glance","title":"Open in Glance"},{"id":"share","title":"Share"}]"""

    @Test
    fun theFirstAnswerIsAppliedAndInvalidatesTheModeOnceAndTheNextPrepareAsksAgainWithoutACycle() {
        val bridge = Bridge()
        val listing = bridge.listing
        listing.onPrepare()
        assertEquals(1, listing.asks)
        assertEquals(emptyList<Item>(), listing.items)
        bridge.answer("quantum", textItems)
        assertEquals(ours, listing.items)
        assertEquals("quantum", listing.text)
        assertEquals(1, bridge.invalidations)
        // The invalidate's own prepare asks once more; the same answer ends it there.
        listing.onPrepare()
        assertEquals(2, listing.asks)
        bridge.answer("quantum", textItems)
        assertEquals(1, bridge.invalidations)
        assertEquals(0, bridge.reads.size)
    }

    @Test
    fun aHandleDragOntoAnAddressAndBackChangesTheItemsThroughThePrepareTheWebViewInvalidates() {
        val bridge = Bridge()
        val listing = bridge.listing
        listing.onPrepare()
        bridge.answer("quantum", textItems)
        listing.onPrepare()
        bridge.answer("quantum", textItems)
        assertEquals(1, bridge.invalidations)
        // The handle is dragged onto the address: Chromium invalidates the mode it has.
        listing.onPrepare()
        assertEquals(3, listing.asks)
        bridge.answer("https://example.org/docs", addressItems)
        assertEquals(listOf(Item("glance", "Open in Glance"), Item("share", "Share")), listing.items)
        assertEquals(2, bridge.invalidations)
        listing.onPrepare()
        bridge.answer("https://example.org/docs", addressItems)
        assertEquals(2, bridge.invalidations)
        // And back onto the text.
        listing.onPrepare()
        bridge.answer("quantum", textItems)
        assertEquals(ours, listing.items)
        assertEquals(3, bridge.invalidations)
        listing.onPrepare()
        bridge.answer("quantum", textItems)
        assertEquals(3, bridge.invalidations)
        assertEquals(6, listing.asks)
    }

    @Test
    fun onePrepareDuringAnAskWaitsForItAndAsksAgainAfterAnUnchangedAnswer() {
        val bridge = Bridge()
        val listing = bridge.listing
        listing.onPrepare()
        bridge.answer("quantum", textItems)
        listing.onPrepare()
        // Two more prepares while that ask is in flight: no second ask, one more after it.
        listing.onPrepare()
        listing.onPrepare()
        assertEquals(2, listing.asks)
        assertEquals(1, bridge.reads.size)
        bridge.answer("quantum", textItems)
        assertEquals(1, bridge.invalidations)
        assertEquals(3, listing.asks)
        assertEquals(1, bridge.reads.size)
        // The late prepare was for a selection that changed under the ask: the follow-up sees it.
        bridge.answer("example.org", addressItems)
        assertEquals(2, bridge.invalidations)
        assertEquals(listOf(Item("glance", "Open in Glance"), Item("share", "Share")), listing.items)
    }

    @Test
    fun aChangedAnswerDuringAWaitingPrepareInvalidatesInsteadOfAskingTwice() {
        val bridge = Bridge()
        val listing = bridge.listing
        listing.onPrepare()
        listing.onPrepare()
        bridge.answer("quantum", textItems)
        // The invalidate's prepare is the follow-up; nothing asks on its own.
        assertEquals(1, bridge.invalidations)
        assertEquals(1, listing.asks)
        listing.onPrepare()
        assertEquals(2, listing.asks)
    }

    @Test
    fun aBlankSelectionListsNothingAndClearsWhatShowed() {
        val bridge = Bridge()
        val listing = bridge.listing
        listing.onPrepare()
        bridge.answer("quantum", textItems)
        listing.onPrepare()
        bridge.answer("", null)
        assertEquals(emptyList<Item>(), listing.items)
        assertEquals(2, bridge.invalidations)
        assertEquals(0, bridge.lists.size)
        // Blank from the start: nothing to apply, nothing to invalidate.
        val fresh = Bridge()
        fresh.listing.onPrepare()
        fresh.answer("   ", null)
        assertEquals(0, fresh.invalidations)
        assertEquals("   ", fresh.listing.text)
    }

    @Test
    fun answersAfterTheModeIsGoneAreDroppedAndNothingAsksAgain() {
        val bridge = Bridge()
        val listing = bridge.listing
        listing.onPrepare()
        listing.finish()
        bridge.answer("quantum", textItems)
        assertEquals(emptyList<Item>(), listing.items)
        assertEquals(0, bridge.invalidations)
        listing.onPrepare()
        assertEquals(1, listing.asks)
        // Gone between the page's answer and the core's.
        val late = Bridge()
        late.listing.onPrepare()
        late.reads.removeAt(0)("quantum")
        late.listing.finish()
        late.lists.removeAt(0).second(textItems)
        assertEquals(emptyList<Item>(), late.listing.items)
        assertEquals(0, late.invalidations)
    }

    @Test
    fun aMalformedAnswerListsNothing() {
        val bridge = Bridge()
        bridge.listing.onPrepare()
        bridge.answer("quantum", "{not json")
        assertEquals(emptyList<Item>(), bridge.listing.items)
        assertEquals(0, bridge.invalidations)
    }

    // --- the touch -----------------------------------------------------------------------------------

    @Test
    fun menuItemIdsNameTheItemsInOrder() {
        assertEquals(Item("search", "Search DuckDuckGo"), SelectionToolbar.itemAt(ours, SelectionToolbar.FIRST_ITEM_ID))
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
