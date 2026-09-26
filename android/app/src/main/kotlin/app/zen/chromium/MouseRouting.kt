package app.zen.chromium

import android.graphics.Matrix
import android.os.Build
import android.view.InputDevice
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.webkit.WebView

/**
 * A mouse's buttons and wheel in a desktop window on Android 14 (OS-12). Android 14's
 * `ViewGroup.dispatchGenericPointerEvent` (`android/view/ViewGroup.java:2538-2539` in the API 34
 * sources) reads the point it hit-tests its children at as
 * `x = event.getXDispatchLocation(0); y = event.getXDispatchLocation(0)` – Y from X – so a
 * non-hover pointer event (`ACTION_BUTTON_PRESS`, `ACTION_BUTTON_RELEASE`, `ACTION_SCROLL`) at
 * (x, y) goes to the child under (x, x), at every level of the tree: the decor, the content
 * frame, the shell, the root. Android 15 reads `getYDispatchLocation` (`:2542-2543`); the
 * touch path a mouse's DOWN / UP / MOVE take and the hover path are right on both. Chromium
 * makes `mousedown` / `mouseup` from BUTTON_PRESS / RELEASE alone (its `EventForwarder`
 * consumes DOWN / UP as no-ops), so on Android 14 a click in the toolbar with the page view to
 * the right of the sidebar lands in the page whenever (x, x) does, and a click on the page's
 * right lands in the chrome – the sidebar, whose x is under the page's left edge, is the only
 * part that works. Real Android 14 devices carry the same code (a Samsung tablet under DeX on
 * One UI 6), so on SDK 34 [MainActivity] routes those three actions itself, from the decor down,
 * with the point read right – the same walk the framework makes (children back to front by
 * their Z and drawing order, the visible or animating ones, the point in the child's own
 * coordinates through its matrix), through our own groups down to the leaf. A WebView is a
 * leaf here: its children are Chromium's zero-sized anchor views, never under a point, so its
 * own buggy level is harmless.
 */
object MouseRouting {
    /**
     * Whether the framework would hit-test this event at the wrong point: SDK 34, a pointer
     * source (a mouse, a trackpad, a stylus) and one of the three non-hover generic actions.
     * Everything else – another release, a hover, a touch, a joystick – is left to the framework.
     */
    fun misrouted(sdk: Int, source: Int, actionMasked: Int): Boolean =
        sdk == Build.VERSION_CODES.UPSIDE_DOWN_CAKE &&
            (source and InputDevice.SOURCE_CLASS_POINTER) == InputDevice.SOURCE_CLASS_POINTER &&
            (
                actionMasked == MotionEvent.ACTION_BUTTON_PRESS ||
                    actionMasked == MotionEvent.ACTION_BUTTON_RELEASE ||
                    actionMasked == MotionEvent.ACTION_SCROLL
                )

    /**
     * Whether a point (`x`, `y`) in a group scrolled by (`scrollX`, `scrollY`) falls in a child
     * laid out at `left`..`right` × `top`..`bottom` – the framework's `pointInView` after
     * `transformPointToViewLocal` for a child with an identity matrix (`ViewGroup.java:3047-3071`).
     */
    fun inChild(x: Float, y: Float, scrollX: Int, scrollY: Int, left: Int, top: Int, right: Int, bottom: Int): Boolean {
        val localX = x + scrollX - left
        val localY = y + scrollY - top
        return localX >= 0f && localX < (right - left) && localY >= 0f && localY < (bottom - top)
    }

    /**
     * The order the framework hit-tests a group's children in – the last drawn first: a child
     * with a higher Z (elevation + translationZ) ahead of a lower one, ties from the last index
     * down (`buildOrderedChildList`, then the loop from the end). The index is the drawing
     * position: no group on the decor-to-page path customises its children's drawing order.
     */
    fun hitOrder(count: Int, z: (Int) -> Float): List<Int> =
        (0 until count).sortedWith(compareByDescending<Int> { z(it) }.thenByDescending { it })

    /** [misrouted] for a live event on this device. */
    fun misrouted(event: MotionEvent): Boolean = misrouted(Build.VERSION.SDK_INT, event.source, event.actionMasked)

    /**
     * Dispatches `event` (in `group`'s coordinates) to the child under its point, walking our
     * own groups down to the leaf; false when no child took it. Called on the main thread.
     */
    fun dispatch(group: ViewGroup, event: MotionEvent): Boolean {
        val count = group.childCount
        if (count == 0) return false
        val x = dispatchX(event)
        val y = dispatchY(event)
        val order = hitOrder(count) { group.getChildAt(it).z }
        for (index in order) {
            val child = group.getChildAt(index)
            if (child.visibility != View.VISIBLE && child.animation == null) continue
            val matrix = child.matrix
            if (matrix.isIdentity) {
                if (!inChild(x, y, group.scrollX, group.scrollY, child.left, child.top, child.right, child.bottom)) continue
                val offsetX = (group.scrollX - child.left).toFloat()
                val offsetY = (group.scrollY - child.top).toFloat()
                event.offsetLocation(offsetX, offsetY)
                try {
                    if (deliver(child, event)) return true
                } finally {
                    event.offsetLocation(-offsetX, -offsetY)
                }
            } else {
                val inverse = Matrix()
                if (!matrix.invert(inverse)) continue
                val point = floatArrayOf(x + group.scrollX - child.left, y + group.scrollY - child.top)
                inverse.mapPoints(point)
                if (point[0] < 0f || point[0] >= child.width || point[1] < 0f || point[1] >= child.height) continue
                val transformed = MotionEvent.obtain(event)
                transformed.offsetLocation((group.scrollX - child.left).toFloat(), (group.scrollY - child.top).toFloat())
                transformed.transform(inverse)
                try {
                    if (deliver(child, transformed)) return true
                } finally {
                    transformed.recycle()
                }
            }
        }
        return false
    }

    /**
     * The coordinate the framework dispatches a pointer event at (`getXDispatchLocation`): a
     * mouse event's cursor position – a trackpad's fingers all go to the cursor – else the first
     * pointer's. The cursor position is hidden API (`getXCursorPosition` is `@hide`), so this is
     * the framework's own value of it: the mean of the event's pointers
     * (`MotionEvent.updateCursorPosition`, `MotionEvent.java:3844-3864`), which a single-pointer
     * event – a mouse's click, a wheel notch, a trackpad's two-finger scroll – makes the pointer
     * itself. Offsets and transforms move the pointers and the cursor position alike.
     */
    fun dispatchCoordinate(source: Int, pointerCount: Int, first: Float, coordinate: (Int) -> Float): Float {
        if (pointerCount <= 1 || (source and InputDevice.SOURCE_MOUSE) != InputDevice.SOURCE_MOUSE) return first
        var sum = 0f
        for (index in 0 until pointerCount) sum += coordinate(index)
        return sum / pointerCount
    }

    private fun dispatchX(event: MotionEvent): Float =
        dispatchCoordinate(event.source, event.pointerCount, event.x) { event.getX(it) }

    private fun dispatchY(event: MotionEvent): Float =
        dispatchCoordinate(event.source, event.pointerCount, event.y) { event.getY(it) }

    /**
     * A group of ours or the framework's is walked on (its own generic-motion handling is a
     * no-op for these actions); a WebView or a plain view takes the event itself.
     */
    private fun deliver(child: View, event: MotionEvent): Boolean =
        if (child is ViewGroup && child !is WebView && child.childCount > 0) {
            dispatch(child, event)
        } else {
            child.dispatchGenericMotionEvent(event)
        }
}
