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
        // A longest frame at 1.5x the control's and a share 10 points up: still within.
        val edge = WakeFrames.summarize(List(44) { 10.0 } + List(15) { 40.0 } + 60.0)
        assertTrue(WakeFrames.judge("out", edge, control, bar).line(), WakeFrames.judge("out", edge, control, bar).pass)
        // A 212 ms stall: over on the longest frame.
        val stall = WakeFrames.summarize(List(49) { 10.0 } + List(10) { 40.0 } + 212.0)
        val verdict = WakeFrames.judge("out", stall, control, bar)
        assertFalse(verdict.pass)
        assertTrue(verdict.line(), verdict.reasons.any { it.startsWith("longest 212.0 ms over 60.0") })
        // Every frame over two vsyncs where the control had one in six: over on the share alone.
        val slow = WakeFrames.summarize(List(60) { 40.0 })
        val share = WakeFrames.judge("out", slow, control, bar)
        assertFalse(share.pass)
        assertEquals(share.line(), 1, share.reasons.size)
        assertTrue(share.line(), share.reasons.first().startsWith("100% of frames over 32 ms, cap 27%"))
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
    fun tableRendersRows() {
        val table = WakeFrames.table(listOf("a" to WakeFrames.summarize(listOf(10.0, 40.0))))
        assertTrue(table, table.contains("| a | 2 | 10.0 | 40.0 | 40.0 | 40.0 | 1 | 1 |"))
    }
}
