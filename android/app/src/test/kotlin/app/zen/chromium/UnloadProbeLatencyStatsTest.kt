package app.zen.chromium

import app.zen.chromium.UnloadProbeLatencyStats.Arm
import app.zen.chromium.UnloadProbeLatencyStats.MISSED
import app.zen.chromium.UnloadProbeLatencyStats.Sample
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The latency harness's arithmetic (`UnloadProbeLatencyStats`, seed A10 step 1): the arms'
 * summaries on known series, the paired delta, the verdict against one frame.
 */
class UnloadProbeLatencyStatsTest {
    @Test
    fun medianAndP95AreNearestRankOnAKnownSeries() {
        // 1..20 in any order: the 10th of 20 is the median (rank ceil(10)), the 19th the p95 (rank ceil(19)).
        val twenty = (1..20).map { it.toDouble() }.shuffled(java.util.Random(7))
        val s = UnloadProbeLatencyStats.summarise(Arm.WITH, twenty)
        assertEquals(20, s.n)
        assertEquals(0, s.missed)
        assertEquals(10.0, s.median, 0.0)
        assertEquals(19.0, s.p95, 0.0)
        assertEquals(1.0, s.min, 0.0)
        assertEquals(20.0, s.max, 0.0)
        assertEquals(10.5, s.mean, 1e-9)
        // An odd series: the middle value, and the last for the p95 of five.
        val five = UnloadProbeLatencyStats.summarise(Arm.WITHOUT, listOf(5.0, 1.0, 9.0, 3.0, 7.0))
        assertEquals(5.0, five.median, 0.0)
        assertEquals(9.0, five.p95, 0.0)
        assertEquals(1.0, five.min, 0.0)
        assertEquals(9.0, five.max, 0.0)
        assertEquals(5.0, five.mean, 0.0)
        // The run's emulator numbers, as #789 reported them, read back the same way.
        val one = UnloadProbeLatencyStats.summarise(Arm.WITH, listOf(594.0))
        assertEquals(594.0, one.median, 0.0)
        assertEquals(594.0, one.p95, 0.0)
    }

    @Test
    fun aWordThatNeverCameIsCountedNotSummarised() {
        val s = UnloadProbeLatencyStats.summarise(Arm.WITH, listOf(10.0, MISSED, 30.0))
        assertEquals(2, s.n)
        assertEquals(1, s.missed)
        assertEquals(10.0, s.min, 0.0)
        assertEquals(30.0, s.max, 0.0)
        assertEquals(20.0, s.mean, 0.0)
        assertTrue(s.row().contains("(1 never came)"))
        val none = UnloadProbeLatencyStats.summarise(Arm.WITHOUT, listOf(MISSED, MISSED))
        assertEquals(0, none.n)
        assertEquals(2, none.missed)
    }

    @Test
    fun thePairedDeltaIsWithMinusWithoutInsideEachPair() {
        val samples = listOf(
            sample(0, Arm.WITH, 100.0), sample(0, Arm.WITHOUT, 80.0),
            sample(1, Arm.WITHOUT, 90.0), sample(1, Arm.WITH, 120.0),
            sample(2, Arm.WITH, 90.0), sample(2, Arm.WITHOUT, 95.0),
            // A pair short of an arm, and one whose reading never came: left out.
            sample(3, Arm.WITH, 500.0),
            sample(4, Arm.WITH, MISSED), sample(4, Arm.WITHOUT, 50.0)
        )
        val p = UnloadProbeLatencyStats.paired(samples) { it.startedMs }
        assertEquals(3, p.n)
        assertEquals(20.0, p.median, 0.0)
        assertEquals(15.0, p.mean, 1e-9)
        assertEquals(-5.0, p.min, 0.0)
        assertEquals(30.0, p.max, 0.0)
        assertEquals(2, p.overFrame)
        assertTrue(p.line().contains("median +20.0, mean +15.0, min -5.0, max +30.0 ms; 2 of 3 pairs over one frame (16.7 ms)"))
        assertEquals(UnloadProbeLatencyStats.Paired.NONE, UnloadProbeLatencyStats.paired(emptyList()) { it.startedMs })
    }

    @Test
    fun theArmsDeltasAreMedianToMedianAndP95ToP95() {
        val with = UnloadProbeLatencyStats.Summary(Arm.WITH, 20, 0, 594.0, 813.0, 400.0, 900.0, 600.0)
        val without = UnloadProbeLatencyStats.Summary(Arm.WITHOUT, 20, 0, 346.0, 618.0, 300.0, 700.0, 380.0)
        assertEquals("delta (with - without): median +248.0 ms, p95 +195.0 ms", UnloadProbeLatencyStats.armDeltaLine(with, without))
        assertEquals("delta (with - without): an arm has no reading", UnloadProbeLatencyStats.armDeltaLine(with, UnloadProbeLatencyStats.Summary.empty(Arm.WITHOUT)))
    }

