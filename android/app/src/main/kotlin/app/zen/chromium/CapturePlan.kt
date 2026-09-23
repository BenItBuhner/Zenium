package app.zen.chromium

import org.json.JSONObject
import kotlin.math.ceil
import kotlin.math.max
import kotlin.math.min

/** An axis-aligned box in CSS pixels, page coordinates unless a comment says otherwise. */
data class Box(val x: Double, val y: Double, val width: Double, val height: Double) {
    val right: Double get() = x + width
    val bottom: Double get() = y + height

    fun contains(other: Box): Boolean =
        other.x >= x - EPSILON && other.y >= y - EPSILON &&
            other.right <= right + EPSILON && other.bottom <= bottom + EPSILON

    /** The overlap with `other`, or null when the boxes do not share at least a pixel. */
    fun intersect(other: Box): Box? {
        val l = max(x, other.x)
        val t = max(y, other.y)
        val r = min(right, other.right)
        val b = min(bottom, other.bottom)
        return if (r - l < MIN_SIZE || b - t < MIN_SIZE) null else Box(l, t, r - l, b - t)
    }

    companion object {
        private const val EPSILON = 0.01
        private const val MIN_SIZE = 0.5
    }
}

/** What the page reports about itself, in CSS pixels (see `PageCapture.METRICS_SCRIPT`). */
data class PageMetrics(
    /** Layout viewport scroll offset (`window.scrollX/Y`). */
    val scrollX: Double,
    val scrollY: Double,
    /** Visual viewport: where the pixels on screen come from (`visualViewport.pageLeft/pageTop`). */
    val pageLeft: Double,
    val pageTop: Double,
    val viewportWidth: Double,
    val viewportHeight: Double,
    /** The document's scrollable size. */
    val documentWidth: Double,
    val documentHeight: Double,
    /** The document runs right-to-left (`direction: rtl` on the root); only the chrome's geometry reads it. */
    val rtl: Boolean = false
) {
    /** The part of the page currently on screen. */
    val visible: Box get() = Box(pageLeft, pageTop, viewportWidth, viewportHeight)
}

/** Where a strip's pixels go: `src` in device pixels of the strip, `dst` in pixels of the output image. */
data class Blit(val src: Box, val dst: Box)

/**
 * The geometry of an agent screenshot on Android, where a WebView can only ever paint what is on
 * screen: a full-page or region capture scrolls the page in viewport-sized steps and stitches the
 * copies together. Everything here is arithmetic so it can be unit-tested on the JVM.
 */
object CapturePlan {
    const val MODE_VIEWPORT = "viewport"
    const val MODE_FULL_PAGE = "fullPage"
    const val MODE_REGION = "region"
    /** The long screenshot's capture (SH-08): from the viewport's top down to about ten screens. */
    const val MODE_LONG = "long"

    /** Very long pages are cut here, not failed – the same limit as the desktop host (CSS px). */
    const val MAX_PAGE_HEIGHT = 12_000.0

    /** Chrome's long screenshot reaches about this many screens of the page and no further. */
    const val LONG_MAX_SCREENS = 10.0
    /** The long capture's output caps (image px): its width at the device's scale, its height so the bitmap stays within reach. */
    const val LONG_MAX_WIDTH = 1_440.0
    const val LONG_MAX_HEIGHT = 12_000.0

    /** Output caps in image pixels: a full page is downscaled to fit, a region or viewport too. */
    const val MAX_FULL_PAGE_WIDTH = 1_600.0
    const val MAX_FULL_PAGE_HEIGHT = 8_000.0
    const val MAX_SIDE = 4_096.0

    /** Full pages never come out sharper than this (image px per CSS px); phones are ~2.6–3.5. */
    const val FULL_PAGE_MAX_SCALE = 2.0

    /** Device pixels per CSS pixel: the view's width in pixels covers exactly the visual viewport. */
    fun deviceScale(viewWidthPx: Int, metrics: PageMetrics, fallback: Double): Double =
        if (viewWidthPx > 0 && metrics.viewportWidth > 0) viewWidthPx / metrics.viewportWidth else fallback

    /**
     * The page's geometry in the chrome's terms (`shared/capture.ts`'s `PageViewport`, the
     * `page.viewport` command): the visual viewport's offset and size in CSS px – what is on
     * screen, pinch-pan included – the device pixels per CSS px ([deviceScale]) and, as `zoom`,
     * how many of the chrome's CSS px (dp) one page px takes: that scale over the display
     * density. A desktop-layout page squeezed into the screen is below 1, a pinch zoom above.
     * With no laid-out view (`viewWidthPx` 0) the density is the scale and the zoom 1.
     *
     * `clientWidth` / `clientHeight` – the visible area minus the scrollbar gutters, what a
     * visible-area capture paints (the desktop's twin cuts a classic scrollbar's column off) –
     * are the visible area itself here: a WebView's scrollbars overlay the page and take no room
     * of it, so `PageCapture`'s viewport copy is all page. `rtl` is the document's direction, for
     * the chrome's information (it does not move a gutter on either platform).
     */
    fun viewportJson(metrics: PageMetrics, viewWidthPx: Int, density: Double): JSONObject {
        val dp = if (density > 0) density else 1.0
        val scale = deviceScale(viewWidthPx, metrics, dp)
        return json(
            "scrollX" to metrics.pageLeft,
            "scrollY" to metrics.pageTop,
            "width" to metrics.viewportWidth,
            "height" to metrics.viewportHeight,
            "clientWidth" to metrics.viewportWidth,
            "clientHeight" to metrics.viewportHeight,
            "rtl" to metrics.rtl,
            "zoom" to scale / dp,
            "devicePixelRatio" to scale,
            "documentWidth" to max(metrics.documentWidth, metrics.viewportWidth),
            "documentHeight" to max(metrics.documentHeight, metrics.viewportHeight)
        )
    }

