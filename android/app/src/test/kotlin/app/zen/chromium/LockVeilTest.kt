package app.zen.chromium

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The opaque veil over the chrome from the private lock's arming until the chrome's first masked
 * frame (the `09-locked` finding of #346): up only with a private surface in view, down on the
 * frame the renderer's masked report was answered for, on the lock's release, or – logged – on the
 * host's deadline; a wait the window's stop voided is not the next start's. Over its siblings by
 * height, which holds only while the host lifts nothing else – pinned here off the sources.
 */
class LockVeilTest {
    private fun awayAndArmed(): LockVeil = LockVeil().apply {
        windowStopped()
        assertTrue(arm(privateSurface = true))
    }

    @Test
    fun raisedOnlyWithAPrivateSurfaceInView() {
        val veil = LockVeil()
        // A lock armed with a regular tab in front: the stale frame carries no private identity.
        assertFalse(veil.arm(privateSurface = false))
        assertFalse(veil.raised)
        // A private tab in front (or the overview's private pane): up.
        assertTrue(veil.arm(privateSurface = true))
        assertTrue(veil.raised)
        // Armed again (the prompt's late answer): as it is.
        assertFalse(veil.arm(privateSurface = true))
        assertTrue(veil.raised)
    }

    @Test
    fun aMaskedReportWhileTheWindowIsAwayIsAnsweredAtTheStart() {
        val veil = awayAndArmed()
        // The renderer commits the masked tree while the window is away: kept, no frame waited for yet.
        assertFalse(veil.masked())
        assertTrue(veil.maskedReported)
        assertFalse(veil.awaitingFrame)
        // The window comes back: the wait starts now, one serial.
        assertTrue(veil.windowStarted())
        assertTrue(veil.awaitingFrame)
        val serial = veil.waitSerial
        // The host's re-announcement brings a second report: no second wait.
        assertFalse(veil.masked())
        assertEquals(serial, veil.waitSerial)
        // The frame is on the display: down.
        assertTrue(veil.frameDrawn(serial))
        assertFalse(veil.raised)
        assertFalse(veil.awaitingFrame)
        assertFalse(veil.maskedReported)
    }

    @Test
    fun aMaskedReportWithTheWindowOnScreenStartsTheWaitAtOnce() {
        val veil = LockVeil()
        assertTrue(veil.arm(privateSurface = true))
        assertTrue(veil.masked())
        assertTrue(veil.awaitingFrame)
        assertTrue(veil.frameDrawn(veil.waitSerial))
        assertFalse(veil.raised)
    }

    @Test
    fun theStartWithoutAReportWaitsForOne() {
        val veil = awayAndArmed()
        assertFalse(veil.windowStarted())
        assertFalse(veil.awaitingFrame)
        // The report comes after the start (the announcement's answer): the wait starts on it.
        assertTrue(veil.masked())
        assertTrue(veil.frameDrawn(veil.waitSerial))
        assertFalse(veil.raised)
    }

    @Test
    fun theReleaseLowersItAndNothingLowersTwice() {
        val veil = awayAndArmed()
        veil.masked()
        veil.windowStarted()
        val serial = veil.waitSerial
        assertTrue(veil.lower())
        assertFalse(veil.raised)
        // The wait's callback after the release: nothing to lower.
        assertFalse(veil.frameDrawn(serial))
        assertFalse(veil.lower())
        // A report without a veil is nothing.
        assertFalse(veil.masked())
        assertFalse(veil.maskedReported)
    }

    @Test
    fun aStopVoidsTheWaitAndTheNextStartPostsANewOne() {
        val veil = awayAndArmed()
        veil.masked()
        assertTrue(veil.windowStarted())
        val first = veil.waitSerial
        // Away again before the frame: the wait is void, the veil stays (the lock still stands).
        veil.windowStopped()
        assertFalse(veil.awaitingFrame)
        assertTrue(veil.raised)
        // The old wait's callback, should it fire: not this veil's frame.
        assertFalse(veil.frameDrawn(first))
        assertTrue(veil.raised)
        // Back: a new wait, its own serial, answered by its own frame.
        assertTrue(veil.windowStarted())
        val second = veil.waitSerial
        assertTrue(second > first)
        assertFalse(veil.frameDrawn(first))
        assertTrue(veil.frameDrawn(second))
        assertFalse(veil.raised)
    }

    @Test
    fun theDeadlineOutlastsTheSlowestFirstFrameBackTheHarnessHasSeen() {
        // ≈ 2.4 s under swiftshader (#346's finding); the probe's own span for a chrome's answer.
        assertTrue(LockVeil.DEADLINE_MS > 2_400L)
        assertEquals(HostLifecycle.PROBE_TIMEOUT_MS, LockVeil.DEADLINE_MS)
    }

    @Test
    fun theVeilStandsOverTheChromeAndEveryPageViewByHeightNotByOrder() {
        // Any height above 0 draws it over its siblings at 0 and hands it their touches first,
        // whatever a page view appended or fronted after the raise did to the child order …
        assertTrue(LockVeil.Z_PX > 0f)
        // … so long as nothing else in the host is lifted: the one lift in the host's Kotlin is
        // the veil's own. A sibling of the veil in `root` that a later change lifts goes under
        // `LockVeil.Z_PX`, or the veil is re-fronted while raised; a view outside `root` is
        // listed here with its reason.
        //
        // Outside `root`: the history navigation disc (GN-04, `HistoryNavBubbleView`), whose
        // 3 dp is its shadow (v2 §11.9's `--v2-shadow-panel`), not an order. Its layer sits in
        // the activity's shell above `root` (`MainActivity`: the pages appended to `root` would
        // cover it), so it is over the veil by parent, whatever its height; it draws an arrow on
        // the panel token and nothing of a page, only during a live edge drag – a stop's
        // ACTION_CANCEL ends the drag (`HistoryNavGesture` → the chrome's `retract`) and the disc
        // goes down – and it takes no touch.
        val sources = File(repoRoot(), "android/app/src/main/kotlin").walkTopDown().filter { it.isFile && it.extension == "kt" }.toList()
        val lifts = sources.flatMap { file -> code(file).lines().filter { LIFT.containsMatchIn(it) }.map { "${file.name}: ${it.trim()}" } }.sorted()
        assertEquals(
            listOf(
                "HistoryNavBubbleView.kt: elevation = SHADOW_ELEVATION_DP * density",
                "Host.kt: it.elevation = LockVeil.Z_PX"
            ),
            lifts
        )
    }

    private companion object {
        /** A view lifted off 0: the property written, or its setter called. */
        val LIFT = Regex("""\b(elevation|translationZ)\s*=[^=]|\.z\s*=[^=]|\bset(Elevation|TranslationZ|Z)\(""")

        /** The file's code – block comments and comment lines out, as `V2TokensPinTest` reads a source. */
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
}
