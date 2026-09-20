package app.zen.chromium

import app.zen.chromium.UrlFieldClose.Field
import app.zen.chromium.UrlFieldClose.Move
import app.zen.chromium.UrlFieldClose.Page
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The demo harness's URL-field close (`DemoHarness.closeUrlField`), decided in [UrlFieldClose]. */
class UrlFieldCloseTest {
    private val closed = Field(open = false, chromeHandlesBack = false, imeUp = false)
    private val openWithKeyboard = Field(open = true, chromeHandlesBack = true, imeUp = true)
    private val openNoKeyboard = Field(open = true, chromeHandlesBack = true, imeUp = false)
    /** The store says open, the host has not heard yet (`back.update` in flight). */
    private val openHostBehind = Field(open = true, chromeHandlesBack = false, imeUp = false)

    private val demoPage = Page("tab_long", "http://127.0.0.1:18142/long", viewUp = true, historyIndex = 0)

    // --- what to do next -------------------------------------------------------------------------

    @Test
    fun `a closed field is done, whatever the host or the keyboard say and however many backs went in`() {
        assertEquals(Move.Done, UrlFieldClose.nextMove(closed, backs = 0, hostWaitedMs = 0))
        assertEquals(Move.Done, UrlFieldClose.nextMove(closed.copy(chromeHandlesBack = true, imeUp = true), backs = 2, hostWaitedMs = 0))
        assertEquals(Move.Done, UrlFieldClose.nextMove(closed, backs = UrlFieldClose.MAX_BACKS, hostWaitedMs = 0))
    }

    @Test
    fun `an open field the host would hand to the chrome takes one back, named for what it takes down`() {
        assertEquals(Move.PressBack(keyboard = true), UrlFieldClose.nextMove(openWithKeyboard, backs = 0, hostWaitedMs = 0))
        assertEquals(Move.PressBack(keyboard = false), UrlFieldClose.nextMove(openNoKeyboard, backs = 0, hostWaitedMs = 0))
        assertEquals(Move.PressBack(keyboard = false), UrlFieldClose.nextMove(openNoKeyboard, backs = 1, hostWaitedMs = 0))
    }

    @Test
    fun `no back goes to a field the host would not hand to the chrome - the host is waited for, then the close gives up`() {
        // The fifth run's retry: with the host's mirror not saying "chrome", a back reaches the page.
        assertEquals(Move.AwaitHost, UrlFieldClose.nextMove(openHostBehind, backs = 0, hostWaitedMs = 0))
        assertEquals(Move.AwaitHost, UrlFieldClose.nextMove(openHostBehind, backs = 0, hostWaitedMs = UrlFieldClose.HOST_WAIT_MS - 1))
        val move = UrlFieldClose.nextMove(openHostBehind, backs = 0, hostWaitedMs = UrlFieldClose.HOST_WAIT_MS)
        assertTrue("$move", move is Move.GiveUp)
        assertTrue((move as Move.GiveUp).reason.contains("send a back to the page"))
        // Even with the keyboard up: the route is the host's to confirm.
        assertEquals(Move.AwaitHost, UrlFieldClose.nextMove(openHostBehind.copy(imeUp = true), backs = 0, hostWaitedMs = 0))
    }

    @Test
    fun `the backs are bounded`() {
        val move = UrlFieldClose.nextMove(openNoKeyboard, backs = UrlFieldClose.MAX_BACKS, hostWaitedMs = 0)
        assertTrue("$move", move is Move.GiveUp)
        assertEquals("the field is still open after ${UrlFieldClose.MAX_BACKS} backs", (move as Move.GiveUp).reason)
        assertEquals(Move.PressBack(keyboard = false), UrlFieldClose.nextMove(openNoKeyboard, backs = UrlFieldClose.MAX_BACKS - 1, hostWaitedMs = 0))
    }

    // --- whether a back took ---------------------------------------------------------------------

    @Test
    fun `a back has taken once the field is closed, or once the keyboard it was for is down`() {
        assertTrue(UrlFieldClose.backTook(before = openNoKeyboard, now = closed))
        assertTrue(UrlFieldClose.backTook(before = openWithKeyboard, now = openNoKeyboard))
        assertTrue(UrlFieldClose.backTook(before = openWithKeyboard, now = closed))
        assertFalse(UrlFieldClose.backTook(before = openNoKeyboard, now = openNoKeyboard))
        assertFalse(UrlFieldClose.backTook(before = openWithKeyboard, now = openWithKeyboard))
        // The keyboard coming UP after a back for the field is not the back taking.
        assertFalse(UrlFieldClose.backTook(before = openNoKeyboard, now = openWithKeyboard))
    }

    // --- the page ----------------------------------------------------------------------------------

