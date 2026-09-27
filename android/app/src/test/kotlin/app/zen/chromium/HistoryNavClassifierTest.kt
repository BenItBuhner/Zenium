package app.zen.chromium

import android.view.MotionEvent
import app.zen.chromium.HistoryNavClassifier.Edge
import app.zen.chromium.HistoryNavClassifier.Nav
import app.zen.chromium.HistoryNavClassifier.State
import app.zen.chromium.HistoryNavClassifier.Step
import app.zen.chromium.PullGestureClassifier.Disposition
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

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

    // --- the refusal's diagnosis (the `history not started` log line) -----------------------------

    @Test
    fun aRefusedEdgeDragNamesItsCauseAtTheLift() {
        // The page never reported the overscroll and never answered the probe.
        val silent = classifier()
        assertEquals(Step.FORWARD, silent.down(20f, 600f, width, canBack = true, canForward = false))
        assertEquals(Step.FORWARD, silent.move(120f, 602f, 10L))
        assertEquals("LEFT edge: eligible=true page=unanswered overscroll=false", silent.refusal())

        // The page keeps its sideways overscroll.
        val kept = classifier()
        assertEquals(Step.FORWARD, kept.down(20f, 600f, width, canBack = true, canForward = false))
        assertNull(kept.pageAnswered(false))
        assertEquals(Step.FORWARD, kept.move(120f, 600f, 10L))
        assertEquals("LEFT edge: eligible=true page=false overscroll=false", kept.refusal())

        // The right edge with no forward entry, the overscroll reported all the same.
        val nowhere = classifier()
        assertEquals(Step.FORWARD, nowhere.down(1070f, 600f, width, canBack = true, canForward = false))
        assertNull(nowhere.overscrolledX(Edge.RIGHT))
        assertEquals(Step.FORWARD, nowhere.move(960f, 600f, 10L))
        assertEquals("RIGHT edge: eligible=false page=unanswered overscroll=false", nowhere.refusal())
    }

    @Test
    fun onlyAnInwardDragFromAnEdgeWindowThatNeverStartedIsARefusal() {
        // The drag that started (and released) is no refusal.
        val went = classifier()
        assertEquals(Step(Disposition.CANCEL_WEBVIEW, Nav.Start(Edge.LEFT)), dragFromLeft(went, 30f))
        assertEquals(Step(Disposition.CONSUME, Nav.Move(100f, 20L)), went.move(150f, 600f, 20L))
        assertNull(went.refusal())

        // Nor one that started and was then handed back to a second finger.
        val handedBack = classifier()
        assertEquals(Step(Disposition.CANCEL_WEBVIEW, Nav.Start(Edge.LEFT)), dragFromLeft(handedBack, 30f))
        assertEquals(Step(Disposition.HANDBACK, Nav.Cancel(20L)), handedBack.pointerDown(20L))
        assertEquals(Step.FORWARD, handedBack.move(150f, 600f, 30L))
        assertNull(handedBack.refusal())

        // A tap at the edge, a drag out over the edge, a touch away from the edges, a touchpad swipe.
        val tap = classifier()
        assertEquals(Step.FORWARD, tap.down(20f, 600f, width, canBack = true, canForward = true))
        assertEquals(Step.FORWARD, tap.move(24f, 603f, 10L))
        assertNull(tap.refusal())
        val outward = classifier()
        assertEquals(Step.FORWARD, outward.down(20f, 600f, width, canBack = true, canForward = true))
        assertEquals(Step.FORWARD, outward.move(2f, 600f, 10L))
        assertNull(outward.refusal())
        val middle = classifier()
        assertEquals(Step.FORWARD, middle.down(540f, 600f, width, canBack = true, canForward = true))
        assertEquals(Step.FORWARD, middle.move(700f, 600f, 10L))
        assertNull(middle.refusal())
        val pad = classifier()
        assertEquals(Step.FORWARD, pad.down(540f, 600f, width, canBack = true, canForward = true, touchpad = true))
        assertEquals(Step.FORWARD, pad.move(700f, 600f, 10L))
        assertNull(pad.refusal())
    }

    // --- a touchpad's two-finger swipe (GN-23 / A11Y-14) ------------------------------------------

    /** A touchpad swipe from the middle of the page, moved by (`dx`, `dy`) past the slop, with the page answering `allows`. */
    private fun touchpadSwipe(
        c: HistoryNavClassifier,
        dx: Float,
        dy: Float = 0f,
        canBack: Boolean = true,
        canForward: Boolean = true,
        allows: Boolean = true
    ): Step {
        assertEquals(Step.FORWARD, c.down(540f, 600f, width, canBack = canBack, canForward = canForward, touchpad = true))
        assertNull(c.pageAnswered(allows))
        return c.move(540f + dx, 600f + dy, 10L)
    }

    @Test
    fun aTouchpadSwipeGoesBackFromAnywhereOnThePage() {
        val c = classifier()
        assertEquals(Step.FORWARD, touchpadSwipe(c, 60f))
        assertEquals(State.WATCHING, c.state)
        assertTrue(c.touchpad)
        // The page cannot scroll left under it: the swipe pulls the left side in, and that is a back.
        assertEquals(Step(Disposition.CANCEL_WEBVIEW, Nav.Start(Edge.LEFT)), c.overscrolledX(Edge.LEFT))
        assertEquals(State.DRAGGING, c.state)
        assertEquals(Edge.LEFT, c.edge)
        assertEquals(Step(Disposition.CONSUME, Nav.Move(0f, 20L)), c.move(600f, 600f, 20L))
        assertEquals(Step(Disposition.CONSUME, Nav.Move(100f, 30L)), c.move(700f, 605f, 30L))
        assertEquals(Step(Disposition.CONSUME, Nav.Release(40L)), c.up(40L))
        assertEquals(State.IDLE, c.state)

        // The same movement by a finger on the screen, away from the edges, is the WebView's.
        val finger = classifier()
        assertEquals(Step.FORWARD, finger.down(540f, 600f, width, canBack = true, canForward = true))
        assertEquals(State.PASSTHROUGH, finger.state)
    }

    @Test
    fun aTouchpadSwipeTheOtherWayGoesForwardOnceThatSideOverscrolls() {
        val c = classifier()
        assertEquals(Step.FORWARD, touchpadSwipe(c, -60f, dy = 4f))
        // A page with no sideways scroll reports both sides clamped; only the side the swipe pulls in from counts.
        assertNull(c.overscrolledX(Edge.LEFT))
        assertEquals(State.WATCHING, c.state)
        assertEquals(Step(Disposition.CANCEL_WEBVIEW, Nav.Start(Edge.RIGHT)), c.overscrolledX(Edge.RIGHT))
        assertEquals(Edge.RIGHT, c.edge)
        // Travel is measured inward: leftward here.
        assertEquals(Step(Disposition.CONSUME, Nav.Move(80f, 20L)), c.move(400f, 604f, 20L))
        assertEquals(Step(Disposition.CONSUME, Nav.Release(30L)), c.up(30L))
    }

    @Test
    fun aTouchpadSwipeOnAPageWithRoomThatWayStaysThePagesScroll() {
        // The page scrolls under the swipe: no clamp comes, and the WebView keeps every event.
        val c = classifier()
        assertEquals(Step.FORWARD, touchpadSwipe(c, -60f))
        assertEquals(Step.FORWARD, c.move(400f, 600f, 20L))
        assertEquals(State.WATCHING, c.state)
        assertEquals(Step.FORWARD, c.up(30L))
        assertEquals(State.IDLE, c.state)

        // A clamp on the side the swipe pushes the page towards says nothing about it.
        val other = classifier()
        assertEquals(Step.FORWARD, touchpadSwipe(other, -60f))
        assertNull(other.overscrolledX(Edge.LEFT))
        assertEquals(State.WATCHING, other.state)
    }

    @Test
    fun aTouchpadSwipeTowardsNothingIsTheWebViews() {
        // Nothing behind: a swipe pulling the left side in has nowhere to go, and is the page's past the slop.
        val noBack = classifier()
        assertEquals(Step.FORWARD, noBack.down(540f, 600f, width, canBack = false, canForward = true, touchpad = true))
        assertEquals(State.WATCHING, noBack.state)
        assertNull(noBack.pageAnswered(true))
        assertEquals(Step.FORWARD, noBack.move(600f, 600f, 10L))
        assertEquals(State.PASSTHROUGH, noBack.state)
        assertNull(noBack.overscrolledX(Edge.LEFT))

        // Within the slop, heading that way: neither side's report arms it.
        val early = classifier()
        early.down(540f, 600f, width, canBack = false, canForward = true, touchpad = true)
        early.pageAnswered(true)
        early.move(544f, 600f, 10L)
        assertNull(early.overscrolledX(Edge.LEFT))
        assertNull(early.overscrolledX(Edge.RIGHT))
        assertEquals(State.WATCHING, early.state)

        // Nowhere to go either way: the WebView's from the down.
        val nothing = classifier()
        assertEquals(Step.FORWARD, nothing.down(540f, 600f, width, canBack = false, canForward = false, touchpad = true))
        assertEquals(State.PASSTHROUGH, nothing.state)
    }

    @Test
    fun aTouchpadScrollIsTheWebViews() {
        // Vertical: a two-finger scroll, whatever the page reports.
        val vertical = classifier()
        assertEquals(Step.FORWARD, touchpadSwipe(vertical, 2f, dy = 40f))
        assertEquals(State.PASSTHROUGH, vertical.state)
        assertNull(vertical.overscrolledX(Edge.LEFT))
        assertNull(vertical.overscrolledX(Edge.RIGHT))

        // 40 across, 30 down: outside the 30° cone either way.
        val diagonal = classifier()
        assertEquals(Step.FORWARD, touchpadSwipe(diagonal, -40f, dy = 30f))
        assertEquals(State.PASSTHROUGH, diagonal.state)
        assertNull(diagonal.overscrolledX(Edge.RIGHT))

        // 60 across, 30 down: inside it.
        val shallow = classifier()
        assertEquals(Step.FORWARD, touchpadSwipe(shallow, -60f, dy = 30f))
        assertEquals(Step(Disposition.CANCEL_WEBVIEW, Nav.Start(Edge.RIGHT)), shallow.overscrolledX(Edge.RIGHT))
    }

    @Test
    fun aTouchpadSwipeOnAPageThatContainsItsSidewaysOverscrollIsTheWebViews() {
        val c = classifier()
        assertEquals(Step.FORWARD, touchpadSwipe(c, 60f, allows = false))
        assertEquals(State.PASSTHROUGH, c.state)
        assertNull(c.overscrolledX(Edge.LEFT))

        // The answer arriving after the overscroll settles it the same way.
        val late = classifier()
        late.down(540f, 600f, width, canBack = true, canForward = true, touchpad = true)
        late.move(600f, 600f, 10L)
        assertNull(late.overscrolledX(Edge.LEFT))
        assertEquals(State.WATCHING, late.state)
        assertEquals(Step(Disposition.CANCEL_WEBVIEW, Nav.Start(Edge.LEFT)), late.pageAnswered(true))
    }

    @Test
    fun aTouchpadSwipeEndsLikeADragAndTheNextDownStartsAfresh() {
        val c = classifier()
        touchpadSwipe(c, 60f)
        assertEquals(Step(Disposition.CANCEL_WEBVIEW, Nav.Start(Edge.LEFT)), c.overscrolledX(Edge.LEFT))
        assertEquals(Step(Disposition.CONSUME, Nav.Cancel(20L)), c.cancel(20L))
        assertEquals(State.IDLE, c.state)

        // A finger on the screen next: back to the edge rule, and the swipe's reports are gone.
        assertEquals(Step.FORWARD, c.down(20f, 600f, width, canBack = true, canForward = true))
        assertEquals(State.WATCHING, c.state)
        assertFalse(c.touchpad)
        assertNull(c.pageAnswered(true))
        c.move(60f, 600f, 30L)
        assertNull(c.overscrolledX(Edge.RIGHT))
        assertEquals(Step(Disposition.CANCEL_WEBVIEW, Nav.Start(Edge.LEFT)), c.overscrolledX(Edge.LEFT))
    }

    @Test
    fun aTouchpadSwipeIsAndroid14sClassifiedFingerWithNoButtonHeld() {
        // The spelt-out constants are Android's.
        assertEquals(MotionEvent.CLASSIFICATION_NONE, HistoryNavClassifier.CLASSIFICATION_NONE)
        assertEquals(MotionEvent.CLASSIFICATION_TWO_FINGER_SWIPE, HistoryNavClassifier.CLASSIFICATION_TWO_FINGER_SWIPE)

        // Android 14+ classifies the fake finger it makes of the swipe (GestureConverter.cpp).
        assertTrue(HistoryNavClassifier.isTouchpadSwipe(0, MotionEvent.CLASSIFICATION_TWO_FINGER_SWIPE))
        // The same with the touchpad's button held is a click-and-drag: Chromium's mouse path
        // (EventForwarder.isTrackpadToMouseConversionEvent runs before its swipe test).
        assertFalse(HistoryNavClassifier.isTouchpadSwipe(MotionEvent.BUTTON_PRIMARY, MotionEvent.CLASSIFICATION_TWO_FINGER_SWIPE))
        assertFalse(HistoryNavClassifier.isTouchpadSwipe(MotionEvent.BUTTON_SECONDARY, MotionEvent.CLASSIFICATION_TWO_FINGER_SWIPE))
        // Unclassified: a finger on the screen – and, on Android 13 and before, the legacy
        // touchpad's one-finger tap-drag and its two-finger scroll alike, which arrive as an
        // unclassified mouse-sourced finger (TouchInputMapper.cpp) and are a finger on the
        // screen to Chrome there too: the edge rule, not this.
        assertFalse(HistoryNavClassifier.isTouchpadSwipe(0, MotionEvent.CLASSIFICATION_NONE))
        assertFalse(HistoryNavClassifier.isTouchpadSwipe(MotionEvent.BUTTON_PRIMARY, MotionEvent.CLASSIFICATION_NONE))
        // Android's other classifications: an ambiguous gesture, a deep press, Android 14's
        // pinch and (hidden CLASSIFICATION_MULTI_FINGER_SWIPE, 4) three-finger system swipes.
        assertFalse(HistoryNavClassifier.isTouchpadSwipe(0, MotionEvent.CLASSIFICATION_AMBIGUOUS_GESTURE))
        assertFalse(HistoryNavClassifier.isTouchpadSwipe(0, MotionEvent.CLASSIFICATION_DEEP_PRESS))
        assertFalse(HistoryNavClassifier.isTouchpadSwipe(0, MotionEvent.CLASSIFICATION_PINCH))
        assertFalse(HistoryNavClassifier.isTouchpadSwipe(0, 4))
    }

    /**
     * The back drag's eligibility, held in the source between nightlies (the device pin is
     * `GesturesDemo.edgeDragCloseTab`): `TabWebView.historyNavEligible` answers a LEFT-edge drag
     * true whatever the history – Chrome's `NavigationHandler.isNavigationEnabled(forward)` is
     * `!forward || canGoForward()` (152.0.7977.89, l.388–392), the back with no page to go to
     * closing the tab or leaving at the release (`lib/back.ts` `dragBack`) – while a RIGHT-edge
     * drag still asks for a forward entry. The `when` is read from the file, the repo's idiom for
     * a WebView branch no JVM test can reach (`TabWebView` needs the platform).
     */
    @Test
    fun theBackDragIsEligibleAtTheHistorysFirstPage() {
        val sources = listOf("src/main/kotlin/app/zen/chromium", "app/src/main/kotlin/app/zen/chromium").map(::File).first { it.isDirectory }
        val eligible = File(sources, "TabWebView.kt").readText()
            .substringAfter("fun historyNavEligible(")
            .substringBefore("\n    }\n")
        assertTrue("a back drag is eligible whatever the history", "HistoryNavClassifier.Edge.LEFT -> true" in eligible)
        assertTrue("a forward drag still needs a forward entry", "HistoryNavClassifier.Edge.RIGHT -> canGoForward()" in eligible)
        assertFalse("the history's depth is no part of the back drag's answer", "canGoBack()" in eligible)
    }

    // --- the fling that forces the navigation (Chrome's FORCE_ACTIVATION) -------------------------

    /** A touchpad swipe that has taken over, pulling in from `side`, `travel` px in – short of the 96 dp threshold at this density. */
    private fun draggingSwipe(c: HistoryNavClassifier, side: Edge = Edge.LEFT, travel: Float = 30f) {
        val sign = if (side == Edge.LEFT) 1f else -1f
        assertEquals(Step.FORWARD, touchpadSwipe(c, sign * 60f))
        assertEquals(Step(Disposition.CANCEL_WEBVIEW, Nav.Start(side)), c.overscrolledX(side))
        assertEquals(Step(Disposition.CONSUME, Nav.Move(travel, 20L)), c.move(540f + sign * (60f + travel), 600f, 20L))
    }

    @Test
    fun theFlingsThresholdIsChromesInPhysicalPixelsPerSecond() {
        // `kMinFlingVelocityForForceActivation` (`ui/android/overscroll_refresh.cc`): 1788 px/s, one
        // number on every device; `EventForwarder.MAX_FLING_VELOCITY`: the cap it is measured under.
        assertEquals(1788f, HistoryNavClassifier.FORCE_ACTIVATION_VELOCITY)
        assertEquals(8000f, HistoryNavClassifier.MAX_FLING_VELOCITY)
    }

    @Test
    fun aTouchpadSwipeLetGoFastEnoughForcesTheNavigationShortOfTheThreshold() {
        val c = classifier()
        draggingSwipe(c)
        // Well short of the threshold (30 px of 240 at this density), moving right at 2000 px/s.
        assertEquals(Step(Disposition.CONSUME, Nav.Release(30L, force = true)), c.up(30L, velocityX = 2000f))
        assertEquals(State.IDLE, c.state)

        // The threshold is exclusive: exactly 1788 px/s is not over it.
        val at = classifier()
        draggingSwipe(at)
        assertEquals(Step(Disposition.CONSUME, Nav.Release(30L, force = false)), at.up(30L, velocityX = 1788f))
        val just = classifier()
        draggingSwipe(just)
        assertEquals(Step(Disposition.CONSUME, Nav.Release(30L, force = true)), just.up(30L, velocityX = 1788.5f))

        // A slower release is the travel's alone (the chrome's machine reads the threshold).
        val slow = classifier()
        draggingSwipe(slow)
        assertEquals(Step(Disposition.CONSUME, Nav.Release(30L)), slow.up(30L, velocityX = 1200f))
        // The default: no velocity known, nothing forced – the release the earlier tests read.
        val none = classifier()
        draggingSwipe(none)
        assertEquals(Step(Disposition.CONSUME, Nav.Release(30L, force = false)), none.up(30L))
    }

    @Test
    fun theFlingMustHeadIntoThePageTheWayTheSwipePulls() {
        // Pulling in from the right (a forward): the velocity that counts is leftward, `-velocity.x`
        // (Chrome's `GetVelocityInActiveActionDirection`).
        val forward = classifier()
        draggingSwipe(forward, Edge.RIGHT)
        assertEquals(Step(Disposition.CONSUME, Nav.Release(30L, force = true)), forward.up(30L, velocityX = -2000f))
        val forwardBack = classifier()
        draggingSwipe(forwardBack, Edge.RIGHT)
        assertEquals(Step(Disposition.CONSUME, Nav.Release(30L, force = false)), forwardBack.up(30L, velocityX = 2000f))

        // Pulling in from the left, let go flicking back towards the edge: not forced.
        val back = classifier()
        draggingSwipe(back)
        assertEquals(Step(Disposition.CONSUME, Nav.Release(30L, force = false)), back.up(30L, velocityX = -3000f))
    }

    @Test
    fun aFingersDragIsNeverForcedAndNorIsASwipeThatNeverTookOver() {
        // The finger's edge drag, flicked fast: Chrome forces the touchpad's action alone
        // (`active_action.device == kTouchpad`); the finger's release reads the threshold.
        val finger = classifier()
        dragFromLeft(finger, 30f)
        assertEquals(Step(Disposition.CONSUME, Nav.Move(20f, 20L)), finger.move(70f, 600f, 20L))
        assertEquals(Step(Disposition.CONSUME, Nav.Release(30L, force = false)), finger.up(30L, velocityX = 5000f))

        // A swipe still the WebView's (no overscroll came back) lifts as the WebView's, however fast.
        val watching = classifier()
        assertEquals(Step.FORWARD, touchpadSwipe(watching, 60f))
        assertEquals(State.WATCHING, watching.state)
        assertEquals(Step.FORWARD, watching.up(30L, velocityX = 5000f))
        assertEquals(State.IDLE, watching.state)
    }

    // --- the host's side: the switch and the velocity, pinned in the source ---------------------------

    @Test
    fun theAccessibilitySwitchGatesTheTouchpadSwipeAloneAtTheDown() {
        // Settings → Accessibility → "Swipe between pages using a touchpad" (Chrome's
        // `settings.a11y.touchpad_overscroll_history_navigation`, on by default) is one guard line
        // in `TabWebView.historyNavEligible`, for the touchpad-sourced swipe alone, ahead of the
        // finger's own rule (3-button mode), so the finger's edge drag never reads it.
        val tabWebView = File(repoRoot(), "android/app/src/main/kotlin/app/zen/chromium/TabWebView.kt").readText()
        val guard = "if (touchpad && !host.touchpadSwipeToNavigate) return false"
        assertEquals(1, Regex(Regex.escape(guard)).findAll(tabWebView).count())
        val fingerRule = "if ((!touchpad && !host.threeButtonNavigation) || backTransition != null) return false"
        assertTrue(tabWebView.indexOf(guard) in 0 until tabWebView.indexOf(fingerRule))
        // The release carries the fling's word to the chrome's machine.
        assertTrue(tabWebView.contains("\"release\" to json(\"time\" to event.time, \"force\" to event.force)"))

        // The host mirrors the chrome's setting (on until it says otherwise) on the same bridge
        // path as the pull-to-refresh's, and the interface's default keeps a chrome-less host on.
        val host = File(repoRoot(), "android/app/src/main/kotlin/app/zen/chromium/Host.kt").readText()
        assertTrue(host.contains("override var touchpadSwipeToNavigate = true"))
        assertTrue(host.contains("\"chrome.setTouchpadSwipeToNavigate\" -> {"))
        assertTrue(host.contains("touchpadSwipeToNavigate = args.bool(\"enabled\", true)"))
        val pageHost = File(repoRoot(), "android/app/src/main/kotlin/app/zen/chromium/PageHost.kt").readText()
        assertTrue(pageHost.contains("val touchpadSwipeToNavigate: Boolean get() = true"))
        // The chrome sends it from the settings, as it sends the pull-to-refresh's.
        val boot = File(repoRoot(), "src/android/boot.ts").readText()
        assertTrue(boot.contains("bridge.send('chrome.setTouchpadSwipeToNavigate', { enabled })"))
    }

    @Test
    fun theGestureMeasuresTheSwipesVelocityAsChromiumDoes() {
        // A `VelocityTracker` over the touchpad swipe's events alone, the up added, read under
        // Chromium's cap (`EventForwarder.onTrackpadScrollEvent`), and handed to the classifier's up.
        val gesture = File(repoRoot(), "android/app/src/main/kotlin/app/zen/chromium/HistoryNavGesture.kt").readText()
        assertTrue(gesture.contains("if (touchpad) velocity = VelocityTracker.obtain().also { it.addMovement(event) }"))
        assertTrue(gesture.contains("velocity?.addMovement(event)"))
        assertTrue(gesture.contains("tracker.computeCurrentVelocity(1000, HistoryNavClassifier.MAX_FLING_VELOCITY)"))
        assertTrue(gesture.contains("classifier.up(event.eventTime, releaseVelocityX(event))"))
        // Recycled with the touch, whichever way it ended.
        assertTrue(gesture.contains("velocity?.recycle()"))
    }

    private fun repoRoot(): File {
        var dir: File? = File(System.getProperty("user.dir") ?: ".").absoluteFile
        while (dir != null) {
            if (File(dir, "package.json").isFile && File(dir, "android").isDirectory) return dir
            dir = dir.parentFile
        }
        error("not inside the repository")
    }
}
