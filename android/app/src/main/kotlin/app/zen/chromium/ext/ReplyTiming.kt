package app.zen.chromium.ext

import org.json.JSONArray

/**
 * Where a call's round trip through the host and the runtime spent its time, for the bridge
 * trace line of its reply while `debug` ([Extensions.trace]).
 *
 * A `chrome.*` call a frame makes crosses four queues before its answer is back in the frame:
 * the host's main thread receives it (`onPostMessage`), the runtime's `evaluateJavascript` task
 * waits its turn on the WebView's one renderer main thread – every document of every WebView of
 * the app runs there, the chrome's, the tabs', the extension pages' – the runtime answers, and
 * the reply comes back through the chrome's port (its delivery and its dispatch, two tasks on
 * the app's main thread, `BridgePort.kt`) to the frame's reply proxy. Compat round 18 read
 * `storage.set` at a median 161 ms from the host's receipt to the host's send against Chrome's
 * ~1-5 ms, and round 19 read seconds on the AOSP image, with a floor of a few milliseconds when
 * nothing is queued: the time is queueing, and this says in which queue. The runtime stamps the
 * call's receipt and the reply's post (`Date.now()`, `ext.send`'s `at`), the host the call's
 * receipt and the reply's send (`System.currentTimeMillis()`, the same wall clock), and the
 * three legs are:
 *
 *  - `hop`: the host's receipt to the runtime's – the `evaluateJavascript` carrying the call
 *    and the renderer main thread's queue ahead of it;
 *  - `run`: the runtime's own work, the call's answer included;
 *  - `back`: the runtime's post to the host's send – the port's delivery and dispatch on the
 *    app's threads.
 *
 * The frame's own two hops (its `postMessage` to the host's receipt, the reply proxy's message
 * to the frame's handler) are outside both stamps and outside this account.
 */
object ReplyTiming {
    /**
     * The legs as a trace-line tail (` hop=<ms> run=<ms> back=<ms>`), or "" when any stamp is
     * missing: [receivedWall] the host's wall clock at the call's receipt (null for a call the
     * host never saw as one), [at] the runtime's `[seen, replied]` (null for a reply the host
     * made itself, or one from a runtime without `debug`), [sentWall] the host's wall clock now.
     * A negative leg is kept as it comes (the two clocks are one, but each stamp is taken on a
     * thread of its own and a millisecond's rounding can invert a zero-length leg).
     */
    fun legs(receivedWall: Long?, at: JSONArray?, sentWall: Long): String {
        if (receivedWall == null || at == null || at.length() < 2) return ""
        val seen = at.optLong(0, Long.MIN_VALUE)
        val replied = at.optLong(1, Long.MIN_VALUE)
        if (seen == Long.MIN_VALUE || replied == Long.MIN_VALUE) return ""
        return " hop=${seen - receivedWall} run=${replied - seen} back=${sentWall - replied}"
    }
}
