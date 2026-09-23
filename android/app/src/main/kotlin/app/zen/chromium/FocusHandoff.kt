package app.zen.chromium

import android.graphics.Rect
import android.view.View
import android.view.ViewGroup
import android.webkit.WebView
import android.widget.FrameLayout

/**
 * Page-to-chrome Tab traversal for a hardware keyboard (A11Y-09's remainder). The page and the
 * chrome are two WebViews in one window, and each walks its own document: when Tab runs past a
 * document's last tabbable (Shift+Tab past its first) Chromium clears the document's focus and
 * asks the view for a neighbour – `AwWebContentsDelegateAdapter.takeFocus`, which tries the
 * view's `focusSearch` to the right (the left in RTL), then below, and requests the focus on
 * whatever it finds; finding nothing, it gives the same document the focus back, unplaced, so
 * the next Tab wraps to its first element. Nothing lies beside a page view geometrically (the
 * chrome's WebView is under it, the same rectangle), so on its own the keyboard never leaves
 * the page.
 *
 * These four one-pixel views are the neighbours the WebViews name (`nextFocusRightId` and the
 * others, which `focusSearch` honours before any geometry): a page's Tab lands on the one that
 * hands the chrome the focus forward, its Shift+Tab on the one that hands it backward, and the
 * chrome's Tab and Shift+Tab on the two that hand the page the focus. None ever holds the
 * focus: its [View.requestFocus] performs the handoff through [onLand] and reports the focus
 * taken, so Chromium leaves its document cleared instead of re-focusing it. The framework's own
 * search for a default focus (nothing focused, the window coming to the front) reaches these
 * too and is passed by: a handoff counts only while a WebView holds the focus, which is where
 * `takeFocus` runs from. The landing itself is the document's: the chrome reads its first or
 * last control off the host event, a page off the message its page script gets
 * (`@shared/focusEdge`, `TabWebView.focusEdge`).
 */
class FocusHandoff(private val root: ViewGroup, private val onLand: (Landing) -> Unit) {
    /** Where the keyboard goes: into the chrome at its first or last control, or into the page. */
    enum class Landing { CHROME_FIRST, CHROME_LAST, PAGE_FIRST, PAGE_LAST }

    private val toChromeForward = Neighbour(Landing.CHROME_FIRST)
    private val toChromeBackward = Neighbour(Landing.CHROME_LAST)
    private val toPageForward = Neighbour(Landing.PAGE_FIRST)
    private val toPageBackward = Neighbour(Landing.PAGE_LAST)

    init {
        // Under everything (index 0): a pixel that draws nothing and takes no touch.
        for (neighbour in listOf(toChromeForward, toChromeBackward, toPageForward, toPageBackward)) {
            root.addView(neighbour, 0, FrameLayout.LayoutParams(1, 1))
        }
    }

    /** A page's view: Tab past its last tabbable lands in the chrome, Shift+Tab past its first too. */
    fun wirePage(view: View) = wire(view, toChromeForward, toChromeBackward)

    /** The chrome's view: Tab past its last control lands in the page, Shift+Tab past its first too. */
    fun wireChrome(view: View) = wire(view, toPageForward, toPageBackward)

    /** A view leaving this window ([TabHost.release]): its neighbours are not in the next one. */
    fun unwire(view: View) {
        view.nextFocusRightId = View.NO_ID
        view.nextFocusLeftId = View.NO_ID
        view.nextFocusDownId = View.NO_ID
        view.nextFocusUpId = View.NO_ID
    }

    /**
     * Chromium asks to the right for a Tab and to the left for a Shift+Tab under a left-to-right
     * layout, the other way round under a right-to-left one, and below or above when the sides
     * give nothing: all four named, so the answer is the same whichever it asks first.
     */
    private fun wire(view: View, forward: View, backward: View) {
        val rtl = root.resources.configuration.layoutDirection == View.LAYOUT_DIRECTION_RTL
        view.nextFocusRightId = (if (rtl) backward else forward).id
        view.nextFocusLeftId = (if (rtl) forward else backward).id
        view.nextFocusDownId = forward.id
        view.nextFocusUpId = backward.id
    }

    private inner class Neighbour(private val landing: Landing) : View(root.context) {
        init {
            id = generateViewId()
            isFocusable = true
            // FocusFinder passes a neighbour by that is not focusable in touch mode while the
            // device is in it; the keyboard's Tab leaves touch mode, but a first Tab may not have yet.
            isFocusableInTouchMode = true
            isClickable = false
            importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO
        }

        /**
         * Reached by name only: left out of the list a focus search by geometry works from, so a
         * native control elsewhere in the window (a prompt's button) never finds a pixel in the
         * corner as its nearest neighbour.
         */
        override fun addFocusables(views: ArrayList<View>?, direction: Int, focusableMode: Int) {}

        override fun requestFocus(direction: Int, previouslyFocusedRect: Rect?): Boolean {
            if (root.findFocus() !is WebView) return false
            onLand(landing)
            return true
        }
    }
}
