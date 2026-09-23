package app.zen.chromium

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The exit hint's cue (GN-20, MED-03): the chrome hears of a fullscreen half a second after the
 * engine's view went up, with the page's word on whether the element shows a video – waited for
 * up to the cap, never past it; the exit before the cue drops it. A `false` that trails a
 * wordless cue is cued again, late, while the fullscreen stands.
 */
class FullscreenHintCueTest {
    private val cued = mutableListOf<Pair<String, Boolean?>>()
    private val late = mutableListOf<Pair<String, Boolean?>>()
    private val scheduled = mutableListOf<Pair<Long, () -> Unit>>()
    private var cancelled = 0
    private val cue = FullscreenHintCue(
        schedule = { delay, block ->
            val entry = delay to block
            scheduled += entry
            val cancel: () -> Unit = {
                if (scheduled.remove(entry)) cancelled++
            }
            cancel
        },
        cue = { tabId, video, isLate -> (if (isLate) late else cued) += tabId to video }
    )

    /** The delays run out, one round: every block scheduled so far runs. */
    private fun elapse() {
        val due = scheduled.toList()
        scheduled.clear()
        due.forEach { it.second() }
    }

    @Test
    fun theCueFollowsTheViewAfterTheDelayWithThePagesWord() {
        cue.entered("t1")
        assertTrue(cued.isEmpty())
        assertEquals(listOf(FullscreenHintCue.DELAY_MS), scheduled.map { it.first })
        // The page's report comes in the next frames: a canvas, no video.
        cue.reported("t1", active = true, video = false, mainFrame = true)
        assertTrue(cued.isEmpty())
        elapse()
        assertEquals(listOf("t1" to false), cued)
        assertTrue(scheduled.isEmpty())
        // The next fullscreen of a video: its own cue.
        cue.exited("t1")
        cue.entered("t1")
        cue.reported("t1", active = true, video = true, mainFrame = true)
        elapse()
        assertEquals(listOf("t1" to false, "t1" to true), cued)
    }

    @Test
    fun aReportAheadOfTheViewIsKeptForIt() {
        cue.reported("t1", active = true, video = true, mainFrame = true)
        cue.entered("t1")
        elapse()
        assertEquals(listOf("t1" to true), cued)
        // Another tab's report is not this tab's word.
        cue.exited("t1")
        cue.reported("t2", active = true, video = false, mainFrame = true)
        cue.entered("t1")
        elapse()
        assertEquals(1, cued.size)
        assertEquals(FullscreenHintCue.CAP_MS - FullscreenHintCue.DELAY_MS, scheduled.single().first)
    }

    @Test
    fun aPageSilentAtTheDelayIsWaitedForUpToTheCapThenCuedWithoutAWord() {
        cue.entered("t1")
        elapse()
        assertTrue(cued.isEmpty())
        assertEquals(listOf(FullscreenHintCue.CAP_MS - FullscreenHintCue.DELAY_MS), scheduled.map { it.first })
        // The word arrives inside the cap: the cue goes out at once, the cap's wait is dropped.
        cue.reported("t1", active = true, video = false, mainFrame = true)
        assertEquals(listOf("t1" to false), cued)
        assertEquals(1, cancelled)
        assertTrue(scheduled.isEmpty())
        // A page that never speaks: cued at the cap without a word (the chrome keeps to GN-20's once).
        cue.exited("t1")
        cue.entered("t1")
        elapse()
        elapse()
        assertEquals(listOf("t1" to false, "t1" to null), cued)
        assertTrue(late.isEmpty())
        // A word after a cue that had one is the next fullscreen's at most, never a second cue for this one.
        cue.exited("t1")
        cue.entered("t1")
        cue.reported("t1", active = true, video = false, mainFrame = true)
        elapse()
        cue.reported("t1", active = true, video = false, mainFrame = true)
        assertEquals(3, cued.size)
        assertTrue(late.isEmpty())
    }

