package app.zen.chromium

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * What of the bar-hide stream reaches the chrome (`BarHideGesture.reports`). The gesture itself
 * needs a WebView; its gate is a pure predicate, and the wiring around it is pinned by reading
 * the source (as `PullGestureClassifierTest` pins the pull's).
 */
class BarHideGestureTest {
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

        /** `chrome.setBarHide`'s arguments as the chrome publishes them (`publishHost`, `lib/barHide.ts`). */
        fun gateClosed() = org.json.JSONObject().put("enabled", false)
        fun gateOpen() = org.json.JSONObject().put("edge", "bottom").put("offset", 0.0).put("travel", 50).put("shownEdge", 800)
    }

    @Test
    fun theFirstPageTouchReachesTheChromeWithTheBarUnableToHide() {
        // Hide-on-scroll off (or an internal page, a sheet up: any closed gate): the chrome's word
        // is `{ enabled: false }`, the host holds no frame – and a finger's down still goes, so
        // the tab switcher's hint bubble hears the page touched, as Chrome's IPH bubble hears the
        // `ACTION_OUTSIDE` a page touch's down delivers to it (TB-19's (f) clause).
        val frame = BarHideFrame.parse(gateClosed(), 1.75f)
        assertNull("a closed gate is no frame", frame)
        assertTrue(BarHideGesture.reports("start", barMayHide = frame != null))
    }

    @Test
    fun theRestOfTheStreamStaysGatedAfterIt() {
        // The bar's own hide-on-scroll is unchanged: with the gate closed nothing but the down goes
        // – no deltas, no lift, no show – so a gesture with the setting off costs one report.
        for (phase in listOf("move", "end", "show")) {
            assertFalse("$phase goes only while the bar may hide", BarHideGesture.reports(phase, barMayHide = false))
        }
    }

    @Test
    fun withTheBarAbleToHideEveryReportGoesAsBefore() {
        val frame = BarHideFrame.parse(gateOpen(), 1.75f)
        assertEquals(BarHideFrame.Edge.BOTTOM, frame!!.edge)
        for (phase in listOf("start", "move", "end", "show")) {
            assertTrue("$phase goes with the gate open", BarHideGesture.reports(phase, barMayHide = frame != null))
        }
    }

    @Test
    fun theGestureRoutesItsTouchReportsThroughThePredicateAndTheScrollsThroughTheFrame() {
        val gesture = code(File(repoRoot(), "android/app/src/main/kotlin/app/zen/chromium/BarHideGesture.kt"))

        // The touch handler's two reports ask the predicate with the chrome's word.
        val touch = gesture.indexOf("fun onTouch(event: MotionEvent) {")
        assertTrue(touch >= 0)
        val body = gesture.substring(touch, gesture.indexOf("fun forward(event: MotionEvent", touch))
        val down = body.indexOf("MotionEvent.ACTION_DOWN -> {")
        val lift = body.indexOf("MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {")
        assertTrue(down >= 0 && lift > down)
        val start = body.indexOf("""if (reports("start", barMayHide = frame != null)) emit("start", null)""")
        val end = body.indexOf("""if (reports("end", barMayHide = frame != null)) emit("end", json("time" to event.eventTime))""")
        assertTrue("the down's report goes through the predicate", start in (down + 1) until lift)
        assertTrue("the lift's report goes through the predicate", end > lift)
        assertFalse("no report in the touch handler bypasses it", body.contains("if (frame != null) emit("))
        // One `start` per gesture: the down's is the file's only `start` emit – no other arm (a
        // move, a second finger) and no other path says it again.
        assertEquals("one start emit in the file, the down's", 1, Regex("""emit\("start"""").findAll(gesture).count())

        // The page's scroll (`move`, `show`) still needs the frame itself: its travel, its edge.
        val scrolled = gesture.indexOf("fun onScrollChanged(scrollY: Int, oldScrollY: Int) {")
        assertTrue(scrolled >= 0)
        assertTrue(
            "the scroll's reports stay gated on the frame",
            gesture.substring(scrolled).trimStart().lines().drop(1).first().trim() == "val frame = frame ?: return"
        )

        // The predicate is the one written here, and the report's road to the chrome has no other
        // gate: every touch, then the tab's host, then the chrome WebView's `__zenHost.barScroll`.
        assertTrue(gesture.contains("""fun reports(phase: String, barMayHide: Boolean): Boolean = phase == "start" || barMayHide"""))
        val view = code(File(repoRoot(), "android/app/src/main/kotlin/app/zen/chromium/TabWebView.kt"))
        assertTrue(view.contains("val barHide = BarHideGesture(this) { phase, payload -> host.barScroll(tabId, phase, payload) }"))
        val onTouch = view.indexOf("override fun onTouchEvent(event: MotionEvent): Boolean {")
        assertTrue(onTouch >= 0)
        assertTrue(view.substring(onTouch, view.indexOf("\n    }\n", onTouch)).contains("\n        barHide.onTouch(event)\n"))
        assertTrue(
            code(File(repoRoot(), "android/app/src/main/kotlin/app/zen/chromium/Host.kt"))
                .contains("override fun barScroll(tabId: String, phase: String, payload: JSONObject?) = chrome.barScroll(tabId, phase, payload)")
        )
    }
}
