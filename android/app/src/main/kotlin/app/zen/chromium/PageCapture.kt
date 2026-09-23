package app.zen.chromium

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Rect
import android.graphics.RectF
import android.os.Handler
import android.os.Looper
import android.util.Base64
import android.util.Log
import android.view.PixelCopy
import android.view.Window
import android.webkit.WebView
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.util.concurrent.Executor
import kotlin.math.roundToInt

/**
 * Agent screenshots of a tab WebView: the viewport, the whole page, or a region of the page in CSS
 * page coordinates – the same `capture()` contract the desktop host implements with the DevTools
 * protocol. A WebView only paints what is on screen, so anything beyond the viewport is captured
 * by scrolling the page in viewport-sized steps, copying the window pixels of each step and
 * stitching them together; the scroll position is restored afterwards. Elements pinned with
 * `position: fixed` are hidden while the strips below the first are taken, so a fixed header does
 * not repeat once per strip.
 *
 * Everything runs on the main thread except the final encoding. `callback` is invoked exactly
 * once, with `{ data, mimeType, width, height }` or null when the view cannot be captured (not on
 * screen, nothing painted yet) or stops being capturable part-way (hidden under a sheet while
 * the strips were being taken: the copies are of the window, so a page that is not on screen
 * cannot be read from it, and a picture with white rows for it is not returned).
 */
