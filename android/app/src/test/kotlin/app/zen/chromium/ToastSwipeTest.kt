package app.zen.chromium

import app.zen.chromium.ToastSwipe.Axis
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.abs

/**
 * The native toast card's swipe decides as the chrome's message cards do: these are the cases of
 * `src/renderer/src/lib/__tests__/dismiss.test.ts`, held to [ToastSwipe] – the same slop, the
 * same open ways, the same rubber band, the same release rule on the shared `SWIPE_THRESHOLDS`
 * (§9.33), the same presence. The numbers themselves are pinned to the sources by
 * `V2TokensPinTest.theToastCardSpecIsTheChromesCard`.
 */
class ToastSwipeTest {
    private val toast = ToastSwipe.TOAST_WAYS
    /** A banner's ways (the chrome's `BANNER` in the test): up, or off to either side – the rule is not the toast's alone. */
    private val banner = ToastSwipe.Ways(setOf(-1, 1), setOf(-1))
    private val fling = ToastCardSpec.FLING_VELOCITY
    private val commit = ToastCardSpec.COMMIT_FRACTION
    private val projection = ToastCardSpec.PROJECTION_SECONDS
    private val slop = ToastCardSpec.SLOP_DP.toFloat()
    private val extent = 52f

    @Test
    fun theAxisIsUndecidedInsideTheSlopCircleAndTheDominantDirectionOutsideIt() {
        assertNull(ToastSwipe.dragAxis(3f, 4f))
        assertNull(ToastSwipe.dragAxis(slop - 1, 0f))
        assertEquals(Axis.X, ToastSwipe.dragAxis(slop, 0f))
        assertEquals(Axis.Y, ToastSwipe.dragAxis(0f, -slop))
        assertEquals(Axis.Y, ToastSwipe.dragAxis(10f, -12f))
        assertEquals(Axis.X, ToastSwipe.dragAxis(-12f, 10f))
    }

    @Test
    fun aToastGoesDownAndSidewaysABannerUpAndSideways() {
        assertTrue(ToastSwipe.allowedAlong(20f, Axis.Y, toast))
        assertFalse(ToastSwipe.allowedAlong(-20f, Axis.Y, toast))
        assertTrue(ToastSwipe.allowedAlong(-20f, Axis.Y, banner))
        assertFalse(ToastSwipe.allowedAlong(20f, Axis.Y, banner))
        assertTrue(ToastSwipe.allowedAlong(-20f, Axis.X, toast))
        assertTrue(ToastSwipe.allowedAlong(20f, Axis.X, banner))
        assertFalse(ToastSwipe.allowedAlong(0f, Axis.X, toast))
        // The toast's ways are the chrome's `TOAST_DIRS`: sideways both ways, down.
        assertEquals(setOf(-1, 1), toast.x)
        assertEquals(setOf(1), toast.y)
    }

    @Test
    fun theCardFollowsTheFingerWhereItMayGoAndRubberBandsWhereItMayNot() {
        assertEquals(80f, ToastSwipe.dragOffset(80f, Axis.Y, toast))
        assertEquals(-80f, ToastSwipe.dragOffset(-80f, Axis.X, toast))
        val held = ToastSwipe.dragOffset(-80f, Axis.Y, toast)
        assertTrue(held < 0f)
        assertTrue("never further than the resist extent", abs(held) < ToastCardSpec.RESIST_DP)
        // Diminishing returns: each further 80 gives less than the last.
        val a = abs(ToastSwipe.dragOffset(-80f, Axis.Y, toast))
        val b = abs(ToastSwipe.dragOffset(-160f, Axis.Y, toast)) - a
        val c = abs(ToastSwipe.dragOffset(-240f, Axis.Y, toast)) - a - b
        assertTrue(b < a)
        assertTrue(c < b)
        // The band is `rubberBand`'s closed form on its coefficient: 80 against 40 at .55.
        assertEquals(-(1f - 1f / ((80f * 0.55f) / 40f + 1f)) * 40f, held, 1e-4f)
    }

