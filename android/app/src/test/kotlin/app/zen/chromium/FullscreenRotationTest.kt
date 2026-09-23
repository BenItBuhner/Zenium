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
    private val schedule: (Long, () -> Unit) -> (() -> Unit) = { delay, block ->
        val entry = delay to block
        scheduled += entry
        val cancel: () -> Unit = {
            if (scheduled.remove(entry)) cancelled++
        }
        cancel
    }
    /** A phone's window: the hold is handed over (the default). */
    private val rotation = FullscreenRotation(schedule = schedule, apply = { applied += it })

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

    /**
     * A tablet's window (600 dp or more on the short side, [ScreenClass]; the host's word false):
     * the hold itself stands (MED-01), but the turn of the device hands nothing over – the screen
     * stays held until the exit releases it, as Chrome's phone-only lock leaves a tablet's alone.
     */
    @Test
    fun inATabletsWindowTheHeldScreenIsNeverHandedToTheDevice() {
        val tablet = FullscreenRotation(schedule = schedule, apply = { applied += it }, handsOver = { false })
        tablet.hold(ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE)
        assertEquals(FullscreenRotation.Phase.HELD, tablet.phase)
        assertEquals(listOf(ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE), applied)
        // The tablet turns to landscape and stays: no delay, no following.
        tablet.onDevice(true)
        assertTrue(scheduled.isEmpty())
        tablet.onDevice(true)
        elapse()
        assertEquals(FullscreenRotation.Phase.HELD, tablet.phase)
        assertEquals(1, applied.size)
        // The exit releases the screen as on a phone.
        tablet.release()
        assertEquals(FullscreenRotation.Phase.OFF, tablet.phase)
        assertEquals(listOf(ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE, FullscreenOrientation.RELEASED), applied)
    }

    /**
     * The word is read live: a phone's screen grown past the line mid-hold (a fold opened, a
     * floating window widened – never a split, which leaves the display's class in place) drops
     * the hand-over under way; narrowed back under it, the next word from the device starts it
     * again (the sensor a phone's hold started keeps speaking, so the host's wiring does the same).
     */
    @Test
    fun aWindowGrownPastTheLineDropsAHandOverUnderWay() {
        var phone = true
        val window = FullscreenRotation(schedule = schedule, apply = { applied += it }, handsOver = { phone })
        window.hold(ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE)
        window.onDevice(true)
        assertEquals(1, scheduled.size)
        phone = false
        window.onDevice(true)
        assertEquals(1, cancelled)
        assertTrue(scheduled.isEmpty())
        elapse()
        assertEquals(FullscreenRotation.Phase.HELD, window.phase)
        assertEquals(1, applied.size)
        phone = true
        window.onDevice(true)
        assertEquals(1, scheduled.size)
        elapse()
        assertEquals(FullscreenRotation.Phase.FOLLOWING, window.phase)
        assertEquals(ActivityInfo.SCREEN_ORIENTATION_FULL_SENSOR, applied.last())
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
