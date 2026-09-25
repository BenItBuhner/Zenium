package app.zen.chromium

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The `posture` host event's shape (OS-11, `Posture.kt`): the fold's state as the kind, its
 * bounds in CSS px, its orientation and separation; a repeat is the same report; the log's line.
 */
class PostureReportTest {
    private val tabletop = Posture.Report.describe(
        halfOpened = true,
        horizontal = true,
        left = 0,
        top = 1200,
        right = 2520,
        bottom = 1260,
        separating = true,
        density = 3f
    )

    @Test
    fun `flat with no fold carries a null hinge`() {
        val flat = Posture.Report.flat()
        assertEquals("flat", flat.getString("kind"))
        assertTrue(flat.has("hinge"))
        assertTrue(flat.isNull("hinge"))
    }

    @Test
    fun `a half-opened fold is the kind with its hinge in CSS px`() {
        assertEquals("halfOpened", tabletop.getString("kind"))
        val hinge = tabletop.getJSONObject("hinge")
        assertEquals(0.0, hinge.getDouble("left"), 0.0)
        assertEquals(400.0, hinge.getDouble("top"), 0.0)
        assertEquals(840.0, hinge.getDouble("right"), 0.0)
        assertEquals(420.0, hinge.getDouble("bottom"), 0.0)
        assertEquals("horizontal", hinge.getString("orientation"))
        assertTrue(hinge.getBoolean("separating"))
    }

    @Test
    fun `a flat fold keeps the fold's line, vertical for a book`() {
        val book = Posture.Report.describe(
            halfOpened = false,
            horizontal = false,
            left = 1258,
            top = 0,
            right = 1262,
            bottom = 2100,
            separating = false,
            density = 2f
        )
        assertEquals("flat", book.getString("kind"))
        val hinge = book.getJSONObject("hinge")
        assertEquals(629.0, hinge.getDouble("left"), 0.0)
        assertEquals(631.0, hinge.getDouble("right"), 0.0)
        assertEquals(1050.0, hinge.getDouble("bottom"), 0.0)
        assertEquals("vertical", hinge.getString("orientation"))
        assertFalse(hinge.getBoolean("separating"))
    }

    @Test
    fun `a density of zero divides by nothing`() {
        val report = Posture.Report.describe(true, true, 0, 10, 20, 30, false, 0f)
        assertEquals(10.0, report.getJSONObject("hinge").getDouble("top"), 0.0)
    }

    @Test
    fun `the same pose and hinge is a repeat, a moved hinge or another kind is not`() {
        val again = Posture.Report.describe(true, true, 0, 1200, 2520, 1260, true, 3f)
        assertTrue(Posture.Report.same(tabletop, again))
        assertTrue(Posture.Report.same(Posture.Report.flat(), Posture.Report.flat()))
        assertFalse(Posture.Report.same(tabletop, Posture.Report.flat()))
        assertFalse(Posture.Report.same(tabletop, Posture.Report.describe(false, true, 0, 1200, 2520, 1260, true, 3f)))
        assertFalse(Posture.Report.same(tabletop, Posture.Report.describe(true, true, 0, 1203, 2520, 1260, true, 3f)))
        assertFalse(Posture.Report.same(tabletop, Posture.Report.describe(true, false, 0, 1200, 2520, 1260, true, 3f)))
        assertFalse(Posture.Report.same(tabletop, Posture.Report.describe(true, true, 0, 1200, 2520, 1260, false, 3f)))
    }

    @Test
    fun `the log's line names the pose and the hinge`() {
        assertEquals("flat", Posture.Report.line(Posture.Report.flat()))
        assertEquals("halfOpened, horizontal hinge 20.0 tall at y 400.0, separating", Posture.Report.line(tabletop))
        val book = Posture.Report.describe(true, false, 1258, 0, 1262, 2100, false, 2f)
        assertEquals("halfOpened, vertical hinge 2.0 wide at x 629.0", Posture.Report.line(book))
    }
}
