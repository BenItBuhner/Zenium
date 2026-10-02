package app.zen.chromium

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The unload probe's rules (`UnloadProbeRules`, seed A7 "Cancel on 'Leave site?' keeps the
 * page"): which documents a load the core asked for is asked about first, and which addresses
 * are the probe's own.
 */
class UnloadProbeRulesTest {
    @Test
    fun aWebDocumentIsAskedFirst() {
        assertTrue(UnloadProbeRules.needsProbe("https://example.com/form", failed = false, interstitial = false, viewer = false, checkInFlight = false))
        assertTrue(UnloadProbeRules.needsProbe("http://127.0.0.1:38427/second.html", failed = false, interstitial = false, viewer = false, checkInFlight = false))
    }

    @Test
    fun nothingWithoutHandlersToRunIsAsked() {
        // A view with no document yet, the blank document, an internal page under its own name.
        assertFalse(UnloadProbeRules.needsProbe(null, failed = false, interstitial = false, viewer = false, checkInFlight = false))
        assertFalse(UnloadProbeRules.needsProbe("about:blank", failed = false, interstitial = false, viewer = false, checkInFlight = false))
        assertFalse(UnloadProbeRules.needsProbe("zen://newtab", failed = false, interstitial = false, viewer = false, checkInFlight = false))
        assertFalse(UnloadProbeRules.needsProbe("zen://error?code=-106", failed = false, interstitial = false, viewer = false, checkInFlight = false))
        assertFalse(UnloadProbeRules.needsProbe("chrome-extension://abcdefghijklmnopabcdefghijklmnop/popup.html", failed = false, interstitial = false, viewer = false, checkInFlight = false))
    }

    @Test
    fun aFailedLoadAnInterstitialTheViewerAndACheckInFlightAreNotAsked() {
        val page = "https://example.com/"
        assertFalse(UnloadProbeRules.needsProbe(page, failed = true, interstitial = false, viewer = false, checkInFlight = false))
        assertFalse(UnloadProbeRules.needsProbe(page, failed = false, interstitial = true, viewer = false, checkInFlight = false))
        assertFalse(UnloadProbeRules.needsProbe(page, failed = false, interstitial = false, viewer = true, checkInFlight = false))
        // The page is on its way out under the close path's check already.
        assertFalse(UnloadProbeRules.needsProbe(page, failed = false, interstitial = false, viewer = false, checkInFlight = true))
    }

    @Test
    fun theProbesAddressesAreItsOwnAndEachProbeHasOne() {
        assertEquals("http://unload-probe.zen.invalid/1", UnloadProbeRules.probeUrl(1))
        assertTrue(UnloadProbeRules.probeUrl(1) != UnloadProbeRules.probeUrl(2))
        assertTrue(UnloadProbeRules.isProbeUrl(UnloadProbeRules.probeUrl(7)))
        assertTrue(UnloadProbeRules.isProbeUrl("http://unload-probe.zen.invalid/"))
        assertTrue(UnloadProbeRules.isProbeUrl("http://unload-probe.zen.invalid"))
        // A reserved host (RFC 2606 `.invalid`): no page's address is ever the probe's, and
        // nothing resolves it – answered on the device or not at all; plain http, so no
        // handshake would even be attempted for it.
        assertTrue(UnloadProbeRules.ORIGIN.endsWith(".invalid"))
        assertTrue(UnloadProbeRules.ORIGIN.startsWith("http://"))
        assertFalse(UnloadProbeRules.isProbeUrl("https://unload-probe.zen.invalid/1"))
        assertFalse(UnloadProbeRules.isProbeUrl("http://unload-probe.zen.invalid.example.com/1"))
        assertFalse(UnloadProbeRules.isProbeUrl("http://example.com/unload-probe.zen.invalid/1"))
        assertFalse(UnloadProbeRules.isProbeUrl("about:blank"))
        assertFalse(UnloadProbeRules.isProbeUrl(""))
    }
}
