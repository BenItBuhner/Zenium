package app.zen.chromium

import android.net.Uri
import android.os.Bundle
import android.os.SystemClock
import android.util.Log
import android.view.KeyEvent
import android.view.accessibility.AccessibilityNodeInfo
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.io.FileInputStream

/**
 * Shows the failed-load fixes on a device so the `android-errors-demo` workflow can record them:
 * a DNS failure (`nonexistent.invalid`), the bug hunt's `localhost:1` (a port Chromium never
 * connects to: `ERR_UNSAFE_PORT`) and a refused connection (`localhost:81`) typed into the URL
 * bar land on the zen://error page (the site, a reason, Reload); the radios off (`svc wifi
 * disable`, `svc data disable`) and a load: the page says the device is offline; the radios back
 * on and its Reload loads the page. Then Take Screenshot, with its Screenshot saved card in the
 * toast's slot (the picture goes to the gallery since #321, no longer to Downloads); a new tab's
 * zero-suggest, which has no "Webpage not available" row and none of the
 * failed URLs (history.json is read as well); Zenium's fullscreen (asked for over the bridge, as
 * the menu item did), back leaving it with the app still in front; and fullscreen, Home, a
 * relaunch coming back with the bars.
 *
 * Only asserts that it could run; the recording, the screenshots (`errors-*.png`) and the
 * `ErrorPagesDemo` lines in the logcat are the evidence. See [DemoHarness] for the plumbing.
 */
@RunWith(AndroidJUnit4::class)
class ErrorPagesDemo : DemoHarness("share-demo-state.json", "errors", "errors-demo") {
    override val tag = "ErrorPagesDemo"

    private val host: Host get() = (activity as MainActivity).host

    @Test
    fun record() = runDemo()

    /**
     * The seeded page, the first menu and the first keyboard (they pay for layout, compilation and
     * the IME's start-up: keys sent to a keyboard still coming up are lost) off camera. The system's
     * one-time "Viewing full screen" notice would take the touches and the back of the fullscreen
     * steps, so it counts as seen.
     */
    override fun warmUp() {
        shell("settings put secure immersive_mode_confirmations confirmed")
        awaitPage("example.com")
        openMenu()
        if (waitFor(HANDLE_LABEL, 6_000) != null) {
            SystemClock.sleep(1_000)
            back()
        }
        SystemClock.sleep(1_500)
        Finger().tap(pillCenterX, pillY)
        if (waitFor(CLEAR_LABEL, 6_000) != null) {
            SystemClock.sleep(4_000)
            dismissKeyboard()
            back()
        }
        SystemClock.sleep(2_000)
        Log.i(tag, "warm-up done")
    }

