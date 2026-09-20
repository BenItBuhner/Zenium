package app.zen.chromium

import app.zen.chromium.JankBudget.Budget
import app.zen.chromium.JankBudget.Gate
import app.zen.chromium.JankBudget.Kind
import app.zen.chromium.JankBudget.Reading
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The jank budget's evaluation behind `DemoHarness.measureFrames` / `traceFrames` ([JankBudget]):
 * the RATIO half against a same-run baseline scene, the TRACE half on the renderer main thread's
 * columns, and – the perf program's ruling for the software-GPU recipe – no absolute frame-time
 * gate at all: a scene with neither baseline nor trace is reported only, whatever its frame times.
 */
class JankBudgetTest {
    private val budget = Budget(p95Ratio = 1.5, sharePoints = 0.10, layoutsPerFrame = 1.0, paintsPerFrame = 0.5, mainThreadP95Ms = 20.0, longTasks = 1, provisional = false)

    /** HWUI's numbers of a scene on the recipe: every frame janky, frame times in the hundreds of ms. */
    private fun hwui(frames: Int = 100, janky: Int = frames, p95Ms: Int = 400, trace: BlinkTrace.Reading? = null, traceMissing: String? = null) =
        Reading(frames, if (frames > 0) janky.toDouble() / frames else 0.0, p95Ms, trace, traceMissing)

    /** A renderer main-thread reading with the counts given. */
    private fun trace(frames: Int = 20, layouts: Int = 0, paints: Int = 0, p95Ms: Double? = 10.0, longTasks: Int = 0, found: Boolean = true) =
        BlinkTrace.Reading(
            found = found, thread = if (found) "4242:4242" else null, frames = frames,
            frameMs = p95Ms?.let { BlinkTrace.Stat(it / 2, it, it) }, busyMs = 100.0, scriptMs = 5.0,
            layoutCount = layouts, paintCount = paints, styleRecalcCount = frames, layerChurn = 0,
            longTasks = longTasks, longestTaskMs = 60.0, events = 100, threads = 3, windowMs = 1000.0, whole = false
        )

    // --- the gate and the kinds ------------------------------------------------------------------

    @Test
    fun `the gate reads hard in any case and with spaces, and soft for everything else`() {
        assertEquals(Gate.HARD, Gate.parse("hard"))
        assertEquals(Gate.HARD, Gate.parse("HARD"))
        assertEquals(Gate.HARD, Gate.parse(" Hard "))
        assertEquals(Gate.SOFT, Gate.parse("soft"))
        assertEquals(Gate.SOFT, Gate.parse(null))
        assertEquals(Gate.SOFT, Gate.parse(""))
        assertEquals(Gate.SOFT, Gate.parse("strict"))
        assertEquals("hard", Gate.HARD.key)
        assertEquals("soft", Gate.SOFT.key)
    }

    @Test
    fun `the kinds are keyed by their JSON names and each has a budget of ratios and trace columns, no absolute frame time`() {
        assertEquals(Kind.GESTURE, Kind.parse("gesture"))
        assertEquals(Kind.SPRING, Kind.parse("spring"))
        assertEquals(Kind.OPEN, Kind.parse("open"))
        assertNull(Kind.parse("scroll"))
        assertNull(Kind.parse(null))
        assertSame(JankBudget.GESTURE_BUDGET, JankBudget.budgetFor(Kind.GESTURE))
        assertSame(JankBudget.SPRING_BUDGET, JankBudget.budgetFor(Kind.SPRING))
        assertSame(JankBudget.OPEN_BUDGET, JankBudget.budgetFor(Kind.OPEN))
        for (kind in Kind.values()) {
            val b = JankBudget.budgetFor(kind)
            assertTrue("${kind.key}: a ratio of at least 1", b.p95Ratio >= 1.0)
            assertTrue("${kind.key}: share points are 0 to 1", b.sharePoints in 0.0..1.0)
            assertTrue("${kind.key}: positive per-frame counts", b.layoutsPerFrame > 0 && b.paintsPerFrame > 0)
            assertTrue("${kind.key}: a positive main-thread 95th", b.mainThreadP95Ms > 0)
            assertTrue("${kind.key}: long tasks are a count", b.longTasks >= 0)
        }
    }

    // --- reported only ---------------------------------------------------------------------------

    @Test
    fun `a scene with neither baseline nor trace is reported only - within whatever its frame times, and says so`() {
        val verdict = JankBudget.evaluate(budget, hwui(frames = 83, janky = 83, p95Ms = 5000))
        assertTrue(verdict.within)
        assertEquals(emptyList<String>(), verdict.gated)
        assertEquals(emptyList<String>(), verdict.breaches)
        assertEquals(listOf("reported only: the scene names no baseline and took no trace"), verdict.notes)
        assertEquals("reported only (no baseline, no trace)", verdict.describe())
    }

