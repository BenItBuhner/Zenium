package app.zen.chromium

import kotlin.math.abs
import kotlin.math.roundToInt

/**
 * Where a page's view is laid out for the bar that hides on scroll: the pure part of
 * [TabHost.place], device px (`lib/barHide.ts`; the preview host's `applyFrame` does the same in
 * CSS px). `top` and `bottom` are the view's edges in the container, [shiftPx] its slide and
 * [clipPx] what is clipped off its bottom edge ([TabWebView.setBarHideShift]).
 *
 * The chrome's content column takes one of two layouts – short, with the bar's band left free
 * (`S`), or tall, into the band, once the bar is hidden and at rest (`H`) – and reports whichever
 * it is in; the report can trail the bar by a frame or two either way, so which one it is is
 * read off the frame's `shownEdge`, not assumed. From that the page's edge on the bar's side
 * follows the bar: at rest the layout is the chrome's own, `S` or `H`, and while the bar is off
 * its edge but not fully the page is laid out tall once (one relayout per gesture, not one per
 * frame, and it never pushes the page's content) and its far edge is clipped to what the bar has
 * left. A bottom-docked bar's page grows at the bottom under the clip; a top-docked bar's page is
 * slid up with the bar and clipped at the frame's bottom, so the content under the bar moves with
 * it and the page holds still under the finger.
 *
 * The tall layout has a band less to scroll, so Chromium clamps a page that was within the band
 * of its end: the gesture starts no hide there ([BarHideScrollFilter], [BarHideShare]), and a
 * page in its last band keeps its bar, laid out short, with all of it reachable.
 */
class BarHidePlacement(val top: Int, val bottom: Int, val shiftPx: Float, val clipPx: Int) {
    val height: Int get() = (bottom - top).coerceAtLeast(0)

    override fun equals(other: Any?): Boolean =
        other is BarHidePlacement && other.top == top && other.bottom == bottom && other.shiftPx == shiftPx && other.clipPx == clipPx

    override fun hashCode(): Int = ((top * 31 + bottom) * 31 + shiftPx.hashCode()) * 31 + clipPx

    override fun toString(): String = "BarHidePlacement(top=$top, bottom=$bottom, shift=$shiftPx, clip=$clipPx)"

    companion object {
        /**
         * The layout for a view the chrome reported at `reportedTop` … `reportedBottom` under
         * `frame` (null: the bar may not hide, and the chrome's layout stands). `held`: the view
         * fills the window (picture-in-picture, [TabHost.fillWindow]) and is laid out by nobody
         * else until it is put back – null, nothing to write; the same call with `held` false
         * once it is put back gives the layout it takes then.
         */
        fun of(reportedTop: Int, reportedBottom: Int, frame: BarHideFrame?, held: Boolean = false): BarHidePlacement? {
            if (held) return null
            if (frame == null) return BarHidePlacement(reportedTop, reportedBottom, 0f, 0)
            val t = frame.travelPx
            val o = frame.offsetPx
            var top = reportedTop
            var bottom = reportedBottom
            var shift = 0f
            var clip = 0
            when (frame.edge) {
                BarHideFrame.Edge.TOP -> {
                    // `S` starts at the shown edge, `H` a band above it; whichever the report is nearer.
                    val shownTop = if (abs(reportedTop - frame.shownEdgePx) <= abs(reportedTop + t - frame.shownEdgePx)) reportedTop else reportedTop + t
                    when {
                        o <= 0f -> top = shownTop
                        o < t -> {
                            top = shownTop
                            bottom = reportedBottom + t
                            shift = -o
                            clip = (t - o).roundToInt()
                        }
                        else -> top = shownTop - t
                    }
                }
                BarHideFrame.Edge.BOTTOM -> {
                    val shownBottom = if (abs(reportedBottom - frame.shownEdgePx) <= abs(reportedBottom - t - frame.shownEdgePx)) reportedBottom else reportedBottom - t
                    bottom = if (o <= 0f) shownBottom else shownBottom + t
                    if (o > 0f && o < t) clip = (t - o).roundToInt()
                }
            }
            return BarHidePlacement(top, bottom, shift, clip)
        }
    }
}
