package app.zen.chromium

/**
 * The unload probe's pure rules (`TabWebView.probeThenLoad`, seed A7 "Cancel on 'Leave site?'
 * keeps the page"): which documents are asked by a probe before a load the core asked for goes
 * out, and which addresses are the probe's own, so the WebView's words about them are dropped
 * and the request engine never sees them. Pinned on the JVM (`UnloadProbeRulesTest`). Also the
 * one switch that holds the probe off, for a debuggable build's measurement alone
 * ([debugHoldProbe]; seed A10 step 1).
 */
object UnloadProbeRules {
    /**
     * The probe's origin: a reserved host (RFC 2606 `.invalid`) – no site stands there, no
     * service worker can claim it, nothing resolves it – answered on the device alone.
     */
    const val ORIGIN = "http://unload-probe.zen.invalid"

    /** The `n`th probe's address: its own, so a late word about an earlier probe is told from the one up. */
    fun probeUrl(n: Int): String = "$ORIGIN/$n"

    /** Whether `url` is a probe's (any request to the probe origin: a probe never has subresources). */
    fun isProbeUrl(url: String): Boolean = url.startsWith("$ORIGIN/") || url == ORIGIN

    /**
     * Whether a load over `document` is asked by a probe first: only a web document can have
     * `beforeunload` handlers to run – not a view with no document, the blank document, an
     * internal page (`zen://`, the served new tab page under its `zen://` name), an error page
     * or interstitial standing in for a failed load, or the viewer page – and never under an
     * unload check (`TabWebView.confirmUnload`: the page is on its way out already). The same
     * list as the check's. Nor while the measurement's hold stands ([debugHoldProbe]), which a
     * debuggable build alone can set: `debuggable` is the build's flag, `BuildConfig.DEBUG` at
     * the one call site.
     */
    fun needsProbe(document: String?, failed: Boolean, interstitial: Boolean, viewer: Boolean, checkInFlight: Boolean, debuggable: Boolean = BuildConfig.DEBUG): Boolean {
        if (heldForMeasurement(debuggable)) return false
        if (checkInFlight || failed || interstitial || viewer) return false
        if (document == null || document == "about:blank") return false
        return PageRules.isWebPage(document)
    }

    // --- the measurement's hold (seed A10 step 1: the probe's latency on a device) -----------

    /**
     * The hold the latency harness (`UnloadProbeLatency`, androidTest) sets for its baseline
     * arm – the same loads with no probe ahead of them. Written and read on the main thread by
     * the harness and the view; volatile for the JVM tests' sake, which have no main thread.
     */
    @Volatile private var held = false

    /**
     * Whether the probe is held off for a measurement: the hold, and a debuggable build. A
     * release build's answer is false whatever was written – the probe stays on every load the
     * core asks for (the Design Lead's ruling of 10-02: option (i)), and no switch reaches it.
     */
    fun heldForMeasurement(debuggable: Boolean): Boolean = DebugHooks.enabled(debuggable) && held

    /**
     * Hold the probe off (`hold`) or let it back (`!hold`) for a measurement. The one place the
     * probe can be turned off, and a debuggable build alone answers it: elsewhere nothing is
     * written and the answer is false. Returns whether the hold stands afterwards. A hook in
     * the sense of [DebugHooks]: in-process Kotlin for the instrumentation, no bridge method,
     * nothing a page or the chrome's script can reach.
     */
    fun debugHoldProbe(hold: Boolean, debuggable: Boolean = BuildConfig.DEBUG): Boolean {
        if (!DebugHooks.enabled(debuggable)) return false
        held = hold
        return held
    }
}
