package app.zen.chromium

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Rect
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Base64
import android.util.Log
import android.view.PixelCopy
import java.io.ByteArrayOutputStream
import java.util.concurrent.ExecutorService
import org.json.JSONObject

/**
 * The picture of a page the chrome draws itself – Settings (`render: 'chrome'`), a tab with no
 * [TabWebView] whose window to copy. The core asks for it (`chrome.snapshot`, its
 * `WindowHost.snapshotChrome`) where it asks for a page's cover – as a sheet or the overview is
 * about to hide the page, and once the page's route has settled after a change
 * (`zen://settings/privacy` → `zen://settings/privacy/site-data`) – and is answered with a copy
 * of the window where the content area is: the cover the overview's card swaps in for the page
 * (a JPEG data URL at the copy's size, as [TabWebView.snapshot] answers one), and the card picture
 * scaled from the same copy, written to disk under the tab's address ([Thumbnails.save]: the
 * stamp `thumbnail.load` compares) – so the card of a Settings tab shows the section or the
 * drill-in page the tab is on, in the overview and after a relaunch, as a page's card shows its
 * page. Nothing of the tab's state lives here: the core says which tab, at which address, and
 * raises `thumbnail.captured` to the chrome itself, while the tab is still at that address.
 *
 * The copy is of the window ([PixelCopy], as a page's is): the area is the content frame the
 * chrome reported (CSS px at the display's density, offset by where the chrome view lies in the
 * window), clipped to the view ([frame]); nothing else of the window is in it. Taken at a page's
 * scale ([coverScale]: half, or 1400 px at most) in RGB_565. The card's freshness rule holds here
 * as it does for a page ([Thumbnails.fresh]): a second copy within a frame of the first answers
 * the cover alone and no card; the chrome's `thumbnail.drop` on the tab's navigation resets it.
 * The card's scaling, encode and write run on the pictures' thread ([Thumbnails.disk]), the
 * cover's encode on the host's io pool; the one answer goes out on the main thread once both are
 * in. A private tab's card is answered and never written (`persist` false).
 */
class ChromePageSnapshot(private val host: Host, private val io: ExecutorService) {
    /**
     * `chrome.snapshot { tabId, url, area, persist }` → `{ cover, card }` or null (nothing on
     * screen to copy, or the window refused). Main thread; `reply` on it.
     */
    fun take(args: JSONObject, reply: (Any?) -> Unit) {
        val tabId = args.str("tabId")
        val url = args.str("url")
        val persist = args.bool("persist", true)
        val view = host.chrome
        if (tabId.isEmpty() || url.isEmpty() || view.width <= 0 || view.height <= 0 || !view.isShown) {
            reply(null)
            return
        }
        val location = IntArray(2)
        view.getLocationInWindow(location)
        val density = host.activity.resources.displayMetrics.density
        val frame = frame(Area.of(args.optJSONObject("area")), density, location[0], location[1], view.width, view.height)
        if (frame == null) {
            reply(null)
            return
        }
        val bitmap = Bitmap.createBitmap(frame.scaledWidth, frame.scaledHeight, Bitmap.Config.RGB_565)
        val asked = SystemClock.uptimeMillis()
        val main = Handler(Looper.getMainLooper())
        val copied: (Boolean) -> Unit = { ok ->
            if (ok) publish(tabId, url, persist, bitmap, SystemClock.uptimeMillis() - asked, main, reply) else reply(null)
        }
        try {
            PixelCopy.request(host.activity.window, Rect(frame.left, frame.top, frame.right, frame.bottom), bitmap, { result ->
                copied(result == PixelCopy.SUCCESS)
            }, main)
        } catch (e: Exception) {
            // Software fallback (the window without a surface yet): the chrome view drawn at the
            // copy's scale, the area's corner at the bitmap's.
            val drawn = runCatching {
                val canvas = Canvas(bitmap)
                canvas.scale(frame.scale, frame.scale)
                canvas.translate((location[0] - frame.left).toFloat(), (location[1] - frame.top).toFloat())
                view.draw(canvas)
            }.isSuccess
            copied(drawn)
        }
    }

