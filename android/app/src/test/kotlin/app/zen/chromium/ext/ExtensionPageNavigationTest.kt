package app.zen.chromium.ext

import app.zen.chromium.ext.ExtensionPageNavigation.Decision
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * A navigation asked from inside an extension's own WebView: Chrome's spelling of an extension
 * page never leaves for the OS (Read&Write's offscreen document builds its feature frame with a
 * literal `chrome-extension://<id>/...`; the phone handed it to a VIEW intent nothing resolved).
 */
class ExtensionPageNavigationTest {
    private val id = "inoeonmfapjbbkmdafoankkfajkcphgd"
    private val other = "ecnphlgnajanjnkcmbpancdjoidceilk"
    private val origin = "https://$id.ext.zenium.invalid"

    @Test
    fun theServedOriginProceedsAsAsked() {
        assertEquals(Decision.Proceed, ExtensionPageNavigation.decide(origin, "$origin/popup.html?x#y", mainFrame = true))
        assertEquals(Decision.Proceed, ExtensionPageNavigation.decide(origin, "$origin/frames/feature.html", mainFrame = false))
    }

    @Test
    fun chromeSpellingOfTheExtensionsOwnPageLoadsInTheViewOrIsLeftToTheFramesServedSrc() {
        assertEquals(
            Decision.Load("$origin/options.html?tab=2"),
            ExtensionPageNavigation.decide(origin, "chrome-extension://$id/options.html?tab=2", mainFrame = true)
        )
        assertEquals(Decision.Load("$origin/"), ExtensionPageNavigation.decide(origin, "chrome-extension://$id", mainFrame = true))
        // The sub-frame case: the page script rewrote the element's src; this navigation is dropped, never an intent.
        assertEquals(Decision.Drop, ExtensionPageNavigation.decide(origin, "chrome-extension://$id/frames/toolbar.html", mainFrame = false))
        assertEquals(Decision.Drop, ExtensionPageNavigation.decide(origin, "chrome-extension://$other/embed.html", mainFrame = false))
    }

    @Test
    fun anotherExtensionsPageAndTheWebOpenAsTabs() {
        assertEquals(
            Decision.OpenTab("https://$other.ext.zenium.invalid/viewer.html"),
            ExtensionPageNavigation.decide(origin, "chrome-extension://$other/viewer.html", mainFrame = true)
        )
        assertEquals(
            Decision.OpenTab("https://$other.ext.zenium.invalid/viewer.html"),
            ExtensionPageNavigation.decide(origin, "https://$other.ext.zenium.invalid/viewer.html", mainFrame = true)
        )
        assertEquals(Decision.OpenTab("https://texthelp.com/signin"), ExtensionPageNavigation.decide(origin, "https://texthelp.com/signin", mainFrame = true))
        assertEquals(Decision.OpenTab("http://page.example/"), ExtensionPageNavigation.decide(origin, "http://page.example/", mainFrame = true))
    }

    @Test
    fun otherSchemesStayTheSystems() {
        assertEquals(Decision.External("mailto:help@texthelp.com"), ExtensionPageNavigation.decide(origin, "mailto:help@texthelp.com", mainFrame = true))
        assertEquals(Decision.External("intent://x#Intent;scheme=zxing;end"), ExtensionPageNavigation.decide(origin, "intent://x#Intent;scheme=zxing;end", mainFrame = true))
        // Not an extension id: not the runtime's URL, so not mapped.
        assertEquals(Decision.External("chrome-extension://not-an-id/x"), ExtensionPageNavigation.decide(origin, "chrome-extension://not-an-id/x", mainFrame = true))
    }
}
