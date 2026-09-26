package app.zen.chromium

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The order `shouldOverrideUrlLoading` decides an http(s) navigation in (`TabWebView.webNavigationTaken`,
 * the pure half of its http/https branch): the engine, then the App Link probe, then the hold for
 * the core's content-settings answer, then the desktop-site switch. Pinned because the hold drops
 * the navigation and re-issues it as a load of the view's own, which never re-enters the hook: a
 * probe behind the hold would never see a tap into an unanswered site.
 */
class TabWebViewNavigationOrderTest {
    private val page = "https://news.example.com/story"
    private val steps = mutableListOf<String>()

    private fun step(name: String, answer: Boolean): () -> Boolean = {
        steps.add(name)
        answer
    }

    private fun decide(engine: Boolean, appLink: Boolean, hold: Boolean, desktopSwitch: Boolean): Boolean =
        TabWebView.webNavigationTaken(
            engine = step("engine", engine),
            appLink = step("appLink", appLink),
            hold = step("hold", hold),
            desktopSwitch = step("desktopSwitch", desktopSwitch)
        )

    @Test
    fun aCrossSiteTapIntoAnUnansweredSiteIsProbedBeforeItIsHeld() {
        // The very navigation the hold takes first: a main-frame, gestured, cross-site tap – the
        // one `AppLinks.shouldProbe` fires for. With no app claiming the address the probe
        // declines and the hold follows; the navigation is taken (held), not let go.
        assertTrue(AppLinks.shouldProbe(page, "https://youtube.com/watch?v=1", mainFrame = true, redirect = false, gesture = true))
        assertTrue(decide(engine = false, appLink = false, hold = true, desktopSwitch = false))
        assertEquals(listOf("engine", "appLink", "hold"), steps)
    }

    @Test
    fun aVerifiedAppLinkOpensItsAppAndNothingIsHeld() {
        // The app opened: the tab loads nothing, so the core is asked nothing for the address
        // and the view's settings stay the page's.
        assertTrue(decide(engine = false, appLink = true, hold = true, desktopSwitch = true))
        assertEquals(listOf("engine", "appLink"), steps)
    }

    @Test
    fun theEngineSpeaksFirstAndABlockedAddressOpensNoApp() {
        assertTrue(decide(engine = true, appLink = true, hold = true, desktopSwitch = true))
        assertEquals(listOf("engine"), steps)
    }

    @Test
    fun anAnsweredSiteGoesOnToTheDesktopSiteSwitchAndThenLoads() {
        // Nothing held (the site answered, its settings applied by the hold step): the switch has
        // its say, and with no switch the navigation is the WebView's to run.
        assertFalse(decide(engine = false, appLink = false, hold = false, desktopSwitch = false))
        assertEquals(listOf("engine", "appLink", "hold", "desktopSwitch"), steps)
        steps.clear()
        assertTrue(decide(engine = false, appLink = false, hold = false, desktopSwitch = true))
        assertEquals(listOf("engine", "appLink", "hold", "desktopSwitch"), steps)
    }

    @Test
    fun aHeldNavigationNeverReachesTheDesktopSiteSwitch() {
        // Its re-issued load switches for itself (`loadRequested`); a switch here would issue the
        // link a second time.
        assertTrue(decide(engine = false, appLink = false, hold = true, desktopSwitch = true))
        assertEquals(listOf("engine", "appLink", "hold"), steps)
    }
}
