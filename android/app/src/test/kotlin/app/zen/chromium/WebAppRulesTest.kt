package app.zen.chromium

import app.zen.chromium.WebAppRules.Display
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class WebAppRulesTest {
    @Test
    fun displayWordsParseAndAnythingElseIsBrowser() {
        assertEquals(Display.STANDALONE, Display.parse("standalone"))
        assertEquals(Display.MINIMAL_UI, Display.parse(" Minimal-UI "))
        assertEquals(Display.FULLSCREEN, Display.parse("fullscreen"))
        assertEquals(Display.BROWSER, Display.parse("browser"))
        assertEquals(Display.BROWSER, Display.parse("window-controls-overlay"))
        assertEquals(Display.BROWSER, Display.parse(null))
        assertEquals(Display.BROWSER, Display.parse(""))
    }

    @Test
    fun onlyBrowserStaysATab() {
        assertTrue(WebAppRules.ownWindow(Display.STANDALONE))
        assertTrue(WebAppRules.ownWindow(Display.MINIMAL_UI))
        assertTrue(WebAppRules.ownWindow(Display.FULLSCREEN))
        assertFalse(WebAppRules.ownWindow(Display.BROWSER))
    }

    @Test
    fun onlyFullscreenHidesTheBars() {
        assertTrue(WebAppRules.immersive(Display.FULLSCREEN))
        assertFalse(WebAppRules.immersive(Display.STANDALONE))
        assertFalse(WebAppRules.immersive(Display.MINIMAL_UI))
    }

    @Test
    fun scopeIsSameOriginAndAPathPrefix() {
        val scope = "https://app.example/app/"
        assertTrue(WebAppRules.inScope("https://app.example/app/", scope))
        assertTrue(WebAppRules.inScope("https://app.example/app/inbox?x=1#y", scope))
        assertTrue(WebAppRules.inScope("https://APP.example:443/app/settings", scope))
        assertFalse(WebAppRules.inScope("https://app.example/", scope))
        assertFalse(WebAppRules.inScope("https://app.example/other/", scope))
        // A sibling path that merely shares the scope's letters is outside it: the prefix is the
        // scope string's, slash included, so `/app/` does not cover `/app2/`.
        assertFalse(WebAppRules.inScope("https://app.example/app2/", scope))
        assertFalse(WebAppRules.inScope("https://app.example/app2/inbox", scope))
        // A scope without the trailing slash is the plain string prefix the spec and Chrome apply
        // (`IsInScope`: `StartsWith(url.spec(), scope.spec())`), so `/app` does cover `/app2`.
        assertTrue(WebAppRules.inScope("https://app.example/app2", "https://app.example/app"))
        assertFalse(WebAppRules.inScope("http://app.example/app/", scope))
        assertFalse(WebAppRules.inScope("https://evil.example/app/", scope))
        assertFalse(WebAppRules.inScope("https://app.example:8443/app/", scope))
        assertFalse(WebAppRules.inScope(null, scope))
        assertFalse(WebAppRules.inScope("not a url", scope))
        assertFalse(WebAppRules.inScope("https://app.example/app/", "nonsense"))
    }

    @Test
    fun aRootScopeCoversTheWholeOrigin() {
        assertTrue(WebAppRules.inScope("https://app.example", "https://app.example/"))
        assertTrue(WebAppRules.inScope("https://app.example/anything/at/all", "https://app.example/"))
        assertTrue(WebAppRules.inScope("http://10.0.2.2:8123/pwa/", "http://10.0.2.2:8123/"))
        assertFalse(WebAppRules.inScope("http://10.0.2.2:8124/pwa/", "http://10.0.2.2:8123/"))
    }

    @Test
    fun theReportedModeFollowsScopeBarsAndThePhone() {
        // Out of scope the browser's controls are up: `browser`, whatever the manifest said.
        for (display in Display.entries) assertEquals(Display.BROWSER, WebAppRules.reportedDisplay(display, inScope = false, barsHidden = false))
        assertEquals(Display.STANDALONE, WebAppRules.reportedDisplay(Display.STANDALONE, inScope = true, barsHidden = false))
        // minimal-ui on a phone renders no controls: Chrome reports standalone.
        assertEquals(Display.STANDALONE, WebAppRules.reportedDisplay(Display.MINIMAL_UI, inScope = true, barsHidden = false))
        assertEquals(Display.FULLSCREEN, WebAppRules.reportedDisplay(Display.FULLSCREEN, inScope = true, barsHidden = true))
        // A fullscreen app whose bars are up for the moment reads as fullscreen still.
        assertEquals(Display.FULLSCREEN, WebAppRules.reportedDisplay(Display.FULLSCREEN, inScope = true, barsHidden = false))
    }

    @Test
    fun taskUriNamesTheShortcut() {
        val id = Shortcuts.shortcutId("https://app.example/app/")
        assertEquals("zen-webapp://$id", WebAppRules.taskUri(id))
        assertTrue(id.startsWith("webapp-"))
        assertEquals(WebAppRules.taskUri(id), WebAppRules.taskUri(Shortcuts.shortcutId("https://app.example/app/")))
    }

    @Test
    fun theDisplayModeScriptCarriesTheModeAndItsUpdateHook() {
        val script = WebAppRules.displayModeScript(Display.STANDALONE)
        assertTrue(script.contains("window.__zenDisplayMode = 'standalone'"))
        assertTrue(script.contains("window.__zenSetDisplayMode = function"))
        assertTrue(script.contains("display-mode"))
        assertEquals("window.__zenSetDisplayMode && window.__zenSetDisplayMode('fullscreen');", WebAppRules.displayModeUpdate(Display.FULLSCREEN))
    }
}
