package app.zen.chromium

import app.zen.chromium.FieldToolbar.Field
import app.zen.chromium.FieldToolbar.Item
import app.zen.chromium.FieldToolbar.SystemItem
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The omnibox field's Paste and go (OMN-23), the view-free half: the chrome's answer about the
 * field in focus, the plan for the system's menu (after Paste, one item, go or search as the
 * clipboard's description says, only over the omnibox's field), the listing kept current across
 * one mode's prepares, and the touch's host event. The menu work itself runs on the emulator
 * (`OmniboxDemo`).
 */
class FieldToolbarTest {
    private val strings = FieldToolbar.Strings(paste = "Paste", pasteAndGo = "Paste and go", pasteAndSearch = "Paste and search")
    private val omnibox = Field("tab_1")

    /** Chromium's default group, whatever resource id the WebView build gave it. */
    private val defaults = 0x7f0a0042

    /** The insertion handle's toolbar over a field: Paste, Select all. */
    private val handleMenu = listOf(SystemItem(defaults, 13, "Paste"), SystemItem(defaults, 15, "Select all"))

    /** A selection in a field: Cut, Copy, Paste, Share, Select all. */
    private val selectionMenu = listOf(
        SystemItem(defaults, 11, "Cut"),
        SystemItem(defaults, 12, "Copy"),
        SystemItem(defaults, 13, "Paste"),
        SystemItem(defaults, 14, "Share"),
        SystemItem(defaults, 15, "Select all")
    )

    // --- the chrome's answer -----------------------------------------------------------------------

    @Test
    fun readsTheOmniboxFieldAndItsTabOutOfTheScriptAnswer() {
        assertEquals(omnibox, FieldToolbar.parseField("""{"tabId":"tab_1"}"""))
        // The new-tab bar's field: a submit opens a new tab, and the attribute is not set.
        assertEquals(Field(null), FieldToolbar.parseField("""{"tabId":null}"""))
        assertEquals(Field(null), FieldToolbar.parseField("""{}"""))
        assertEquals(Field(null), FieldToolbar.parseField("""{"tabId":""}"""))
    }

    @Test
    fun anotherElementOrNoAnswerIsNoField() {
        assertNull(FieldToolbar.parseField("null"))
        assertNull(FieldToolbar.parseField(null))
        assertNull(FieldToolbar.parseField(""))
        assertNull(FieldToolbar.parseField("\"urlbar\""))
        assertNull(FieldToolbar.parseField("[1]"))
        assertNull(FieldToolbar.parseField("{\"tabId\":"))
    }

    @Test
    fun theScriptAsksAfterTheDesktopMenusMark() {
        assertTrue(FieldToolbar.FIELD_SCRIPT.contains("document.activeElement"))
        assertTrue(FieldToolbar.FIELD_SCRIPT.contains("'data-zen-menu')!=='urlbar'"))
        assertTrue(FieldToolbar.FIELD_SCRIPT.contains("getAttribute('data-zen-menu-tab')"))
    }

    // --- the plan ----------------------------------------------------------------------------------

    @Test
    fun pasteAndGoFollowsPasteOverTheOmniboxFieldForALink() {
        val plan = FieldToolbar.plan(handleMenu, omnibox, FieldToolbar.GO, strings)
        assertTrue(plan.anchored)
        assertEquals(13, plan.order)
        assertEquals(Item(FieldToolbar.GO, "Paste and go"), plan.item)
    }

    @Test
    fun pasteAndSearchForTextTheSystemReadAsNoLink() {
        val plan = FieldToolbar.plan(selectionMenu, omnibox, FieldToolbar.SEARCH, strings)
        assertTrue(plan.anchored)
        assertEquals(13, plan.order)
        assertEquals(Item(FieldToolbar.SEARCH, "Paste and search"), plan.item)
    }

    @Test
    fun theItemsTakeTheSystemsSentenceCase() {
        // Beside Android's own "Paste" / "Select all": no capital on go or search.
        assertEquals("Paste and go", FieldToolbar.plan(handleMenu, omnibox, FieldToolbar.GO, strings).item?.title)
        assertEquals("Paste and search", FieldToolbar.plan(handleMenu, omnibox, FieldToolbar.SEARCH, strings).item?.title)
    }

    @Test
    fun nothingOverAnotherFieldOfTheChrome() {
        // The find bar, a bookmark's name, a settings field: the system's Paste alone.
        val plan = FieldToolbar.plan(handleMenu, null, FieldToolbar.GO, strings)
        assertTrue(plan.anchored)
        assertNull(plan.item)
    }

    @Test
    fun nothingWhenTheClipboardHasNothingToPaste() {
        assertNull(FieldToolbar.plan(handleMenu, omnibox, null, strings).item)
        assertNull(FieldToolbar.plan(handleMenu, omnibox, "image", strings).item)
    }

