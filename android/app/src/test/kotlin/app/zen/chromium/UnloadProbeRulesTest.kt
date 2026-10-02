package app.zen.chromium

import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The unload probe's rules (`UnloadProbeRules`, seed A7 "Cancel on 'Leave site?' keeps the
 * page"): which documents a load the core asked for is asked about first, and which addresses
 * are the probe's own; and the measurement's hold (seed A10 step 1), which a debuggable build
 * alone can set.
 */
class UnloadProbeRulesTest {
    @After
    fun letTheProbeBack() {
        UnloadProbeRules.debugHoldProbe(false, debuggable = true)
    }

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
    fun theProbeIsOnByDefaultAndTheHoldTakesItOffForADebuggableBuild() {
        val page = "https://example.com/form"
        // Nothing held: the probe, as the ruling has it.
        assertFalse(UnloadProbeRules.heldForMeasurement(debuggable = true))
        assertTrue(UnloadProbeRules.needsProbe(page, failed = false, interstitial = false, viewer = false, checkInFlight = false, debuggable = true))
        // The harness's baseline arm: held, and no load is asked by a probe.
        assertTrue(UnloadProbeRules.debugHoldProbe(true, debuggable = true))
        assertTrue(UnloadProbeRules.heldForMeasurement(debuggable = true))
        assertFalse(UnloadProbeRules.needsProbe(page, failed = false, interstitial = false, viewer = false, checkInFlight = false, debuggable = true))
        // Let back: the probe again.
        assertFalse(UnloadProbeRules.debugHoldProbe(false, debuggable = true))
        assertTrue(UnloadProbeRules.needsProbe(page, failed = false, interstitial = false, viewer = false, checkInFlight = false, debuggable = true))
    }

    @Test
    fun theHoldCannotBeSetOutsideADebuggableBuild() {
        val page = "https://example.com/form"
        // A release build's call writes nothing and answers false.
        assertFalse(UnloadProbeRules.debugHoldProbe(true, debuggable = false))
        assertFalse(UnloadProbeRules.heldForMeasurement(debuggable = false))
        assertFalse(UnloadProbeRules.heldForMeasurement(debuggable = true))
        assertTrue(UnloadProbeRules.needsProbe(page, failed = false, interstitial = false, viewer = false, checkInFlight = false, debuggable = false))
        // Even a hold a debuggable caller set is nothing to a release build's reading.
        assertTrue(UnloadProbeRules.debugHoldProbe(true, debuggable = true))
        assertFalse(UnloadProbeRules.heldForMeasurement(debuggable = false))
        assertTrue(UnloadProbeRules.needsProbe(page, failed = false, interstitial = false, viewer = false, checkInFlight = false, debuggable = false))
    }

    @Test
    fun theDefaultFlagIsTheBuildsOwn() {
        // The unit tests run against the debug variant: the one call site's default reads it.
        assertTrue(BuildConfig.DEBUG)
        assertTrue(UnloadProbeRules.debugHoldProbe(true))
        assertFalse(UnloadProbeRules.needsProbe("https://example.com/", failed = false, interstitial = false, viewer = false, checkInFlight = false))
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
