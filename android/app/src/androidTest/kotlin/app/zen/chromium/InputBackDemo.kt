package app.zen.chromium

import android.content.Intent
import android.graphics.PointF
import android.net.Uri
import android.os.Build
import android.os.SystemClock
import android.util.Log
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.json.JSONArray
import org.json.JSONObject
import org.json.JSONTokener
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlin.math.max
import kotlin.math.roundToInt

/**
 * Walks the input and back findings of the emulator bug hunt on a device so the
 * `android-input-back-demo` workflow can record them, and writes what it measured to
 * `input-back-findings.txt` next to the screenshots (one `PASS` or `FAIL` per check; the test
 * itself only fails when the driver could not run):
 *
 *  - BH-08: a swipe along the address pill at the hunt's pace (45 % of the width in 250 ms) and
 *    a slow drag with a resting lift switch to the neighbouring tab in both directions;
 *  - BH-16: History, Bookmarks and New Space open without the keyboard and one back closes them;
 *  - BH-03: with the keyboard up for a page text field the page reaches down to the bar, which
 *    rests on the keyboard – the inset is not applied twice;
 *  - BH-09: a long press on page text selects a word and shows the floating toolbar;
 *  - BH-01: Print…, the system preview renders the page, back out of it, and the chrome still
 *    takes touches;
 *  - BH-07: back over history, back on a `target=_blank` child tab returns to its opener, back
 *    on a tab another app sent (through LinkDispatchActivity) leaves to the caller and resumes
 *    the tab the user was on when the app is next in front, back at an ordinary tab's first
 *    page starts it over as a new tab and once more closes it.
 *
 * The pages come from a loopback server inside this process ([DemoServer]), so nothing depends
 * on the network. The profile (`input-back-demo-state.json`) holds three tabs of those pages
 * with the middle one active. See [DemoHarness] for the plumbing.
 */
@RunWith(AndroidJUnit4::class)
class InputBackDemo : DemoHarness("input-back-demo-state.json", "input-back", "input-back-demo") {
    override val tag = "InputBackDemo"
    private lateinit var server: DemoServer
    private lateinit var findings: File
    private val host get() = (activity as MainActivity).host

    @Test
    fun record() {
        server = DemoServer(
            PORT,
            mapOf(
                "/" to ("text/html; charset=utf-8" to readAsset("input-back-demo-page.html").toByteArray()),
                "/second.html" to DemoServer.page("Second page", "<p><a href=\"/\">Back to the first page</a></p>"),
                "/child.html" to DemoServer.page("Child tab", "<p>Opened by the first page's link.</p>"),
                "/intent.html" to DemoServer.page("Sent by another app"),
                "/left.html" to DemoServer.page("Left tab"),
                "/right.html" to DemoServer.page("Right tab")
            )
        ).also { it.start() }
        try {
            runDemo()
        } finally {
            server.close()
        }
    }

    override fun warmUp() {
        findings = File(out, "input-back-findings.txt")
        findings.writeText("Zenium Android input and back checks (API ${Build.VERSION.SDK_INT}, ${width}x$height, density $density)\n\n")
        finding("demo server: ${server.selfCheck()}")
        awaitLoaded("$ORIGIN/")
        SystemClock.sleep(2_000)
        finding("start: ${describeActive()}")
    }

    override fun demo() {
        shot("00-start")
        pillSwipes()
        panelsWithoutKeyboard()
        keyboardInset()
        textSelection()
        printAndBack()
        backSemantics()
        finding("\nend: ${describeActive()}")
    }

    // --- BH-08 -----------------------------------------------------------------------------------