    override fun demo() {
        // 1. A host that does not exist: ERR_NAME_NOT_RESOLVED.
        enter("nonexistent.invalid")
        awaitErrorPage("nonexistent.invalid")
        shot("01-dns-failure")

        // 2. The bug hunt's localhost:1 – a port on Chromium's restricted list: ERR_UNSAFE_PORT.
        enter("localhost:1")
        awaitErrorPage("localhost:1")
        shot("02-unsafe-port")

        // 3. A port nothing listens on: ERR_CONNECTION_REFUSED.
        enter("localhost:81")
        awaitErrorPage("localhost:81")
        shot("03-connection-refused")

        // 4. Radios off, then a load: the page says the device is offline.
        shell("svc wifi disable")
        shell("svc data disable")
        awaitOffline(true)
        enter("example.org")
        awaitErrorPage("example.org")
        shot("04-offline")

        // 5. Radios back on; the page's own Reload loads the site.
        shell("svc wifi enable")
        shell("svc data enable")
        awaitOffline(false)
        SystemClock.sleep(2_500)
        tapReload()
        awaitPage("example.org")
        SystemClock.sleep(1_000)
        shot("05-reloaded")

        // 6. Take Screenshot: the picture goes to the gallery and its preview card stands in the
        //    toast's slot above the bar (#321's SH-07: `.zen-screenshot-card`, "Screenshot saved"
        //    with the picture's size as the detail) – not to Downloads, where the run before
        //    #321 looked for the file under its name. The card is read off the chrome's document
        //    (the tree trails it, and it lives on the toast's clock); its Dismiss puts it away.
        val touched = menuItem("Take Screenshot")
        val card = awaitScreenshotCard(8_000)
        SystemClock.sleep(1_200)
        shot("06-screenshot-toast")
        Log.i(tag, "screenshot card: ${card ?: "none"}")
        // The menu flow's injected touch (the rule in DemoHarness): its result is the card, not
        // the menu going away (a touch through to the scrim does that too).
        if (touched && card == null) touchFault("the touch on the menu's Take Screenshot row put up no Screenshot saved card")
        if (card != null && !card.startsWith(SCREENSHOT_CARD_TITLE)) touchFault("the screenshot's card reads '$card', not '$SCREENSHOT_CARD_TITLE'")
        dismissScreenshotCard()
        SystemClock.sleep(800)
        shot("07-screenshot-card-dismissed")
        SystemClock.sleep(1_000)

        // 7. A new tab's zero-suggest: recent history, without the failed loads.
        tapByLabel("New tab")
        SystemClock.sleep(3_000)
        shot("08-zero-suggest")
        Log.i(
            tag,
            "zero-suggest: 'Webpage not available' row ${if (findByLabel(INTERSTITIAL_TITLE) != null) "PRESENT" else "absent"}; " +
                "failed URLs on screen: ${texts(FAILED_URLS)}"
        )
        historyReport()
        dismissKeyboard()
        back()
        SystemClock.sleep(1_500)

        // 8. Zenium's fullscreen; back leaves it and the app stays in front.
        enterFullscreen()
        SystemClock.sleep(2_500)
        Log.i(tag, "fullscreen: immersive=${immersive()}")
        shot("09-fullscreen")
        back()
        SystemClock.sleep(2_500)
        Log.i(tag, "after back: immersive=${immersive()} inFront=${inFront()}")
        shot("10-fullscreen-back")

        // 9. Fullscreen again, Home, and back through the launcher intent: bars, not fullscreen.
        enterFullscreen()
        SystemClock.sleep(2_000)
        shell("input keyevent KEYCODE_HOME")
        SystemClock.sleep(2_500)
        relaunch()
        SystemClock.sleep(3_000)
        Log.i(tag, "after relaunch: immersive=${immersive()} inFront=${inFront()}")
        shot("11-relaunched")
    }

    // --- the URL bar -----------------------------------------------------------------------------

