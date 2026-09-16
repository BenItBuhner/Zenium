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
 * screen, nothing painted yet).
 */
class PageCapture(
    private val view: WebView,
    private val window: Window,
    private val encoder: Executor
) {
    private val main = Handler(Looper.getMainLooper())

    fun run(mode: String, region: Box?, format: String, callback: (JSONObject?) -> Unit) {
        if (view.width <= 0 || view.height <= 0 || !view.isShown) {
            callback(null)
            return
        }
        if (mode == CapturePlan.MODE_VIEWPORT) {
            copyView { bitmap -> if (bitmap == null) callback(null) else encode(bitmap, format, callback) }
            return
        }
        readMetrics { metrics ->
            if (metrics == null) {
                // No page script access (about:blank before anything ran, a crashed renderer): the
                // viewport is still worth returning.
                copyView { bitmap -> if (bitmap == null) callback(null) else encode(bitmap, format, callback) }
                return@readMetrics
            }
            Stitch(mode, region, format, metrics, callback).start()
        }
    }

    /** One stitched capture: a chain of scroll → wait → copy → blit steps ending in `finish`. */
    private inner class Stitch(
        mode: String,
        region: Box?,
        private val format: String,
        private val metrics: PageMetrics,
        private val callback: (JSONObject?) -> Unit
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
                view.evaluateJavascript(scrollScript(cell.first, cell.second)) {
                    awaitFrames(SETTLE_FRAMES) {
                        readMetrics { now ->
                            if (done) return@readMetrics
                            // Where the page actually ended up decides where the strip is blitted.
                            copyStrip(now?.visible ?: Box(cell.first, cell.second, metrics.viewportWidth, metrics.viewportHeight))
                        }
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
                val t = target
                if (bitmap != null && t != null) {
                    CapturePlan.blit(strip, t, deviceScale, outputScale)?.let { b ->
                        canvas?.drawBitmap(bitmap, rect(b.src), rectF(b.dst), paint)
                    }
                    bitmap.recycle()
                }
                step()
            }
        }

        private fun finish() {
            if (done) return
            done = true
            main.removeCallbacks(watchdog)
            if (cells.size > 1) {
                view.isVerticalScrollBarEnabled = verticalBar
                view.isHorizontalScrollBarEnabled = horizontalBar
            }
            if (hidFixed) view.evaluateJavascript(SHOW_FIXED_SCRIPT, null)
            if (scrolled) view.evaluateJavascript(scrollScript(metrics.scrollX, metrics.scrollY), null)
            val bitmap = output
            output = null
            canvas = null
            if (bitmap == null) callback(null) else encode(bitmap, format, callback)
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

    private fun encode(bitmap: Bitmap, format: String, callback: (JSONObject?) -> Unit) {
        encoder.execute {
            val png = format == "png"
            val out = ByteArrayOutputStream()
            val ok = runCatching {
                if (png) bitmap.compress(Bitmap.CompressFormat.PNG, 100, out)
                else bitmap.compress(Bitmap.CompressFormat.JPEG, JPEG_QUALITY, out)
            }.getOrDefault(false)
            val result = if (ok) json(
                "data" to Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP),
                "mimeType" to if (png) "image/png" else "image/jpeg",
                "width" to bitmap.width,
                "height" to bitmap.height
            ) else null
            bitmap.recycle()
            main.post { callback(result) }
        }
    }

    companion object {
        private const val TAG = "ZenCapture"
        private const val JPEG_QUALITY = 75
        /** Frames to let the WebView paint a new scroll position before its pixels are copied. */
        private const val SETTLE_FRAMES = 3
        private const val WATCHDOG_MS = 20_000L

        private const val METRICS_SCRIPT = """(function(){var v=window.visualViewport,d=document.documentElement,b=document.body;
return {sx:window.scrollX,sy:window.scrollY,px:v?v.pageLeft:window.scrollX,py:v?v.pageTop:window.scrollY,
vw:v?v.width:window.innerWidth,vh:v?v.height:window.innerHeight,
dw:Math.max(d?d.scrollWidth:0,b?b.scrollWidth:0,window.innerWidth),dh:Math.max(d?d.scrollHeight:0,b?b.scrollHeight:0,window.innerHeight)}})()"""

        private const val HIDE_FIXED_SCRIPT = """(function(){var all=document.querySelectorAll('body *'),n=0;
for(var i=0;i<all.length&&i<30000;i++){var e=all[i];if(getComputedStyle(e).position==='fixed'&&!e.hasAttribute('data-zen-capture-hidden')){
e.setAttribute('data-zen-capture-hidden',e.style.visibility||'');e.style.visibility='hidden';n++}}return n})()"""

        private const val SHOW_FIXED_SCRIPT = """(function(){var all=document.querySelectorAll('[data-zen-capture-hidden]');
for(var i=0;i<all.length;i++){var e=all[i];e.style.visibility=e.getAttribute('data-zen-capture-hidden');e.removeAttribute('data-zen-capture-hidden')}return all.length})()"""

        private fun scrollScript(x: Double, y: Double): String =
            "window.scrollTo({left:${x.roundToInt()},top:${y.roundToInt()},behavior:'instant'})"

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
                documentHeight = o.optDouble("dh", vh)
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
