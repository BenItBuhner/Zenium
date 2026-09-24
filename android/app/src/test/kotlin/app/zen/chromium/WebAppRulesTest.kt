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
    fun theUrlsTheWebViewCommitsAreReadAsWritten() {
        // The WHATWG serialisation leaves `|` in a query and `[`, `]`, `^` in a path as they are
        // (only `{` and `}` are percent-encoded there) and takes `_` in a host. `java.net.URI`
        // (RFC 2396) refused each – `Illegal character in query`, `in path`, a null host – and
        // every such page read as outside every scope, the X toolbar up on an in-scope page. The
        // rule reads with `java.net.URL` now; these rows kill a parser that goes back.
        val scope = "https://app.example/app/"
        assertTrue(WebAppRules.inScope("https://app.example/app/?filter=a|b", scope))
        assertTrue(WebAppRules.inScope("https://app.example/app/[x]", scope))
        assertTrue(WebAppRules.inScope("https://app.example/app/a^b", scope))
        assertTrue(WebAppRules.inScope("https://app.example/app/%7Bx%7D?q=[1]|{2}^3#h", scope))
        assertTrue(WebAppRules.inScope("https://my_app.example/app/", "https://my_app.example/app/"))
        assertFalse(WebAppRules.inScope("https://my_app.example/app/", scope))
        // Credentials in the authority, and a query carrying `://` and `@` of its own.
        assertTrue(WebAppRules.inScope("https://user:pw@app.example/app/inbox", scope))
        assertTrue(WebAppRules.inScope("https://app.example/app/?next=https://other.example/@me", scope))
        assertFalse(WebAppRules.inScope("https://app.example/other/?next=https://app.example/app/", scope))
        // An IPv6 literal keeps its brackets; its port is read past them.
        assertTrue(WebAppRules.inScope("http://[::1]:8123/pwa/", "http://[::1]:8123/"))
        assertFalse(WebAppRules.inScope("http://[::1]:8124/pwa/", "http://[::1]:8123/"))
        // What is no URL at all.
        assertFalse(WebAppRules.inScope("https://app.example:port/app/", scope))
        assertFalse(WebAppRules.inScope("https:///app/", scope))
        assertFalse(WebAppRules.inScope("app.example/app/", scope))
        assertFalse(WebAppRules.inScope("about:blank", scope))
        // The parts themselves: the scheme and host folded, the port and the path as written.
        val parts = WebAppRules.parse("HTTPS://User@APP.Example:8443/App/[x]?y=1#z")!!
        assertEquals("https", parts.scheme)
        assertEquals("app.example", parts.host)
        assertEquals(8443, parts.port)
        assertEquals("/App/[x]", parts.path)
        assertEquals(-1, WebAppRules.parse("https://app.example")!!.port)
        assertEquals("", WebAppRules.parse("https://app.example?x=1")!!.path)
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
    fun aPageElementsFullscreenIsReportedWhileItLastsAndTheStandingModeAfter() {
        // The media feature's rule (Chrome's `isFullscreen()` first): `fullscreen` while an element
        // of the page is fullscreen through the Fullscreen API, whatever the manifest said and
        // wherever the page stands – in scope with the bars up, or out of scope under the toolbar.
        for (display in Display.entries) {
            assertEquals(Display.FULLSCREEN, WebAppRules.reportedDisplay(display, inScope = true, barsHidden = false, elementFullscreen = true))
            assertEquals(Display.FULLSCREEN, WebAppRules.reportedDisplay(display, inScope = false, barsHidden = false, elementFullscreen = true))
        }
        // The element's exit: the mode as it stands, the window's own pose having never moved.
        assertEquals(Display.STANDALONE, WebAppRules.reportedDisplay(Display.STANDALONE, inScope = true, barsHidden = false, elementFullscreen = false))
        assertEquals(Display.STANDALONE, WebAppRules.reportedDisplay(Display.MINIMAL_UI, inScope = true, barsHidden = false, elementFullscreen = false))
        assertEquals(Display.FULLSCREEN, WebAppRules.reportedDisplay(Display.FULLSCREEN, inScope = true, barsHidden = true, elementFullscreen = false))
        assertEquals(Display.BROWSER, WebAppRules.reportedDisplay(Display.STANDALONE, inScope = false, barsHidden = false, elementFullscreen = false))
        // The three-argument form is the window's own answer, with no element's fullscreen counted:
        // what the bars follow and what the next document's script starts with.
        assertEquals(Display.STANDALONE, WebAppRules.reportedDisplay(Display.STANDALONE, inScope = true, barsHidden = false))
        assertEquals(Display.BROWSER, WebAppRules.reportedDisplay(Display.FULLSCREEN, inScope = false, barsHidden = false))
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
