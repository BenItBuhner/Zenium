package app.zen.chromium

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The sleeping-tab wake profile's frame arithmetic ([WakeFrames]), on the JVM. */
class WakeFramesTest {
    private fun frame(vsyncMs: Long, total: Double, delay: Double = 0.0, draw: Double = 2.0, swap: Double = 0.0, animation: Double = 1.0) =
        WakeFrames.Frame(
            vsyncNs = vsyncMs * 1_000_000, totalMs = total, delayMs = delay, inputMs = 0.5, animationMs = animation,
            layoutMs = 1.0, drawMs = draw, syncMs = 0.5, commandsMs = 1.0, swapMs = swap
        )

    @Test
    fun percentileIsNearestRank() {
        val values = listOf(5.0, 1.0, 3.0, 2.0, 4.0)
        assertEquals(3.0, WakeFrames.percentile(values, 50.0), 0.0)
        assertEquals(5.0, WakeFrames.percentile(values, 95.0), 0.0)
        assertEquals(5.0, WakeFrames.percentile(values, 99.0), 0.0)
        assertEquals(1.0, WakeFrames.percentile(values, 1.0), 0.0)
        assertEquals(0.0, WakeFrames.percentile(emptyList(), 50.0), 0.0)
    }

    @Test
    fun summaryCountsTheLongFrames() {
        val s = WakeFrames.summarize(listOf(8.0, 12.0, 16.7, 17.0, 33.0, 120.0))
        assertEquals(6, s.frames)
        assertEquals(3, s.over16)
        assertEquals(2, s.over32)
        assertEquals(120.0, s.longest, 0.0)
        assertEquals(16.7, s.p50, 0.0)
        assertEquals(120.0, s.p95, 0.0)
        assertEquals(2.0 / 6, s.over32Share, 1e-9)
        assertEquals(WakeFrames.Summary.EMPTY, WakeFrames.summarize(emptyList()))
    }

    @Test
    fun windowCutsOnTheVsyncAndSorts() {
        val frames = listOf(frame(300, 10.0), frame(100, 10.0), frame(200, 10.0), frame(400, 10.0))
        val cut = WakeFrames.window(frames, 100_000_000, 300_000_000)
        assertEquals(listOf(100L, 200L, 300L), cut.map { it.vsyncNs / 1_000_000 })
    }

    @Test
    fun uiTimeIsTheMainThreadsPartAndTheDelayNamesTheStall() {
        val stalled = frame(0, 250.0, delay = 212.0, swap = 30.0)
        assertEquals(212.0 + 0.5 + 1.0 + 1.0 + 2.0, stalled.uiMs, 1e-9)
        assertEquals(212.0 + 0.5 + 1.0 + 2.0, stalled.ownMs, 1e-9)
        // The WebView's wait on the renderer sits in the animation stage: in `ui`, out of `own`.
        val handshake = frame(0, 300.0, animation = 254.0)
        assertEquals(254.0 + 0.5 + 1.0 + 2.0, handshake.uiMs, 1e-9)
        assertEquals(0.5 + 1.0 + 2.0, handshake.ownMs, 1e-9)
        assertEquals("delay", stalled.longestStage())
        val heavyDraw = frame(0, 60.0, draw = 40.0, swap = 10.0)
        assertEquals("draw", heavyDraw.longestStage())
        assertEquals("delay", WakeFrames.dominantStage(listOf(stalled, stalled, heavyDraw)))
        assertNull(WakeFrames.dominantStage(listOf(frame(0, 10.0))))
    }

    @Test
    fun stageTotalsGiveMeanAndMax() {
        val totals = WakeFrames.stageTotals(listOf(frame(0, 10.0, delay = 10.0), frame(16, 10.0, delay = 30.0)))
        assertEquals(20.0 to 30.0, totals["delay"])
        assertTrue(WakeFrames.stageTotals(emptyList()).isEmpty())
    }

