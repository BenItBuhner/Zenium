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
 */
object PageFrameFit {
    fun fits(width: Int, height: Int, containerWidth: Int, containerHeight: Int, density: Float): Boolean {
        if (containerWidth <= 0 || containerHeight <= 0) return true
        val slack = ceil(density.coerceAtLeast(1f)).toInt()
        return width <= containerWidth + slack && height <= containerHeight + slack
    }
}
