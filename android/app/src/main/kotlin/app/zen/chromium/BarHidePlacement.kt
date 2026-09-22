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
 * follows the bar: at either rest the layout is the chrome's own, `S` or `H`, and while the
 * frame says the page is `tall` ([BarHideFrame.tall]: from the hide's first frame to the shown
 * REST) it is laid out tall, its far edge clipped to what the bar has left. Two layouts per
 * hide-and-return, never one per frame, neither pushing the page's content: the page grows at the
 * hide's first frame, since the clip that uncovers it as the bar leaves needs content to
 * uncover, and shrinks at the return's rest, after the bar has arrived – not the frame it
 * arrives, when the finger may still be down (§11.5 as amended on #270: the return's relayout,
 * 105 ms on github.com, leaves the gesture's frames entirely). A bar home with the page still
 * tall is clipped at the bar's edge: the same picture as short. A bottom-docked bar's page grows
 * at the bottom under the clip; a top-docked bar's page is slid up with the bar and clipped at
 * the frame's bottom, so the content under the bar moves with it and the page holds still under
 * the finger.
 *
 * The tall layout has a band less to scroll, so Chromium clamps a page that was within the band
 * of its end: the gesture starts no hide there from the short layout ([BarHideScrollFilter],
 * [BarHideShare]), and a page in its last band keeps its bar, laid out short, with all of it
 * reachable.
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
            // Tall from the hide's first frame to the shown rest (the frame's word, not the offset's:
            // a bar home under a finger still down leaves the page tall, clipped at the bar's edge).
            val tall = frame.tall || o > 0f
            when (frame.edge) {
                BarHideFrame.Edge.TOP -> {
                    // `S` starts at the shown edge, `H` a band above it; whichever the report is nearer.
                    val shownTop = if (abs(reportedTop - frame.shownEdgePx) <= abs(reportedTop + t - frame.shownEdgePx)) reportedTop else reportedTop + t
                    when {
                        !tall -> top = shownTop
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
                    bottom = if (tall) shownBottom + t else shownBottom
                    if (tall && o < t) clip = (t - o).roundToInt()
                }
            }
            return BarHidePlacement(top, bottom, shift, clip)
        }
    }
}