    @Test
    fun noPasteNoPlan() {
        // A read-only selection in the chrome (a settings paragraph), or a password field's menu.
        val readOnly = listOf(SystemItem(defaults, 12, "Copy"), SystemItem(defaults, 14, "Share"), SystemItem(defaults, 15, "Select all"))
        val plan = FieldToolbar.plan(readOnly, omnibox, FieldToolbar.GO, strings)
        assertFalse(plan.anchored)
        assertNull(plan.item)
        assertFalse(FieldToolbar.plan(emptyList(), omnibox, FieldToolbar.GO, strings).anchored)
    }

    @Test
    fun pasteIsToldByTheFrameworksString() {
        // A WebView that titled its Paste otherwise (another locale) is matched by the string the
        // framework gave the app, not by "Paste".
        val german = FieldToolbar.Strings(paste = "Einfügen", pasteAndGo = "Paste and go", pasteAndSearch = "Paste and search")
        val menu = listOf(SystemItem(defaults, 13, "Einfügen"), SystemItem(defaults, 15, "Alles auswählen"))
        assertEquals(Item(FieldToolbar.GO, "Paste and go"), FieldToolbar.plan(menu, omnibox, FieldToolbar.GO, german).item)
        assertFalse(FieldToolbar.plan(menu, omnibox, FieldToolbar.GO, strings).anchored)
    }

    // --- the touch ---------------------------------------------------------------------------------

    @Test
    fun theTouchNamesTheActionAndTheFieldsTab() {
        val go = FieldToolbar.action(FieldToolbar.GO, "tab_1")
        assertEquals("go", go.getString("action"))
        assertEquals("tab_1", go.getString("tabId"))
        // The new-tab bar's field: the core opens a new tab for a null tab.
        val search = FieldToolbar.action(FieldToolbar.SEARCH, null)
        assertEquals("search", search.getString("action"))
        assertTrue(search.isNull("tabId"))
    }

    // --- the listing -------------------------------------------------------------------------------

    /** A chrome that answers when told to, so the round trips can be counted. */
    private class Chrome {
        val pending = ArrayList<(Field?) -> Unit>()
        var invalidations = 0
        val listing = FieldToolbar.Listing(readField = { pending += it }, invalidate = { invalidations++ })

        fun answer(field: Field?) {
            val reply = pending.removeAt(0)
            reply(field)
        }
    }

    @Test
    fun theFirstPrepareAsksAndTheOmniboxsAnswerInvalidatesOnce() {
        val chrome = Chrome()
        chrome.listing.onPrepare()
        assertEquals(1, chrome.listing.asks)
        assertNull(chrome.listing.field)
        chrome.answer(omnibox)
        assertEquals(omnibox, chrome.listing.field)
        assertEquals(1, chrome.invalidations)
        // The invalidation's prepare asks again and gets the same answer: no second invalidation.
        chrome.listing.onPrepare()
        assertEquals(2, chrome.listing.asks)
        chrome.answer(omnibox)
        assertEquals(1, chrome.invalidations)
    }

    @Test
    fun anotherFieldsAnswerChangesNothing() {
        val chrome = Chrome()
        chrome.listing.onPrepare()
        chrome.answer(null)
        assertNull(chrome.listing.field)
        assertEquals(0, chrome.invalidations)
    }

    @Test
    fun aPrepareDuringAnAskIsAskedAfterIt() {
        val chrome = Chrome()
        chrome.listing.onPrepare()
        chrome.listing.onPrepare()
        chrome.listing.onPrepare()
        assertEquals(1, chrome.pending.size)
        // The same answer: the remembered prepare asks once more, once.
        chrome.answer(null)
        assertEquals(2, chrome.listing.asks)
        assertEquals(1, chrome.pending.size)
        chrome.answer(null)
        assertEquals(2, chrome.listing.asks)
        assertEquals(0, chrome.pending.size)
    }

    @Test
    fun aChangedAnswerInvalidatesInsteadOfAskingAgain() {
        val chrome = Chrome()
        chrome.listing.onPrepare()
        chrome.listing.onPrepare()
        chrome.answer(omnibox)
        // The invalidation's own prepare will ask; the remembered one is not asked on top of it.
        assertEquals(1, chrome.invalidations)
        assertEquals(1, chrome.listing.asks)
    }

    @Test
    fun answersAfterTheModeIsGoneAreDropped() {
        val chrome = Chrome()
        chrome.listing.onPrepare()
        chrome.listing.finish()
        chrome.answer(omnibox)
        assertNull(chrome.listing.field)
        assertEquals(0, chrome.invalidations)
        chrome.listing.onPrepare()
        assertEquals(1, chrome.listing.asks)
    }
}
