package app.zen.chromium

import app.zen.chromium.HistoryNavClassifier.Edge
import app.zen.chromium.HistoryNavClassifier.Nav
import app.zen.chromium.HistoryNavClassifier.State
import app.zen.chromium.HistoryNavClassifier.Step
import app.zen.chromium.PullGestureClassifier.Disposition
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class HistoryNavClassifierTest {
    private val slop = 8f
    /** Chrome's 24 dp edge at a density of 2.5 (a 1080 px wide phone is 432 dp). */
    private val edge = 60f
    private val width = 1080f

    private fun classifier() = HistoryNavClassifier(slop, edge)

    /** A finger at the left edge of a page that can go back, dragged `dx` into the page, with the page reporting the overscroll. */
    private fun dragFromLeft(c: HistoryNavClassifier, dx: Float, dy: Float = 0f, allows: Boolean = true): Step? {
        assertEquals(Step.FORWARD, c.down(20f, 600f, width, canBack = true, canForward = true))
        assertNull(c.pageAnswered(allows))
        assertEquals(Step.FORWARD, c.move(20f + dx, 600f + dy, 10L))
        return c.overscrolledX(Edge.LEFT)
    }

    @Test
    fun aDragInFromTheLeftEdgeGoesBackOnceThePageOverscrolls() {
        val c = classifier()
        assertEquals(Step(Disposition.CANCEL_WEBVIEW, Nav.Start(Edge.LEFT)), dragFromLeft(c, 30f))
        assertEquals(State.DRAGGING, c.state)
        assertEquals(Edge.LEFT, c.edge)
        // Travel counts from where the drag took over, so the bubble starts from its edge.
        assertEquals(Step(Disposition.CONSUME, Nav.Move(0f, 20L)), c.move(50f, 600f, 20L))
        assertEquals(Step(Disposition.CONSUME, Nav.Move(120f, 30L)), c.move(170f, 604f, 30L))
        assertEquals(Step(Disposition.CONSUME, Nav.Release(40L)), c.up(40L))
        assertEquals(State.IDLE, c.state)
    }

    @Test
    fun aDragInFromTheRightEdgeGoesForwardWithTravelMeasuredInward() {
        val c = classifier()
        assertEquals(Step.FORWARD, c.down(1070f, 600f, width, canBack = true, canForward = true))
        assertNull(c.pageAnswered(true))
        assertEquals(Step.FORWARD, c.move(1030f, 602f, 10L))
        // The page reports its left side clamped too (it cannot scroll sideways at all): not this drag's side.
        assertNull(c.overscrolledX(Edge.LEFT))
        assertEquals(State.WATCHING, c.state)
        assertEquals(Step(Disposition.CANCEL_WEBVIEW, Nav.Start(Edge.RIGHT)), c.overscrolledX(Edge.RIGHT))
        assertEquals(Step(Disposition.CONSUME, Nav.Move(80f, 20L)), c.move(950f, 600f, 20L))
        assertEquals(Step(Disposition.CONSUME, Nav.Release(30L)), c.up(30L))
    }

    @Test
    fun theWebViewSeesEverythingUntilTheDragTakesOver() {
        val c = classifier()
        assertEquals(Step.FORWARD, c.down(20f, 600f, width, canBack = true, canForward = false))
        assertEquals(State.WATCHING, c.state)
        assertEquals(Step.FORWARD, c.move(24f, 600f, 10L))
        assertEquals(Step.FORWARD, c.move(40f, 601f, 20L))
        // Lifted before any overscroll came back: a tap or a tiny drag, all the WebView's.
        assertEquals(Step.FORWARD, c.up(30L))
        assertEquals(State.IDLE, c.state)
    }

    @Test
    fun aFingerAwayFromTheEdgesIsTheWebViews() {
        val c = classifier()
        assertEquals(Step.FORWARD, c.down(edge, 600f, width, canBack = true, canForward = true))
        assertEquals(State.PASSTHROUGH, c.state)
        c.move(200f, 600f, 10L)
        assertNull(c.overscrolledX(Edge.LEFT))
        assertNull(c.pageAnswered(true))
        assertEquals(Step.FORWARD, c.up(20L))

        val inside = classifier()
        assertEquals(Step.FORWARD, inside.down(width - edge, 600f, width, canBack = true, canForward = true))
        assertEquals(State.PASSTHROUGH, inside.state)
    }

    @Test
    fun anEdgeWithNothingToGoToNeverArms() {
        val noBack = classifier()
        assertEquals(Step.FORWARD, noBack.down(10f, 600f, width, canBack = false, canForward = true))
        assertEquals(State.PASSTHROUGH, noBack.state)
        noBack.move(100f, 600f, 10L)
        assertNull(noBack.overscrolledX(Edge.LEFT))

        val noForward = classifier()
        assertEquals(Step.FORWARD, noForward.down(1075f, 600f, width, canBack = true, canForward = false))
        assertEquals(State.PASSTHROUGH, noForward.state)

        // Gesture navigation mode: the caller passes both as false, and the edges stay the system's.
        val gestureMode = classifier()
        assertEquals(Step.FORWARD, gestureMode.down(10f, 600f, width, canBack = false, canForward = false))
        assertEquals(State.PASSTHROUGH, gestureMode.state)
    }

    @Test
    fun aDragOutsideTheThirtyDegreeConeIsAScroll() {
        // 40 across, 30 down: 40 < 30 × 1.73, too steep.
        val diagonal = classifier()
        assertNull(dragFromLeft(diagonal, 40f, dy = 30f))
        assertEquals(State.PASSTHROUGH, diagonal.state)
        assertEquals(Step.FORWARD, diagonal.move(100f, 640f, 20L))
        assertEquals(Step.FORWARD, diagonal.up(30L))

        // 60 across, 30 down: 60 > 51.9, inside the cone.
        val shallow = classifier()
        assertEquals(Step(Disposition.CANCEL_WEBVIEW, Nav.Start(Edge.LEFT)), dragFromLeft(shallow, 60f, dy = 30f))

        val vertical = classifier()
        vertical.down(20f, 600f, width, canBack = true, canForward = true)
        vertical.pageAnswered(true)
        vertical.move(21f, 630f, 10L)
        assertEquals(State.PASSTHROUGH, vertical.state)
        // Curling sideways afterwards does not make it a drag.
        vertical.move(120f, 632f, 20L)
        assertNull(vertical.overscrolledX(Edge.LEFT))
    }

    @Test
    fun aDragOutOverTheEdgeIsTheWebViews() {
        val c = classifier()
        c.down(20f, 600f, width, canBack = true, canForward = true)
        c.pageAnswered(true)
        c.move(4f, 600f, 10L) // towards the edge, past the slop
        assertEquals(State.PASSTHROUGH, c.state)
        assertNull(c.overscrolledX(Edge.LEFT))
    }

    @Test
    fun aWobbleWithinTheSlopIsStillWatching() {
        val c = classifier()
        c.down(20f, 600f, width, canBack = true, canForward = true)
        c.pageAnswered(true)
        c.move(17f, 604f, 10L) // 3 back, 4 down: within the slop either way
        assertEquals(State.WATCHING, c.state)
        // The page cannot scroll sideways and reports the overscroll for that wobble: not a drag yet.
        assertNull(c.overscrolledX(Edge.LEFT))
        assertEquals(State.WATCHING, c.state)
        // …and then in: the drag starts from here.
        c.move(60f, 606f, 20L)
        assertEquals(Step(Disposition.CANCEL_WEBVIEW, Nav.Start(Edge.LEFT)), c.overscrolledX(Edge.LEFT))
    }

    @Test
    fun aPageThatContainsItsSidewaysOverscrollKeepsTheDrag() {
        val c = classifier()
        assertNull(dragFromLeft(c, 40f, allows = false))
        assertEquals(State.PASSTHROUGH, c.state)
        assertEquals(Step.FORWARD, c.move(120f, 600f, 20L))
        assertEquals(Step.FORWARD, c.up(30L))
    }

    @Test
    fun anOverscrollBeforeThePageAnsweredActivatesWhenTheAnswerComes() {
        val c = classifier()
        c.down(20f, 600f, width, canBack = true, canForward = true)
        c.move(60f, 600f, 10L)
        assertNull(c.overscrolledX(Edge.LEFT)) // the probe is still on its way
        assertEquals(State.WATCHING, c.state)
        assertEquals(Step(Disposition.CANCEL_WEBVIEW, Nav.Start(Edge.LEFT)), c.pageAnswered(true))
        assertEquals(State.DRAGGING, c.state)

        val contained = classifier()
        contained.down(20f, 600f, width, canBack = true, canForward = true)
        contained.move(60f, 600f, 10L)
        assertNull(contained.overscrolledX(Edge.LEFT))
        assertNull(contained.pageAnswered(false))
        assertEquals(State.PASSTHROUGH, contained.state)
    }

    @Test
    fun aSecondFingerHandsTheGestureBackToTheWebView() {
        val c = classifier()
        dragFromLeft(c, 40f)
        assertEquals(State.DRAGGING, c.state)
        assertEquals(Step(Disposition.HANDBACK, Nav.Cancel(20L)), c.pointerDown(20L))
        assertEquals(State.PASSTHROUGH, c.state)
        assertEquals(Step.FORWARD, c.move(200f, 600f, 30L))
        assertNull(c.overscrolledX(Edge.LEFT))
        assertEquals(Step.FORWARD, c.up(40L))

        val watching = classifier()
        watching.down(20f, 600f, width, canBack = true, canForward = true)
        assertEquals(Step.FORWARD, watching.pointerDown(10L))
        assertEquals(State.PASSTHROUGH, watching.state)
    }

    @Test
    fun aFingerThatComesBackTowardsTheEdgeKeepsTheDragWithNegativeTravel() {
        val c = classifier()
        dragFromLeft(c, 40f)
        // The chrome clamps the bubble at its edge; the finger stays the drag's until it lifts.
        assertEquals(Step(Disposition.CONSUME, Nav.Move(-20f, 20L)), c.move(40f, 600f, 20L))
        assertEquals(State.DRAGGING, c.state)
        assertEquals(Step(Disposition.CONSUME, Nav.Move(100f, 30L)), c.move(160f, 600f, 30L))
    }

    @Test
    fun aSystemCancelEndsTheDrag() {
        val c = classifier()
        dragFromLeft(c, 40f)
        assertEquals(Step(Disposition.CONSUME, Nav.Cancel(20L)), c.cancel(20L))
        assertEquals(State.IDLE, c.state)

        val watching = classifier()
        watching.down(20f, 600f, width, canBack = true, canForward = true)
        assertEquals(Step.FORWARD, watching.cancel(10L))
        assertEquals(State.IDLE, watching.state)
    }

    @Test
    fun aNewDownStartsAfresh() {
        val c = classifier()
        dragFromLeft(c, 40f)
        c.up(20L)
        // The earlier finger's overscroll and answer do not carry over.
        assertEquals(Step.FORWARD, c.down(20f, 600f, width, canBack = true, canForward = true))
        assertEquals(State.WATCHING, c.state)
        c.move(60f, 600f, 30L)
        assertNull(c.overscrolledX(Edge.LEFT))
        assertEquals(Step(Disposition.CANCEL_WEBVIEW, Nav.Start(Edge.LEFT)), c.pageAnswered(true))
    }
}
