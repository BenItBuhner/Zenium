package app.zen.chromium

import kotlin.math.ceil

/**
 * Whether a frame the chrome lays a page out at can be the container's: the pure part of
 * [TabHost.setBounds]'s guard (BH-32). A page's frame never legitimately exceeds the window it
 * is in, so one wider or taller than the container is a stale measurement – the chrome measured
 * its viewport before its own WebView had the size the system settled on (the return from a
 * fullscreen that turned the screen: the container is portrait again while the chrome still
 * reads landscape, and lays the page out at a landscape frame that would show cropped, a third
 * of the height, for as long as the chrome takes to catch up). Such a frame is refused; the
 * chrome's next report, at its real size, lays the page out.
 *
 * The chrome's frame is in CSS px rounded to whole pixels and scaled here by the density, so a
 * frame that is the container's exact width may come out a device pixel over: a CSS pixel of
 * slack is allowed. A container not laid out yet (no size) refuses nothing – there is nothing
 * to judge against, and the page's first frames must land.
 *
 * The container is not always the screen the page is about to be on. A fullscreen that turned
 * the screen ends with the orientation's release, and the system turns the screen back some
 * hundred milliseconds later; the chrome's report in between – its layout under the fullscreen
 * layer, or its first inline one, both on the turned screen – fits the container as it still
 * stands and would be applied, to lay the page out landscape on the portrait screen it lands
 * on a moment later (the return of a landscape video, BH-32's frame caught late). While such
 * an exit is landing the host knows the screen it lands on ([TabHost.landingOn], from
 * [FullscreenLanding]'s window); a frame that fits the container but not that screen is held
 * back ([Verdict.HOLD]) rather than applied, and applied once the bars have settled if it fits
 * the container then (a screen that stayed as it was), or dropped.
 */
object PageFrameFit {
    /** A screen's size in device px. */
    data class Screen(val width: Int, val height: Int)

    /** What [TabHost.setBounds] does with a frame. */
    enum class Verdict { APPLY, HOLD, REFUSE }

    fun fits(width: Int, height: Int, containerWidth: Int, containerHeight: Int, density: Float): Boolean {
        if (containerWidth <= 0 || containerHeight <= 0) return true
        val slack = ceil(density.coerceAtLeast(1f)).toInt()
        return width <= containerWidth + slack && height <= containerHeight + slack
    }

    /**
     * The frame against the container, and against the screen a fullscreen's exit is landing on
     * (`landing`; null outside such a landing): refused when it fits neither, held back when it
     * fits the container alone, applied otherwise.
     */
    fun judge(width: Int, height: Int, containerWidth: Int, containerHeight: Int, landing: Screen?, density: Float): Verdict {
        if (!fits(width, height, containerWidth, containerHeight, density)) return Verdict.REFUSE
        if (landing != null && !fits(width, height, landing.width, landing.height, density)) return Verdict.HOLD
        return Verdict.APPLY
    }
}