    @Test
    fun aFalseTrailingTheCapIsCuedLateOnceWhileTheFullscreenStands() {
        cue.entered("t1")
        elapse()
        elapse()
        assertEquals(listOf("t1" to null), cued)
        // The canvas's word past the cap: the toast the cap withheld is owed (MED-03), cued late – once.
        cue.reported("t1", active = true, video = false, mainFrame = true)
        assertEquals(listOf("t1" to false), late)
        cue.reported("t1", active = true, video = false, mainFrame = true)
        assertEquals(1, late.size)
        assertEquals(1, cued.size)
        assertTrue(scheduled.isEmpty())
        // The next fullscreen starts clean: its own cue, no late word carried over.
        cue.exited("t1")
        cue.entered("t1")
        cue.reported("t1", active = true, video = true, mainFrame = true)
        elapse()
        assertEquals(listOf("t1" to null, "t1" to true), cued)
        assertEquals(1, late.size)
    }

    @Test
    fun aLateTrueConfirmsTheWordlessCueAndTheExitEndsTheWait() {
        cue.entered("t1")
        elapse()
        elapse()
        // A video's late word (an embed's player): the wordless cue was the video's treatment already; nothing more.
        cue.reported("t1", active = true, video = true, mainFrame = false)
        assertTrue(late.isEmpty())
        // The main document's `false` after a frame's `true` does not unsay it, late either.
        cue.reported("t1", active = true, video = false, mainFrame = true)
        assertTrue(late.isEmpty())
        // The word after the exit is no late cue: the fullscreen it was for is over.
        cue.exited("t1")
        cue.entered("t2")
        elapse()
        elapse()
        assertEquals(listOf("t1" to null, "t2" to null), cued)
        cue.exited("t2")
        cue.reported("t2", active = true, video = false, mainFrame = true)
        assertTrue(late.isEmpty())
        // Another tab's word is not this tab's late one.
        cue.entered("t1")
        elapse()
        elapse()
        cue.reported("t3", active = true, video = false, mainFrame = true)
        assertTrue(late.isEmpty())
        cue.reported("t1", active = true, video = false, mainFrame = true)
        assertEquals(listOf("t1" to false), late)
    }

    @Test
    fun aFramesVideoStandsForTheTabAndTheMainDocumentsNoneDoesNotUnsayIt() {
        cue.entered("t1")
        // The main document sees the <iframe>: no video; the embed's document sees its player.
        cue.reported("t1", active = true, video = false, mainFrame = true)
        cue.reported("t1", active = true, video = true, mainFrame = false)
        elapse()
        assertEquals(listOf("t1" to true), cued)
        // The other order.
        cue.exited("t1")
        cue.entered("t1")
        cue.reported("t1", active = true, video = true, mainFrame = false)
        cue.reported("t1", active = true, video = false, mainFrame = true)
        elapse()
        assertEquals(listOf("t1" to true, "t1" to true), cued)
    }

    @Test
    fun theExitBeforeTheCueDropsItAndForgetsTheReport() {
        cue.entered("t1")
        cue.reported("t1", active = true, video = false, mainFrame = true)
        cue.exited("t1")
        assertEquals(1, cancelled)
        elapse()
        assertTrue(cued.isEmpty())
        // The report was that fullscreen's: the next one starts without a word.
        cue.entered("t1")
        elapse()
        assertTrue(cued.isEmpty())
        assertEquals(1, scheduled.size)
        // The page's own end of fullscreen forgets the report too; a frame's end does not.
        cue.reported("t1", active = true, video = false, mainFrame = true)
        assertEquals(listOf("t1" to false), cued)
        cue.exited("t1")
        cue.reported("t1", active = true, video = true, mainFrame = true)
        cue.reported("t1", active = false, video = false, mainFrame = false)
        cue.entered("t1")
        elapse()
        assertEquals(listOf("t1" to false, "t1" to true), cued)
        cue.exited("t1")
        cue.reported("t1", active = true, video = true, mainFrame = true)
        cue.reported("t1", active = false, video = false, mainFrame = true)
        cue.entered("t1")
        elapse()
        assertEquals(2, cued.size)
        assertEquals(1, scheduled.size)
    }

    @Test
    fun theDelayIsTheRevealsSettleAndChromesOwn() {
        assertEquals(500L, FullscreenHintCue.DELAY_MS)
        assertEquals(1500L, FullscreenHintCue.CAP_MS)
    }
}