    /**
     * The two pictures out of one copy: the cover first (the chrome mounts its card on it), the
     * card picture on the pictures' thread – under the freshness rule, and on disk only when
     * `persist` says so – and the one answer once both are in.
     */
    private fun publish(tabId: String, url: String, persist: Boolean, bitmap: Bitmap, copyMs: Long, main: Handler, reply: (Any?) -> Unit) {
        val answer = Answer(reply)
        io.execute {
            val out = ByteArrayOutputStream()
            val ok = runCatching { bitmap.compress(Bitmap.CompressFormat.JPEG, COVER_QUALITY, out) }.getOrDefault(false)
            val data = if (ok) "data:image/jpeg;base64," + Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP) else null
            main.post { answer.cover(data) }
        }
        val thumbnails = host.thumbnails
        val now = SystemClock.uptimeMillis()
        if (thumbnails.fresh(tabId, now)) {
            answer.card(null)
            return
        }
        thumbnails.taken(tabId, now)
        val cardWidth = thumbnails.width
        thumbnails.disk.execute {
            val started = SystemClock.uptimeMillis()
            val picture = Thumbnails.encode(bitmap, cardWidth)
            val saved = picture != null && (!persist || thumbnails.save(tabId, picture.jpeg, url))
            if (BuildConfig.DEBUG && picture != null) {
                Log.d(
                    TAG,
                    "chrome page picture of $tabId: ${picture.width}x${picture.height} ${picture.jpeg.size} bytes, " +
                        "copy $copyMs ms, encode and save ${SystemClock.uptimeMillis() - started} ms, " +
                        if (persist) "on disk $saved" else "not written (private)"
                )
            }
            main.post {
                // A picture that could not be encoded or written does not count as taken.
                if (picture == null || !saved) {
                    thumbnails.stale(tabId)
                    answer.card(null)
                    return@post
                }
                answer.card(json("data" to picture.dataUrl, "width" to picture.width, "height" to picture.height))
            }
        }
    }

    /** The two halves of one answer, each from its own thread; replied once both are in. Main thread. */
    private class Answer(private val reply: (Any?) -> Unit) {
        private var cover: String? = null
        private var coverIn = false
        private var card: JSONObject? = null
        private var cardIn = false

        fun cover(data: String?) {
            cover = data
            coverIn = true
            settle()
        }

        fun card(picture: JSONObject?) {
            card = picture
            cardIn = true
            settle()
        }

        private fun settle() {
            if (!coverIn || !cardIn) return
            val data = cover
            reply(if (data == null) null else json("cover" to data, "card" to card))
        }
    }

    /** The content area as the chrome reported it: CSS px, window coordinates (`Rect` in `shared/types.ts`). */
    class Area(val x: Double, val y: Double, val width: Double, val height: Double) {
        companion object {
            /** `{ x, y, width, height }`, or null for no area (the whole view is the copy then). */
            fun of(json: JSONObject?): Area? {
                if (json == null) return null
                return Area(json.num("x"), json.num("y"), json.num("width"), json.num("height"))
            }
        }
    }

    /** Where the copy is taken (window px, the view's edges at most) and the scale it is taken at. */
    class Frame(val left: Int, val top: Int, val right: Int, val bottom: Int, val scale: Float) {
        val width: Int get() = right - left
        val height: Int get() = bottom - top
        val scaledWidth: Int get() = (width * scale).toInt().coerceAtLeast(1)
        val scaledHeight: Int get() = (height * scale).toInt().coerceAtLeast(1)

        override fun equals(other: Any?): Boolean =
            other is Frame && other.left == left && other.top == top && other.right == right && other.bottom == bottom && other.scale == scale

        override fun hashCode(): Int = (((left * 31 + top) * 31 + right) * 31 + bottom) * 31 + scale.hashCode()

        override fun toString(): String = "Frame($left, $top, $right, $bottom @ $scale)"
    }

    companion object {
        private const val TAG = "ZenChromePage"

        /** The cover's JPEG quality, the page cover's own ([TabWebView.snapshot]). */
        const val COVER_QUALITY = 62

        /** The widest a copy is taken: a page cover's ceiling ([TabWebView]'s `coverScale`). */
        const val COVER_MAX_WIDTH = 1400

        /** The scale a copy `width` px wide is taken at: half, or [COVER_MAX_WIDTH] at most. */
        fun coverScale(width: Int): Float = if (width > COVER_MAX_WIDTH) COVER_MAX_WIDTH.toFloat() / width else 0.5f

        /**
         * The window rectangle of the content area `area` on a chrome view `viewWidth` × `viewHeight`
         * px whose top left is at (`viewLeft`, `viewTop`) in the window, at `density` – the area's
         * CSS px to device px as the host lays a page view out by them ([TabHost.setBounds]: the
         * product's integer part), offset by the view's place, clipped to the view – and the scale
         * the copy is taken at. No area: the whole view. Null for an area with nothing of the view
         * in it (a stale frame from a window that is gone).
         */
        fun frame(area: Area?, density: Float, viewLeft: Int, viewTop: Int, viewWidth: Int, viewHeight: Int): Frame? {
            if (viewWidth <= 0 || viewHeight <= 0) return null
            val viewRight = viewLeft + viewWidth
            val viewBottom = viewTop + viewHeight
            val left: Int
            val top: Int
            val right: Int
            val bottom: Int
            if (area == null) {
                left = viewLeft
                top = viewTop
                right = viewRight
                bottom = viewBottom
            } else {
                val x = (area.x * density).toInt()
                val y = (area.y * density).toInt()
                val w = (area.width * density).toInt().coerceAtLeast(0)
                val h = (area.height * density).toInt().coerceAtLeast(0)
                left = (viewLeft + x).coerceIn(viewLeft, viewRight)
                top = (viewTop + y).coerceIn(viewTop, viewBottom)
                right = (viewLeft + x + w).coerceIn(viewLeft, viewRight)
                bottom = (viewTop + y + h).coerceIn(viewTop, viewBottom)
            }
            if (right <= left || bottom <= top) return null
            return Frame(left, top, right, bottom, coverScale(right - left))
        }
    }
}
