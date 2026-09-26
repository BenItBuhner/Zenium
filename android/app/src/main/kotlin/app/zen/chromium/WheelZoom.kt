package app.zen.chromium

import kotlin.math.roundToInt

/**
 * Ctrl + the mouse wheel over a page zooms it (OS-12; Chrome's and Edge's desktop rule, kept on
 * DeX and in a desktop window): the wheel's vertical travel under Ctrl is the core's Zoom In
 * (away from the user, positive `AXIS_VSCROLL`) or Zoom Out, one step per whole notch – the
 * `zoom.in` / `zoom.out` the keyboard's Ctrl+= / Ctrl+- run, so the ladder and the site memory
 * are the same. Chromium's browser process does exactly this for a Ctrl+wheel the renderer left
 * alone (`WebContentsImpl::HandleWheelEvent`: whole ticks accumulated, fractions carried to the
 * next event), but the WebView's delegate has no zoom to change, so the event went nowhere; here
 * it is taken ahead of the WebView, which never sees it – no scroll under the zoom and no second
 * zoom of its own.
 *
 * The accumulator lives per view, so a trackpad's fine-grained scroll (many events of a fraction
 * of a notch) adds up to a step as a wheel's whole notch does; a wheel without Ctrl clears it,
 * since the next Ctrl+wheel begins a new gesture.
 */
class WheelZoom {
    private var remainder = 0.0

    /**
     * The zoom step this wheel event asks for – `in`, `out` – or null for none: not a scroll,
     * Ctrl not held (the wheel scrolls the page as ever), or a fraction of a notch that has not
     * added up to one yet. `consumed` says whether the event was the zoom's at all (a Ctrl+wheel
     * is, even at a fraction: the page must not scroll under a zoom in progress).
     */
    fun step(scroll: Boolean, ctrl: Boolean, vscroll: Float): Step {
        if (!scroll) return Step.PASS
        if (!ctrl) {
            remainder = 0.0
            return Step.PASS
        }
        if (vscroll == 0f || vscroll.isNaN()) return Step.NONE
        remainder += vscroll.toDouble()
        val whole = remainder.roundToInt()
        remainder -= whole
        return when {
            whole > 0 -> Step.IN
            whole < 0 -> Step.OUT
            else -> Step.NONE
        }
    }

    /** The core's direction word for a step that zooms (`zoomChanged` view event; `ViewEvents.onZoomChanged`). */
    enum class Step(val direction: String?, val consumed: Boolean) {
        /** Not a Ctrl+scroll: the WebView's. */
        PASS(null, false),
        /** A Ctrl+scroll short of a whole notch: taken, nothing to zoom yet. */
        NONE(null, true),
        IN("in", true),
        OUT("out", true)
    }
}