    /**
     * Open the URL bar from the pill, type `text` over the selected address once the keyboard has
     * settled, and press Enter. Keys the IME dropped anyway would send a fragment to the search
     * engine, so the field is read back and set outright when it does not say `text`.
     */
    private fun enter(text: String) {
        ensureForeground()
        Finger().tap(pillCenterX, pillY)
        if (waitFor(CLEAR_LABEL, 6_000) == null) Log.w(tag, "the URL bar did not open for $text")
        SystemClock.sleep(2_000)
        instrumentation.sendStringSync(text)
        SystemClock.sleep(900)
        val field = addressField()
        val typed = field?.text?.toString()
        if (field != null && typed != text) {
            Log.w(tag, "the URL bar reads '$typed' after typing '$text'; setting it")
            val arguments = Bundle().apply {
                putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, text)
            }
            field.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, arguments)
            SystemClock.sleep(900)
        }
        instrumentation.sendKeyDownUpSync(KeyEvent.KEYCODE_ENTER)
        SystemClock.sleep(1_000)
    }

    /** The URL bar's input: the editable node with the focus, when the tree exposes one. */
    private fun addressField(): AccessibilityNodeInfo? {
        val root = ui.rootInActiveWindow ?: return null
        val queue = ArrayDeque<AccessibilityNodeInfo>()
        queue.add(root)
        var visited = 0
        var editable: AccessibilityNodeInfo? = null
        while (queue.isNotEmpty() && visited < 6_000) {
            val node = queue.removeFirst()
            visited++
            if (node.isEditable) {
                if (node.isFocused) return node
                editable = editable ?: node
            }
            for (i in 0 until node.childCount) node.getChild(i)?.let(queue::add)
        }
        return editable
    }

    /** Back twice when the keyboard is up (it takes the first), else once: the URL bar or a panel closes. */
    private fun dismissKeyboard() {
        var up = false
        instrumentation.runOnMainSync {
            val root = activity.window.decorView
            up = ViewCompat.getRootWindowInsets(root)?.isVisible(WindowInsetsCompat.Type.ime()) == true
        }
        if (!up) return
        back()
        SystemClock.sleep(1_200)
    }

    // --- the page --------------------------------------------------------------------------------

    /** The tab on screen: its URL and progress, read on the main thread. */
    private fun pageState(): Pair<String, Int> {
        var state = "" to 0
        instrumentation.runOnMainSync {
            val tab = host.tabs.all().firstOrNull { it.isShown }
            state = (tab?.url ?: "") to (tab?.progress ?: 0)
        }
        return state
    }

    private fun awaitPage(urlPart: String, timeoutMs: Long = 25_000) {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            val (url, progress) = pageState()
            if (url.contains(urlPart) && !url.startsWith(ERROR_PREFIX) && progress == 100) {
                Log.i(tag, "loaded $url")
                return
            }
            SystemClock.sleep(250)
        }
        Log.w(tag, "gave up waiting for $urlPart; page is ${pageState()}")
    }

    /**
     * The zen://error page for `failed` is the document on screen (and has had a moment to paint);
     * the failed URL rides in the page's query percent-encoded (`localhost%3A1`).
     */
    private fun awaitErrorPage(failed: String, timeoutMs: Long = 20_000) {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            val (url, _) = pageState()
            if (url.startsWith(ERROR_PREFIX) && Uri.decode(url).contains(failed)) {
                Log.i(tag, "error page up: $url")
                SystemClock.sleep(2_000)
                return
            }
            SystemClock.sleep(250)
        }
        Log.w(tag, "no error page for $failed; page is ${pageState()}")
    }

    /** The error page's Reload control, tapped where the accessibility tree says it is. */
    private fun tapReload() {
        val button = findByLabel("Reload")?.takeIf { it.bottom < pill.top }
        if (button != null) {
            Finger().tap(button.exactCenterX(), button.exactCenterY())
            return
        }
        Log.w(tag, "no Reload on the page; reloading the view")
        instrumentation.runOnMainSync { host.tabs.all().firstOrNull { it.isShown }?.reload() }
    }

    /** Wait for ConnectivityManager to agree the device is offline (or online again). */
    private fun awaitOffline(expected: Boolean, timeoutMs: Long = 25_000) {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            if (NetErrors.offline(app) == expected) {
                Log.i(tag, if (expected) "offline" else "online again")
                return
            }
            SystemClock.sleep(300)
        }
        Log.w(tag, "connectivity never became ${if (expected) "offline" else "online"}")
    }

    // --- the menu --------------------------------------------------------------------------------

    /**
     * The harness's finger on the bar's Menu button: by label, else on the pill's line, which the
     * harness measures from the window's insets. (The driver's own fallback put the button 28 dp
     * above the window's bottom edge, inside a 48 dp navigation bar.)
     */
    private fun openMenu() = tapMenuButton()

    /**
     * Open the menu, expand it so the whole list is in reach, and touch the item labelled `label`
     * – the menu flow's injected touch (the rule in DemoHarness); the caller asserts what the item
     * did. True when a finger went in; false when the menu or the item never showed, or the row
     * had no bounds on screen to touch (the tree's click then gets to the item's page, with no
     * touch to assert). A touch that left the menu open is a fault of the run, and the tree's
     * click then gets to the item's page.
     */
    private fun menuItem(label: String): Boolean {
        openMenu()
        if (waitFor(HANDLE_LABEL, 6_000) == null) {
            Log.w(tag, "the menu never opened for $label")
            return false
        }
        SystemClock.sleep(1_200)
        val handle = findByLabel(HANDLE_LABEL)
        if (handle != null) {
            Finger().apply {
                down(handle.exactCenterX(), handle.exactCenterY())
                moveBy(0f, -0.4f * height, 130)
                up()
            }
            SystemClock.sleep(2_000)
        }
        val target = reveal(label)
        if (target == null) {
            Log.w(tag, "no $label in the menu")
            back()
            return false
        }
        // The finger goes in once the row's bounds hold still (the tree lags the menu's scroll on
        // the emulator) and inside the touchable window (touchTapLabel).
        if (!touchTapLabel(label)) {
            Log.w(tag, "no bounds on screen to touch for $label at $target; clicking it through the tree")
            clickByLabel(label)
            SystemClock.sleep(1_500)
            return false
        }
        // The menu's leave takes three seconds on the software GPU and the tree reports it
        // later still, so the menu is polled for going rather than read once.
        if (!waitForGone(HANDLE_LABEL, 10_000)) {
            touchFault("the touch on the menu's $label row left the menu open")
            clickByLabel(label)
            SystemClock.sleep(1_500)
        }
        return true
    }

    private fun tapByLabel(label: String) {
        val target = findByLabel(label) ?: run {
            Log.w(tag, "no $label to tap")
            return
        }
        Finger().tap(target.exactCenterX(), target.exactCenterY())
    }

    // --- evidence --------------------------------------------------------------------------------

    /** Texts (and descriptions) in the active window that match `pattern`. */
    private fun texts(pattern: Regex): List<String> {
        val root = ui.rootInActiveWindow ?: return emptyList()
        val queue = ArrayDeque<AccessibilityNodeInfo>()
        val found = ArrayList<String>()
        queue.add(root)
        var visited = 0
        while (queue.isNotEmpty() && visited < 6_000) {
            val node = queue.removeFirst()
            visited++
            for (label in listOfNotNull(node.text?.toString(), node.contentDescription?.toString())) {
                if (pattern.containsMatchIn(label)) found += label
            }
            for (i in 0 until node.childCount) node.getChild(i)?.let(queue::add)
        }
        return found
    }

    /**
     * The screenshot's preview card as the chrome's document has it (#321, ScreenshotCard.tsx):
     * "<title>: <detail>" once it stands, null when none comes within `timeoutMs`.
     */
    private fun awaitScreenshotCard(timeoutMs: Long): String? {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            val read = chromeJsString(
                "(function(){var c=document.querySelector('.zen-screenshot-card');if(!c)return '';" +
                    "var t=c.querySelector('.zen-screenshot-title'),d=c.querySelector('.zen-banner-detail');" +
                    "return ((t&&t.textContent)||'').trim()+': '+((d&&d.textContent)||'').trim()})()"
            ).orEmpty()
            if (read.isNotEmpty() && read != ": ") return read
            SystemClock.sleep(250)
        }
        return null
    }

    /** A finger on the card's Dismiss while it stands; the card's own clock takes it otherwise. */
    private fun dismissScreenshotCard() {
        val close = domBox("document.querySelector('.zen-screenshot-card .zen-message-close')") ?: return
        Finger().tap(close.exactCenterX(), close.exactCenterY())
        awaitTrue(4_000) { chromeJs("document.querySelector('.zen-screenshot-card')==null") == "true" }
    }


    /** What the profile's history.json says about the failed loads (the persisted side of BH-19). */
    private fun historyReport() {
        val file = File(app.filesDir, "zen/history.json")
        if (!file.exists()) {
            Log.i(tag, "history.json: not written yet")
            return
        }
        val json = file.readText()
        Log.i(
            tag,
            "history.json: ${json.length} chars; nonexistent.invalid=${json.contains("nonexistent.invalid")} " +
                "localhost:1=${json.contains("localhost:1")} localhost:81=${json.contains("localhost:81")} " +
                "interstitial title=${json.contains(INTERSTITIAL_TITLE)} example.org=${json.contains("example.org")}"
        )
    }

    /**
     * Zenium's own fullscreen, asked for the way the core asks (`window.setFullscreen` over the
     * bridge): what Menu > Fullscreen did on the build the bug hunt tested; the phone menu on
     * current main has no such item, but the host's side of it (back leaves it first, it does not
     * outlive the window) is what this shows.
     */
    private fun enterFullscreen() {
        instrumentation.runOnMainSync { host.dispatch("window.setFullscreen", json("fullscreen" to true)) {} }
    }

    private fun immersive(): Boolean {
        var on = false
        instrumentation.runOnMainSync { on = host.immersive }
        return on
    }

    private fun inFront(): Boolean = ui.rootInActiveWindow?.packageName?.toString() == app.packageName

    private fun relaunch() {
        val component = activity.componentName.flattenToString()
        val out = shell("am start -W -n $component")
        Log.i(tag, "relaunch: ${out.lineSequence().firstOrNull { it.contains("Status") || it.contains("Warning") }?.trim()}")
        val deadline = SystemClock.uptimeMillis() + 8_000
        while (!inFront() && SystemClock.uptimeMillis() < deadline) SystemClock.sleep(250)
    }

    private fun shell(command: String): String {
        val fd = ui.executeShellCommand(command)
        return FileInputStream(fd.fileDescriptor).use { it.readBytes().toString(Charsets.UTF_8) }.also { fd.close() }
    }

    companion object {
        private const val HANDLE_LABEL = "Resize menu"
        /** The URL bar's clear button: there once the bar is open. */
        private const val CLEAR_LABEL = "Clear"
        private const val ERROR_PREFIX = "zen://error"
        /** WebView's built-in error page's title: must not reach history or the zero-suggest. */
        private const val INTERSTITIAL_TITLE = "Webpage not available"
        /** The screenshot's preview card's title (#321, ScreenshotCard.tsx). */
        private const val SCREENSHOT_CARD_TITLE = "Screenshot saved"
        private val FAILED_URLS = Regex("nonexistent\\.invalid|localhost:1|localhost:81")
    }
}
