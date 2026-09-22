package app.zen.chromium

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
        //    Tab rolls the count down; the bar's New tab takes it back up. Since #51 New tab opens
        //    the new tab page – its field in the page, the pill reading 'Search or enter address',
        //    no URL bar – so the address goes in the way a user's does: a tap on the pill opens the
        //    field, then the keys. (The nightly's run typed into nothing here and lost the pill.)
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
        expect("New tab opens the new tab page, the pill empty", awaitPillLabel(8_000) { it == NTP_PILL_LABEL })
        remeasurePill()
        Finger().tap(pillCenterX, pillY)
        typeAddress(NEW_TAB_HOST)
        expect("the bar is back after the new tab", waitForBar())
        SystemClock.sleep(2_000)
        expect("the count is up again", waitFor("Tabs ($before)", 4_000) != null)
        shot("13-new-tab-count")

        // 10. The pill still switches tabs: the new tab is last in the space, so a fling from the
        //     pill's left end goes to the previous tab (an article) and one from its right end back.
        remeasurePill()
        awaitPageSettled()
        flingRight()
        expect("the pill's swipe switches to the previous tab", waitForAddress(12_000) { SECOND_HOST in it })
        SystemClock.sleep(2_500)
        shot("14-swiped")
        remeasurePill()
        awaitPageSettled()
        flingLeft()
        expect("the pill's swipe switches back", waitForAddress(12_000) { NEW_TAB_HOST in it })
        SystemClock.sleep(2_500)

        // 11. The pill's hold carries the bar to the top: the same controls there, the editor from a
        //     hold on the top bar, and the swipe.
        carryBarToTop()
        remeasurePill()
        // The dock by the document (`.zen-phone-bar[data-edge]`, the setting's word) and the
        // pill's box in the upper half; the tree trails the moved bar by seconds here.
        val edge = barEdge()
        Log.i(tag, "after the carry: bar edge '$edge', pill $pill")
        expect("the bar docked at the top", edge == "top" && pill.top < height / 2)
        shot("15-bar-top")
        holdBarButton("Menu")
        expect("a hold on the top bar opens the editor", waitFor("Reset to defaults", 6_000) != null)
        SystemClock.sleep(1_500)
        shot("16-editor-from-top")
        back()
        SystemClock.sleep(2_500)
        remeasurePill()
        awaitPageSettled()
        flingRight()
        expect("the pill's swipe switches tabs at the top", waitForAddress(12_000) { SECOND_HOST in it })
        SystemClock.sleep(2_500)
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
     * Type into the URL field once it is open – by the field ([awaitOmniboxOpen]: the store's
     * word and the focused input, never the tree, which trails the screen here) – and the
     * keyboard has settled (the first keyboard of a run comes up slowly, and keys sent before it
     * is ready are lost), then Go.
     */
    private fun typeAddress(text: String) {
        val open = awaitOmniboxOpen(8_000)
        if (!open.ok) Log.w(tag, "typing into a field not proven open: ${open.describe()}")
        SystemClock.sleep(2_000)
        instrumentation.sendStringSync(text)
        SystemClock.sleep(600)
        instrumentation.sendKeyDownUpSync(KeyEvent.KEYCODE_ENTER)
    }

    /**
     * Wait for the active page to have loaded (the core's word) and a moment past it before a
     * fling. On the nightly's proof run the swipe back went into a Wikipedia page still loading
     * at four to six frames a second (`app_time_stats` avg 250 ms) and never became a switch:
     * the 120 ms fling fell inside one frame. The claim is a swipe on a page at rest, not one
     * raced against the software GPU; the fling itself stays the harness's quick one.
     */
    private fun awaitPageSettled(timeoutMs: Long = 20_000) {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        var loading = true
        while (SystemClock.uptimeMillis() < deadline) {
            loading = activeCoreTab()?.optBoolean("loading", true) ?: true
            if (!loading) break
            SystemClock.sleep(250)
        }
        if (loading) Log.w(tag, "the active page is still loading after $timeoutMs ms; flinging anyway")
        SystemClock.sleep(1_500)
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

    /**
     * The pill moved (with the bar, or back from under the URL bar): find it again where the
     * chrome lays it out ([pillBounds]: the document first, the tree – by either name – after it;
     * the tree kept the pill's old bounds for seconds after the carry on the nightly's proof run).
     */
    private fun remeasurePill() {
        val found = pillBounds()?.takeIf { it.width() > 100 * density }
        if (found == null) {
            Log.w(tag, "pill neither in the document nor the accessibility tree; keeping $pill")
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

    /** The pill's whole label ([pillNode]: `Address, example.com, …` on a page, the empty field's words on the new tab page), or null while the URL bar hides the bar. */
    private fun pillLabel(): String? = pillNode()?.let { it.contentDescription?.toString() ?: it.text?.toString() }

    /** The address the pill shows (`example.com, Connection is secure`), or null on the new tab page and while the URL bar hides the bar. */
    private fun address(): String? =
        pillLabel()?.takeIf { it.startsWith("$PILL_LABEL,") }?.removePrefix("$PILL_LABEL,")?.trim()

    /** Poll until the pill's address satisfies `matches`. */
    private fun waitForAddress(timeoutMs: Long, matches: (String) -> Boolean): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            val now = address()
            if (now != null && matches(now)) return true
            SystemClock.sleep(200)
        }
        Log.w(tag, "address still ${address()} (pill '${pillLabel()}')")
        return false
    }

    /** Poll until the pill's whole label satisfies `matches` (the new tab page's empty pill). */
    private fun awaitPillLabel(timeoutMs: Long, matches: (String) -> Boolean): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            pillLabel()?.let { if (matches(it)) return true }
            SystemClock.sleep(200)
        }
        Log.w(tag, "pill still '${pillLabel()}'")
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

    /** Poll until the address pill is back on screen, by either name (the URL bar hides the bar while it is up). */
    private fun waitForBar(timeoutMs: Long = 8_000): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            if (pillNode() != null) return true
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

    private companion object {
        /** The seeded active tab's host and the page the demo leaves it for. */
        const val FIRST_HOST = "example.com"
        const val SECOND_PAGE = "en.wikipedia.org/wiki/Damping"
        /** Also the host of the seeded space's last tab (an article), the previous tab of the new one. */
        const val SECOND_HOST = "wikipedia.org"
        /** The page the new tab of step 9 is sent to. */
        const val NEW_TAB_HOST = "example.org"
    }
}
