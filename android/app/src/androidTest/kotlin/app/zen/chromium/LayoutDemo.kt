package app.zen.chromium

import android.accessibilityservice.AccessibilityService
import android.app.UiAutomation
import android.graphics.Rect
import android.os.SystemClock
import android.util.Log
import android.view.KeyEvent
import android.view.View
import android.view.ViewGroup
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.json.JSONTokener
import org.junit.Test
import org.junit.runner.RunWith
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * Drives the phone chrome through the layout and menu fixes so the `android-layout-demo` workflow
 * can record them on an emulator with three-button navigation: the phone turned to landscape and
 * back (the bar and pill stay, no desktop sidebar), the tab overview with eight tabs in landscape
 * scrolled to its end (four columns), the app menu at its last detent scrolled to the end with
 * its last row tapped by a real touch above the navigation bar, a long URL loaded and the pill
 * showing the site alone, and the pill tapped so editing starts at the origin with everything
 * selected.
 *
 * Same handshake as the other demos, under `files/layout-demo/`; screenshots land there as
 * `layout-*.png`. The run fails when the chrome is not the phone chrome after a rotation or the
 * menu row cannot be tapped – the two regressions the recording is for.
 */
@RunWith(AndroidJUnit4::class)
class LayoutDemo : DemoHarness("layout-demo-state.json", "layout", "layout-demo") {
    override val tag = "LayoutDemo"

    private val problems = mutableListOf<String>()

    @Test
    fun record() {
        runDemo()
    }

    /** The first menu and overview pay for layout and compilation: show each once off camera. */
    override fun warmUp() {
        openMenu()
        if (waitFor(HANDLE_LABEL, 6_000) != null) {
            SystemClock.sleep(800)
            back()
        }
        SystemClock.sleep(1_500)
        tapLabel(TABS_LABEL)
        if (waitFor("New Tab", 6_000) != null) {
            SystemClock.sleep(1_000)
            back()
        }
        SystemClock.sleep(2_000)
        Log.i(tag, "warm-up done; chrome ${chromeState()}")
    }

    override fun demo() {
        val f = Finger()

        // 1. Portrait: the phone chrome, the pill naming the site.
        shot("01-portrait")

        // 2. Turn the phone: the bar stays at the bottom, the pill keeps the site, the page fills
        //    the width between the status bar and the navigation bar on the side.
        rotate(UiAutomation.ROTATION_FREEZE_90)
        expectPhoneChrome("landscape")
        shot("02-landscape")

        // 3. The overview in landscape: eight tabs in a row of four, scrolled to the end.
        tapLabel(TABS_LABEL)
        if (waitFor("New Tab", 6_000) != null) {
            SystemClock.sleep(2_000)
            shot("03-landscape-overview")
            reveal("New Tab")
            SystemClock.sleep(1_000)
            shot("04-landscape-overview-end")
            back()
            SystemClock.sleep(2_500)
        } else {
            problems += "the overview did not open in landscape"
            shot("03-landscape-no-overview")
        }

        // 4. Back to portrait.
        rotate(UiAutomation.ROTATION_FREEZE_0)
        expectPhoneChrome("portrait again")
        shot("05-portrait-again")

        // 5. The menu at its last detent, scrolled to its end: the last row sits above the
        //    navigation bar, so a real touch on it opens Settings.
        openMenu()
        if (waitFor(HANDLE_LABEL, 6_000) != null) {
            SystemClock.sleep(1_500)
            val handle = findByLabel(HANDLE_LABEL)
            if (handle != null) {
                f.down(handle.exactCenterX(), handle.exactCenterY())
                f.moveBy(0f, -0.4f * height, 130)
                f.up()
                SystemClock.sleep(2_000)
            }
            reveal(LAST_ROW_LABEL)
            SystemClock.sleep(1_000)
            shot("06-menu-last-detent")
            // Read the row's bounds once the list has settled: on the emulator the tree lags a
            // scroll, and the touch must land where the row is now.
            val settings = findByLabel(LAST_ROW_LABEL)
            val about = findNodeLabel { it.startsWith(ABOUT_LABEL) }
            Log.i(tag, "menu rows: Settings at $settings, About '$about', window ${width}x$height")
            if (settings != null) {
                f.tap(settings.exactCenterX(), settings.exactCenterY())
                if (waitFor(SETTINGS_PROOF, 6_000) != null) {
                    SystemClock.sleep(2_000)
                    shot("07-settings")
                    back()
                    SystemClock.sleep(2_000)
                } else {
                    problems += "touching the Settings row at $settings did not open Settings"
                    shot("07-settings-missed")
                    dismiss()
                }
            } else {
                problems += "no Settings row in the menu"
                dismiss()
            }
        } else {
            problems += "the menu did not open"
        }

        // 6. Load a long URL: the pill opens the address selected from its start; type over it.
        tapPill()
        if (waitFor(CLEAR_LABEL, 6_000) != null) {
            SystemClock.sleep(1_500)
            shot("08-omnibox-opened")
            instrumentation.sendStringSync(LONG_URL)
            SystemClock.sleep(1_000)
            shot("09-omnibox-typed")
            instrumentation.sendKeyDownUpSync(KeyEvent.KEYCODE_ENTER)
            SystemClock.sleep(7_000)
            Log.i(tag, "pill after the long URL: ${findPillLabel()}")
            shot("10-pill-long-url")
        } else {
            problems += "the pill did not open the address bar"
        }

        // 7. Tap the pill again: the long address, all of it selected, read from the origin.
        tapPill()
        if (waitFor(CLEAR_LABEL, 6_000) != null) {
            SystemClock.sleep(2_000)
            shot("11-omnibox-long-start")
            back()
            SystemClock.sleep(1_500)
        }

        ui.setRotation(UiAutomation.ROTATION_UNFREEZE)
        check(problems.isEmpty()) { problems.joinToString("; ") }
    }

