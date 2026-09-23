package app.zen.chromium

import android.animation.ValueAnimator
import android.graphics.Rect
import android.view.View
import kotlin.math.roundToInt

/**
 * The fullscreen layer's reveal over the chrome (MOT-32; design language v2 §11.5). The layer –
 * black, with the engine's fullscreen view filling it – goes up over the whole window the moment
 * a page's element goes fullscreen, and the chrome under it, kept mounted, slides its bar off
 * the edge as the system bars go (`lib/fullscreenMotion.ts`). For the slide to be seen the layer
 * is clipped, at first, to the frame the page had inline, and the clip grows to the window on
 * the same spring the bar leaves on (`SPRING_SNAPPY`'s stiffness and damping, [Spring]), so the
 * page is seen to take the bar's band as the bar leaves it, Chrome's way. The clip is a property
 * of the layer's render node ([View.setClipBounds]): no layout, no re-recording of the layer or
 * what it holds, per frame – the performance program's rule for motion, on the host's side.
 *
 * Nothing here touches the bars or their insets: the system animates the bars out on its own,
 * and the chrome hears every `insets` as it always did (#277). Under the system's "remove
 * animations" ([ValueAnimator.areAnimatorsEnabled] false – the setting the pages' and the chrome's
 * `prefers-reduced-motion` follow) there is no reveal: the layer is the window at once, as the
 * chrome's bar is off at once. The exit is a cut, as the engine makes it: the fullscreen view
 * leaves the layer and the page is drawn inline again; what moves then is the chrome's return.
 */
class FullscreenReveal(
    private val layer: View,
    private val animationsEnabled: () -> Boolean = { ValueAnimator.areAnimatorsEnabled() }
) {
    /** A box in the layer's device px. */
    data class Box(val left: Int, val top: Int, val right: Int, val bottom: Int) {
        fun toRect(): Rect = Rect(left, top, right, bottom)

        companion object {
            fun of(rect: Rect): Box = Box(rect.left, rect.top, rect.right, rect.bottom)
        }
    }

    private var from: Box? = null
    private var to: Box? = null
    private var travel = 0f
    private val spring = Spring(STIFFNESS, DAMPING, ::onFrame, ::onRest)

    /** Whether the clip is still on its way to the window. */
    val running: Boolean get() = spring.running

    /**
     * The layer went up: reveal it from `page` – the fullscreen tab's frame as it stood inline,
     * in the layer's device px, or null for a page not laid out – to `window`, the layer's whole
     * box. A page that already fills the window, or a system without animations, has no reveal.
     */
    fun begin(page: Rect?, window: Rect) {
        spring.stop()
        val start = page?.let(Box::of)
        val end = Box.of(window)
        val distance = if (start == null) 0f else travelOf(start, end)
        if (start == null || distance <= 0f || !animationsEnabled()) {
            clear()
            return
        }
        from = start
        to = end
        travel = distance
        layer.clipBounds = start.toRect()
        spring.animate(0f, 0f, distance)
    }

    /** The layer comes down (or another fullscreen takes it): whatever clip is left goes. */
    fun end() {
        spring.stop()
        clear()
    }

    private fun onFrame(x: Float) {
        val page = from ?: return
        val window = to ?: return
        layer.clipBounds = clipAt(page, window, (x / travel).coerceIn(0f, 1f)).toRect()
    }

    private fun onRest(@Suppress("UNUSED_PARAMETER") x: Float) = clear()

    private fun clear() {
        from = null
        to = null
        layer.clipBounds = null
    }

    companion object {
        /** The chrome's `SPRING_SNAPPY` (`shared/spring.ts`): the bar hide's snap and the bar's way off around a fullscreen. */
        const val STIFFNESS = 420f
        const val DAMPING = 40f

        /**
         * How far the clip has to go (device px): the farthest of its four edges from the window's.
         * The spring runs over this distance, so its rest thresholds – px-sized, [Spring]'s – end
         * the reveal a fraction of a pixel from the window on every edge, and the progress it
         * yields is the same curve the chrome's bar runs on over its own travel.
         */
        fun travelOf(page: Box, window: Box): Float =
            maxOf(page.top - window.top, window.bottom - page.bottom, page.left - window.left, window.right - page.right)
                .coerceAtLeast(0)
                .toFloat()

        /** The clip at `progress` of the way (0 the page's frame, 1 the window), each edge on its own straight line. */
        fun clipAt(page: Box, window: Box, progress: Float): Box {
            val p = progress.coerceIn(0f, 1f)
            return Box(
                lerp(page.left, window.left, p),
                lerp(page.top, window.top, p),
                lerp(page.right, window.right, p),
                lerp(page.bottom, window.bottom, p)
            )
        }

        private fun lerp(a: Int, b: Int, p: Float): Int = (a + (b - a) * p).roundToInt()
    }
}
