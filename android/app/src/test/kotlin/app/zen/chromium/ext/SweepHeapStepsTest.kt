package app.zen.chromium.ext

import app.zen.chromium.ext.SweepHeapSteps.Mark
import app.zen.chromium.ext.SweepHeapSteps.Sample
import app.zen.chromium.ext.SweepHeapSteps.Segment
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** The compat sweep's heap peak per step (`CompatSweep.MemorySampler`), decided in [SweepHeapSteps]. */
class SweepHeapStepsTest {
    private val mb = 1_048_576L
    private val t0Sec = 1_790_000_000L
    private val t0 = t0Sec * 1000

    // Round 22's OOM row as the runtime logged it on 113 (the figures of its BEFORE): the install's
    // one-unit plan, then the worker's eleven-unit re-plan compiled in 7,787 ms.
    private val arrival1 = "$t0Sec.100  4321  4400 I ZenExt  : configure dgjbaljg 2.0.17: 1 unit(s) planned, 812 config chars, shapes 1 whole, heap 63/192 MB, previous runtime none"
    private val configured1 = "$t0Sec.900  4321  4321 I ZenExt  : configured dgjbaljg 2.0.17: 1 unit(s), 71234 chars (0 cached, 0 refused) in 640 ms, builders presized 71234 for 71234 chars (0 grown), shapes 1 whole, worlds [], heap 42/192 MB"
    private val arrival2 = "${t0Sec + 12}.000  4321  4400 I ZenExt  : configure dgjbaljg 2.0.17: 11 unit(s) planned, 19761656 config chars, shapes 1 carrier 10 thin, heap 83/192 MB, previous runtime none"
    private val configured2 = "${t0Sec + 21}.000  4321  4321 I ZenExt  : configured dgjbaljg 2.0.17: 11 unit(s), 19761656 chars (0 cached, 0 refused) in 7787 ms, builders presized 19761656 for 19761656 chars (0 grown), shapes 1 carrier 10 thin, worlds [3], heap 140/192 MB"

    @Test
    fun `the runtime's configure lines parse off logcat's epoch format`() {
        val a = SweepHeapSteps.parseConfigureLine(arrival1)!!
        assertEquals(t0 + 100, a.atMs)
        assertEquals("dgjbaljg", a.id8)
        assertEquals("2.0.17", a.version)
        assertEquals(false, a.configured)
        assertEquals(1, a.units)
        assertEquals(63, a.heapMb)
        assertEquals(192, a.maxMb)
        assertNull(a.compileMs)
        val c = SweepHeapSteps.parseConfigureLine(configured2)!!
        assertEquals(t0 + 21_000, c.atMs)
        assertEquals(true, c.configured)
        assertEquals(11, c.units)
        assertEquals(7787L, c.compileMs)
        assertEquals(140, c.heapMb)
        assertNull(SweepHeapSteps.parseConfigureLine("$t0Sec.100  4321  4321 I ZenExt  : configure of dgjbaljg 2.0.17 dropped: detached while its 11 unit(s) compiled (7787 ms)"))
        assertNull(SweepHeapSteps.parseConfigureLine("$t0Sec.100  4321  4321 I CompatSweep: ROW-START 1/60 dgjbaljgolmlcmmklmmeafecikidmjpi Adblock Ad Blocker Pro"))
        assertNull(SweepHeapSteps.parseConfigureLine("--------- beginning of main"))
    }

    @Test
    fun `an arrival and its configured line make a compile and an attach segment, per configure, for the row's id alone`() {
        val other = "$t0Sec.500  4321  4400 I ZenExt  : configure aefkmifg 1.2.3: 2 unit(s) planned, 100 config chars, shapes 2 whole, heap 70/192 MB, previous runtime none"
        val lines = listOf(arrival1, other, configured1, arrival2, configured2).mapNotNull(SweepHeapSteps::parseConfigureLine)
        val segments = SweepHeapSteps.segments(lines, "dgjbaljg")
        assertEquals(
            listOf(
                Segment(t0 + 100, t0 + 740, "compile 1"),
                Segment(t0 + 741, t0 + 900, "attach 1"),
                Segment(t0 + 12_000, t0 + 19_787, "compile 2"),
                Segment(t0 + 19_788, t0 + 21_000, "attach 2")
            ),
            segments
        )
        // An arrival still in flight (no configured line behind it) makes no segment; a compile
        // time longer than the gap to the configured line is clipped to it, no attach then.
        assertEquals(emptyList<Segment>(), SweepHeapSteps.segments(listOf(SweepHeapSteps.parseConfigureLine(arrival2)!!), "dgjbaljg"))
        val quick = SweepHeapSteps.parseConfigureLine("${t0Sec + 12}.050  4321  4321 I ZenExt  : configured dgjbaljg 2.0.17: 11 unit(s), 5 chars (11 cached, 0 refused) in 900 ms, builders presized 5 for 5 chars (0 grown), shapes 1 carrier, worlds [3], heap 90/192 MB")!!
        assertEquals(listOf(Segment(t0 + 12_000, t0 + 12_050, "compile 1")), SweepHeapSteps.segments(listOf(SweepHeapSteps.parseConfigureLine(arrival2)!!, quick), "dgjbaljg"))
    }