    // --- moves -----------------------------------------------------------------------------------

    private fun rotate(rotation: Int) {
        ui.setRotation(rotation)
        // The Activity keeps its instance (configChanges), the WebView re-lays the chrome out.
        SystemClock.sleep(5_000)
        ensureForeground()
    }

    /** The pill is the phone chrome's; the desktop layout has a URL bar in its sidebar instead. */
    private fun expectPhoneChrome(where: String) {
        val found = findByLabelPrefix(PILL_LABEL)
        val state = chromeState()
        Log.i(tag, "$where: pill $found, chrome $state")
        if (found == null || !state.startsWith("phone")) problems += "not the phone chrome in $where ($state)"
    }

    private fun openMenu() {
        ensureForeground()
        val button = findByLabel(MENU_LABEL) ?: computedMenuButton()
        Finger().tap(button.exactCenterX(), button.exactCenterY())
    }

    /** Where the menu button is when the accessibility tree does not say: rightmost in the bar. */
    private fun computedMenuButton() = Rect(
        (width - 52 * density).toInt(), (pill.centerY() - 22 * density).toInt(),
        (width - 8 * density).toInt(), (pill.centerY() + 22 * density).toInt()
    )

    private fun tapLabel(label: String) {
        ensureForeground()
        val target = findByLabel(label) ?: run {
            problems += "no $label to tap"
            return
        }
        Finger().tap(target.exactCenterX(), target.exactCenterY())
    }

    private fun tapPill() {
        ensureForeground()
        val target = findByLabelPrefix(PILL_LABEL) ?: pill
        Finger().tap(target.exactCenterX(), target.exactCenterY())
    }

    private fun findPillLabel(): String? = findNodeLabel { it.startsWith("$PILL_LABEL,") }

    private fun back() {
        ui.performGlobalAction(AccessibilityService.GLOBAL_ACTION_BACK)
    }

    /** Take down an open menu or panel. */
    private fun dismiss() {
        if (findByLabel(HANDLE_LABEL) != null || findByLabel(SETTINGS_PROOF) != null) {
            back()
            SystemClock.sleep(1_500)
        }
    }

    // --- the chrome ------------------------------------------------------------------------------

    /** The chrome WebView (the test shares the app's process and its views). */
    private fun chromeWebView(): ChromeWebView? {
        var found: ChromeWebView? = null
        instrumentation.runOnMainSync {
            fun walk(view: View) {
                if (found != null) return
                if (view is ChromeWebView) {
                    found = view
                    return
                }
                if (view is ViewGroup) for (i in 0 until view.childCount) walk(view.getChildAt(i))
            }
            walk(activity.window.decorView)
        }
        return found
    }

    /** The layout class the chrome settled on and its viewport, e.g. `phone 915x412`. */
    private fun chromeState(): String {
        val web = chromeWebView() ?: return "no chrome WebView"
        val latch = CountDownLatch(1)
        var result: String? = null
        instrumentation.runOnMainSync {
            web.evaluateJavascript(CHROME_STATE_JS) {
                result = it
                latch.countDown()
            }
        }
        latch.await(10, TimeUnit.SECONDS)
        return runCatching { JSONTokener(result ?: "null").nextValue() as? String }.getOrNull() ?: "unknown"
    }

    /** The first label in the active window that `matches`, as text. */
    private fun findNodeLabel(matches: (String) -> Boolean): String? {
        val root = ui.rootInActiveWindow ?: return null
        val queue = ArrayDeque(listOf(root))
        var visited = 0
        while (queue.isNotEmpty() && visited < 6_000) {
            val node = queue.removeFirst()
            visited++
            node.contentDescription?.toString()?.takeIf(matches)?.let { return it }
            node.text?.toString()?.takeIf(matches)?.let { return it }
            for (i in 0 until node.childCount) node.getChild(i)?.let(queue::add)
        }
        return null
    }

    companion object {
        private const val MENU_LABEL = "Menu"
        private const val TABS_LABEL = "Tabs (8)"
        private const val HANDLE_LABEL = "Resize menu"
        /** The last enabled row of the phone menu; About below it is a label, not an action. */
        private const val LAST_ROW_LABEL = "Settings"
        private const val ABOUT_LABEL = "About Zenium"
        /** A section chip of the Settings panel: proof it opened (the menu row is "Settings" too). */
        private const val SETTINGS_PROOF = "Look and Feel"
        /** The address bar's clear button: proof that editing is open. */
        private const val CLEAR_LABEL = "Clear"
        private const val LONG_URL =
            "https://www.rfc-editor.org/rfc/rfc2324.html?demo=android-layout&query=a-long-query-string-that-fills-the-pill&section=2.1.1#section-2.1.1"
        private const val CHROME_STATE_JS =
            "document.documentElement.dataset.formFactor + ' ' + innerWidth + 'x' + innerHeight"
    }
}
