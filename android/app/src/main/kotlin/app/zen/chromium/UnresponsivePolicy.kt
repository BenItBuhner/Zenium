package app.zen.chromium

/**
 * When the unresponsive-page prompt (ERR-16 / OS-36) comes up, stays down and goes, from the
 * platform's renderer callbacks and the user's answer. The WebView itself keeps the clock:
 * `WebViewRenderProcessClient.onRenderProcessUnresponsive` fires once the shared renderer has
 * left an input event or a navigation unanswered for its delay (Chrome's ~5 s), then again at
 * every interval while it stays that way, and `onRenderProcessResponsive` once when it answers
 * again – and every WebView of the app (the chrome, each tab) reports the one renderer, so the
 * same moment arrives several times over. This turns that stream into one prompt: shown once,
 * kept from coming straight back after the user chose Wait ([WAIT_GRACE_MS] of the renderer
 * still hung), dismissed when the renderer answers or goes.
 *
 * Free of Android types, so it runs under plain JUnit (`UnresponsivePolicyTest`); [Host] acts on it.
 */
class UnresponsivePolicy(private val clock: () -> Long) {
    enum class Action { NONE, SHOW, DISMISS }

    /** The prompt is up. */
    var showing = false
        private set
    /** When the user last chose Wait; the prompt keeps off until the renderer has been hung [WAIT_GRACE_MS] past it. */
    private var waitedAt = Long.MIN_VALUE

    /** A WebView reported the renderer unresponsive. */
    fun unresponsive(): Action {
        if (showing) return Action.NONE
        if (clock() - waitedAt < WAIT_GRACE_MS) return Action.NONE
        showing = true
        return Action.SHOW
    }

    /** A WebView reported the renderer responsive again: the page is back, the prompt goes. */
    fun responsive(): Action {
        waitedAt = Long.MIN_VALUE
        if (!showing) return Action.NONE
        showing = false
        return Action.DISMISS
    }

    /** The user chose Wait (or dismissed the sheet): the page keeps running; the prompt returns only after the grace, if the renderer is still hung. */
    fun waited() {
        showing = false
        waitedAt = clock()
    }

    /** The user chose Exit page, or the renderer went on its own: the prompt is over and nothing carries. */
    fun ended() {
        showing = false
        waitedAt = Long.MIN_VALUE
    }

    companion object {
        /**
         * After Wait, how long the renderer must stay hung before the prompt returns. Chrome
         * restarts its hang monitor on Wait and asks again at its next timeout; the WebView's
         * callbacks keep coming at its own interval, so the wait is counted here.
         */
        const val WAIT_GRACE_MS = 15_000L
    }
}

/** The site the prompt's title block names: the page's host, or [UNKNOWN] for a page without one. */
object UnresponsiveSite {
    const val UNKNOWN = "This page"
    private val AUTHORITY = Regex("^[a-zA-Z][a-zA-Z0-9+.-]*://([^/?#]*)")

    fun of(url: String?): String {
        if (url.isNullOrEmpty()) return UNKNOWN
        val authority = AUTHORITY.find(url)?.groupValues?.get(1) ?: return UNKNOWN
        // Neither the credentials before an @ nor the port: the host as the pill shows it.
        val host = authority.substringAfterLast('@').let { h ->
            if (h.startsWith("[")) h.substringBefore(']') + "]" else h.substringBefore(':')
        }
        return if (host.isEmpty()) UNKNOWN else host
    }
}