    @Test
    fun theVerdictReadsThePairedMedianAgainstOneFrame() {
        val with = UnloadProbeLatencyStats.Summary(Arm.WITH, 20, 0, 594.0, 813.0, 400.0, 900.0, 600.0)
        val without = UnloadProbeLatencyStats.Summary(Arm.WITHOUT, 20, 0, 346.0, 618.0, 300.0, 700.0, 380.0)
        val over = UnloadProbeLatencyStats.verdict(UnloadProbeLatencyStats.Paired(20, 240.0, 230.0, -20.0, 400.0, 18), with, without, emulator = false, asked = 20)
        assertTrue(over, over.startsWith("VERDICT (advisory; threshold > 16.7 ms = more than one frame at 60 Hz): the probe adds +240.0 ms median per load (paired; arm medians +248.0, p95s +195.0) -- OVER one frame (18 of 20 pairs over): step 2, the armed-hook skip, is indicated"))
        assertFalse(over.contains("EMULATOR"))
        val within = UnloadProbeLatencyStats.verdict(UnloadProbeLatencyStats.Paired(20, 9.0, 10.0, -3.0, 20.0, 2), with, without, emulator = false, asked = 20)
        assertTrue(within, within.contains("+9.0 ms median per load") && within.contains("-- within one frame (2 of 20 pairs over): the probe may stay as it is"))
        // Exactly one frame is not over it.
        val edge = UnloadProbeLatencyStats.verdict(UnloadProbeLatencyStats.Paired(20, 16.7, 16.7, 16.7, 16.7, 0), with, without, emulator = false, asked = 20)
        assertTrue(edge, edge.contains("within one frame"))
        // The emulator's numbers are said to be, and a short run too.
        val emulator = UnloadProbeLatencyStats.verdict(UnloadProbeLatencyStats.Paired(12, 240.0, 230.0, -20.0, 400.0, 11), with, without, emulator = true, asked = 20)
        assertTrue(emulator, emulator.endsWith("; EMULATOR numbers, not a device's; 20 pairs asked, 12 measured"))
        // No pair, no verdict.
        assertTrue(UnloadProbeLatencyStats.verdict(UnloadProbeLatencyStats.Paired.NONE, with, without, emulator = false, asked = 20).endsWith("no pair with both readings; no verdict"))
    }

    @Test
    fun theArmIsProvenBySampleAndAHoldThatNeverTookVoidsTheRun() {
        val proven = listOf(
            sample(0, Arm.WITH, 100.0, probePending = true), sample(0, Arm.WITHOUT, 80.0, probePending = false)
        )
        assertTrue(proven.all { it.armProven })
        assertEquals("arm proof: 1/1 with-arm loads had the probe's address pending after loadUrl; 1/1 without-arm loads had the target's", UnloadProbeLatencyStats.armProofLine(proven))
        assertFalse(UnloadProbeLatencyStats.holdNeverTook(proven))
        val unheld = listOf(
            sample(0, Arm.WITH, 100.0, probePending = true), sample(0, Arm.WITHOUT, 80.0, probePending = true),
            sample(1, Arm.WITH, 100.0, probePending = true), sample(1, Arm.WITHOUT, 80.0, probePending = true)
        )
        assertTrue(UnloadProbeLatencyStats.holdNeverTook(unheld))
        assertTrue(UnloadProbeLatencyStats.armProofLine(unheld).endsWith("0/2 without-arm loads had the target's -- NOT EVERY SAMPLE PROVEN: see the samples"))
        assertTrue(unheld[1].line().endsWith("pending=probe (ARM NOT PROVEN)"))
        // One sample unproven is a note, not a void run.
        val oneOff = unheld.take(2) + proven.map { it.copy(pair = 1) }
        assertFalse(UnloadProbeLatencyStats.holdNeverTook(oneOff))
        assertFalse(UnloadProbeLatencyStats.holdNeverTook(emptyList()))
    }

    @Test
    fun theBlockIsFencedAndCarriesTheHeaderTheRowsAndTheVerdict() {
        val samples = (0 until 3).flatMap { pair ->
            listOf(sample(pair, Arm.WITH, 100.0 + pair, probePending = true), sample(pair, Arm.WITHOUT, 70.0 + pair, probePending = false))
        }
        val block = UnloadProbeLatencyStats.block(listOf("device: Test (API 34)", "page: http://127.0.0.1:18138/page.html"), samples, emulator = true, asked = 3)
        val lines = block.trimEnd().lines()
        assertEquals("== unload probe latency (A10 step 1) ==", lines.first())
        assertEquals("== end ==", lines.last())
        assertTrue(block.contains("device: Test (API 34)\npage: http://127.0.0.1:18138/page.html\nsamples: 3 with the probe, 3 without, 3 pairs asked\n"))
        assertTrue(block.contains("-- loadUrl -> onPageStarted (the reading judged), ms --\n" + UnloadProbeLatencyStats.Summary.HEADER + "\n"))
        assertTrue(block.contains("with probe     3     101.0    102.0    100.0    102.0    101.0\n"))
        assertTrue(block.contains("without        3      71.0     72.0     70.0     72.0     71.0\n"))
        assertEquals("arm            N    median      p95      min      max     mean", UnloadProbeLatencyStats.Summary.HEADER)
        assertTrue(block.contains("delta (with - without): median +30.0 ms, p95 +30.0 ms\n"))
        assertTrue(block.contains("3 of 3 pairs over one frame"))
        assertTrue(block.contains("-- loadUrl -> onPageFinished, ms --"))
        assertTrue(block.contains("arm proof: 3/3 with-arm loads"))
        assertTrue(block.contains("VERDICT (advisory; threshold > 16.7 ms = more than one frame at 60 Hz): the probe adds +30.0 ms median per load"))
        assertTrue(block.contains("EMULATOR numbers, not a device's"))
    }

    private fun sample(pair: Int, arm: Arm, startedMs: Double, probePending: Boolean = arm == Arm.WITH) =
        Sample(pair, arm, startedMs, startedMs + 1, startedMs + 2, startedMs + 50, probePending)
}
