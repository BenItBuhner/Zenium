package app.zen.chromium

import android.accessibilityservice.AccessibilityService
import android.os.SystemClock
import android.util.Log
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Test
import org.junit.runner.RunWith
import java.io.FileInputStream

/**
 * Shows pull-to-refresh on a device so the `android-ptr-demo` workflow can record it: a long page
 * (Wikipedia's Damping article) at its top pulled a little and let go (the disc comes out and
 * goes back), pulled past the threshold (the page reloads under a spinning disc), a retracting
 * page caught by a second touch and pushed back up (the finger returns to the page), a fling on
 * the address pill still switching tabs, a scroll inside the page and a drag down from mid-page
 * neither of them pulling, the Look and Feel switch turning the pull off, and one more pull with
 * the address bar docked at the top.
 *
 * The profile (`ptr-demo-state.json`) holds two tabs. The `theme` instrumentation argument
 * (`light`, the default, or `dark`) picks the colour scheme. Screenshots land as
 * `ptr-<theme>-*.png`; see [DemoHarness] for the plumbing.
 */
@RunWith(AndroidJUnit4::class)
class PullToRefreshDemo : DemoHarness("ptr-demo-state.json", "ptr-$THEME", "ptr-demo") {
    override val tag = "PullToRefreshDemo"

    @Test
    fun record() = runDemo()

    override fun patchState(json: String): String =
        json.replace("\"colorScheme\": \"light\"", "\"colorScheme\": \"$THEME\"")

    /** Somewhere on the page, clear of both bar positions and of the article's first links. */
    private val pageX get() = width * 0.5f
    private val pageY get() = height * 0.4f

    override fun warmUp() {
        shell("cmd uimode night ${if (THEME == "dark") "yes" else "no"}")
        SystemClock.sleep(2_500)
        ensureForeground()
        // The article comes over the network; give it time, then pay for the touch pipeline off
        // camera with a scroll down and back up that no pull can come out of (it starts upwards).
        SystemClock.sleep(10_000)
        Finger().apply {
            down(pageX, pageY)
            moveBy(0f, -120 * density, 300)
            moveBy(0f, 120 * density, 300)
            up()
        }
        SystemClock.sleep(1_500)
        toTop()
        Log.i(tag, "warm-up done")
    }

