package app.zen.chromium.ext

import android.content.Context
import android.view.MotionEvent
import android.webkit.WebView
import androidx.core.view.NestedScrollingChild3
import androidx.core.view.NestedScrollingChildHelper
import androidx.core.view.ViewCompat

/**
 * A WebView that takes part in nested scrolling, so a sheet's `BottomSheetBehavior` can tell a
 * page scroll from a drag of the sheet: the document scrolls while it can, and a pull past its
 * top moves the sheet (dismissing it when hideable). Without this the behaviour intercepts every
 * vertical drag over the WebView and the page never scrolls. Touch handling follows the
 * `NestedScrollingChild` recipe: each move is first offered to the parent (`dispatchNestedPreScroll`),
 * what the parent leaves goes to the WebView, and the parent's own offset is folded back into the
 * event coordinates so the finger stays put on the page while the sheet moves under it.
 */
open class NestedScrollWebView(context: Context) : WebView(context), NestedScrollingChild3 {
    private val helper = NestedScrollingChildHelper(this)
    private var lastY = 0
    private var nestedOffsetY = 0
    private val consumed = IntArray(2)
    private val offset = IntArray(2)

    init {
        isNestedScrollingEnabled = true
    }

    override fun onTouchEvent(ev: MotionEvent): Boolean {
        val event = MotionEvent.obtain(ev)
        try {
            val action = event.actionMasked
            if (action == MotionEvent.ACTION_DOWN) nestedOffsetY = 0
            val eventY = event.y.toInt()
            event.offsetLocation(0f, nestedOffsetY.toFloat())
            return when (action) {
                MotionEvent.ACTION_DOWN -> {
                    lastY = eventY
                    startNestedScroll(ViewCompat.SCROLL_AXIS_VERTICAL)
                    super.onTouchEvent(event)
                }
                MotionEvent.ACTION_MOVE -> {
                    var deltaY = lastY - eventY
                    if (dispatchNestedPreScroll(0, deltaY, consumed, offset)) {
                        deltaY -= consumed[1]
                        lastY = eventY - offset[1]
                        event.offsetLocation(0f, -offset[1].toFloat())
                        nestedOffsetY += offset[1]
                    } else {
                        lastY = eventY
                    }
                    val handled = super.onTouchEvent(event)
                    if (dispatchNestedScroll(0, offset[1], 0, deltaY, offset)) {
                        event.offsetLocation(0f, offset[1].toFloat())
                        nestedOffsetY += offset[1]
                        lastY -= offset[1]
                    }
                    handled
                }
                MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
                    stopNestedScroll()
                    super.onTouchEvent(event)
                }
                else -> super.onTouchEvent(event)
            }
        } finally {
            event.recycle()
        }
    }

    override fun setNestedScrollingEnabled(enabled: Boolean) {
        // Called from View's constructor before the helper exists; the helper is what makes it true.
        @Suppress("SENSELESS_COMPARISON")
        if (helper == null) return
        helper.isNestedScrollingEnabled = enabled
    }

    override fun isNestedScrollingEnabled(): Boolean = helper.isNestedScrollingEnabled

    override fun startNestedScroll(axes: Int): Boolean = helper.startNestedScroll(axes)

    override fun startNestedScroll(axes: Int, type: Int): Boolean = helper.startNestedScroll(axes, type)

    override fun stopNestedScroll() = helper.stopNestedScroll()

    override fun stopNestedScroll(type: Int) = helper.stopNestedScroll(type)

    override fun hasNestedScrollingParent(): Boolean = helper.hasNestedScrollingParent()

    override fun hasNestedScrollingParent(type: Int): Boolean = helper.hasNestedScrollingParent(type)

    override fun dispatchNestedScroll(
        dxConsumed: Int,
        dyConsumed: Int,
        dxUnconsumed: Int,
        dyUnconsumed: Int,
        offsetInWindow: IntArray?
    ): Boolean = helper.dispatchNestedScroll(dxConsumed, dyConsumed, dxUnconsumed, dyUnconsumed, offsetInWindow)

    override fun dispatchNestedScroll(
        dxConsumed: Int,
        dyConsumed: Int,
        dxUnconsumed: Int,
        dyUnconsumed: Int,
        offsetInWindow: IntArray?,
        type: Int
    ): Boolean = helper.dispatchNestedScroll(dxConsumed, dyConsumed, dxUnconsumed, dyUnconsumed, offsetInWindow, type)

    override fun dispatchNestedScroll(
        dxConsumed: Int,
        dyConsumed: Int,
        dxUnconsumed: Int,
        dyUnconsumed: Int,
        offsetInWindow: IntArray?,
        type: Int,
        consumed: IntArray
    ) = helper.dispatchNestedScroll(dxConsumed, dyConsumed, dxUnconsumed, dyUnconsumed, offsetInWindow, type, consumed)

    override fun dispatchNestedPreScroll(dx: Int, dy: Int, consumed: IntArray?, offsetInWindow: IntArray?): Boolean =
        helper.dispatchNestedPreScroll(dx, dy, consumed, offsetInWindow)

    override fun dispatchNestedPreScroll(dx: Int, dy: Int, consumed: IntArray?, offsetInWindow: IntArray?, type: Int): Boolean =
        helper.dispatchNestedPreScroll(dx, dy, consumed, offsetInWindow, type)

    override fun dispatchNestedFling(velocityX: Float, velocityY: Float, consumed: Boolean): Boolean =
        helper.dispatchNestedFling(velocityX, velocityY, consumed)

    override fun dispatchNestedPreFling(velocityX: Float, velocityY: Float): Boolean =
        helper.dispatchNestedPreFling(velocityX, velocityY)
}