    @Test
    fun `the page is kept while the same tab holds the same view at the same place in its history`() {
        assertNull(UrlFieldClose.pageLost(demoPage, demoPage))
        // A page that navigated on its own meanwhile (a redirect, a load the driver started) is not lost.
        assertNull(UrlFieldClose.pageLost(demoPage, demoPage.copy(url = "http://127.0.0.1:18142/long#anchor", historyIndex = 1)))
    }

    @Test
    fun `a back that reached the tab's root shows as another tab, or the same tab with its view gone`() {
        val closedTab = UrlFieldClose.pageLost(demoPage, demoPage.copy(tabId = "tab_2", url = null, viewUp = false, historyIndex = -1))
        assertTrue("$closedTab", closedTab != null && closedTab.contains("active tab changed from tab_long to tab_2"))
        // #200's fifth run: the root rule put a new tab page in the demo tab's place; the core kept the id, the host lost the view.
        val newTabPage = UrlFieldClose.pageLost(demoPage, demoPage.copy(url = "zen://newtab", viewUp = false, historyIndex = -1))
        assertTrue("$newTabPage", newTabPage != null && newTabPage.contains("page view is gone") && newTabPage.contains("zen://newtab"))
    }

    @Test
    fun `a back that reached a page with history shows as a step back in it`() {
        val second = demoPage.copy(url = "http://127.0.0.1:18142/second", historyIndex = 1)
        val lost = UrlFieldClose.pageLost(second, demoPage)
        assertTrue("$lost", lost != null && lost.contains("stepped back in its history") && lost.contains("/second") && lost.contains("/long"))
    }

    @Test
    fun `a tab with no view to begin with (a new tab page) cannot lose one`() {
        val ntp = Page("tab_new", "zen://newtab", viewUp = false, historyIndex = -1)
        assertNull(UrlFieldClose.pageLost(ntp, ntp))
        assertNull(UrlFieldClose.pageLost(ntp, ntp.copy(url = "https://example.com/", viewUp = true, historyIndex = 0)))
    }

    // --- the outcome -----------------------------------------------------------------------------

    @Test
    fun `a field found shut is an outcome of its own - nothing pressed, the page kept`() {
        val outcome = UrlFieldClose.NOT_OPEN
        assertTrue(outcome.ok)
        assertEquals(0, outcome.backs)
        assertEquals("the URL field was not open, the page kept", outcome.describe())
    }

    @Test
    fun `a close that took its backs and kept the page is ok, and says how many`() {
        val one = UrlFieldClose.outcome(demoPage, demoPage, closed, backs = 1, gaveUp = null)
        assertTrue(one.ok)
        assertEquals("the URL field closed after 1 back, the page kept", one.describe())
        val two = UrlFieldClose.outcome(demoPage, demoPage, closed, backs = 2, gaveUp = null)
        assertTrue(two.ok)
        assertEquals("the URL field closed after 2 backs, the page kept", two.describe())
    }

    @Test
    fun `a lost page fails the outcome by name even though the field closed`() {
        val after = demoPage.copy(url = "zen://newtab", viewUp = false, historyIndex = -1)
        val outcome = UrlFieldClose.outcome(demoPage, after, closed, backs = 2, gaveUp = null)
        assertTrue(outcome.closed)
        assertFalse(outcome.pageKept)
        assertFalse(outcome.ok)
        assertTrue(outcome.describe(), outcome.describe().startsWith("the URL field closed after 2 backs, the page LOST: the active tab's page view is gone"))
    }

    @Test
    fun `a field left open fails the outcome with the reason the close gave up for`() {
        val outcome = UrlFieldClose.outcome(demoPage, demoPage, openHostBehind, backs = 0, gaveUp = "the field is open but the host would send a back to the page")
        assertFalse(outcome.closed)
        assertTrue(outcome.pageKept)
        assertFalse(outcome.ok)
        assertEquals("the URL field stayed open after 0 backs, the page kept: the field is open but the host would send a back to the page", outcome.describe())
        // Out of backs, the field still open: the loop's own reason.
        val spent = UrlFieldClose.outcome(demoPage, demoPage, openNoKeyboard, backs = 3, gaveUp = "the field is still open after 3 backs")
        assertEquals("the URL field stayed open after 3 backs, the page kept: the field is still open after 3 backs", spent.describe())
    }

    @Test
    fun `with no back pressed the page counts as kept whatever the readings say`() {
        val moved = demoPage.copy(tabId = "tab_other")
        val outcome = UrlFieldClose.outcome(demoPage, moved, openHostBehind, backs = 0, gaveUp = "waited out")
        assertTrue(outcome.pageKept)
        assertFalse(outcome.closed)
    }
}
