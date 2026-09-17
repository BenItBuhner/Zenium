package app.zen.chromium

import app.zen.chromium.PullGestureClassifier.Disposition
import app.zen.chromium.PullGestureClassifier.Pull
import app.zen.chromium.PullGestureClassifier.State
import app.zen.chromium.PullGestureClassifier.Step
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class PullGestureClassifierTest {
    private val slop = 8f

    private fun classifier() = PullGestureClassifier(slop)

    /** A finger at the top of an ordinary page, moved `dy` down, with the page reporting the overscroll. */
    private fun pullTo(c: PullGestureClassifier, dy: Float, allows: Boolean = true): Step? {
        assertEquals(Step.FORWARD, c.down(100f, 300f, atTop = true, eligible = true))
        assertNull(c.pageAnswered(allows))
        assertEquals(Step.FORWARD, c.move(100f, 300f + dy, 10L, atTop = true))
        return c.overscrolledTop()
    }

    @Test
    fun aDownwardDragAtTheTopBecomesAPullOnceThePageOverscrolls() {
        val c = classifier()
        val start = pullTo(c, 20f)
        assertEquals(Step(Disposition.CANCEL_WEBVIEW, Pull.Start), start)
        assertEquals(State.PULLING, c.state)
        // Travel counts from where the pull took over, so the page starts moving from rest.
        assertEquals(Step(Disposition.CONSUME, Pull.Move(0f, 20L)), c.move(100f, 320f, 20L, atTop = true))
        assertEquals(Step(Disposition.CONSUME, Pull.Move(45f, 30L)), c.move(100f, 365f, 30L, atTop = true))
        assertEquals(Step(Disposition.CONSUME, Pull.Release(40L)), c.up(40L))
        assertEquals(State.IDLE, c.state)
    }

    @Test
    fun theWebViewSeesEverythingUntilThePullTakesOver() {
        val c = classifier()
        assertEquals(Step.FORWARD, c.down(100f, 300f, atTop = true, eligible = true))
        assertEquals(State.WATCHING, c.state)
        assertEquals(Step.FORWARD, c.move(100f, 304f, 10L, atTop = true))
        assertEquals(Step.FORWARD, c.move(100f, 312f, 20L, atTop = true))
        // Lifted before any overscroll came back: a tap or a tiny drag, all the WebView's.
        assertEquals(Step.FORWARD, c.up(30L))
        assertEquals(State.IDLE, c.state)
    }

    @Test
    fun aPageThatIsNotAtTheTopCannotBePulled() {
        val c = classifier()
        assertEquals(Step.FORWARD, c.down(100f, 300f, atTop = false, eligible = true))
        assertEquals(State.PASSTHROUGH, c.state)
        c.move(100f, 400f, 10L, atTop = true) // scrolled up to the top during the drag
        assertNull(c.overscrolledTop())
        assertEquals(State.PASSTHROUGH, c.state)
    }

    @Test
    fun aDragThatScrollsThePageIsNotAPull() {
        val c = classifier()
        assertEquals(Step.FORWARD, c.down(100f, 300f, atTop = true, eligible = true))
        c.pageAnswered(true)
        // The page consumed the drag (some nested scroller, or it just scrolled): no longer at top.
        assertEquals(Step.FORWARD, c.move(100f, 330f, 10L, atTop = false))
        assertEquals(State.PASSTHROUGH, c.state)
        assertNull(c.overscrolledTop())
    }

    @Test
    fun aSidewaysDragOrAnUpwardOneIsTheWebViews() {
        val sideways = classifier()
        sideways.down(100f, 300f, atTop = true, eligible = true)
        sideways.pageAnswered(true)
        sideways.move(130f, 306f, 10L, atTop = true)
        assertEquals(State.PASSTHROUGH, sideways.state)
        assertNull(sideways.overscrolledTop())

        val upward = classifier()
        upward.down(100f, 300f, atTop = true, eligible = true)
        upward.pageAnswered(true)
        upward.move(100f, 280f, 10L, atTop = true)
        assertEquals(State.PASSTHROUGH, upward.state)
        // Coming back down afterwards does not make it a pull.
        upward.move(100f, 340f, 20L, atTop = true)
        assertNull(upward.overscrolledTop())
    }

    @Test
    fun aShortPageReportsTheSameOverscrollForAnUpwardDragWhichIsIgnored() {
        val c = classifier()
        c.down(100f, 300f, atTop = true, eligible = true)
        c.pageAnswered(true)
        c.move(100f, 296f, 10L, atTop = true) // within slop, upwards
        assertNull(c.overscrolledTop())
        assertEquals(State.WATCHING, c.state)
        // …and then down: the pull starts from here.
        c.move(100f, 330f, 20L, atTop = true)
        assertEquals(Step(Disposition.CANCEL_WEBVIEW, Pull.Start), c.overscrolledTop())
    }

    @Test
    fun anIneligiblePageIsNeverPulled() {
        val c = classifier()
        assertEquals(Step.FORWARD, c.down(100f, 300f, atTop = true, eligible = false))
        assertEquals(State.PASSTHROUGH, c.state)
        c.move(100f, 400f, 10L, atTop = true)
        assertNull(c.overscrolledTop())
        assertNull(c.pageAnswered(true))
        assertEquals(Step.FORWARD, c.up(20L))
    }

    @Test
    fun aPageThatContainsItsOverscrollKeepsTheDrag() {
        val c = classifier()
        assertNull(pullTo(c, 40f, allows = false))
        assertEquals(State.PASSTHROUGH, c.state)
        assertEquals(Step.FORWARD, c.move(100f, 380f, 20L, atTop = true))
        assertEquals(Step.FORWARD, c.up(30L))
    }

    @Test
    fun anOverscrollBeforeThePageAnsweredActivatesWhenTheAnswerComes() {
        val c = classifier()
        c.down(100f, 300f, atTop = true, eligible = true)
        c.move(100f, 330f, 10L, atTop = true)
        assertNull(c.overscrolledTop()) // the probe is still on its way
        assertEquals(State.WATCHING, c.state)
        assertEquals(Step(Disposition.CANCEL_WEBVIEW, Pull.Start), c.pageAnswered(true))
        assertEquals(State.PULLING, c.state)

        val contained = classifier()
        contained.down(100f, 300f, atTop = true, eligible = true)
        contained.move(100f, 330f, 10L, atTop = true)
        assertNull(contained.overscrolledTop())
        assertNull(contained.pageAnswered(false))
        assertEquals(State.PASSTHROUGH, contained.state)
    }

    @Test
    fun reversingAboveTheOriginHandsTheFingerBackAndCanPullAgain() {
        val c = classifier()
        pullTo(c, 20f)
        c.move(100f, 360f, 20L, atTop = true)
        // Back up past where the pull began: the page is home, the WebView gets a fresh down.
        assertEquals(Step(Disposition.HANDBACK, Pull.Cancel(30L)), c.move(100f, 315f, 30L, atTop = true))
        assertEquals(State.WATCHING, c.state)
        // Every further move is the WebView's…
        assertEquals(Step.FORWARD, c.move(100f, 312f, 40L, atTop = true))
        // …until the page overscrolls at the top again, below the hand-back point.
        assertEquals(Step.FORWARD, c.move(100f, 340f, 50L, atTop = true))
        assertEquals(Step(Disposition.CANCEL_WEBVIEW, Pull.Start), c.overscrolledTop())
        assertEquals(Step(Disposition.CONSUME, Pull.Move(10f, 60L)), c.move(100f, 350f, 60L, atTop = true))
    }

    @Test
    fun aSecondFingerEndsThePullAndHandsBothToTheWebView() {
        val c = classifier()
        pullTo(c, 20f)
        c.move(100f, 360f, 20L, atTop = true)
        assertEquals(Step(Disposition.HANDBACK, Pull.Cancel(30L)), c.pointerDown(30L))
        assertEquals(State.PASSTHROUGH, c.state)
        assertEquals(Step.FORWARD, c.move(100f, 380f, 40L, atTop = true))
        assertNull(c.overscrolledTop())

        val watching = classifier()
        watching.down(100f, 300f, atTop = true, eligible = true)
        assertEquals(Step.FORWARD, watching.pointerDown(10L))
        assertEquals(State.PASSTHROUGH, watching.state)
    }

    @Test
    fun aSystemCancelWhilePullingCancelsThePull() {
        val c = classifier()
        pullTo(c, 20f)
        assertEquals(Step(Disposition.CONSUME, Pull.Cancel(50L)), c.cancel(50L))
        assertEquals(State.IDLE, c.state)
        val watching = classifier()
        watching.down(100f, 300f, atTop = true, eligible = true)
        assertEquals(Step.FORWARD, watching.cancel(50L))
    }

    @Test
    fun aFingerOnAPageStillOutCatchesItAtOnce() {
        val c = classifier()
        c.offsetApplied(30f) // retracting after an earlier pull
        assertEquals(Step(Disposition.CONSUME, Pull.Start), c.down(100f, 300f, atTop = false, eligible = true))
        assertEquals(State.PULLING, c.state)
        assertEquals(Step(Disposition.CONSUME, Pull.Move(25f, 10L)), c.move(100f, 325f, 10L, atTop = false))
        // Coming back up: the chrome eases the page home under the finger; the WebView takes over
        // only once the page has actually arrived there.
        assertEquals(Step(Disposition.CONSUME, Pull.Move(-10f, 20L)), c.move(100f, 290f, 20L, atTop = false))
        c.offsetApplied(0f)
        assertEquals(Step(Disposition.HANDBACK, Pull.Cancel(30L)), c.move(100f, 285f, 30L, atTop = false))
        assertEquals(State.WATCHING, c.state)
    }

    @Test
    fun aPageAtHomeIsNotCaught() {
        val c = classifier()
        c.offsetApplied(0.2f) // a spring's last sub-pixel
        assertEquals(Step.FORWARD, c.down(100f, 300f, atTop = true, eligible = true))
        assertEquals(State.WATCHING, c.state)
    }

    @Test
    fun onlyPagesWithSomethingToFetchRefresh() {
        assertTrue(PullGestureClassifier.refreshable("https://example.com/"))
        assertTrue(PullGestureClassifier.refreshable("HTTP://example.com"))
        assertTrue(PullGestureClassifier.refreshable("file:///sdcard/page.html"))
        assertTrue(PullGestureClassifier.refreshable("zen://error?code=-105&url=https%3A%2F%2Fexample.com"))
        assertFalse(PullGestureClassifier.refreshable("zen://blank"))
        assertFalse(PullGestureClassifier.refreshable("zen://settings"))
        assertFalse(PullGestureClassifier.refreshable("zen://reader/abc"))
        assertFalse(PullGestureClassifier.refreshable("about:blank"))
        assertFalse(PullGestureClassifier.refreshable("data:text/html,hi"))
        assertFalse(PullGestureClassifier.refreshable(""))
        assertFalse(PullGestureClassifier.refreshable(null))
    }
}