class PageCapture(
    private val view: WebView,
    private val window: Window,
    private val encoder: Executor,
    /** Called before the first and after the last copy: the host squares the view's corners. */
    private val squareCorners: (Boolean) -> Unit = {},
    /** Runs a script and awaits a returned Promise (`TabWebView.evaluate`); null → plain evaluate. */
    private val evalAsync: ((String, (String?) -> Unit) -> Unit)? = null
) {
    private val main = Handler(Looper.getMainLooper())

    /**
     * The capture's pixels (the caller's to recycle) and the viewport's height in them.
     * `fallback` says the picture is the visible area although a full page or region was asked
     * for (the page's geometry could not be read): the core passes it on (`fallback: "viewport"`)
     * so the chrome does not pass the viewport off as the whole.
     */
    class Capture(val bitmap: Bitmap, val viewportHeightPx: Int, val fallback: Boolean = false)

    /** `quality`: the JPEG quality 0..100; anything outside is the agent's default ([JPEG_QUALITY]). */
    fun run(mode: String, region: Box?, format: String, quality: Int = -1, callback: (JSONObject?) -> Unit) {
        val jpegQuality = if (quality in 0..100) quality else JPEG_QUALITY
        runBitmap(mode, region) { capture ->
            if (capture == null) callback(null) else encode(capture.bitmap, format, jpegQuality, capture.fallback, callback)
        }
    }

    /**
     * The capture as a bitmap, for a caller that crops or writes it itself (the long screenshot,
     * SH-08), or null when the view cannot be captured. Main thread; `callback` once.
     */
    fun runBitmap(mode: String, region: Box?, callback: (Capture?) -> Unit) {
        if (view.width <= 0 || view.height <= 0 || !view.isShown) {
            callback(null)
            return
        }
        // The rounded corners of the tab view would otherwise be cut out of every copy (and show
        // up once per strip in a stitched image). The same settle lets the page paint whatever the
        // core hid just before asking (the agent's cursor overlay), which a copy of the window
        // buffer would otherwise still show.
        squareCorners(true)
        val finish: (Capture?) -> Unit = { result ->
            squareCorners(false)
            callback(result)
        }
        val viewportOnly = { fallback: Boolean -> copyView { bitmap -> finish(bitmap?.let { Capture(it, it.height, fallback) }) } }
        settle {
            if (mode == CapturePlan.MODE_VIEWPORT) {
                viewportOnly(false)
                return@settle
            }
            readMetrics { metrics ->
                if (metrics == null) {
                    // No page script access (about:blank before anything ran, a crashed renderer):
                    // the viewport is still worth returning, marked as the stand-in it is.
                    viewportOnly(true)
                    return@readMetrics
                }
                Stitch(mode, region, metrics, finish).start()
            }
        }
    }

    /** One stitched capture: a chain of scroll → wait → copy → blit steps ending in `finish`. */
    private inner class Stitch(
        mode: String,
        region: Box?,
        private val metrics: PageMetrics,
        private val callback: (Capture?) -> Unit
    ) {
        private val density = view.resources.displayMetrics.density.toDouble()
        private val deviceScale = CapturePlan.deviceScale(view.width, metrics, density)
        private val target = CapturePlan.target(mode, region, metrics)
        private val outputScale = target?.let { CapturePlan.outputScale(mode, it, deviceScale) } ?: 1.0
        private val cells: List<Pair<Double, Double>?> = when {
            target == null -> emptyList()
            metrics.visible.contains(target) -> listOf(null) // already on screen: copy once, no scrolling
            else -> CapturePlan.scrollTargets(target, metrics)
        }
        private var output: Bitmap? = null
        private var canvas: Canvas? = null
        private val paint = Paint(Paint.FILTER_BITMAP_FLAG or Paint.ANTI_ALIAS_FLAG)
        private var index = 0
        private var scrolled = false
        private var hidFixed = false
        private var done = false
        private val verticalBar = view.isVerticalScrollBarEnabled
        private val horizontalBar = view.isHorizontalScrollBarEnabled
        /** The view's own scroll offset (device px, pinch pan included) to put back afterwards. */
        private val originalScrollX = view.scrollX
        private val originalScrollY = view.scrollY
        private val watchdog = Runnable {
            Log.w(TAG, "capture watchdog fired after ${index}/${cells.size} strips")
            finish()
        }

        fun start() {
            val t = target
            if (t == null || cells.isEmpty()) {
                callback(null)
                return
            }
            val (w, h) = CapturePlan.outputSize(t, outputScale)
            val bitmap = try {
                Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
            } catch (e: OutOfMemoryError) {
                Log.w(TAG, "capture bitmap ${w}x$h does not fit in memory")
                callback(null)
                return
            }
            bitmap.eraseColor(Color.WHITE)
            output = bitmap
            canvas = Canvas(bitmap)
            if (cells.size > 1) {
                // Overlay scrollbars would otherwise fade in and out of the strips.
                view.isVerticalScrollBarEnabled = false
                view.isHorizontalScrollBarEnabled = false
            }
            main.postDelayed(watchdog, WATCHDOG_MS)
            step()
        }

        private fun step() {
            if (done) return
            val t = target ?: return finish()
            if (index >= cells.size) return finish()
            val cell = cells[index++]
            if (cell == null) {
                copyStrip(metrics.visible)
                return
            }
            val afterHide = {
                scrolled = true
                // The view's scroll offset is the page's total scroll in device px (layout scroll
                // plus pinch pan), so it also moves a visual viewport that is smaller than the
                // layout viewport – window.scrollTo() cannot.
                view.scrollTo((cell.first * deviceScale).roundToInt(), (cell.second * deviceScale).roundToInt())
                settle {
                    readMetrics { now ->
                        if (done) return@readMetrics
                        // Where the page actually ended up decides where the strip is blitted.
                        copyStrip(now?.visible ?: Box(cell.first, cell.second, metrics.viewportWidth, metrics.viewportHeight))
                    }
                }
            }
            // The first strip keeps fixed elements where the user sees them; from the second on they
            // would repeat, so they are hidden until the capture is over.
            if (index > 1 && !hidFixed && t.height > metrics.viewportHeight) {
                hidFixed = true
                view.evaluateJavascript(HIDE_FIXED_SCRIPT) { afterHide() }
            } else {
                afterHide()
            }
        }

        private fun copyStrip(strip: Box) {
            copyView { bitmap ->
                if (done) {
                    bitmap?.recycle()
                    return@copyView
                }
                if (bitmap == null) {
                    // The window refused, or the view left the screen while the page was being
                    // stitched (a sheet came over it: on Android the chrome lies under the pages,
                    // so the host hides a page a sheet covers). The strip's rows would stay white,
                    // and a picture with white where the page is would pass for the page.
                    Log.w(TAG, "capture strip $index/${cells.size} could not be copied (view shown: ${view.isShown})")
                    finish(failed = true)
                    return@copyView
                }
                val t = target
                if (t != null) {
                    CapturePlan.blit(strip, t, deviceScale, outputScale)?.let { b ->
                        canvas?.drawBitmap(bitmap, rect(b.src), rectF(b.dst), paint)
                    }
                }
                bitmap.recycle()
                step()
            }
        }

        /** The end of the chain: the page put back as it was, the picture (or null when `failed`) to the caller. */
        private fun finish(failed: Boolean = false) {
            if (done) return
            done = true
            main.removeCallbacks(watchdog)
            if (cells.size > 1) {
                view.isVerticalScrollBarEnabled = verticalBar
                view.isHorizontalScrollBarEnabled = horizontalBar
            }
            if (hidFixed) view.evaluateJavascript(SHOW_FIXED_SCRIPT, null)
            if (scrolled) view.scrollTo(originalScrollX, originalScrollY)
            val bitmap = output
            output = null
            canvas = null
            if (bitmap == null) {
                callback(null)
            } else if (failed) {
                bitmap.recycle()
                callback(null)
            } else {
                callback(Capture(bitmap, (metrics.viewportHeight * outputScale).roundToInt().coerceIn(1, bitmap.height)))
            }
        }
    }

    // --- primitives ------------------------------------------------------------------------------

    /** The page's viewport and document geometry, or null when the script cannot run. */
    private fun readMetrics(callback: (PageMetrics?) -> Unit) {
        view.evaluateJavascript(METRICS_SCRIPT) { result ->
            val obj = runCatching { JSONObject(result ?: "") }.getOrNull()
            callback(obj?.let { parseMetrics(it) })
        }
    }

    /**
     * Wait until the page has produced a frame with its latest changes (two animation frames in
     * the renderer – a fixed number of vsyncs is no measure of that on a software GPU) and the
     * view has drawn it into the window buffer. Falls back to a plain frame wait when the host
     * cannot await scripts.
     */
    private fun settle(then: () -> Unit) {
        val eval = evalAsync
        if (eval == null) {
            awaitFrames(SETTLE_FRAMES, then)
            return
        }
        eval(RAF_SCRIPT) { awaitFrames(DRAW_FRAMES, then) }
    }

    private fun awaitFrames(count: Int, then: () -> Unit) {
        if (count <= 0) {
            then()
            return
        }
        view.postOnAnimation { awaitFrames(count - 1, then) }
    }

    /** Copies the view's pixels as they are on screen; null when the window refuses. */
    private fun copyView(callback: (Bitmap?) -> Unit) {
        val width = view.width
        val height = view.height
        if (width <= 0 || height <= 0 || !view.isShown) {
            callback(null)
            return
        }
        val bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
        val location = IntArray(2)
        view.getLocationInWindow(location)
        val rect = Rect(location[0], location[1], location[0] + width, location[1] + height)
        try {
            PixelCopy.request(window, rect, bitmap, { result ->
                if (result == PixelCopy.SUCCESS) {
                    callback(bitmap)
                } else {
                    bitmap.recycle()
                    callback(null)
                }
            }, main)
        } catch (e: Exception) {
            bitmap.recycle()
            callback(null)
        }
    }

    private fun encode(bitmap: Bitmap, format: String, jpegQuality: Int, fallback: Boolean, callback: (JSONObject?) -> Unit) {
        encoder.execute {
            val png = format == "png"
            val out = ByteArrayOutputStream()
            val ok = runCatching {
                if (png) bitmap.compress(Bitmap.CompressFormat.PNG, 100, out)
                else bitmap.compress(Bitmap.CompressFormat.JPEG, jpegQuality, out)
            }.getOrDefault(false)
            val result = if (ok) json(
                "data" to Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP),
                "mimeType" to if (png) "image/png" else "image/jpeg",
                "width" to bitmap.width,
                "height" to bitmap.height
            ).also { if (fallback) it.put("fallback", FALLBACK_VIEWPORT) } else null
            bitmap.recycle()
            main.post { callback(result) }
        }
    }

    companion object {
        private const val TAG = "ZenCapture"
        private const val JPEG_QUALITY = 75
        /** Frames to let the WebView paint a new scroll position when scripts cannot be awaited. */
        private const val SETTLE_FRAMES = 3
        /** Frames between the renderer's frame and its pixels being in the window buffer. */
        private const val DRAW_FRAMES = 2

        /** Resolves after two animation frames, or after 400 ms if the page is not animating. */
        private const val RAF_SCRIPT = """new Promise(function(r){var d=false;var f=function(){if(!d){d=true;r(1)}};
requestAnimationFrame(function(){requestAnimationFrame(f)});setTimeout(f,400)})"""
        private const val WATCHDOG_MS = 20_000L

        /** The answer's `fallback` when the visible area stood in for a full page or region. */
        const val FALLBACK_VIEWPORT = "viewport"

        /**
         * The page's geometry as the stitcher plans with it; `TabWebView.viewport` reads it for the
         * chrome too, with the document's direction (`rtl`, the desktop twin's `VIEWPORT_SCRIPT`).
         */
        const val METRICS_SCRIPT = """(function(){var v=window.visualViewport,d=document.documentElement,b=document.body;
return {sx:window.scrollX,sy:window.scrollY,px:v?v.pageLeft:window.scrollX,py:v?v.pageTop:window.scrollY,
vw:v?v.width:window.innerWidth,vh:v?v.height:window.innerHeight,
dw:Math.max(d?d.scrollWidth:0,b?b.scrollWidth:0,window.innerWidth),dh:Math.max(d?d.scrollHeight:0,b?b.scrollHeight:0,window.innerHeight),
rtl:!!d&&getComputedStyle(d).direction==='rtl'}})()"""

        private const val HIDE_FIXED_SCRIPT = """(function(){var all=document.querySelectorAll('body *'),n=0;
for(var i=0;i<all.length&&i<30000;i++){var e=all[i];if(getComputedStyle(e).position==='fixed'&&!e.hasAttribute('data-zen-capture-hidden')){
e.setAttribute('data-zen-capture-hidden',e.style.visibility||'');e.style.visibility='hidden';n++}}return n})()"""

        private const val SHOW_FIXED_SCRIPT = """(function(){var all=document.querySelectorAll('[data-zen-capture-hidden]');
for(var i=0;i<all.length;i++){var e=all[i];e.style.visibility=e.getAttribute('data-zen-capture-hidden');e.removeAttribute('data-zen-capture-hidden')}return all.length})()"""

        fun parseMetrics(o: JSONObject): PageMetrics? {
            val vw = o.optDouble("vw", 0.0)
            val vh = o.optDouble("vh", 0.0)
            if (!(vw > 0) || !(vh > 0)) return null
            return PageMetrics(
                scrollX = o.optDouble("sx", 0.0),
                scrollY = o.optDouble("sy", 0.0),
                pageLeft = o.optDouble("px", 0.0),
                pageTop = o.optDouble("py", 0.0),
                viewportWidth = vw,
                viewportHeight = vh,
                documentWidth = o.optDouble("dw", vw),
                documentHeight = o.optDouble("dh", vh),
                rtl = o.optBoolean("rtl", false)
            )
        }

        /** A region argument from the core (`{ x, y, width, height }` in CSS page px), or null. */
        fun parseRegion(o: JSONObject?): Box? {
            if (o == null) return null
            val w = o.optDouble("width", 0.0)
            val h = o.optDouble("height", 0.0)
            if (!(w > 0) || !(h > 0)) return null
            return Box(o.optDouble("x", 0.0), o.optDouble("y", 0.0), w, h)
        }

        private fun rect(b: Box) = Rect(
            b.x.roundToInt(),
            b.y.roundToInt(),
            b.right.roundToInt(),
            b.bottom.roundToInt()
        )

        private fun rectF(b: Box) = RectF(b.x.toFloat(), b.y.toFloat(), b.right.toFloat(), b.bottom.toFloat())
    }
}
