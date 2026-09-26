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
 * probe behind the hold would never see a tap into an unanswered site. Ahead of all of it, the
 * hook's front (`TabWebView.prerenderPassOrNavigation`): a speculation-rules prerender's pass is
 * the veto's alone, so no step of a navigation's – the hold and its spending of the page's word on
 * the next navigation's referrer policy among them – happens for it.
 */
class TabWebViewNavigationOrderTest {
    private val page = "https://news.example.com/story"
    private val steps = mutableListOf<String>()

    private fun step(name: String, answer: Boolean): () -> Boolean = {
        steps.add(name)
        answer
    }

    /** `WebResourceRequest.hasGesture()` as the hook reads it, spelled out. */
    private fun hasGesture(gesture: Boolean): Boolean = gesture

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

    @Test
    fun aPrerendersPassThroughTheHookIsTheVetosAloneAndSpendsNoStep() {
        // A speculation-rules prerender the page declared: `Sec-Purpose: prefetch;prerender`, the
        // outermost main frame, no gesture (`TabWebView.prerenderPassOrNavigation`'s condition as
        // the hook spells it). The veto answers; the primary load's steps – the engine, the App
        // Link probe, the hold, the switch – run for none of it.
        val mainFrame = true
        val prerender = PageRules.isPrerender(mapOf("Sec-Purpose" to "prefetch;prerender")) && mainFrame && !hasGesture(false)
        assertTrue(prerender)
        assertTrue(TabWebView.prerenderPassOrNavigation(prerender, veto = step("veto", true), navigation = step("navigation", true)))
        assertEquals(listOf("veto"), steps)
        steps.clear()
        // Allowed to go on prerendering: still no step of a navigation's.
        assertFalse(TabWebView.prerenderPassOrNavigation(prerender, veto = step("veto", false), navigation = step("navigation", true)))
        assertEquals(listOf("veto"), steps)
        steps.clear()
        // The real tap (a gesture, no `Sec-Purpose`) is the navigation's alone.
        val tap = PageRules.isPrerender(emptyMap()) && mainFrame && !hasGesture(true)
        assertFalse(tap)
        assertTrue(TabWebView.prerenderPassOrNavigation(tap, veto = step("veto", true), navigation = step("navigation", true)))
        assertEquals(listOf("navigation"), steps)
    }

    @Test
    fun aPrerendersPassNeitherSpendsNorExpiresThePagesReferrerWord() {
        // The one spender of the page's word on the next navigation's referrer policy is the hold
        // (`holdOrApplyContentRules` → `ReferrerPolicyWord.forNavigation`), a step of the
        // navigation's; the one expiry short of the window is the document starting
        // (`onPageStarted` → `documentStarted`), which a prerendering page – not the primary main
        // frame – never fires. So a prerender the page's pointerdown eagerness kicked off between
        // the tap's word and the tap's own navigation leaves the word for that navigation.
        val word = ReferrerPolicyWord()
        val site = "https://news.example.com"
        word.nextNavigation("no-referrer", now = 10_000L)
        val prerender = PageRules.isPrerender(mapOf("sec-purpose" to "prefetch;prerender"))
        val spent = mutableListOf<String>()
        assertTrue(
            TabWebView.prerenderPassOrNavigation(
                prerender,
                veto = { true },
                navigation = { spent.add(word.forNavigation(site, now = 10_100L)); true }
            )
        )
        assertEquals(emptyList<String>(), spent)
        // The tap's navigation, within the window: the word is there for its hold.
        assertEquals("no-referrer", word.forNavigation(site, now = 10_800L))
        // And spent by it: a navigation after it is not the tap's.
        assertEquals("", word.forNavigation(site, now = 10_900L))
    }
}
