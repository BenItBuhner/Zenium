package app.zen.chromium

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * The pre-12 reading of the "Open by default" state (DEF-06): decided from the package a plain
 * web link resolves to, the words the chrome's `AppLinkState` reads.
 */
class DefaultBrowserLinkStateTest {
    private val self = "io.github.benitbuhner.zenium"

    @Test
    fun linksResolvingToThisAppAreAllowed() {
        assertEquals(DefaultBrowser.ALLOWED, DefaultBrowser.linkStateOf(self, self))
    }

    @Test
    fun linksResolvingToAnotherAppAreDisallowed() {
        assertEquals(DefaultBrowser.DISALLOWED, DefaultBrowser.linkStateOf("com.android.chrome", self))
    }

    @Test
    fun noDefaultHandlerIsUnknown() {
        assertEquals(DefaultBrowser.UNKNOWN, DefaultBrowser.linkStateOf(null, self))
    }

    @Test
    fun theWordsAreTheChromesAppLinkState() {
        assertEquals("allowed", DefaultBrowser.ALLOWED)
        assertEquals("disallowed", DefaultBrowser.DISALLOWED)
        assertEquals("unknown", DefaultBrowser.UNKNOWN)
    }
}