    override fun demo() {
        shot("01-top")

        // 1. A little way and let go: the disc comes out under the frame's edge and goes back.
        Finger().apply {
            down(pageX, pageY)
            moveBy(0f, BELOW * density, 800)
            hold(700)
            shot("02-pull-below-threshold")
            up()
        }
        SystemClock.sleep(1_500)
        shot("03-retracted")

        // 2. Past the threshold: letting go reloads the page; the disc spins until it has loaded.
        Finger().apply {
            down(pageX, pageY)
            moveBy(0f, PAST * density, 1_000)
            hold(700)
            shot("04-pull-past-threshold")
            up()
        }
        SystemClock.sleep(600)
        shot("05-refreshing")
        SystemClock.sleep(7_000)
        shot("06-reloaded")

        // 3. Caught in flight: let go below the threshold and touch again while the page is still
        //    springing home – the finger has it where it is – then push it back up: the pull is
        //    undone and the rest of the drag is the page's, as any other scroll.
        Finger().apply {
            down(pageX, pageY)
            moveBy(0f, BELOW * density, 500)
            up()
            hold(90)
            down(pageX, pageY)
            hold(700)
            shot("07-caught")
            moveBy(0f, -(BELOW + 40) * density, 500)
            hold(400)
            shot("08-reversed")
            up()
        }
        SystemClock.sleep(1_500)
        toTop()

        // 4. The pill's horizontal fling is untouched: next tab, and back.
        flingLeft()
        SystemClock.sleep(3_500)
        shot("09-pill-swipe-next-tab")
        flingRight()
        SystemClock.sleep(3_500)

        // 5. Scrolling inside the page is a scroll; a drag down from mid-page scrolls back up
        //    instead of pulling, because the page was not at its top when the finger landed.
        Finger().apply {
            down(pageX, pageY)
            moveBy(0f, -260 * density, 500)
            up()
        }
        SystemClock.sleep(1_200)
        shot("10-scrolled-down")
        Finger().apply {
            down(pageX, pageY)
            moveBy(0f, PAST * density, 900)
            hold(600)
            shot("11-drag-down-mid-page-no-pull")
            up()
        }
        SystemClock.sleep(1_200)
        toTop()

        // 6. Settings → Look and Feel → Pull to refresh off: the same drag is the page's.
        openLookAndFeel()
        val row = reveal(PULL_ROW) ?: error("no $PULL_ROW row in Look and Feel")
        shot("12-settings-row")
        Finger().tap(width - 62 * density, row.exactCenterY())
        SystemClock.sleep(1_200)
        shot("13-settings-row-off")
        back()
        SystemClock.sleep(2_000)
        Finger().apply {
            down(pageX, pageY)
            moveBy(0f, PAST * density, 900)
            hold(600)
            shot("14-toggle-off-no-pull")
            up()
        }
        SystemClock.sleep(1_200)

        // 7. Back on, and the address bar carried to the top: the disc still comes from the
        //    frame's top edge, now under the bar.
        openLookAndFeel()
        val again = reveal(PULL_ROW) ?: error("no $PULL_ROW row in Look and Feel")
        Finger().tap(width - 62 * density, again.exactCenterY())
        SystemClock.sleep(800)
        reveal("Top")
        if (!clickByLabel("Top")) error("no Top option for the bar position")
        SystemClock.sleep(1_200)
        back()
        SystemClock.sleep(2_500)
        shot("15-bar-top")
        Finger().apply {
            down(pageX, pageY)
            moveBy(0f, PAST * density, 1_000)
            hold(700)
            shot("16-bar-top-pull-past-threshold")
            up()
        }
        SystemClock.sleep(600)
        shot("17-bar-top-refreshing")
        SystemClock.sleep(5_000)
        shot("18-bar-top-reloaded")
    }

    // --- moves -----------------------------------------------------------------------------------

    /**
     * Make sure the page is at its top without pulling it: a short drag up first (a drag that
     * begins upwards is never a pull, and it leaves the page off its top), then a long drag down
     * that scrolls it back up – it began with the page off the top, so it is the page's alone.
     */
    private fun toTop() {
        Finger().apply {
            down(pageX, pageY)
            moveBy(0f, -80 * density, 250)
            up()
        }
        SystemClock.sleep(900)
        Finger().apply {
            down(pageX, pageY)
            moveBy(0f, 500 * density, 300)
            up()
        }
        SystemClock.sleep(1_200)
    }

    /** Settings from the menu sheet; Look and Feel is the section it opens on. */
    private fun openLookAndFeel() {
        ensureForeground()
        val menu = findByLabel(MENU_LABEL) ?: error("no menu button")
        Finger().tap(menu.exactCenterX(), menu.exactCenterY())
        SystemClock.sleep(2_500)
        reveal("Settings")
        if (!clickByLabel("Settings")) error("no Settings row in the menu")
        SystemClock.sleep(3_000)
    }

    private fun back() {
        ui.performGlobalAction(AccessibilityService.GLOBAL_ACTION_BACK)
    }

    /** Run a shell command with the instrumentation's shell permissions; returns its output. */
    private fun shell(command: String): String {
        val fd = ui.executeShellCommand(command)
        return FileInputStream(fd.fileDescriptor).bufferedReader().use { it.readText() }.also { fd.close() }
    }

    companion object {
        private const val MENU_LABEL = "Menu"
        private const val PULL_ROW = "Pull to refresh"
        /**
         * Finger travel in dp. The chrome's pull reaches its threshold at 120 CSS px of travel
         * past the slop (`lib/pull.ts`); 70 stays clearly under it, 240 clearly over.
         */
        private const val BELOW = 70f
        private const val PAST = 240f
        private val THEME = InstrumentationRegistry.getArguments().getString("theme").let {
            if (it == "dark") "dark" else "light"
        }
    }
}