    /** The page rectangle to capture for `mode`, or null when there is nothing to capture. */
    fun target(mode: String, region: Box?, metrics: PageMetrics): Box? {
        val document = Box(
            0.0,
            0.0,
            max(metrics.documentWidth, metrics.viewportWidth),
            max(metrics.documentHeight, metrics.viewportHeight)
        )
        return when (mode) {
            MODE_FULL_PAGE -> Box(0.0, 0.0, document.width, min(document.height, MAX_PAGE_HEIGHT))
            MODE_REGION -> region?.intersect(document)
            MODE_LONG -> longTarget(metrics)
            else -> metrics.visible
        }
    }

    /**
     * The long screenshot's page rectangle: the visual viewport's width, from the viewport's top
     * down to [LONG_MAX_SCREENS] screens – pulled up over what the document lacks below, so a
     * page read near its end still fills the capture, and never past the document's top. What
     * the user sees is always in it.
     */
    fun longTarget(metrics: PageMetrics): Box {
        val vh = metrics.viewportHeight
        val documentHeight = max(metrics.documentHeight, vh)
        val height = min(documentHeight, vh * LONG_MAX_SCREENS)
        val y = max(0.0, min(metrics.pageTop, documentHeight - height))
        return Box(metrics.pageLeft, y, metrics.viewportWidth, height)
    }

    /** Image pixels per CSS pixel for the output. */
    fun outputScale(mode: String, target: Box, deviceScale: Double): Double {
        val scale = when (mode) {
            MODE_FULL_PAGE -> minOf(
                deviceScale,
                FULL_PAGE_MAX_SCALE,
                MAX_FULL_PAGE_WIDTH / target.width,
                MAX_FULL_PAGE_HEIGHT / target.height
            )
            // The long capture keeps the device's sharpness while its height allows, and gives
            // up sharpness rather than screens past the height cap (a ten-screen phone page
            // comes out ~540 px wide; a three-screen one at the device's scale).
            MODE_LONG -> minOf(
                deviceScale,
                FULL_PAGE_MAX_SCALE,
                LONG_MAX_WIDTH / target.width,
                LONG_MAX_HEIGHT / target.height
            )
            else -> min(deviceScale, MAX_SIDE / max(target.width, target.height))
        }
        return max(scale, MIN_SCALE)
    }

    /** Output image size in pixels (never empty). */
    fun outputSize(target: Box, outputScale: Double): Pair<Int, Int> =
        Pair(
            max(1, ceil(target.width * outputScale - ROUNDING_SLACK).toInt()),
            max(1, ceil(target.height * outputScale - ROUNDING_SLACK).toInt())
        )

    /**
     * Scroll positions (CSS page px, row-major) that together show every part of `target`. Positions
     * are clamped to what the page can scroll to, so a target near the end of the document maps to
     * fewer, overlapping strips; the blit step places each strip by where the page actually ended up.
     */
    fun scrollTargets(target: Box, metrics: PageMetrics): List<Pair<Double, Double>> {
        val vw = metrics.viewportWidth
        val vh = metrics.viewportHeight
        if (vw <= 0 || vh <= 0) return emptyList()
        val xs = steps(target.x, target.right, vw, max(0.0, metrics.documentWidth - vw))
        val ys = steps(target.y, target.bottom, vh, max(0.0, metrics.documentHeight - vh))
        return ys.flatMap { y -> xs.map { x -> Pair(x, y) } }
    }

    private fun steps(from: Double, to: Double, size: Double, maxStart: Double): List<Double> {
        val out = ArrayList<Double>()
        var p = from
        while (p < to - 0.5) {
            out.add(min(p, maxStart).coerceAtLeast(0.0))
            p += size
        }
        if (out.isEmpty()) out.add(min(from, maxStart).coerceAtLeast(0.0))
        return out.distinct()
    }

    /**
     * Where the pixels of one strip (the visual viewport `strip`, as reported after scrolling) land
     * in the output image; null when the strip shows none of the target.
     */
    fun blit(strip: Box, target: Box, deviceScale: Double, outputScale: Double): Blit? {
        val i = strip.intersect(target) ?: return null
        return Blit(
            src = Box(
                (i.x - strip.x) * deviceScale,
                (i.y - strip.y) * deviceScale,
                i.width * deviceScale,
                i.height * deviceScale
            ),
            dst = Box(
                (i.x - target.x) * outputScale,
                (i.y - target.y) * outputScale,
                i.width * outputScale,
                i.height * outputScale
            )
        )
    }

    private const val MIN_SCALE = 0.05
    private const val ROUNDING_SLACK = 0.001
}