    @Test
    fun theBarIsAbsoluteWhereTheControlHoldsSixtyFps() {
        val smooth = WakeFrames.summarize(List(60) { 12.0 })
        assertEquals(WakeFrames.Bar.Absolute, WakeFrames.bar(smooth))
        val emulator = WakeFrames.summarize(List(20) { 300.0 })
        assertTrue(WakeFrames.bar(emulator) is WakeFrames.Bar.Relative)
        assertTrue(WakeFrames.bar(WakeFrames.Summary.EMPTY) is WakeFrames.Bar.Relative)
    }

    @Test
    fun absoluteBarPassesAndFails() {
        val control = WakeFrames.summarize(List(60) { 12.0 })
        val good = WakeFrames.summarize(List(60) { 15.0 })
        assertTrue(WakeFrames.judge("switch", good, control, WakeFrames.Bar.Absolute).pass)
        val hitch = WakeFrames.summarize(List(59) { 12.0 } + 40.0)
        val verdict = WakeFrames.judge("switch", hitch, control, WakeFrames.Bar.Absolute)
        assertFalse(verdict.pass)
        assertTrue(verdict.line(), verdict.line().startsWith("FAIL switch: 1 frame(s) over 32 ms"))
        val slow = WakeFrames.summarize(List(60) { 20.0 })
        assertTrue(WakeFrames.judge("switch", slow, control, WakeFrames.Bar.Absolute).reasons.first().startsWith("p95 20.0 ms over 16.7"))
    }

    @Test
    fun relativeBarReadsAgainstTheControl() {
        val control = WakeFrames.summarize(List(50) { 10.0 } + List(10) { 40.0 })
        val bar = WakeFrames.bar(control)
        assertTrue(bar is WakeFrames.Bar.Relative)
        // The same spread as the control: within.
        assertTrue(WakeFrames.judge("out", control, control, bar).pass)
        // A longest frame at 2x the control's and a share 10 points up: still within.
        val edge = WakeFrames.summarize(List(44) { 10.0 } + List(15) { 40.0 } + 80.0)
        assertTrue(WakeFrames.judge("out", edge, control, bar).line(), WakeFrames.judge("out", edge, control, bar).pass)
        // A 212 ms stall: over on the longest frame.
        val stall = WakeFrames.summarize(List(49) { 10.0 } + List(10) { 40.0 } + 212.0)
        val verdict = WakeFrames.judge("out", stall, control, bar)
        assertFalse(verdict.pass)
        assertTrue(verdict.line(), verdict.reasons.any { it.startsWith("longest 212.0 ms over 80.0") })
        // A p95 past twice the control's: over on the p95.
        val slower = WakeFrames.summarize(List(50) { 10.0 } + List(10) { 90.0 })
        assertTrue(WakeFrames.judge("out", slower, control, bar).reasons.first().startsWith("p95 90.0 ms over 80.0 (2.00x the control's 40.0)"))
        // Every frame over two vsyncs where the control had one in six: over on the share alone.
        val slow = WakeFrames.summarize(List(60) { 40.0 })
        val share = WakeFrames.judge("out", slow, control, bar)
        assertFalse(share.pass)
        assertEquals(share.line(), 1, share.reasons.size)
        assertTrue(share.line(), share.reasons.first().startsWith("100% of frames over 32 ms, cap 27% (the control's 17% + 10 points)"))
    }

