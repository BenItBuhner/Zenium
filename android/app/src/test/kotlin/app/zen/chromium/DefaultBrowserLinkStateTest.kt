package app.zen.chromium

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * The "Open by default" state (DEF-06) as the chrome's `AppLinkState` reads it: from Android 12
 * the screen's switch as `DomainVerificationManager` read it, before that – and on a 12+ device
 * with no manager to ask – the package a plain web link resolves to. The device's reads are
 * `appLinkState`'s; the decision, `appLinkStateOf`, runs here.
 */
class DefaultBrowserLinkStateTest {
    private val self = "io.github.benitbuhner.zenium"

    /** A pre-12 probe that records being asked, so a branch that must not ask can be pinned. */
    private class Probe(private val handler: String?) : () -> String? {
        var asked = 0
        override fun invoke(): String? {
            asked += 1
            return handler
        }
    }

    @Test
    fun fromAndroid12TheSwitchDecidesAndThePackageManagerIsNotAsked() {
        for (sdk in intArrayOf(31, 34)) {
            val probe = Probe(self)
            assertEquals(DefaultBrowser.ALLOWED, DefaultBrowser.appLinkStateOf(sdk, true, true, self, probe))
            assertEquals(DefaultBrowser.DISALLOWED, DefaultBrowser.appLinkStateOf(sdk, true, false, self, probe))
            assertEquals(0, probe.asked)
        }
    }

    @Test
    fun aPackageTheManagerKnowsNoStateForIsUnknown() {
        // The manager threw NameNotFound or answered no state: not a fall to the pre-12 reading,
        // which would have said allowed here.
        val probe = Probe(self)
        assertEquals(DefaultBrowser.UNKNOWN, DefaultBrowser.appLinkStateOf(31, true, null, self, probe))
        assertEquals(0, probe.asked)
    }

    @Test
    fun a12DeviceWithoutTheManagerFallsToThePre12Reading() {
        assertEquals(DefaultBrowser.ALLOWED, DefaultBrowser.appLinkStateOf(31, false, null, self, Probe(self)))
        assertEquals(DefaultBrowser.DISALLOWED, DefaultBrowser.appLinkStateOf(31, false, null, self, Probe("com.android.chrome")))
        assertEquals(DefaultBrowser.UNKNOWN, DefaultBrowser.appLinkStateOf(31, false, null, self, Probe(null)))
    }

    @Test
    fun before12ThePre12ReadingDecidesWhateverWasReadOfASwitch() {
        // The boundary is API 31: at 30 the package-manager probe is the reading, asked once.
        val probe = Probe(self)
        assertEquals(DefaultBrowser.ALLOWED, DefaultBrowser.appLinkStateOf(30, true, false, self, probe))
        assertEquals(1, probe.asked)
        assertEquals(DefaultBrowser.UNKNOWN, DefaultBrowser.appLinkStateOf(26, false, null, self, Probe(null)))
    }

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
