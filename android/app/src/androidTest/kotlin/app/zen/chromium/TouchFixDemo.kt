package app.zen.chromium

import android.accessibilityservice.AccessibilityService
import android.graphics.Rect
import android.os.SystemClock
import android.util.Log
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/**
 * Shows the phone chrome's touch fixes on a device so the `android-touchfix-demo` workflow can
 * record them: the History, Bookmarks and Downloads panels with their per-row Remove buttons
 * visible under a finger (no hover on a touch screen), one history entry and one bookmark removed
 * by tapping that button, and the find bar in its phone layout (flexing field, 44 px buttons, a
 * compact n/m counter, the keyboard's search key) stepping through the matches on example.com.
 *
 * The profile is seeded with a few visits, bookmarks and downloads (the `touchfix-demo-*.json`
 * assets; `{{now-Nh}}` stamps become timestamps N hours before the run so the panels show
 * relative times). The `theme` instrumentation argument (`light`, the default, or `dark`) picks
 * the colour scheme. Driven by the `android-touchfix-demo` workflow; see [DemoHarness] for the
 * plumbing. Screenshots land as `touchfix-<theme>-*.png`.
 */
@RunWith(AndroidJUnit4::class)
class TouchFixDemo : DemoHarness("touchfix-demo-state.json", "touchfix-$THEME", "touchfix-demo") {
    override val tag = "TouchFixDemo"

    @Test
    fun record() {
        runDemo()
    }

    // --- seed ------------------------------------------------------------------------------------

    override fun patchState(json: String): String =
        stamp(json).replace("\"colorScheme\": \"light\"", "\"colorScheme\": \"$THEME\"")

    override fun seedMore(zen: File) {
        File(zen, "history.json").writeText(stamp(readAsset("touchfix-demo-history.json")))
        File(zen, "downloads.json").writeText(stamp(readAsset("touchfix-demo-downloads.json")))
    }

    /** `"{{now-3h}}"` (quotes included) becomes the epoch millisecond three hours before now. */
    private fun stamp(text: String): String {
        val now = System.currentTimeMillis()
        return STAMP.replace(text) { m ->
            val hours = m.groupValues[1].toLongOrNull() ?: 0L
            (now - hours * 3_600_000L).toString()
        }
    }

    // --- sequence --------------------------------------------------------------------------------

    /** The first sheet pays for layout and compilation; open it once off camera. */
    override fun warmUp() {
        openMenu()
        if (waitFor(HANDLE_LABEL, 6_000) != null) {
            SystemClock.sleep(1_000)
            back()
        }
        SystemClock.sleep(2_000)
        Log.i(tag, "warm-up done")
    }

    override fun demo() {
        // 1. History: every row shows its Remove button; tapping one removes the entry.
        openPanel("History", "Remove from history")
        dismissKeyboard()
        shot("01-history")
        tapFirst("Remove from history")
        SystemClock.sleep(1_500)
        shot("02-history-removed")
        back()
        SystemClock.sleep(1_500)

        // 2. Bookmarks, the same way.
        openPanel("Bookmarks", "Remove bookmark")
        dismissKeyboard()
        shot("03-bookmarks")
        tapFirst("Remove bookmark")
        SystemClock.sleep(1_500)
        shot("04-bookmarks-removed")
        back()
        SystemClock.sleep(1_500)

        // 3. Downloads: the Remove button of each finished row is visible too.
        openPanel("Downloads", "Remove from list")
        shot("05-downloads")
        back()
        SystemClock.sleep(1_500)

        // 4. Find in page on example.com: type a phrase, the counter reads 1/n, step to the next.
        //    The field itself has no label the tree reports (its name is the hint), so the bar
        //    is recognised by its Next button and the field is tapped by position, left of it.
        openPanel("Find in Page…", "Next match")
        val prev = findByLabel("Previous match") ?: error("no find bar buttons")
        Finger().tap(width * 0.25f, prev.exactCenterY())
        SystemClock.sleep(1_500)
        instrumentation.sendStringSync("example")
        SystemClock.sleep(3_000)
        shot("06-find")
        tapFirst("Next match")
        SystemClock.sleep(1_500)
        shot("07-find-next")
        tapFirst("Close find bar")
        SystemClock.sleep(1_500)
        shot("08-find-closed")
    }

    // --- moves -----------------------------------------------------------------------------------

    private fun openMenu() {
        ensureForeground()
        val button = findByLabel(MENU_LABEL) ?: computedMenuButton()
        Finger().tap(button.exactCenterX(), button.exactCenterY())
    }

    /** Where the menu button is when the accessibility tree does not say: rightmost in the bar. */
    private fun computedMenuButton(): Rect {
        val centerY = height - 28 * density
        val centerX = width - 30 * density
        val half = 22 * density
        return Rect(
            (centerX - half).toInt(), (centerY - half).toInt(),
            (centerX + half).toInt(), (centerY + half).toInt()
        )
    }

    private fun back() {
        ui.performGlobalAction(AccessibilityService.GLOBAL_ACTION_BACK)
    }

    /** The panels focus their search field on open, which raises the keyboard; back takes it down first. */
    private fun dismissKeyboard() {
        var up = false
        instrumentation.runOnMainSync {
            val root = activity.window.decorView
            up = ViewCompat.getRootWindowInsets(root)?.isVisible(WindowInsetsCompat.Type.ime()) == true
        }
        if (!up) return
        back()
        SystemClock.sleep(1_500)
    }

    /**
     * Open the menu, expand it so the whole list is in reach, tap the item labelled `item`, and
     * wait for `expect` (something only the opened surface has) to show up.
     */
    private fun openPanel(item: String, expect: String) {
        openMenu()
        waitFor(HANDLE_LABEL, 6_000) ?: error("the menu never opened")
        SystemClock.sleep(1_200)
        val handle = findByLabel(HANDLE_LABEL) ?: error("no menu handle")
        Finger().apply {
            down(handle.exactCenterX(), handle.exactCenterY())
            moveBy(0f, -0.4f * height, 130)
            up()
        }
        SystemClock.sleep(2_000)
        val target = reveal(item) ?: error("no $item in the menu")
        Finger().tap(target.exactCenterX(), target.exactCenterY())
        waitFor(expect, 8_000) ?: error("$item opened nothing with $expect")
        SystemClock.sleep(2_000)
    }

    /** Tap the first (topmost) element carrying this label with a finger. */
    private fun tapFirst(label: String) {
        val target = findByLabel(label) ?: error("no $label to tap")
        Finger().tap(target.exactCenterX(), target.exactCenterY())
    }

    companion object {
        private val THEME = InstrumentationRegistry.getArguments().getString("theme").let {
            if (it == "dark") "dark" else "light"
        }
        private val STAMP = Regex("\"\\{\\{now(?:-(\\d+)h)?\\}\\}\"")
        private const val MENU_LABEL = "Menu"
        private const val HANDLE_LABEL = "Resize menu"
    }
}
