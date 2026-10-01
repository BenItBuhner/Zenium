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
    fun theBarIsAbsoluteWhereTheControlHoldsSixtyFpsAndAFactWhereItCannot() {
        val smooth = WakeFrames.summarize(List(60) { 12.0 })
        assertEquals(WakeFrames.Bar.Absolute, WakeFrames.bar(smooth, 14.0))
        val emulator = WakeFrames.summarize(List(20) { 300.0 } + 554.0)
        val bar = WakeFrames.bar(emulator, 310.0)
        assertTrue(bar is WakeFrames.Bar.Fact)
        // The denominator is the lane's stall size: the control's longest frame or the run's p95 over every frame, whichever is more.
        assertEquals(554.0, (bar as WakeFrames.Bar.Fact).denominator, 0.0)
        assertEquals(610.0, (WakeFrames.bar(emulator, 610.0) as WakeFrames.Bar.Fact).denominator, 0.0)
        assertTrue(WakeFrames.bar(WakeFrames.Summary.EMPTY, 0.0) is WakeFrames.Bar.Fact)
        assertTrue(bar.toString(), bar.toString().startsWith("FACT, not asserted: the warm control misses 60 fps on this lane; ratios against max(the control's longest 554.0, the run's all-frames p95 310.0) = 554.0 ms"))
    }

    @Test
    fun aFactLineReadsTheWindowAgainstTheDenominatorAndNeverFails() {
        val control = WakeFrames.summarize(List(7) { 213.0 } + List(3) { 10.0 } + 294.0)
        val bar = WakeFrames.Bar.Fact(controlLongest = 294.0, runP95 = 300.0)
        // The retry's switch window: a 606 ms frame against a 294 ms control – a reading, not a failure.
        val sleeping = WakeFrames.summarize(List(11) { 176.0 } + 606.0 + 10.0)
        val fact = WakeFrames.judge("wake-tap switch sleeping", sleeping, control, bar)
        assertTrue(fact.fact)
        assertTrue(fact.pass)
        assertFalse(fact.asserted)
        assertFalse(fact.failed)
        assertEquals(
            fact.line(),
            "FACT wake-tap switch sleeping: p95 606.0 ms, 2.02x the denominator 300.0; longest 606.0 ms, 2.02x; 12 of 13 frames over 32 ms (the control 8 of 11, p95 294.0, longest 294.0)",
            fact.line()
        )
        // An empty window is a fact too on this lane.
        val empty = WakeFrames.judge("out", WakeFrames.Summary.EMPTY, control, bar)
        assertTrue(empty.fact)
        assertEquals(listOf("no frame was recorded in the window"), empty.reasons)
        assertFalse(empty.failed)
    }

    @Test
    fun aDurationFactNamesBothSidesOrTheirAbsence() {
        assertEquals("FACT wake-tap sleeping: shown 2880 ms after the tap, 1.23x the warm control's 2336", WakeFrames.factDuration("wake-tap sleeping", "shown", 2880.0, 2336.0).line())
        assertEquals("FACT wake-tap sleeping: load not seen, the warm control's 2336", WakeFrames.factDuration("wake-tap sleeping", "load", -1.0, 2336.0).line())
        assertEquals("FACT wake-tap sleeping: shown 2880 ms after the tap, the warm control's not seen", WakeFrames.factDuration("wake-tap sleeping", "shown", 2880.0, -1.0).line())
        assertEquals("-", WakeFrames.ratio(1.0, 0.0))
    }

    @Test
    fun theSpareLifecycleClaimWantsBothDrops() {
        assertTrue(WakeFrames.judgeSpareDrop("lifecycle", true, true, true, true).pass)
        val stoodOn = WakeFrames.judgeSpareDrop("lifecycle", true, false, true, true)
        assertEquals(listOf("the spare stood on after memory pressure"), stoodOn.reasons)
        assertTrue(stoodOn.failed)
        val none = WakeFrames.judgeSpareDrop("lifecycle", false, false, false, false)
        assertEquals(listOf("no spare stood to drop under memory pressure", "no spare stood to drop with its renderer"), none.reasons)
        assertEquals(listOf("the spare stood on after its renderer went"), WakeFrames.judgeSpareDrop("lifecycle", true, true, true, false).reasons)
    }

    @Test
    fun theSpareMemoryClaimBoundsThePssDelta() {
        assertTrue(WakeFrames.judgeSpareMemory("memory", true, 1_796, 8_192).pass)
        assertTrue(WakeFrames.judgeSpareMemory("memory", true, -40, 8_192).pass)
        assertEquals(listOf("PSS grew 9000 KB, cap 8192"), WakeFrames.judgeSpareMemory("memory", true, 9_000, 8_192).reasons)
        assertEquals(listOf("no spare was built to measure"), WakeFrames.judgeSpareMemory("memory", false, 0, 8_192).reasons)
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
    fun anEmptyWindowFailsTheAbsoluteBar() {
        val control = WakeFrames.summarize(List(10) { 10.0 })
        val verdict = WakeFrames.judge("switch", WakeFrames.Summary.EMPTY, control, WakeFrames.Bar.Absolute)
        assertTrue(verdict.failed)
        assertEquals("FAIL switch: no frame was recorded in the window", verdict.line())
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
