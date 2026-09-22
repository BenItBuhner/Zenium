package app.zen.chromium

import android.animation.ValueAnimator
import android.graphics.Outline
import android.graphics.Rect
import android.view.View
import android.view.ViewOutlineProvider
import kotlin.math.max
import kotlin.math.roundToInt

/**
 * The fullscreen layer's way in (MOT-32). The engine's fullscreen view covers the window the
 * moment a page goes fullscreen (`onShowCustomView`); shown whole it would cut the chrome off
 * mid-frame, its bars still on screen and the system bars only starting to slide away. Instead
 * the layer is clipped to the page's card as it stands and the clip spreads to the whole window
 * on the chrome's bar spring – the same stiffness and damping as its `SPRING_SNAPPY`, started
 * when the chrome says its bar is translating off (`chrome.fullscreenHiding`) or after
 * [START_CAP_MS] without word – so a fullscreen opens as the page spreading over bars that leave,
 * the two on one curve. The clip is the layer's outline (`clipToOutline`), a property of its
 * render node: nothing is laid out or redrawn per frame (PERF-5's rule, as `TabWebView`'s
 * corners). With animations off (the device's "remove animations", the chrome's
 * `prefers-reduced-motion`) the layer shows whole at once: no transition.
 *
 * `window` gives the frame the clip spreads to (the layer's own, device px); the layer may not
 * be laid out yet when the reveal begins, having been gone until this moment.
 */
class FullscreenReveal(
    private val layer: View,
    private val window: () -> Rect,
    private val animatorsEnabled: () -> Boolean = { ValueAnimator.areAnimatorsEnabled() }
) {
    private val card = Rect()
    private var cardRadius = 0f
    /** 0: the clip is the card; 1: the whole window, and no clip at all. */
    private var progress = 1f
    /** The farthest any edge travels (px): the spring runs in px, like the chrome's, so its rest is a real fraction of a pixel. */
    private var travel = 0f
    /** Clipped to the card and waiting for the chrome's word (or the cap) to spread. */
    private var armed = false
    private val startNow = Runnable { start() }
    private val spring = Spring(STIFFNESS, DAMPING, onFrame = { set(it) }, onRest = { finish() })
    private val outline = object : ViewOutlineProvider() {
        override fun getOutline(view: View, outline: Outline) {
            val p = progress
            val w = view.width
            val h = view.height
            if (p >= 1f) {
                outline.setRect(0, 0, w, h)
                return
            }
            outline.setRoundRect(
                lerp(card.left, 0, p), lerp(card.top, 0, p), lerp(card.right, w, p), lerp(card.bottom, h, p),
                cardRadius * (1f - p)
            )
        }
    }

    /** The clip stands on the card, waiting or spreading. */
    val running: Boolean get() = progress < 1f

    /**
     * The layer is going up over a page whose card is `card` (the layer's coordinates, device
     * px) with `radiusPx` corners: clip to the card now, spread on the chrome's word or the cap.
     */
    fun begin(card: Rect, radiusPx: Float) {
        snap()
        if (!animatorsEnabled() || card.isEmpty) return
        val w = window()
        travel = max(
            max(card.left - w.left, w.right - card.right),
            max(card.top - w.top, w.bottom - card.bottom)
        ).toFloat()
        if (travel <= 0f) return
        this.card.set(card)
        cardRadius = radiusPx
        progress = 0f
        layer.outlineProvider = outline
        layer.clipToOutline = true
        layer.invalidateOutline()
        armed = true
        layer.postDelayed(startNow, START_CAP_MS)
    }

    /** The chrome's bar is translating off: the clip spreads with it. */
    fun onChromeHiding() {
        if (armed) start()
    }

    /** The screen turned, or the fullscreen is leaving: the clip goes at once. */
    fun snap() {
        if (!running && !armed) return
        spring.stop()
        finish()
    }

    private fun start() {
        if (!armed) return
        armed = false
        layer.removeCallbacks(startNow)
        spring.animate(0f, 0f, travel)
    }

    private fun set(x: Float) {
        progress = (x / travel).coerceIn(0f, 1f)
        layer.invalidateOutline()
    }

    private fun finish() {
        armed = false
        layer.removeCallbacks(startNow)
        progress = 1f
        layer.clipToOutline = false
        layer.outlineProvider = ViewOutlineProvider.BACKGROUND
        layer.invalidateOutline()
    }

    private fun lerp(from: Int, to: Int, p: Float): Int = (from + (to - from) * p).roundToInt()

    companion object {
        /** The chrome's `SPRING_SNAPPY`, in px. */
        const val STIFFNESS = 420f
        const val DAMPING = 40f
        /** The longest the clip waits on the card for the chrome's word before it spreads on its own. */
        const val START_CAP_MS = 150L
    }
}