    @Test
    fun `a sample belongs to the runtime segment holding it, else the driver's last mark, else before`() {
        val marks = listOf(Mark(t0, "install"), Mark(t0 + 30_000, "background"), Mark(t0 + 40_000, "popup"))
        val segments = listOf(Segment(t0 + 12_000, t0 + 19_787, "compile 2"), Segment(t0 + 19_788, t0 + 21_000, "attach 2"))
        assertEquals("before", SweepHeapSteps.stepOf(t0 - 1, marks, segments))
        assertEquals("install", SweepHeapSteps.stepOf(t0, marks, segments))
        assertEquals("install", SweepHeapSteps.stepOf(t0 + 11_999, marks, segments))
        assertEquals("compile 2", SweepHeapSteps.stepOf(t0 + 12_000, marks, segments))
        assertEquals("compile 2", SweepHeapSteps.stepOf(t0 + 19_787, marks, segments))
        assertEquals("attach 2", SweepHeapSteps.stepOf(t0 + 19_788, marks, segments))
        assertEquals("install", SweepHeapSteps.stepOf(t0 + 21_001, marks, segments))
        assertEquals("background", SweepHeapSteps.stepOf(t0 + 30_000, marks, segments))
        assertEquals("popup", SweepHeapSteps.stepOf(t0 + 99_000, marks, segments))
        // Two segments nesting: the later to begin wins (another extension's compile inside this one's).
        val nested = segments + Segment(t0 + 12_500, t0 + 30_000, "other configure")
        assertEquals("compile 2", SweepHeapSteps.stepOf(t0 + 12_000, marks, nested))
        assertEquals("other configure", SweepHeapSteps.stepOf(t0 + 13_000, marks, nested))
        assertEquals("attach 2", SweepHeapSteps.stepOf(t0 + 20_000, marks, nested))
        assertEquals("other configure", SweepHeapSteps.stepOf(t0 + 25_000, marks, nested))
    }

    @Test
    fun `every step's peak, in the order the steps were seen, and the row's peak step - the compile's transient over the settled heap`() {
        val marks = listOf(Mark(t0, "install"), Mark(t0 + 30_000, "background"), Mark(t0 + 40_000, "popup"), Mark(t0 + 50_000, "settle"))
        val segments = listOf(Segment(t0 + 12_000, t0 + 19_787, "compile 2"), Segment(t0 + 19_788, t0 + 21_000, "attach 2"))
        val samples = listOf(
            Sample(t0 - 500, 40 * mb),
            Sample(t0 + 1_000, 63 * mb),
            Sample(t0 + 11_000, 83 * mb),
            Sample(t0 + 15_000, 150 * mb),
            Sample(t0 + 18_000, 184 * mb),
            Sample(t0 + 20_000, 160 * mb),
            Sample(t0 + 25_000, 140 * mb),
            Sample(t0 + 31_000, 141 * mb),
            Sample(t0 + 45_000, 165 * mb),
            Sample(t0 + 46_000, 165 * mb),
            Sample(t0 + 55_000, 129 * mb)
        )
        val peaks = SweepHeapSteps.attribute(samples, marks, segments)
        assertEquals(listOf("before", "install", "compile 2", "attach 2", "background", "popup", "settle"), peaks.map { it.step })
        val install = peaks.first { it.step == "install" }
        assertEquals(140 * mb, install.peakBytes)
        assertEquals(t0 + 25_000, install.peakAtMs)
        assertEquals(3, install.samples)
        assertEquals(t0 + 1_000, install.fromMs)
        assertEquals(t0 + 25_000, install.toMs)
        val compile = peaks.first { it.step == "compile 2" }
        assertEquals(184 * mb, compile.peakBytes)
        assertEquals(t0 + 18_000, compile.peakAtMs)
        assertEquals(2, compile.samples)
        assertEquals(compile, SweepHeapSteps.peak(peaks))
        // Equal peaks: the earlier step is named.
        val popup = peaks.first { it.step == "popup" }
        assertEquals(t0 + 45_000, popup.peakAtMs)
        assertEquals(popup, SweepHeapSteps.peak(peaks.filter { it.step == "popup" || it.step == "settle" } + popup.copy(step = "later", peakAtMs = t0 + 60_000)))
        assertNull(SweepHeapSteps.peak(emptyList()))
        assertEquals(emptyList<SweepHeapSteps.StepPeak>(), SweepHeapSteps.attribute(emptyList(), marks, segments))
    }

    @Test
    fun `a peak within a tenth of the cap, or twenty mebibytes above its before, is a regression of its own`() {
        val mib = 1_048_576L
        val cap = 192_000_000L
        val atTenth = 172_800_000L
        val near = SweepHeapSteps.peakGate(atTenth, cap)
        assertEquals(true, near.withinTenthOfCap)
        assertEquals(false, near.grown20MiB)
        assertEquals(true, near.regression)
        val under = SweepHeapSteps.peakGate(atTenth - 1, cap)
        assertEquals(false, under.withinTenthOfCap)
        assertEquals(false, under.regression)

        val before = 100 * mib
        val grown = SweepHeapSteps.peakGate(120 * mib, 512 * mib, before)
        assertEquals(false, grown.withinTenthOfCap)
        assertEquals(true, grown.grown20MiB)
        assertEquals(true, grown.regression)
        val shy = SweepHeapSteps.peakGate((119.9 * mib).toLong(), 512 * mib, before)
        assertEquals(false, shy.grown20MiB)
        assertEquals(false, shy.regression)
        val noBefore = SweepHeapSteps.peakGate(120 * mib, 512 * mib, null)
        assertEquals(false, noBefore.grown20MiB)
        assertEquals(false, noBefore.regression)
        assertEquals(false, SweepHeapSteps.peakGate(0, cap).withinTenthOfCap)
        assertEquals(false, SweepHeapSteps.peakGate(atTenth, 0, before).grown20MiB)
        assertEquals(false, SweepHeapSteps.peakGate(0, 0, before).regression)
    }
}
