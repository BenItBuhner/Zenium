package app.zen.chromium

import android.os.Build
import android.view.InputDevice
import android.view.MotionEvent
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Android 14 hit-tests a mouse's button and wheel events at (x, x) (OS-12; `MouseRouting`):
 * which events the activity routes itself – that release, a pointer source, the three
 * non-hover generic actions – and the walk's geometry, the framework's own rules.
 */
class MouseRoutingTest {
    @Test
    fun aMousesButtonsAndWheelOnAndroid14AreRoutedByTheActivity() {
        val sdk34 = Build.VERSION_CODES.UPSIDE_DOWN_CAKE
        assertTrue(MouseRouting.misrouted(sdk34, InputDevice.SOURCE_MOUSE, MotionEvent.ACTION_BUTTON_PRESS))
        assertTrue(MouseRouting.misrouted(sdk34, InputDevice.SOURCE_MOUSE, MotionEvent.ACTION_BUTTON_RELEASE))
        assertTrue(MouseRouting.misrouted(sdk34, InputDevice.SOURCE_MOUSE, MotionEvent.ACTION_SCROLL))
        // A stylus's button is a pointer source too (a trackpad's pointer arrives as SOURCE_MOUSE).
        assertTrue(MouseRouting.misrouted(sdk34, InputDevice.SOURCE_STYLUS, MotionEvent.ACTION_BUTTON_PRESS))
    }

    @Test
    fun hoverTouchAndOtherReleasesGoTheFrameworksWay() {
        val sdk34 = Build.VERSION_CODES.UPSIDE_DOWN_CAKE
        assertFalse(MouseRouting.misrouted(sdk34, InputDevice.SOURCE_MOUSE, MotionEvent.ACTION_HOVER_ENTER))
        assertFalse(MouseRouting.misrouted(sdk34, InputDevice.SOURCE_MOUSE, MotionEvent.ACTION_HOVER_MOVE))
        assertFalse(MouseRouting.misrouted(sdk34, InputDevice.SOURCE_MOUSE, MotionEvent.ACTION_HOVER_EXIT))
        // DOWN / UP / MOVE are touch events – dispatchTouchEvent's, hit-tested right.
        assertFalse(MouseRouting.misrouted(sdk34, InputDevice.SOURCE_MOUSE, MotionEvent.ACTION_DOWN))
        assertFalse(MouseRouting.misrouted(sdk34, InputDevice.SOURCE_MOUSE, MotionEvent.ACTION_UP))
        // A joystick or a keyboard is no pointer source.
        assertFalse(MouseRouting.misrouted(sdk34, InputDevice.SOURCE_JOYSTICK, MotionEvent.ACTION_SCROLL))
        assertFalse(MouseRouting.misrouted(sdk34, InputDevice.SOURCE_KEYBOARD, MotionEvent.ACTION_BUTTON_PRESS))
        // Android 13 read the point right and Android 15 reads it right again.
        assertFalse(MouseRouting.misrouted(Build.VERSION_CODES.TIRAMISU, InputDevice.SOURCE_MOUSE, MotionEvent.ACTION_BUTTON_PRESS))
        assertFalse(MouseRouting.misrouted(Build.VERSION_CODES.VANILLA_ICE_CREAM, InputDevice.SOURCE_MOUSE, MotionEvent.ACTION_BUTTON_PRESS))
    }

    @Test
    fun thePointFallsInAChildByItsBoxAndTheParentsScroll() {
        // The page view of the 1100 x 760 tablet window: at (240, 56), 860 x 704.
        val page = intArrayOf(240, 56, 1100, 760)
        fun inPage(x: Float, y: Float, scrollX: Int = 0, scrollY: Int = 0) =
            MouseRouting.inChild(x, y, scrollX, scrollY, page[0], page[1], page[2], page[3])
        // The pill's click at (594, 28): above the page – the chrome's, not the page's.
        assertFalse(inPage(594f, 28f))
        // The framework's (x, x) for that click would have been inside the page.
        assertTrue(inPage(594f, 594f))
        assertTrue(inPage(240f, 56f))
        assertFalse(inPage(239.5f, 56f))
        assertFalse(inPage(1100f, 400f))
        assertTrue(inPage(1099.5f, 759.5f))
        assertFalse(inPage(500f, 760f))
        // A scrolled parent shifts the point by its scroll.
        assertTrue(inPage(200f, 30f, scrollX = 40, scrollY = 26))
    }

    @Test
    fun aMouseEventIsDispatchedAtItsCursorTheMeanOfItsPointers() {
        // A click or a wheel notch: one pointer, the cursor.
        assertEquals(594f, MouseRouting.dispatchCoordinate(InputDevice.SOURCE_MOUSE, 1, 594f) { error("unused") }, 0f)
        // A trackpad's three fingers spread around the cursor go to the cursor.
        val fingers = floatArrayOf(560f, 600f, 640f)
        assertEquals(600f, MouseRouting.dispatchCoordinate(InputDevice.SOURCE_MOUSE, 3, fingers[0]) { fingers[it] }, 0f)
        // A stylus's pointers are dispatched where the first one is.
        assertEquals(560f, MouseRouting.dispatchCoordinate(InputDevice.SOURCE_STYLUS, 3, fingers[0]) { fingers[it] }, 0f)
    }

    @Test
    fun childrenAreTriedLastDrawnFirstWithAHigherZAhead() {
        // Four children at Z 0: the last index first.
        assertEquals(listOf(3, 2, 1, 0), MouseRouting.hitOrder(4) { 0f })
        // An elevated second child is tried before the ones drawn after it.
        assertEquals(listOf(1, 3, 2, 0), MouseRouting.hitOrder(4) { if (it == 1) 8f else 0f })
        assertEquals(emptyList<Int>(), MouseRouting.hitOrder(0) { 0f })
    }
}
