package app.zen.chromium

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * NOT-13, the capture service's start ([CaptureForeground.enter]): the typed `startForeground`
 * is the service's own to try, and its three ends – as asked, narrowed to the kinds the app
 * holds, or no start at all – decide whether the card is the service's or a plain notification
 * and whether a started service is kept. The kinds are the `FOREGROUND_SERVICE_TYPE_*` bits;
 * the ladder reads them as a mask, so the test's are any two.
 */
class CaptureForegroundTest {
    private val camera = 1
    private val microphone = 2
    private val both = camera or microphone

    /** The calls `startForeground` got, in order, with what each answers. */
    private fun ladder(type: Int, held: Int, takes: (Int) -> Boolean): Pair<CaptureForeground.End, List<Int>> {
        val tried = ArrayList<Int>()
        val end = CaptureForeground.enter(type, held) { kind ->
            tried += kind
            takes(kind)
        }
        return end to tried
    }

    /** Typed ok: one call, as asked, and the service holds the kinds it asked for. */
    @Test
    fun aTypedStartThatTakesIsTheServicesKind() {
        val (end, tried) = ladder(both, held = both) { true }
        assertEquals(ForegroundStart.TYPED, end.outcome)
        assertEquals(both, end.type)
        assertEquals(listOf(both), tried)
        assertTrue(end.outcome.holds)
    }

    /**
     * Typed refused → the kinds held: a camera + microphone request whose prompt granted the
     * microphone alone (Android 14 refuses the camera kind without CAMERA) re-tries as the
     * microphone, and the service stands as that.
     */
    @Test
    fun aTypedStartRefusedFallsBackToTheKindsHeld() {
        val (end, tried) = ladder(both, held = microphone) { kind -> kind == microphone }
        assertEquals(ForegroundStart.NARROWED, end.outcome)
        assertEquals(microphone, end.type)
        assertEquals(listOf(both, microphone), tried)
        assertTrue(end.outcome.holds)
    }

    /** Both refused → stopped: the service is stopped and the caller posts the card plainly. */
    @Test
    fun bothStartsRefusedStopTheService() {
        val (end, tried) = ladder(both, held = microphone) { false }
        assertEquals(ForegroundStart.STOPPED, end.outcome)
        assertEquals(0, end.type)
        assertEquals(listOf(both, microphone), tried)
        assertFalse(end.outcome.holds)
    }

    /**
     * Nothing to narrow to: a kind the app holds, refused (the app left the foreground between
     * the grant and the start), is not tried twice; and the same when no kind of the ask is held.
     */
    @Test
    fun aRefusalWithNothingNarrowerToTryIsOneCall() {
        val (fromBackground, triedOnce) = ladder(microphone, held = microphone) { false }
        assertEquals(ForegroundStart.STOPPED, fromBackground.outcome)
        assertEquals(listOf(microphone), triedOnce)
        val (nothingHeld, triedNothing) = ladder(both, held = 0) { false }
        assertEquals(ForegroundStart.STOPPED, nothingHeld.outcome)
        assertEquals(listOf(both), triedNothing)
    }

    /** Below Android 11 there is no kind: the one plain start is the start as asked. */
    @Test
    fun noKindIsOnePlainStart() {
        val (took, tried) = ladder(0, held = 0) { true }
        assertEquals(ForegroundStart.TYPED, took.outcome)
        assertEquals(0, took.type)
        assertEquals(listOf(0), tried)
        val (refused, triedRefused) = ladder(0, held = 0) { false }
        assertEquals(ForegroundStart.STOPPED, refused.outcome)
        assertEquals(listOf(0), triedRefused)
    }
}