    @Test
    fun aFlingInAnOpenWayCommitsFromAnywhere() {
        assertEquals(1, ToastSwipe.dismissSign(2f, fling, extent, Axis.Y, toast))
        assertEquals(-1, ToastSwipe.dismissSign(-2f, -fling, extent, Axis.X, toast))
        assertEquals(-1, ToastSwipe.dismissSign(-2f, -fling, extent, Axis.Y, banner))
        // A hair under the fling speed is a slow release, judged by where it is projected to be:
        // from 40 on the closed side, 449/s projects 14 out, short of the line; 450 goes.
        assertEquals(0, ToastSwipe.dismissSign(-40f, fling - 1, extent, Axis.Y, toast))
        assertEquals(1, ToastSwipe.dismissSign(-40f, fling, extent, Axis.Y, toast))
    }

    @Test
    fun aFlingTheWrongWayGoesBackToTheSlot() {
        assertEquals(0, ToastSwipe.dismissSign(-10f, -fling * 2, extent, Axis.Y, toast))
        assertEquals(0, ToastSwipe.dismissSign(10f, fling * 2, extent, Axis.Y, banner))
    }

    @Test
    fun aSlowReleaseCommitsPastTheFractionOfTheReachAndReturnsBeforeIt() {
        val line = commit * extent
        assertEquals(23.4f, line, 1e-3f)
        assertEquals(1, ToastSwipe.dismissSign(line + 1, 0f, extent, Axis.Y, toast))
        assertEquals(0, ToastSwipe.dismissSign(line - 1, 0f, extent, Axis.Y, toast))
        assertEquals(-1, ToastSwipe.dismissSign(-(line + 1), 0f, extent, Axis.X, banner))
        // Barely moved and drifting: back it goes.
        assertEquals(0, ToastSwipe.dismissSign(1f, 100f, extent, Axis.Y, toast))
    }

    @Test
    fun aSlowReleaseIsProjectedAhead() {
        val line = commit * extent
        // 15 short of the line, drifting at 200/s: the projection (24) carries it over…
        assertEquals(24f, 200f * projection, 1e-3f)
        assertEquals(1, ToastSwipe.dismissSign(line - 15, 200f, extent, Axis.Y, toast))
        // …drifting at 100/s (12) it does not, and drifting back it never does.
        assertEquals(0, ToastSwipe.dismissSign(line - 15, 100f, extent, Axis.Y, toast))
        assertEquals(0, ToastSwipe.dismissSign(line - 15, -200f, extent, Axis.Y, toast))
    }

    @Test
    fun theSharedThresholdsAreTheDefaultAndAStricterSetIsHonoured() {
        for (velocity in listOf(0f, 200f, 449f, 450f, -450f, 900f)) {
            for (offset in listOf(0f, 10f, 22f, 24f, 30f, 60f)) {
                assertEquals(
                    ToastSwipe.dismissSign(offset, velocity, extent, Axis.Y, toast),
                    ToastSwipe.dismissSign(offset, velocity, extent, Axis.Y, toast, fling, commit, projection)
                )
            }
        }
        assertEquals(1, ToastSwipe.dismissSign(30f, 600f, extent, Axis.Y, toast))
        assertEquals(0, ToastSwipe.dismissSign(30f, 600f, extent, Axis.Y, toast, fling = 2000f, fraction = 0.9f, projection = 0f))
    }

    @Test
    fun thePresenceIsFullInTheSlotAndGoneAReachAway() {
        assertEquals(1f, ToastSwipe.presence(0f, 60f))
        assertEquals(0.5f, ToastSwipe.presence(30f, 60f))
        assertEquals(0.5f, ToastSwipe.presence(-30f, 60f))
        assertEquals(0f, ToastSwipe.presence(90f, 60f))
        assertEquals(1f, ToastSwipe.presence(10f, 0f))
    }
}