    /** A swipe along the pill switches to the neighbouring tab in either direction, at the hunt's pace and slower. */
    private fun pillSwipes() {
        finding("\nBH-08 pill swipes (tabs: left, demo, right; demo active)")
        swipePill(-0.45f * width, 250)
        settle()
        val afterLeft = activeTabId()
        finding("  left swipe, 45 % of the width in 250 ms: active $afterLeft ${verdict(afterLeft == "tab_right")}")
        shot("01-pill-swipe-left")
        swipePill(0.45f * width, 250)
        settle()
        val afterRight = activeTabId()
        finding("  right swipe back: active $afterRight ${verdict(afterRight == "tab_demo")}")
        // Past Chrome's commit distance, slowly, and a lift from a finger at rest: distance alone commits.
        swipePill(-max(0.3f * width, 120 * density), 900, rest = 400)
        settle()
        val afterSlow = activeTabId()
        finding("  slow drag left with a resting lift: active $afterSlow ${verdict(afterSlow == "tab_right")}")
        swipePill(0.45f * width, 250)
        settle()
        val afterSlowBack = activeTabId()
        finding("  right swipe back: active $afterSlowBack ${verdict(afterSlowBack == "tab_demo")}")
        ensureActive("tab_demo")
    }

    /** Along the pill from its far end, so the whole travel stays on screen. */
    private fun swipePill(dx: Float, durationMs: Long, rest: Long = 0) {
        val f = Finger()
        f.down(if (dx < 0) pill.right - 10f else pill.left + 10f, pillY)
        f.moveBy(dx, 0f, durationMs)
        if (rest > 0) f.hold(rest)
        f.up()
    }

    // --- BH-16 -----------------------------------------------------------------------------------

    /** The list panels open without the keyboard, so one back closes them. */
    private fun panelsWithoutKeyboard() {
        finding("\nBH-16 panels open without the keyboard; one back closes them")
        val panels = listOf(
            arrayOf("History") to "02-history",
            // Bookmarks is a submenu since #90; the manager is behind "Show Bookmarks".
            arrayOf("Bookmarks", "Show Bookmarks") to "03-bookmarks",
            arrayOf("New Space…") to "04-new-space"
        )
        for ((path, name) in panels) {
            val item = path.last()
            if (!openMenuItem(*path)) {
                finding("  $item: not reached in the menu")
                closeSurfaces()
                continue
            }
            SystemClock.sleep(1_000)
            // Give a focus-on-open keyboard every chance to come before deciding it did not.
            val keyboard = awaitIme(shown = true, timeoutMs = 3_000)
            val surface = chromeSurfaceUp()
            shot(name)
            back()
            SystemClock.sleep(2_500)
            val closed = !chromeSurfaceUp()
            finding(
                "  $item: keyboard ${if (keyboard) "UP" else "down"}, surface ${if (surface) "up" else "missing"}; " +
                    "one back: surface ${if (closed) "closed" else "STILL UP"} ${verdict(!keyboard && surface && closed)}"
            )
            if (!closed) {
                shot("$name-after-one-back")
                back()
                SystemClock.sleep(2_000)
            }
            if (imeShown()) {
                back()
                awaitIme(shown = false, timeoutMs = 3_000)
            }
        }
    }

    // --- BH-03 -----------------------------------------------------------------------------------

    /** With the keyboard up for a page field, the page ends at the bar and the bar rests on the keyboard. */
    private fun keyboardInset() {
        finding("\nBH-03 page text field and the keyboard")
        val field = pagePoint("#input") ?: run {
            finding("  no #input on the page")
            return
        }
        Finger().tap(field.x, field.y)
        val up = awaitIme(shown = true, timeoutMs = 8_000)
        SystemClock.sleep(2_000)
        val ime = imeInset()
        val decorHeight = onMain { activity.window.decorView.height }
        val page = onMain { shownTabView()?.let { v -> IntArray(2).also(v::getLocationOnScreen).let { loc -> loc[1] to loc[1] + v.height } } }
        shot("05-keyboard-page-field")
        if (page == null) {
            finding("  keyboard inset $ime px, but no page view is shown")
        } else {
            val imeTop = height - ime
            val band = imeTop - page.second
            val bar = (64 * density).roundToInt()
            val ok = up && band in 0..(bar + (24 * density).roundToInt()) && decorHeight == height
            finding(
                "  keyboard ${if (up) "up" else "NOT UP"}, inset $ime px; window ${if (decorHeight == height) "kept its height" else "RESIZED to $decorHeight"}; " +
                    "page ${page.first}..${page.second} of $height; band between page and keyboard $band px (bar $bar) ${verdict(ok)}"
            )
        }
        back()
        awaitIme(shown = false, timeoutMs = 4_000)
        SystemClock.sleep(1_000)
    }

