package app.zen.chromium

import android.accessibilityservice.AccessibilityService
import android.os.SystemClock
import android.util.Log
import android.view.KeyEvent
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.json.JSONTokener
import org.junit.Test
import org.junit.runner.RunWith
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * The customisable navigation bar (`settings.phoneBar`) with OS-level touch input: a hold on
 * the bar opens its editor; Forward is dragged into the bar and Menu to the other side of the
 * address pill; Reset puts the defaults back. Then, with Forward and Reload added (six controls,
 * all the bar holds at this width, so a seventh is refused), the customised bar at work: Forward
 * dimmed until a page has been left and come back from, Reload becoming Stop while a page loads,
 * the tab count rolling when a tab closes and counting up when one opens; the pill's swipe still
 * switching tabs; and the same bar carried to the top edge, where a hold opens the editor too.
 *
 * Every step is checked against the accessibility tree (the moment Reload shows Stop against the
 * chrome's DOM, which answers in time) and logged (`check "..."`); the run fails when a check
 * does not hold. Driven by the `android-navbar-demo` workflow. See [DemoHarness].
 */
@RunWith(AndroidJUnit4::class)
class NavbarDemo : DemoHarness("navbar-demo-state.json", "navbar", "navbar-demo") {
    override val tag = "NavbarDemo"

    /** One row of either editor list in screen px: 44 CSS px at the device's density. */
    private val row get() = 44 * density
    private val failures = ArrayList<String>()

    @Test
    fun record() {
        runDemo()
        if (failures.isNotEmpty()) error("checks failed: ${failures.joinToString()}")
    }

    /** The seeded space is [example (active), tea, rfc, coffee]: give the next tab a card for the swipes. */
    override fun warmUp() {
        flingLeft(); settle()
        touchWithoutGesture(); settle()
        flingRight(); settle()
        touchWithoutGesture(); settle()
        Log.i(tag, "warm-up done")
    }

    override fun demo() {
        // 1. A hold on a bar button (not the pill, whose hold relocates the bar) opens the editor.
        holdBarButton("Menu")
        expect("a hold on the bar opens the editor", waitFor("Reset to defaults", 6_000) != null)
        SystemClock.sleep(1_500)
        shot("01-editor-open")
        expandEditor()

        // 2. Forward from Available into the bar, between Back and the pill.
        dragRow("Add Forward", position = 1, shotName = "02-forward-mid-drag")
        expect("Forward is in the bar", waitFor("Remove Forward", 4_000) != null)
        shot("03-forward-in-bar")

        // 3. Menu from the right of the pill to the far left.
        dragRow("Remove Menu", position = 0, shotName = "04-menu-mid-drag")
        shot("05-menu-left-of-pill")

        // 4. Reset to defaults: Forward is back in Available.
        tap("Reset to defaults")
        SystemClock.sleep(2_000)
        expect("Reset puts Forward back into Available", findByLabel("Add Forward") != null)
        shot("06-reset")

        // 5. The bar for the rest of the demo: Forward beside Back, Reload at the end. Six controls
        //    fill the bar at this width, so Home is refused.
        dragRow("Add Forward", position = 1, shotName = null)
        tap("Add Reload")
        SystemClock.sleep(1_500)
        tap("Add Home")
        SystemClock.sleep(1_500)
        expect(
            "a full bar refuses another control",
            findByLabel("Add Home") != null && findByLabel("Remove Home") == null
        )
        shot("07-bar-full")

        // 6. System back closes the editor; the bar behind shows the new layout.
        back()
        SystemClock.sleep(2_500)
        expect("back closes the editor", findByLabel("Reset to defaults") == null)
        remeasurePill()
        shot("08-custom-bar")

        // 7. Forward: dimmed with nowhere to go, live once a page has been left and come back from.
        expect("Forward is dimmed on a fresh tab", enabled("Forward") == false)
        navigateWithinTab()
        tap("Back")
        expect("Back returns to the first page", waitForAddress(12_000) { FIRST_HOST in it })
        SystemClock.sleep(1_200)
        expect("Forward is live after going back", enabled("Forward") == true)
        shot("09-forward-enabled")
        tap("Forward")
        expect("Forward returns to the second page", waitForAddress(12_000) { SECOND_HOST in it })
        SystemClock.sleep(2_500)

        // 8. Reload becomes Stop while the page loads, and Reload again once it has. A cached
        //    article reloads in well under a second, so the swap is read from the chrome's DOM
        //    as it happens; the settled state comes from the accessibility tree as usual.
        tap("Reload")
        val stopSeen = seenSoon("reload", "Stop", 6_000)
        shot("10-stop-while-loading")
        expect("Reload swaps to Stop while loading", stopSeen)
        expect("Stop swaps back to Reload", waitFor("Reload", 30_000) != null)
        SystemClock.sleep(1_000)

        // 9. The tab count: the Tabs button's hold opens its quick menu instead of the editor, Close
        //    Tab rolls the count down; the bar's New tab (through the URL bar) takes it back up.
        val before = tabCount() ?: error("no tab count on the Tabs button")
        holdBarButton("Tabs ($before)")
        expect("a hold on Tabs opens its quick menu", waitFor("Close Tab", 4_000) != null)
        shot("11-tabs-quick-menu")
        tap("Close Tab")
        SystemClock.sleep(250)
        shot("12-count-rolling")
        expect("the count rolled down", waitFor("Tabs (${before - 1})", 4_000) != null)
        SystemClock.sleep(1_500)
        tap("New tab")
        typeAddress("example.org")
        expect("the bar is back after the new tab", waitForBar())
        SystemClock.sleep(2_000)
        expect("the count is up again", waitFor("Tabs ($before)", 4_000) != null)
        shot("13-new-tab-count")

        // 10. The pill still switches tabs.
        remeasurePill()
        flingLeft()
        SystemClock.sleep(3_500)
        shot("14-swiped")
        flingRight()
        SystemClock.sleep(3_500)

        // 11. The pill's hold carries the bar to the top: the same controls there, the editor from a
        //     hold on the top bar, and the swipe.
        carryBarToTop()
        remeasurePill()
        expect("the bar docked at the top", pill.top < height / 2)
        shot("15-bar-top")
        holdBarButton("Menu")
        expect("a hold on the top bar opens the editor", waitFor("Reset to defaults", 6_000) != null)
        SystemClock.sleep(1_500)
        shot("16-editor-from-top")
        back()
        SystemClock.sleep(2_500)
        remeasurePill()
        flingLeft()
        SystemClock.sleep(3_500)
        shot("17-top-swiped")
    }

    // --- the editor ------------------------------------------------------------------------------

    /** Hold a bar button past the 400 ms hold (the release after a long press is not a tap). */
    private fun holdBarButton(label: String) {
        val r = waitFor(label, 5_000) ?: error("no \"$label\" button on the bar")
        val f = Finger()
        f.press(r.exactCenterX(), r.exactCenterY())
        f.up()
    }

    /** The sheet opens at its peek detent, Available below the fold: a tap on the handle expands it. */
    private fun expandEditor() {
        tap("Resize editor")
        SystemClock.sleep(2_000)
    }

    /**
     * Pick up the row whose trailing control is `control` (a hold on its label lifts it), carry
     * it to `position` in the "In the bar" sequence (0 = first; the address pill counts as a
     * row) and let go. The row is held by its middle, so it lands where the middle of the row at
     * `position` is – measured from the Back row, first in the bar throughout this demo.
     */
    private fun dragRow(control: String, position: Int, shotName: String?) {
        val from = waitFor(control, 5_000) ?: error("no row with \"$control\"")
        val first = findByLabel("Remove Back") ?: error("Back is not first in the bar")
        val x = 0.45f * width
        val fromY = from.exactCenterY()
        val toY = first.exactCenterY() + position * row
        val nudge = if (toY < fromY) -NUDGE else NUDGE
        val f = Finger()
        f.down(x, fromY)
        f.hold(LONG_PRESS_WAIT)
        f.moveBy(0f, nudge, 100)
        f.moveBy(0f, toY - fromY - nudge, 700)
        f.hold(600)
        if (shotName != null) shot(shotName)
        f.hold(300)
        f.up()
        SystemClock.sleep(1_800)
    }

    // --- the bar at work ---------------------------------------------------------------------

    /** Leave the seeded page for an article, within the tab, through the URL bar. */
    private fun navigateWithinTab() {
        val from = address()
        Finger().tap(pillCenterX, pillY)
        typeAddress(SECOND_PAGE)
        val arrived = waitForAddress(15_000) { SECOND_HOST in it }
        Log.i(tag, "navigated from $from to ${address()}${if (arrived) "" else " (still loading)"}")
        SystemClock.sleep(3_000)
    }

    /**
     * Type into the URL bar once it is up and the keyboard has settled (the first keyboard of a
     * run comes up slowly, and keys sent before it is ready are lost), then Go.
     */
    private fun typeAddress(text: String) {
        val deadline = SystemClock.uptimeMillis() + 6_000
        while (findNode { it.startsWith("Search engine:") } == null && SystemClock.uptimeMillis() < deadline) {
            SystemClock.sleep(200)
        }
        SystemClock.sleep(2_000)
        instrumentation.sendStringSync(text)
        SystemClock.sleep(600)
        instrumentation.sendKeyDownUpSync(KeyEvent.KEYCODE_ENTER)
    }

    /** The pill's hold carries the whole bar to the top edge (the page slides down under it). */
    private fun carryBarToTop() {
        val insets = windowInsets()
        val topPillY = insets.top + 56 * density / 2
        val travel = pillY - topPillY
        val f = Finger()
        f.down(pillCenterX, pillY)
        f.hold(800)
        f.moveBy(0f, -0.5f * travel, 700)
        f.hold(400)
        f.moveBy(0f, -0.5f * travel, 600)
        f.hold(400)
        f.up()
        SystemClock.sleep(2_500)
    }

    /** The pill moved (with the bar, or back from under the URL bar): find it again. */
    private fun remeasurePill() {
        val found = findByLabelPrefix(PILL_LABEL)?.takeIf { it.width() > 100 * density }
        if (found == null) {
            Log.w(tag, "pill not in the accessibility tree; keeping $pill")
            return
        }
        pill = found
        pillY = pill.exactCenterY()
        pillCenterX = pill.exactCenterX()
        Log.i(tag, "pill now $pill")
    }

    // --- reading the chrome ----------------------------------------------------------------------

    /** The bar's Tabs button carries its count: `Tabs (4)`. */
    private fun tabCount(): Int? {
        val node = findNode { it.startsWith("Tabs (") } ?: return null
        val label = node.contentDescription?.toString() ?: node.text?.toString() ?: return null
        return label.removePrefix("Tabs (").removeSuffix(")").toIntOrNull()
    }

    /** Whether the control labelled `label` is enabled (`aria-disabled` dims a bar button). */
    private fun enabled(label: String): Boolean? = findNode { it == label }?.isEnabled

    /** The address the pill shows (`Address, example.com`), or null while the URL bar hides the bar. */
    private fun address(): String? {
        val node = findNode { it.startsWith("$PILL_LABEL,") } ?: return null
        val label = node.contentDescription?.toString() ?: node.text?.toString() ?: return null
        return label.removePrefix("$PILL_LABEL,").trim()
    }

    /** Poll until the pill's address satisfies `matches`. */
    private fun waitForAddress(timeoutMs: Long, matches: (String) -> Boolean): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            val now = address()
            if (now != null && matches(now)) return true
            SystemClock.sleep(200)
        }
        Log.w(tag, "address still ${address()}")
        return false
    }

    /**
     * Poll the bar's `item` control until it is labelled `label`: for a state that lasts a
     * moment (Stop). Walking the accessibility tree of an article page takes seconds, so this
     * reads the label the tree would carry straight from the chrome's DOM, every few frames.
     */
    private fun seenSoon(item: String, label: String, timeoutMs: Long): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            if (barLabel(item) == label) return true
            SystemClock.sleep(32)
        }
        return false
    }

    /** The `aria-label` of the live bar's `item` control, or null when the bar is not up. */
    private fun barLabel(item: String): String? {
        val chrome = (activity as MainActivity).host.chrome
        val latch = CountDownLatch(1)
        var answer: String? = null
        instrumentation.runOnMainSync {
            chrome.evaluateJavascript(
                "(function(){var b=document.querySelector('.zen-phone-bar [data-bar-item=\"$item\"]');" +
                    "return b?b.getAttribute('aria-label'):null})()"
            ) {
                answer = it
                latch.countDown()
            }
        }
        latch.await(2, TimeUnit.SECONDS)
        // evaluateJavascript hands the value back as a JSON literal: a quoted string here.
        return runCatching { JSONTokener(answer ?: "null").nextValue() as? String }.getOrNull()
    }

    /** Poll until the address pill is back on screen (the URL bar hides the bar while it is up). */
    private fun waitForBar(timeoutMs: Long = 8_000): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            if (findByLabelPrefix(PILL_LABEL) != null) return true
            SystemClock.sleep(200)
        }
        return false
    }

    private fun expect(name: String, ok: Boolean) {
        Log.i(tag, "check \"$name\": ${if (ok) "ok" else "FAILED"}")
        if (!ok) failures.add(name)
    }

    // --- input -----------------------------------------------------------------------------------

    private fun tap(label: String) {
        val r = waitFor(label, 5_000) ?: error("nothing labelled \"$label\" on screen")
        Finger().tap(r.exactCenterX(), r.exactCenterY())
    }

    private fun back() {
        ui.performGlobalAction(AccessibilityService.GLOBAL_ACTION_BACK)
    }

    private companion object {
        /** The seeded active tab's host and the page the demo leaves it for. */
        const val FIRST_HOST = "example.com"
        const val SECOND_PAGE = "en.wikipedia.org/wiki/Damping"
        const val SECOND_HOST = "wikipedia.org"
    }
}
