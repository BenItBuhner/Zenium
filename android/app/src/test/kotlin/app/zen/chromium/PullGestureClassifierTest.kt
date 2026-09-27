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
import java.io.File

class PullGestureClassifierTest {
    private val slop = 8f

    private fun classifier() = PullGestureClassifier(slop)

    private companion object {
        /** A source file without its comments, so a pin reads the code and not its prose. */
        fun code(file: File): String =
            file.readText().replace(Regex("""/\*[\s\S]*?\*/"""), "").lines().filterNot { it.trim().startsWith("//") }.joinToString("\n")

        fun repoRoot(): File {
            var dir: File? = File(System.getProperty("user.dir") ?: ".").absoluteFile
            while (dir != null) {
                if (File(dir, "package.json").isFile && File(dir, "android").isDirectory) return dir
                dir = dir.parentFile
            }
            error("not inside the repository")
        }
    }

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
    fun aTouchpadsTwoFingerSwipeIsNeverAPullWhereTheSameDragOfAFingerIs() {
        // The finger's shape: at the top, the page answers and overscrolls – the pull takes it.
        val finger = classifier()
        assertEquals(Step(Disposition.CANCEL_WEBVIEW, Pull.Start), pullTo(finger, 20f))
        assertEquals(State.PULLING, finger.state)

        // The same drag as Android 14's classified fake finger (Chrome's `OnOverscrolled`:
        // refresh only on touchscreen overscrolls, not touchpad or mousewheel): the WebView's,
        // whatever the page then reports at its top.
        val touchpad = classifier()
        assertEquals(Step.FORWARD, touchpad.down(100f, 300f, atTop = true, eligible = true, touchpad = true))
        assertEquals(State.PASSTHROUGH, touchpad.state)
        assertNull(touchpad.pageAnswered(true))
        assertEquals(Step.FORWARD, touchpad.move(100f, 320f, 10L, atTop = true))
        assertNull(touchpad.overscrolledTop())
        assertEquals(State.PASSTHROUGH, touchpad.state)
        assertEquals(Step.FORWARD, touchpad.move(100f, 400f, 20L, atTop = true))
        assertEquals(Step.FORWARD, touchpad.up(30L))
        assertEquals(State.IDLE, touchpad.state)

        // Nor does the swipe catch a page still out from a finger's earlier pull.
        val out = classifier()
        out.offsetApplied(30f)
        assertEquals(Step.FORWARD, out.down(100f, 300f, atTop = false, eligible = true, touchpad = true))
        assertEquals(State.PASSTHROUGH, out.state)

        // The finger's default is unchanged: a down without the flag is the finger's.
        val plain = classifier()
        assertEquals(Step.FORWARD, plain.down(100f, 300f, atTop = true, eligible = true))
        assertEquals(State.WATCHING, plain.state)
    }

    @Test
    fun theGestureReadsTheSwipeAtTheDownAndTheViewFreesItsGlowForIt() {
        // The one shared reading of the swipe: #580's predicate behind the API 29 guard.
        val swipe = code(File(repoRoot(), "android/app/src/main/kotlin/app/zen/chromium/TouchpadSwipe.kt"))
        assertTrue(swipe.contains("internal fun MotionEvent.isTouchpadSwipe(): Boolean {"))
        assertTrue(
            swipe.contains(
                "val classification = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) classification else HistoryNavClassifier.CLASSIFICATION_NONE"
            )
        )
        assertTrue(swipe.contains("return HistoryNavClassifier.isTouchpadSwipe(buttonState, classification)"))

        // The pull reads it at the down, frees the view's glow for the swipe before the WebView
        // sees the down, and hands the flag to the classifier.
        val gesture = code(File(repoRoot(), "android/app/src/main/kotlin/app/zen/chromium/PullToRefreshGesture.kt"))
        val down = gesture.indexOf("MotionEvent.ACTION_DOWN -> {")
        assertTrue(down >= 0)
        val arm = gesture.substring(down, gesture.indexOf("MotionEvent.ACTION_POINTER_DOWN ->", down))
        val read = arm.indexOf("val touchpad = event.isTouchpadSwipe()")
        val glow = arm.indexOf("view.applyPullToRefreshMode(touchpad)")
        val classify = arm.indexOf("classifier.down(event.x, event.y, atTop(), view.pullToRefreshEligible(), touchpad)")
        assertTrue("the down reads the swipe", read >= 0)
        assertTrue("then frees the glow", glow > read)
        assertTrue("then classifies with the flag", classify > glow)

        // The view: the pull's mode keeps the WebView's glow off for a finger only; set on change.
        val view = code(File(repoRoot(), "android/app/src/main/kotlin/app/zen/chromium/TabWebView.kt"))
        val mode = view.indexOf("fun applyPullToRefreshMode(touchpad: Boolean = false) {")
        assertTrue(mode >= 0)
        val body = view.substring(mode, view.indexOf("\n    }\n", mode))
        assertTrue(
            body.contains(
                "val mode = if (host.pullToRefresh && !touchpad) View.OVER_SCROLL_NEVER else View.OVER_SCROLL_IF_CONTENT_SCROLLS"
            )
        )
        assertTrue(body.contains("if (overScrollMode != mode) overScrollMode = mode"))
        // Its other callers (creation, the setting's flip) keep the finger's default.
        assertTrue(code(File(repoRoot(), "android/app/src/main/kotlin/app/zen/chromium/TabHost.kt")).contains("view.applyPullToRefreshMode()"))
        assertTrue(code(File(repoRoot(), "android/app/src/main/kotlin/app/zen/chromium/Host.kt")).contains("for (view in tabs.all()) view.applyPullToRefreshMode()"))
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
