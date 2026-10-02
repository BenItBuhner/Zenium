package app.zen.chromium

/**
 * The unload probe's pure rules (`TabWebView.probeThenLoad`, seed A7 "Cancel on 'Leave site?'
 * keeps the page"): which documents are asked by a probe before a load the core asked for goes
 * out, and which addresses are the probe's own, so the WebView's words about them are dropped
 * and the request engine never sees them. Pinned on the JVM (`UnloadProbeRulesTest`).
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
     * list as the check's.
     */
    fun needsProbe(document: String?, failed: Boolean, interstitial: Boolean, viewer: Boolean, checkInFlight: Boolean): Boolean {
        if (checkInFlight || failed || interstitial || viewer) return false
        if (document == null || document == "about:blank") return false
        return PageRules.isWebPage(document)
    }
}
