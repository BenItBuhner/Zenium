package app.zen.chromium

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The `accessibility` payload the chrome reads at boot and on each change (A11Y-04): the touch
 * exploration flag as the manager reports it and the font scale as a finite positive factor.
 */
class AccessibilityStateTest {
    @Test
    fun theDeviceStateTravelsAsIs() {
        val payload = AccessibilityState.payload(touchExploration = true, fontScale = 1.3f)
        assertTrue(payload.getBoolean("touchExploration"))
        assertEquals(1.3, payload.getDouble("fontScale"), 1e-6)
    }

    @Test
    fun theDefaultSizeWithNoServiceIsTheRestingState() {
        val payload = AccessibilityState.payload(touchExploration = false, fontScale = 1f)
        assertFalse(payload.getBoolean("touchExploration"))
        assertEquals(1.0, payload.getDouble("fontScale"), 0.0)
    }

    @Test
    fun aFontScaleThatMeansNothingReadsAsTheDefaultSize() {
        assertEquals(1.0, AccessibilityState.fontScaleOf(0f), 0.0)
        assertEquals(1.0, AccessibilityState.fontScaleOf(-1f), 0.0)
        assertEquals(1.0, AccessibilityState.fontScaleOf(Float.NaN), 0.0)
        assertEquals(1.0, AccessibilityState.fontScaleOf(Float.POSITIVE_INFINITY), 0.0)
        assertEquals(0.85, AccessibilityState.fontScaleOf(0.85f), 1e-6)
        assertEquals(2.0, AccessibilityState.fontScaleOf(2f), 0.0)
    }
}