    @Test
    fun `a scene that rendered no frames is a breach of its own - an unmeasured scene never passes`() {
        val verdict = JankBudget.evaluate(budget, hwui(frames = 0), baselineName = "control", baseline = hwui())
        assertFalse(verdict.within)
        assertEquals(listOf("no frames were recorded for the scene"), verdict.breaches)
        assertEquals(emptyList<String>(), verdict.gated)
        assertEquals(verdict, JankBudget.evaluate(budget, Reading(-1, 0.0, 0)))
    }

    // --- the ratio half --------------------------------------------------------------------------

    @Test
    fun `a scene inside its ratios is within, at the budget's edge included, gated on the ratio`() {
        val baseline = hwui(frames = 80, janky = 72, p95Ms = 400)
        val verdict = JankBudget.evaluate(budget, hwui(frames = 100, janky = 100, p95Ms = 600), "control", baseline)
        assertEquals(JankBudget.Verdict(within = true, breaches = emptyList(), gated = listOf("ratio"), notes = emptyList()), verdict)
        assertEquals("within (gated on ratio)", verdict.describe())
        val ratio = JankBudget.ratio(hwui(frames = 100, janky = 100, p95Ms = 600), baseline)
        assertEquals(1.5, ratio.p95!!, 1e-9)
        assertEquals(0.10, ratio.sharePoints, 1e-9)
        assertEquals("p95 1.5x the baseline's, janky +10 pt", ratio.describe())
    }

    @Test
    fun `a 95th percentile over the ratio is named with both numbers and the ratio`() {
        val verdict = JankBudget.evaluate(budget, hwui(p95Ms = 900), "control", hwui(p95Ms = 400))
        assertFalse(verdict.within)
        assertEquals(listOf("p95 900 ms is 2.25x the baseline's 400 ms > 1.5x"), verdict.breaches)
        assertEquals("over: p95 900 ms is 2.25x the baseline's 400 ms > 1.5x", verdict.describe())
    }

    @Test
    fun `a janky share over the baseline's by more than the points is named in percents and points`() {
        val verdict = JankBudget.evaluate(budget, hwui(frames = 83, janky = 41, p95Ms = 400), "control", hwui(frames = 27, janky = 9, p95Ms = 400))
        assertEquals(listOf("janky 49.4% is +16.06 pt over the baseline's 33.33% > +10 pt"), verdict.breaches)
    }

    @Test
    fun `both ratios over - both named, the 95th first`() {
        val verdict = JankBudget.evaluate(budget, hwui(frames = 100, janky = 100, p95Ms = 900), "control", hwui(frames = 100, janky = 50, p95Ms = 400))
        assertEquals(listOf("p95 900 ms is 2.25x the baseline's 400 ms > 1.5x", "janky 100% is +50 pt over the baseline's 50% > +10 pt"), verdict.breaches)
    }

    @Test
    fun `a scene better than its baseline is within, and the ratio says by how much`() {
        val ratio = JankBudget.ratio(hwui(frames = 100, janky = 90, p95Ms = 300), hwui(frames = 100, janky = 95, p95Ms = 400))
        assertEquals(0.75, ratio.p95!!, 1e-9)
        assertEquals(-0.05, ratio.sharePoints, 1e-9)
        assertEquals("p95 0.75x the baseline's, janky -5 pt", ratio.describe())
        assertTrue(JankBudget.evaluate(budget, hwui(frames = 100, janky = 90, p95Ms = 300), "control", hwui(frames = 100, janky = 95, p95Ms = 400)).within)
    }

    @Test
    fun `a baseline the run never measured, one without frames, one with a 95th of zero - each a breach, the ratio still gated`() {
        val missing = JankBudget.evaluate(budget, hwui(), "control", null)
        assertEquals(listOf("baseline 'control' was not measured in this run"), missing.breaches)
        assertEquals(listOf("ratio"), missing.gated)
        assertEquals(listOf("baseline 'control' recorded no frames"), JankBudget.evaluate(budget, hwui(), "control", hwui(frames = 0)).breaches)
        val zero = JankBudget.evaluate(budget, hwui(), "control", hwui(p95Ms = 0))
        assertEquals(listOf("baseline 'control' has a 95th percentile of 0 ms: no ratio"), zero.breaches)
        val ratio = JankBudget.ratio(hwui(), hwui(p95Ms = 0))
        assertNull(ratio.p95)
        assertEquals("p95 - the baseline's, janky +0 pt", ratio.describe())
    }

    // --- the trace half --------------------------------------------------------------------------

    @Test
    fun `a trace inside its columns is within, at every edge, gated on the trace`() {
        val verdict = JankBudget.evaluate(budget, hwui(trace = trace(frames = 20, layouts = 20, paints = 10, p95Ms = 20.0, longTasks = 1)))
        assertTrue(verdict.breaches.toString(), verdict.within)
        assertEquals(listOf("trace"), verdict.gated)
        assertEquals(emptyList<String>(), verdict.notes)
        assertEquals("within (gated on trace)", verdict.describe())
    }

