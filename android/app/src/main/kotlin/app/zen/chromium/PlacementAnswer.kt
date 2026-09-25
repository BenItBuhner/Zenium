package app.zen.chromium

/**
 * The host's answer to a placement (Q1, the observable landing – the §11 stand-in rule), kept
 * free of Android types so it runs under plain JUnit (`PlacementAnswerTest`); [Host] arms the
 * callbacks.
 *
 * The chrome WebView lies under the page WebViews, and where a gesture lands – a swipe on the
 * next tab, the overview closing into a card – the chrome has been drawing a picture in place
 * of the page. The picture may leave only once the page is on screen in its place, and the
 * word for that is the host's, by a signal, not the chrome's, by a clock: after the batch that
 * places the view and brings it back (`view.setBounds`, `view.setRadius`, `view.setVisible`,
 * one main-thread task in the page's order, [BridgePort]) the chrome asks `view.shown`, and the
 * ask is dispatched after the batch – the strings off the port are posted to the main thread
 * one by one in the order they arrived – so by the time [answer] runs the placement has been
 * applied. The answer is then
 *
 *  - `false` at once for a view the host does not have, or has but does not show (a private
 *    page refused under the lock, [PrivateLock.refusesShow]): nothing is coming, and the chrome
 *    drops its picture – the lock cover, or nothing, is what it stands for;
 *  - `true` once the frame that shows the view has been drawn: the view's own visual-state
 *    callback (`WebView.postVisualStateCallback` – the next draw reflects the page) and then the
 *    frame after the one it names, as [Host.reportDrawn] counts the frame of `view.drawn` (the
 *    READY form the chrome already times its cover's swap by);
 *  - `false` after [PageVisibility.DRAWN_DEADLINE_MS] when no frame comes – the same bound as
 *    `view.drawn`'s, from the same family as the chrome's own waits (`ACK_TIMEOUT_MS`,
 *    `COVER_WAIT_MS`, `lib/cover.ts`) and under the chrome's patience for this answer
 *    (`SHOWN_WAIT_MS`, 1000 ms) so the chrome hears the host's word before its own clock runs
 *    out: a renderer that never draws (gone, the window on its way out) must not keep a picture
 *    over its place for good.
 *
 * Each ask is answered exactly once; the frame and the deadline disarm each other.
 */
class PlacementAnswer(
    /** Whether the host has `tabId`'s view and shows it right now (`View.VISIBLE`). */
    private val showing: (tabId: String) -> Boolean,
    /**
     * Arm `onFrame` for the frame that shows `tabId`'s view: its visual-state callback, then
     * the frame after the one it names ([Host.afterFrames]). Called for a view [showing] said
     * the host shows.
     */
    private val armFrame: (tabId: String, onFrame: () -> Unit) -> Unit,
    /** Arm `onDeadline` for [PageVisibility.DRAWN_DEADLINE_MS] from now; answers with its disarm. */
    private val armDeadline: (onDeadline: () -> Unit) -> (() -> Unit)
) {
    /** Asks answered at once, without a frame armed (a view not shown). */
    var refused = 0L
        private set

    /** Asks whose frame was armed. */
    var armed = 0L
        private set

    /** `view.shown` for `tabId`: `reply` hears the answer, once. */
    fun answer(tabId: String, reply: (Boolean) -> Unit) {
        if (!showing(tabId)) {
            refused++
            reply(false)
            return
        }
        armed++
        var answered = false
        var disarm: (() -> Unit)? = null
        val once = { shown: Boolean ->
            if (!answered) {
                answered = true
                disarm?.invoke()
                reply(shown)
            }
        }
        disarm = armDeadline { once(false) }
        armFrame(tabId) { once(true) }
    }
}