    // --- BH-09 -----------------------------------------------------------------------------------

    /**
     * A long press on page text selects a word and brings up the floating toolbar. The press lands
     * on one word, not on the paragraph's middle: Blink selects the word under the finger and a
     * hit between two words or two lines selects nothing.
     */
    private fun textSelection() {
        finding("\nBH-09 long press on page text")
        val word = pagePoint("#word") ?: run {
            finding("  no #word on the page")
            return
        }
        Finger().apply {
            down(word.x, word.y)
            hold(1_200)
            up()
        }
        SystemClock.sleep(2_500)
        val selected = jsonString(tabJs("String(getSelection())"))
        val toolbar = findInWindows { it == "Copy" || it == "Select all" || it == "Share" || it == "Web search" }
        shot("06-text-long-press")
        finding(
            "  long press on 'selectable': selection '${selected}'; floating toolbar ${if (toolbar != null) "up" else "MISSING"} " +
                verdict(selected.isNotBlank() && toolbar != null)
        )
        // Clear it: a tap on the page's last line.
        pagePoint("#tail")?.let { Finger().tap(it.x, it.y) }
        SystemClock.sleep(1_500)
    }

    // --- BH-01 -----------------------------------------------------------------------------------

    /**
     * Print…, wait for the system preview to render the page (its pages announce themselves as
     * "Page 1 of N"; a document it could not read shows "Sorry, that didn't work"), back out of
     * it, and the chrome still takes touches.
     */
    private fun printAndBack() {
        finding("\nBH-01 Print… and back out of the preview")
        if (!openMenuItem("Print…")) {
            finding("  Print… not reached in the menu")
            closeSurfaces()
            return
        }
        val preview = awaitSystemWindow(20_000)
        val started = SystemClock.uptimeMillis()
        val rendered = awaitPreviewOutcome(30_000)
        val took = SystemClock.uptimeMillis() - started
        SystemClock.sleep(1_500)
        shot("07-print-preview")
        finding("  system print preview ${if (preview) "opened (${topPackage()})" else "did NOT open"}")
        finding(
            "  preview ${
                when (rendered) {
                    null -> "showed neither a page nor an error in ${took} ms"
                    else -> if (rendered.ok) "rendered the page: '${rendered.label}' after $took ms" else "FAILED: '${rendered.label}'"
                }
            } ${verdict(rendered?.ok == true)}"
        )
        back()
        val returned = awaitForeground(15_000)
        SystemClock.sleep(2_500)
        shot("08-after-print")
        tapMenuButton()
        val menu = waitFor(MENU_HANDLE_LABEL, 8_000) != null
        shot("09-menu-after-print")
        finding("  back: browser ${if (returned) "in front" else "NOT in front"}; menu ${if (menu) "opens" else "does NOT open"} ${verdict(preview && returned && menu)}")
        if (menu) {
            back()
            SystemClock.sleep(1_500)
        }
        finding("  page renderer answers 1+1: ${tabJs("1+1")}")
    }

    /** What the print preview came to show: a rendered page (ok) or the spooler's error. */
    private class PreviewOutcome(val ok: Boolean, val label: String)

    /**
     * Poll the spooler's window for a rendered page – each one is described as "Page n of m"
     * (PrintSpooler's `page_description_template`) and numbered "n/m" – or its "Sorry, that
     * didn't work" error; null when neither has come in time (still "Preparing preview…").
     */
    private fun awaitPreviewOutcome(timeoutMs: Long): PreviewOutcome? {
        val page = Regex("""^Page \d+\s+of\s+\d+$""")
        val number = Regex("""^\d+/\d+$""")
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            val label = findInWindows { page.matches(it.trim()) || number.matches(it.trim()) }
                ?.let { it.contentDescription?.toString() ?: it.text?.toString() }
            if (label != null) return PreviewOutcome(true, label.trim())
            val error = findInWindows { it.startsWith("Sorry, that didn") }
                ?.let { it.text?.toString() ?: it.contentDescription?.toString() }
            if (error != null) return PreviewOutcome(false, error)
            SystemClock.sleep(500)
        }
        return null
    }

    // --- BH-07 -----------------------------------------------------------------------------------

    /** Back over history, at a child tab, at a tab another app sent, and at an ordinary tab's first page. */
    private fun backSemantics() {
        finding("\nBH-07 back at a tab's first page")
        val before = tabCount()

        // (a) Over the page's history.
        tapPage("#link a")
        awaitLoaded("$ORIGIN/second.html")
        SystemClock.sleep(1_500)
        back()
        awaitLoaded("$ORIGIN/")
        SystemClock.sleep(1_500)
        finding("  back over history: ${activeUrl()} ${verdict(activeUrl() == "$ORIGIN/")}")
        shot("10-back-over-history")

        // (b) A target=_blank child: back closes it and returns to the opener.
        tapPage("#blank a")
        val child = awaitOtherActiveTab("tab_demo")
        awaitLoaded("$ORIGIN/child.html")
        SystemClock.sleep(1_500)
        shot("11-child-tab")
        back()
        SystemClock.sleep(3_000)
        val afterChild = activeTabId()
        val opener = child?.optString("openerTabId").orEmpty()
        finding(
            "  child tab ${child?.optString("id")} (opener '$opener'): back → active $afterChild, tabs ${tabCount()} (were $before) " +
                verdict(opener == "tab_demo" && afterChild == "tab_demo" && tabCount() == before)
        )
        shot("12-after-child-back")

        // (c) A link another app sent, through LinkDispatchActivity: back closes the tab and leaves to the caller.
        app.startActivity(
            Intent(Intent.ACTION_VIEW, Uri.parse("$ORIGIN/intent.html"))
                .setClass(app, LinkDispatchActivity::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        )
        val sent = awaitOtherActiveTab("tab_demo")
        awaitLoaded("$ORIGIN/intent.html")
        SystemClock.sleep(1_500)
        shot("13-intent-tab")
        // The sent tab was an interruption of tab_demo (active before it): when the app is next
        // in front, tab_demo is back, not the sent tab's strip neighbour.
        back()
        val left = awaitSystemWindow(10_000)
        SystemClock.sleep(2_000)
        shot("14-after-intent-back")
        app.startActivity(Intent(app, MainActivity::class.java).setAction(Intent.ACTION_MAIN).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        awaitForeground(15_000)
        SystemClock.sleep(3_000)
        val afterIntent = activeTabId()
        finding(
            "  intent tab ${sent?.optString("id")} (fromIntent ${sent?.optBoolean("fromIntent")}): back → app ${if (left) "left to the caller" else "STAYED in front"}; " +
                "back in front: active $afterIntent (was on tab_demo), tabs ${tabCount()} " +
                verdict(left && afterIntent == "tab_demo" && tabCount() == before)
        )
        shot("15-returned-after-intent")
        // Already active when (c) passed; keeps (d) on its tab when it did not.
        ensureActive("tab_demo")

        // (d) An ordinary tab at its first page: it starts over as a new tab; back on that closes it to a neighbour.
        back()
        SystemClock.sleep(3_000)
        val fresh = activeCoreTab()
        val freshId = fresh?.optString("id").orEmpty()
        val freshUrl = fresh?.optString("url").orEmpty()
        finding(
            "  root back on the page: active $freshId url '$freshUrl', tabs ${tabCount()} " +
                verdict(freshId.isNotEmpty() && freshId != "tab_demo" && freshUrl == BLANK_URL && tabCount() == before)
        )
        shot("16-root-back-new-tab")
        back()
        SystemClock.sleep(3_000)
        val afterBlank = activeTabId()
        finding("  back on the new tab: active $afterBlank, tabs ${tabCount()} ${verdict(afterBlank != freshId && tabCount() == before - 1)}")
        shot("17-new-tab-back-closes")
    }

    // --- the page --------------------------------------------------------------------------------

    private fun <T> onMain(block: () -> T): T {
        var result: T? = null
        instrumentation.runOnMainSync { result = block() }
        @Suppress("UNCHECKED_CAST")
        return result as T
    }

    private fun shownTabView(): TabWebView? = host.tabs.all().firstOrNull { it.isShown }

    /** Evaluate in the page on screen; the JSON text of the value ("" when nothing answered). */
    private fun tabJs(code: String): String {
        var result = ""
        val latch = CountDownLatch(1)
        instrumentation.runOnMainSync {
            val tab = shownTabView()
            if (tab == null) {
                latch.countDown()
            } else {
                tab.evaluate(code) { value ->
                    result = value ?: ""
                    latch.countDown()
                }
            }
        }
        latch.await(10, TimeUnit.SECONDS)
        return result
    }

    private fun jsonString(raw: String): String = runCatching { JSONTokener(raw).nextValue() as? String }.getOrNull() ?: raw

    /** Where the middle of the first element matching `selector` is on screen, or null. */
    private fun pagePoint(selector: String): PointF? {
        val raw = tabJs(
            "(function(){var e=document.querySelector(${JSONObject.quote(selector)});if(!e)return null;" +
                "var r=e.getBoundingClientRect();return [r.left+r.width/2,r.top+r.height/2]})()"
        )
        val point = runCatching { JSONArray(raw) }.getOrNull()?.takeIf { it.length() == 2 } ?: return null
        val origin = onMain { shownTabView()?.let { v -> IntArray(2).also(v::getLocationOnScreen) } } ?: return null
        return PointF(
            origin[0] + point.getDouble(0).toFloat() * density,
            origin[1] + point.getDouble(1).toFloat() * density
        )
    }

    private fun tapPage(selector: String) {
        val p = pagePoint(selector) ?: run {
            Log.w(tag, "nothing matches $selector on the page")
            return
        }
        Finger().tap(p.x, p.y)
    }

    private fun awaitLoaded(url: String, timeoutMs: Long = 20_000) {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            val (current, progress) = onMain { shownTabView().let { (it?.url ?: "") to (it?.progress ?: 0) } }
            if (current == url && progress == 100) return
            SystemClock.sleep(250)
        }
        Log.w(tag, "gave up waiting for $url")
    }

    // --- the core --------------------------------------------------------------------------------

    private fun activeTabId(): String = activeCoreTab()?.optString("id").orEmpty()

    private fun activeUrl(): String = activeCoreTab()?.optString("url").orEmpty()

    private fun tabCount(): Int = coreState().getJSONObject("tabs").length()

    private fun describeActive(): String = activeCoreTab().let { "active ${it?.optString("id")} ${it?.optString("url")}, ${tabCount()} tabs" }

    /** Poll until the active tab is another than `not` (a new tab opening); that tab, or null. */
    private fun awaitOtherActiveTab(not: String, timeoutMs: Long = 10_000): JSONObject? {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            val tab = activeCoreTab()
            if (tab != null && tab.optString("id") != not) return tab
            SystemClock.sleep(250)
        }
        Log.w(tag, "no tab other than $not became active")
        return null
    }

    private fun ensureActive(tabId: String) {
        if (activeTabId() == tabId) return
        coreInvoke("tab.activate", "{\"tabId\":${JSONObject.quote(tabId)}}")
        settle()
    }

    private fun chromeSurfaceUp(): Boolean = onMain { host.back.chromeSurfaceUp }

    /** Back out of whatever chrome surface is up (a menu, a submenu inside it), a few at most. */
    private fun closeSurfaces() {
        repeat(3) {
            if (!chromeSurfaceUp()) return
            back()
            SystemClock.sleep(1_500)
        }
    }

    private fun topPackage(): String = ui.rootInActiveWindow?.packageName?.toString() ?: "?"

    private fun awaitForeground(timeoutMs: Long): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            if (topPackage() == app.packageName) return true
            SystemClock.sleep(250)
        }
        return false
    }

    private fun verdict(ok: Boolean) = if (ok) "PASS" else "FAIL"

    private fun finding(line: String) {
        Log.i(tag, line.trim())
        findings.appendText(line + "\n")
    }

    companion object {
        private const val PORT = 18124
        private const val ORIGIN = "http://127.0.0.1:$PORT"
        private const val BLANK_URL = "zen://blank"
    }
}