    @Test
    fun `each trace column over its budget is named - layouts and paints per frame, the main-thread 95th, the long tasks`() {
        val verdict = JankBudget.evaluate(budget, hwui(trace = trace(frames = 20, layouts = 41, paints = 15, p95Ms = 20.5, longTasks = 2)))
        assertEquals(
            listOf("layouts 2.05/frame > 1/frame", "paints 0.75/frame > 0.5/frame", "main-thread p95 20.5 ms/frame > 20 ms", "2 long tasks > 1"),
            verdict.breaches
        )
        assertEquals(listOf("layouts 2.05/frame > 1/frame"), JankBudget.evaluate(budget, hwui(trace = trace(frames = 20, layouts = 41))).breaches)
        assertEquals(listOf("2 long tasks > 1"), JankBudget.evaluate(budget, hwui(trace = trace(longTasks = 2))).breaches)
    }

    @Test
    fun `a trace with the frames as instants alone has no main-thread time to gate - the counts per frame still are`() {
        val verdict = JankBudget.evaluate(budget, hwui(trace = trace(frames = 10, layouts = 10, p95Ms = null)))
        assertTrue(verdict.within)
        assertEquals(listOf("paints 0.6/frame > 0.5/frame"), JankBudget.evaluate(budget, hwui(trace = trace(frames = 10, paints = 6, p95Ms = null))).breaches)
    }

    @Test
    fun `a trace that saw no frame counts per one frame, with a note`() {
        val verdict = JankBudget.evaluate(budget, hwui(trace = trace(frames = 0, layouts = 3, p95Ms = null)))
        assertEquals(listOf("layouts 3/frame > 1/frame"), verdict.breaches)
        assertEquals(listOf("the trace saw no main-thread frame: the per-frame counts are the counts themselves"), verdict.notes)
    }

    @Test
    fun `a trace without a renderer main thread, or a trace asked for and not read, is a breach - the gate never passes what it could not see`() {
        val unfound = JankBudget.evaluate(budget, hwui(trace = trace(found = false)))
        assertEquals(listOf("the trace has no renderer main thread"), unfound.breaches)
        assertEquals(listOf("trace"), unfound.gated)
        val missing = JankBudget.evaluate(budget, hwui(traceMissing = "WebView tracing did not start"))
        assertEquals(listOf("no trace was read: WebView tracing did not start"), missing.breaches)
        assertEquals(listOf("trace"), missing.gated)
        assertEquals("over: no trace was read: WebView tracing did not start", missing.describe())
    }

    // --- both halves, the gate, the words --------------------------------------------------------

    @Test
    fun `a scene with a baseline and a trace is gated on both, the ratio's breaches before the trace's`() {
        val within = JankBudget.evaluate(budget, hwui(p95Ms = 500, trace = trace()), "control", hwui(p95Ms = 400))
        assertTrue(within.within)
        assertEquals(listOf("ratio", "trace"), within.gated)
        assertEquals("within (gated on ratio + trace)", within.describe())
        val over = JankBudget.evaluate(budget, hwui(p95Ms = 900, trace = trace(longTasks = 3)), "control", hwui(p95Ms = 400))
        assertEquals(listOf("p95 900 ms is 2.25x the baseline's 400 ms > 1.5x", "3 long tasks > 1"), over.breaches)
    }

    @Test
    fun `a breach is enforced under a hard gate alone`() {
        val over = JankBudget.evaluate(budget, hwui(trace = trace(longTasks = 5)))
        val within = JankBudget.evaluate(budget, hwui(trace = trace()))
        assertTrue(JankBudget.enforces(Gate.HARD, over))
        assertFalse(JankBudget.enforces(Gate.SOFT, over))
        assertFalse(JankBudget.enforces(Gate.HARD, within))
        assertFalse(JankBudget.enforces(Gate.SOFT, within))
    }

    @Test
    fun `a budget describes itself, and says when it is provisional`() {
        assertEquals(
            "vs baseline p95 <= 1.5x, janky <= +10 pt; trace layouts <= 1/frame, paints <= 0.5/frame, main-thread p95 <= 20 ms, long tasks <= 1",
            budget.describe()
        )
        assertEquals(
            "vs baseline p95 <= 2x, janky <= +10 pt; trace layouts <= 2/frame, paints <= 2/frame, main-thread p95 <= 120 ms, long tasks <= 3 (provisional)",
            Budget(2.0, 0.10, 2.0, 2.0, 120.0, 3, provisional = true).describe()
        )
        assertTrue(JankBudget.GESTURE_BUDGET.describe(), JankBudget.GESTURE_BUDGET.describe().endsWith("(provisional)") == JankBudget.GESTURE_BUDGET.provisional)
    }
}
