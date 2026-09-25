package app.zen.chromium

import android.annotation.SuppressLint
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Matrix
import android.os.Handler
import android.util.Log
import android.view.View
import android.view.ViewGroup
import android.widget.ImageView

/**
 * The restored tab's picture at a cold start (OS-26, after Chrome's StartupPaintPreview): the
 * card picture its page left on disk (Thumbnails, BH-33 – a card-width JPEG stamped with the
 * page's URL) drawn over the page view from the moment the core asks the view to load – under
 * the splash still, so it is there as the splash lifts – until the page's first paint
 * (`onPageCommitVisible`; `onPageFinished` for a document whose commit-visible never comes), a
 * touch, the view's end or [TIMEOUT_MS], whichever is first; then the bitmap goes.
 *
 * Two loads get one. The boot's restore: a `view.load` arriving before the chrome's READY is the
 * session coming back (`restoring`); a load after it is the user's, and a page left blank for a
 * moment then is the page's own look, as in Chrome. And a back/forward list restored under a
 * fresh view at any time (`view.restoreNavigation`, `restoredList`): the core creates a view
 * like that for a page it put to sleep and is showing again – a tab the sleep timer or memory
 * pressure discarded (OS-37), whose card picture is its last look – and for a reopened tab,
 * whose picture, if a file under its id exists at all, is checked against the URL like every
 * other. The file is read, its stamp checked against
 * the URL the view is loading (a picture of another page is never shown as this one's) and the
 * JPEG decoded on the pictures' own thread (Thumbnails.disk), RGB_565 – a page's picture has no
 * alpha, and half the bytes: a card-width picture is a few hundred KB; the main thread does one
 * `addView` and the bitmap's upload with the frame it first draws in. As a child of the page
 * view it lies where the view lies, shows when the view shows and is clipped to its corners.
 * Scaled to the view's width from the top-left, as the capture was of the slot: the card's
 * width against the slot's is the picture's softness, the price of a picture that costs no
 * capture of its own (a full-size picture would be a services change: the restore's own capture
 * at the page's last hide, its bytes budgeted beside the cards').
 */
class RestoredPictures(
    private val thumbnails: Thumbnails?,
    private val main: Handler,
    /** Whether the boot's restore is still in flight (before the chrome's READY). */
    private val restoring: () -> Boolean
) {
    private class Shown(val image: ImageView, val bitmap: Bitmap, val timeout: Runnable)

    private val shown = HashMap<String, Shown>()

    /**
     * The core asked `view` to load `url`: its picture from disk, if this is the boot's restore
     * or a list restored under the view (`restoredList`), and there is one.
     */
    fun offer(view: TabWebView, url: String, restoredList: Boolean = false) {
        val thumbs = thumbnails ?: return
        if (!wanted(restoredList, restoring(), view.hasPaintedDocument, shown.containsKey(view.tabId))) return
        val tabId = view.tabId
        thumbs.disk.execute {
            val picture = thumbs.loadPicture(tabId, url) ?: return@execute
            val options = BitmapFactory.Options().apply { inPreferredConfig = Bitmap.Config.RGB_565 }
            val bitmap = BitmapFactory.decodeByteArray(picture.jpeg, 0, picture.jpeg.size, options) ?: return@execute
            main.post { place(view, bitmap) }
        }
    }

    // The picture is not a control: the touch listener only takes it down and lets the event through.
    @SuppressLint("ClickableViewAccessibility")
    private fun place(view: TabWebView, bitmap: Bitmap) {
        // Decoded off the main thread: the page may have painted, or the tab gone, meanwhile.
        if (!wanted(true, false, view.hasPaintedDocument, shown.containsKey(view.tabId)) || view.parent == null) {
            bitmap.recycle()
            return
        }
        val tabId = view.tabId
        val image = ImageView(view.context).apply {
            setImageBitmap(bitmap)
            scaleType = ImageView.ScaleType.MATRIX
            importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
            // A touch is the user's: the picture goes, the event goes on to the page beneath.
            setOnTouchListener { _, _ ->
                release(tabId, "touch")
                false
            }
            addOnLayoutChangeListener { v, left, _, right, _, _, _, _, _ ->
                val width = right - left
                if (width > 0 && bitmap.width > 0 && !bitmap.isRecycled) {
                    val scale = width.toFloat() / bitmap.width
                    (v as ImageView).imageMatrix = Matrix().apply { setScale(scale, scale) }
                }
            }
        }
        val timeout = Runnable { release(tabId, "timeout") }
        view.addView(image, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        shown[tabId] = Shown(image, bitmap, timeout)
        view.onDocumentPainted = { release(tabId, "painted") }
        main.postDelayed(timeout, TIMEOUT_MS)
        Log.i(StartupSplash.TAG, "restored picture up for $tabId: ${bitmap.width}x${bitmap.height} ${bitmap.byteCount / 1024} KB")
    }

    /** The picture of `tabId` goes, if one is up; `why` for the log. */
    fun release(tabId: String, why: String) {
        val up = shown.remove(tabId) ?: return
        main.removeCallbacks(up.timeout)
        (up.image.parent as? TabWebView)?.let { it.onDocumentPainted = null; it.removeView(up.image) }
        up.image.setImageDrawable(null)
        up.bitmap.recycle()
        Log.i(StartupSplash.TAG, "restored picture down for $tabId: $why")
    }

    /** Memory pressure or the host's end: every picture goes. */
    fun releaseAll(why: String) {
        for (tabId in shown.keys.toList()) release(tabId, why)
    }

    /** Whether a picture is up over `tabId`'s view (the harness reads it). */
    fun isShowing(tabId: String): Boolean = shown.containsKey(tabId)

    companion object {
        /** A page that has not painted by then is not about to: the picture would be a lie standing. */
        const val TIMEOUT_MS = 10_000L

        /**
         * Whether a view gets a picture: for a list restored under it (a sleeping tab shown again)
         * or while the boot's restore is in flight, only over a view that has drawn no document
         * yet (a picture over a painted page would hide it), and one per tab.
         */
        fun wanted(restoredList: Boolean, restoring: Boolean, painted: Boolean, shown: Boolean): Boolean =
            (restoredList || restoring) && !painted && !shown
    }
}
