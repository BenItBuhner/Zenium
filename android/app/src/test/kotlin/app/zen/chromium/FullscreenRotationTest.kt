package app.zen.chromium

import android.content.pm.ActivityInfo
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * MED-02: the screen held in a fullscreen video's orientation follows the device again once the
 * device has itself turned to match, so the turn back turns the screen and the page leaves the
 * fullscreen; released to the system at the exit.
 */
class FullscreenRotationTest {
    private val applied = mutableListOf<Int>()
    private val scheduled = mutableListOf<Pair<Long, () -> Unit>>()
    private var cancelled = 0
    private val rotation = FullscreenRotation(
        schedule = { delay, block ->
            val entry = delay to block
            scheduled += entry
            val cancel: () -> Unit = {
                if (scheduled.remove(entry)) cancelled++
            }
            cancel
        },
        apply = { applied += it }
    )

    /** The delay runs out: every scheduled block runs. */
    private fun elapse() {
        val due = scheduled.toList()
        scheduled.clear()
        due.forEach { it.second() }
    }

    @Test
    fun theHoldFollowsTheDeviceOnceItHasTurnedToMatchAndStayed() {
        rotation.hold(ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE)
        assertEquals(FullscreenRotation.Phase.HELD, rotation.phase)
        assertEquals(listOf(ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE), applied)
        // The user watches sideways with the phone upright: nothing.
        rotation.onDevice(false)
        assertTrue(scheduled.isEmpty())
        // The phone turns to landscape: the release is scheduled, not yet applied.
        rotation.onDevice(true)
        assertEquals(1, scheduled.size)
        assertEquals(FullscreenRotation.LOCK_TO_ANY_DELAY_MS, scheduled[0].first)
        assertEquals(FullscreenRotation.Phase.HELD, rotation.phase)
        // More of the same word schedules nothing more.
        rotation.onDevice(true)
        assertEquals(1, scheduled.size)
        elapse()
        assertEquals(FullscreenRotation.Phase.FOLLOWING, rotation.phase)
        assertEquals(listOf(ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE, ActivityInfo.SCREEN_ORIENTATION_FULL_SENSOR), applied)
        assertEquals(ActivityInfo.SCREEN_ORIENTATION_FULL_SENSOR, FullscreenRotation.FOLLOW_DEVICE)
        // Following, the device's word is the system's business.
        rotation.onDevice(false)
        assertTrue(scheduled.isEmpty())
        assertEquals(2, applied.size)
    }

    @Test
    fun aTurnAwayBeforeTheDelayCancelsTheRelease() {
        rotation.hold(ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE)
        rotation.onDevice(true)
        rotation.onDevice(null)
        assertEquals(1, cancelled)
        assertTrue(scheduled.isEmpty())
        assertEquals(FullscreenRotation.Phase.HELD, rotation.phase)
        rotation.onDevice(true)
        rotation.onDevice(false)
        assertEquals(2, cancelled)
        elapse()
        assertEquals(FullscreenRotation.Phase.HELD, rotation.phase)
        assertEquals(1, applied.size)
    }

    @Test
    fun theExitReleasesTheScreenToTheSystemAndForgetsAReleaseUnderWay() {
        rotation.hold(ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE)
        rotation.onDevice(true)
        rotation.release()
        assertEquals(1, cancelled)
        assertEquals(FullscreenRotation.Phase.OFF, rotation.phase)
        assertEquals(listOf(ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE, FullscreenOrientation.RELEASED), applied)
        // A release with nothing held writes nothing.
        rotation.release()
        assertEquals(2, applied.size)
        // The device's word with nothing held is nobody's.
        rotation.onDevice(true)
        assertTrue(scheduled.isEmpty())
        // Following, then the exit: the system's word again.
        rotation.hold(ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE)
        rotation.onDevice(true)
        elapse()
        assertEquals(FullscreenRotation.Phase.FOLLOWING, rotation.phase)
        rotation.release()
        assertEquals(FullscreenRotation.Phase.OFF, rotation.phase)
        assertEquals(FullscreenOrientation.RELEASED, applied.last())
    }

    @Test
    fun aNewHoldForgetsAReleaseUnderWay() {
        rotation.hold(ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE)
        rotation.onDevice(true)
        rotation.hold(ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE)
        assertEquals(1, cancelled)
        assertTrue(scheduled.isEmpty())
        assertEquals(FullscreenRotation.Phase.HELD, rotation.phase)
    }

    @Test
    fun theSensorsDegreesReadAsTheDevicesWayUp() {
        // A phone (natural portrait): sideways within 23° is landscape, upright within 23° is not.
        assertEquals(true, FullscreenRotation.deviceLandscape(90, naturalLandscape = false))
        assertEquals(true, FullscreenRotation.deviceLandscape(270, naturalLandscape = false))
        assertEquals(true, FullscreenRotation.deviceLandscape(90 + 23, naturalLandscape = false))
        assertEquals(true, FullscreenRotation.deviceLandscape(270 - 23, naturalLandscape = false))
        assertEquals(false, FullscreenRotation.deviceLandscape(0, naturalLandscape = false))
        assertEquals(false, FullscreenRotation.deviceLandscape(350, naturalLandscape = false))
        assertEquals(false, FullscreenRotation.deviceLandscape(180, naturalLandscape = false))
        // The diagonal is neither; a device flat (-1) says nothing.
        assertNull(FullscreenRotation.deviceLandscape(45, naturalLandscape = false))
        assertNull(FullscreenRotation.deviceLandscape(135, naturalLandscape = false))
        assertNull(FullscreenRotation.deviceLandscape(-1, naturalLandscape = false))
        // A tablet (natural landscape): upright is landscape, sideways is not.
        assertEquals(true, FullscreenRotation.deviceLandscape(0, naturalLandscape = true))
        assertEquals(false, FullscreenRotation.deviceLandscape(90, naturalLandscape = true))
        assertEquals(23, FullscreenRotation.TOLERANCE_DEGREES)
        assertEquals(400L, FullscreenRotation.LOCK_TO_ANY_DELAY_MS)
    }
}
