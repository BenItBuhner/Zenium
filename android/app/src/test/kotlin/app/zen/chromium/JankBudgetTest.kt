package app.zen.chromium

import app.zen.chromium.JankBudget.Budget
import app.zen.chromium.JankBudget.Gate
import app.zen.chromium.JankBudget.Kind
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

/** The jank budget's evaluation behind `DemoHarness.measureFrames` ([JankBudget]). */
class JankBudgetTest {
    private val budget = Budget(jankyShare = 0.3, p95Ms = 40, provisional = false)

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
    fun `the kinds are keyed by their JSON names and each has a budget of its own`() {
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
            assertTrue("${kind.key}: a share is 0 to 1", b.jankyShare in 0.0..1.0)
            assertTrue("${kind.key}: a positive 95th", b.p95Ms > 0)
        }
    }

    // --- the evaluation --------------------------------------------------------------------------

    @Test
    fun `a scene inside its budget is within, at the budget's edge included`() {
        assertEquals(JankBudget.Verdict(within = true, breaches = emptyList()), JankBudget.evaluate(budget, frames = 100, jankyShare = 0.2, p95Ms = 30))
        assertTrue(JankBudget.evaluate(budget, frames = 10, jankyShare = 3.0 / 10, p95Ms = 40).within)
        // A share read as janky / frames is a ratio of integers: floating-point noise on the edge is no breach.
        assertTrue(JankBudget.evaluate(budget, frames = 10, jankyShare = 0.1 + 0.2, p95Ms = 40).within)
    }

    @Test
    fun `a janky share over the budget is named as whole percents`() {
        val verdict = JankBudget.evaluate(budget, frames = 83, jankyShare = 41.0 / 83, p95Ms = 30)
        assertFalse(verdict.within)
        assertEquals(listOf("janky 49% > 30%"), verdict.breaches)
        assertEquals("over: janky 49% > 30%", verdict.describe())
    }

    @Test
    fun `a 95th percentile over the budget is named in ms`() {
        val verdict = JankBudget.evaluate(budget, frames = 83, jankyShare = 0.1, p95Ms = 41)
        assertEquals(listOf("p95 41 ms > 40 ms"), verdict.breaches)
    }

    @Test
    fun `both over - both named, the share first`() {
        val verdict = JankBudget.evaluate(budget, frames = 83, jankyShare = 0.9, p95Ms = 400)
        assertEquals(listOf("janky 90% > 30%", "p95 400 ms > 40 ms"), verdict.breaches)
        assertEquals("over: janky 90% > 30%; p95 400 ms > 40 ms", verdict.describe())
    }

    @Test
    fun `a scene that rendered no frames is a breach of its own - an unmeasured scene never passes`() {
        val verdict = JankBudget.evaluate(budget, frames = 0, jankyShare = 0.0, p95Ms = 0)
        assertFalse(verdict.within)
        assertEquals(listOf("no frames were recorded for the scene"), verdict.breaches)
        assertEquals(verdict, JankBudget.evaluate(budget, frames = -1, jankyShare = 0.0, p95Ms = 0))
    }

    @Test
    fun `a breach is enforced under a hard gate alone`() {
        val over = JankBudget.evaluate(budget, frames = 83, jankyShare = 0.9, p95Ms = 30)
        val within = JankBudget.evaluate(budget, frames = 83, jankyShare = 0.1, p95Ms = 30)
        assertTrue(JankBudget.enforces(Gate.HARD, over))
        assertFalse(JankBudget.enforces(Gate.SOFT, over))
        assertFalse(JankBudget.enforces(Gate.HARD, within))
        assertFalse(JankBudget.enforces(Gate.SOFT, within))
    }

    // --- the words -------------------------------------------------------------------------------

    @Test
    fun `a budget describes itself, and says when it is provisional`() {
        assertEquals("janky <= 30%, p95 <= 40 ms", budget.describe())
        assertEquals("janky <= 55%, p95 <= 120 ms (provisional)", Budget(0.55, 120, provisional = true).describe())
        assertEquals("within", JankBudget.Verdict(within = true, breaches = emptyList()).describe())
    }
}