    @Test
    fun theShareAllowanceIsTenPointsOrOneFrameOfTheSmallerWindow() {
        assertEquals(0.10, WakeFrames.shareAllowance(0.10, 60, 60), 1e-9)
        assertEquals(1.0 / 6, WakeFrames.shareAllowance(0.10, 6, 13), 1e-9)
        assertEquals(0.10, WakeFrames.shareAllowance(0.10, 0, 6), 1e-9)
        val bar = WakeFrames.Bar.Relative(WakeFrames.P95_RATIO, WakeFrames.LONGEST_RATIO, WakeFrames.OVER32_POINTS)
        // Six frames against six: one more over two vsyncs than the control is within (the share cannot tell a tenth).
        val control = WakeFrames.summarize(List(5) { 100.0 } + 20.0)
        val oneMore = WakeFrames.summarize(List(6) { 100.0 })
        assertTrue(WakeFrames.judge("out", oneMore, control, bar).line(), WakeFrames.judge("out", oneMore, control, bar).pass)
        // Eight against eight: two more is over, and the reason names the frame's worth.
        val eightControl = WakeFrames.summarize(List(4) { 100.0 } + List(4) { 20.0 })
        val twoMore = WakeFrames.summarize(List(6) { 100.0 } + List(2) { 20.0 })
        val verdict = WakeFrames.judge("out", twoMore, eightControl, bar)
        assertFalse(verdict.pass)
        assertEquals(verdict.line(), listOf("75% of frames over 32 ms, cap 63% (the control's 50% + 13 points, one frame of 8)"), verdict.reasons)
        assertTrue(WakeFrames.judge("out", WakeFrames.summarize(List(5) { 100.0 } + List(3) { 20.0 }), eightControl, bar).pass)
        // Ten against ten: a tenth is the frame, and the reason stays the plain one.
        val tenControl = WakeFrames.summarize(List(5) { 100.0 } + List(5) { 20.0 })
        val tenVerdict = WakeFrames.judge("out", WakeFrames.summarize(List(7) { 100.0 } + List(3) { 20.0 }), tenControl, bar)
        assertEquals(tenVerdict.line(), listOf("70% of frames over 32 ms, cap 60% (the control's 50% + 10 points)"), tenVerdict.reasons)
    }

    @Test
    fun relativeBarNeverForbidsAFrameUnderTwoVsyncs() {
        val control = WakeFrames.summarize(List(60) { 10.0 } + 20.0)
        val bar = WakeFrames.Bar.Relative(WakeFrames.P95_RATIO, WakeFrames.LONGEST_RATIO, WakeFrames.OVER32_POINTS)
        val sleeping = WakeFrames.summarize(List(60) { 10.0 } + 31.0)
        assertTrue(WakeFrames.judge("switch", sleeping, control, bar).pass)
    }

    @Test
    fun emptyWindowsFail() {
        val control = WakeFrames.summarize(List(10) { 10.0 })
        assertFalse(WakeFrames.judge("switch", WakeFrames.Summary.EMPTY, control, WakeFrames.Bar.Absolute).pass)
        val relative = WakeFrames.Bar.Relative(1.25, 1.5, 0.1)
        assertEquals(listOf("the warm control recorded no frame"), WakeFrames.judge("switch", control, WakeFrames.Summary.EMPTY, relative).reasons)
    }

    @Test
    fun theConstructionClaimWantsTheSpareTakenAndACheapCreate() {
        val taken = listOf(WakeFrames.Wake(true, 0.4), WakeFrames.Wake(true, 1.2), WakeFrames.Wake(true, 4.9))
        assertTrue(WakeFrames.judgeCreate("spare", taken, 5.0).pass)
        val built = WakeFrames.judgeCreate("spare", taken + WakeFrames.Wake(false, 18.3), 5.0)
        assertFalse(built.pass)
        assertEquals(built.line(), 2, built.reasons.size)
        assertEquals("1 of 4 wake(s) built the view inside the morph (no spare stood)", built.reasons[0])
        assertEquals("1 create(s) over 5.0 ms (longest 18.3)", built.reasons[1])
        val slow = WakeFrames.judgeCreate("spare", listOf(WakeFrames.Wake(true, 7.5)), 5.0)
        assertEquals(listOf("1 create(s) over 5.0 ms (longest 7.5)"), slow.reasons)
        assertEquals(listOf("no wake was recorded"), WakeFrames.judgeCreate("spare", emptyList(), 5.0).reasons)
    }

    @Test
    fun tableRendersRows() {
        val table = WakeFrames.table(listOf("a" to WakeFrames.summarize(listOf(10.0, 40.0))))
        assertTrue(table, table.contains("| a | 2 | 10.0 | 40.0 | 40.0 | 40.0 | 1 | 1 |"))
    }
}
