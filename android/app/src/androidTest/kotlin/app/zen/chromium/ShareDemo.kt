package app.zen.chromium

import android.graphics.PointF
import android.graphics.Rect
import android.os.ParcelFileDescriptor
import android.os.SystemClock
import android.util.Base64
import android.util.Log
import android.view.View
import android.view.ViewGroup
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.json.JSONArray
import org.json.JSONTokener
import org.junit.Test
import org.junit.runner.RunWith
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * Drives sharing out of and into the phone chrome so the `android-share-demo` workflow can record
 * it on an emulator: Share from the app menu and from a link's long-press menu (the system
 * chooser with the page's title and preview), a `mailto:`, a `tel:` and an `intent://` link held
 * behind the confirm sheet (the intent's web fallback loads when nothing can open it), then the
 * share target: a text carrying a URL, a plain text and an `ACTION_WEB_SEARCH`, each sent through
 * `am start` the way `adb shell` does, with DuckDuckGo as the profile's engine so the two
 * searches prove the routing goes through the core.
 *
 * The seeded profile shows example.com; the test runs in the app's process, so it adds its four
 * demo links (a web page, an email address, a phone number, a scanner app's `intent://`) to that
 * page through the tab's WebView and taps them where the page says they are. Only asserts that
 * it could run; the recording and the screenshots (`share-*.png`) are the evidence.
 */
@RunWith(AndroidJUnit4::class)
class ShareDemo : DemoHarness("share-demo-state.json", "share", "share-demo") {
    override val tag = "ShareDemo"

    /** Screen positions (px) of the planted links, in `LINKS` order. */
    private var links: List<PointF> = emptyList()

    @Test
    fun record() = runDemo()

    override fun warmUp() {
        // The workflow disables Gmail to keep the emulator quiet; it is what lets the mailto: sheet
        // name the app that would open the address.
        shell("pm enable --user 0 com.google.android.gm")
        // The first menu pays for layout and compilation: open it once off camera.
        openMenu()
        if (waitFor(HANDLE_LABEL, 6_000) != null) {
            SystemClock.sleep(800)
            back()
        }
        SystemClock.sleep(1_500)
        links = plantLinks()
        Log.i(tag, "demo links at $links")
    }

    override fun demo() {
        val f = Finger()

        // 1. App menu -> Share…: the system chooser, titled with the page and previewing it.
        openMenu()
        if (waitFor(HANDLE_LABEL, 6_000) != null) {
            SystemClock.sleep(1_500)
            shot("01-app-menu")
            if (clickByLabel("Share…")) {
                SystemClock.sleep(5_000)
                shot("02-share-chooser")
            } else {
                Log.w(tag, "no Share… in the app menu")
            }
            dismiss()
        }

        // 2. A link's long-press menu -> Share Link…: the chooser again, for the link.
        link(LINK_WEB)?.let { p ->
            f.press(p.x, p.y)
            f.up()
            SystemClock.sleep(2_500)
            shot("03-link-menu")
            if (clickByLabel("Share Link…")) {
                SystemClock.sleep(5_000)
                shot("04-share-link-chooser")
            } else {
                Log.w(tag, "no Share Link… in the link menu")
            }
            dismiss()
        }

        // 3. mailto: -> "Open in Gmail?" with Always allow; declined, nothing is remembered.
        link(LINK_MAIL)?.let { p ->
            f.tap(p.x, p.y)
            if (waitFor(DECLINE_LABEL, 6_000) != null) {
                SystemClock.sleep(1_200)
                shot("05-mailto-sheet")
                clickByLabel(ALWAYS_LABEL)
                SystemClock.sleep(1_200)
                shot("06-mailto-always")
                clickByLabel(DECLINE_LABEL)
            } else {
                Log.w(tag, "no confirm sheet for mailto:")
                shot("05-mailto-no-sheet")
            }
            SystemClock.sleep(2_000)
        }

        // 4. tel: -> "Open in Phone?", declined.
        link(LINK_TEL)?.let { p ->
            f.tap(p.x, p.y)
            if (waitFor(DECLINE_LABEL, 6_000) != null) {
                SystemClock.sleep(1_200)
                shot("07-tel-sheet")
                clickByLabel(DECLINE_LABEL)
            } else {
                Log.w(tag, "no confirm sheet for tel:")
                shot("07-tel-no-sheet")
            }
            SystemClock.sleep(2_000)
        }

        // 5. intent:// for an app that is not installed -> "Open in another app?"; opening finds
        //    nothing, so the link's browser_fallback_url loads in the tab.
        link(LINK_INTENT)?.let { p ->
            f.tap(p.x, p.y)
            if (waitFor(DECLINE_LABEL, 6_000) != null) {
                SystemClock.sleep(1_200)
                shot("08-intent-sheet")
                clickByLabel(OPEN_LABEL)
                SystemClock.sleep(5_000)
                shot("09-intent-fallback")
            } else {
                Log.w(tag, "no confirm sheet for intent://")
                SystemClock.sleep(4_000)
                shot("08-intent-no-sheet")
            }
        }

        // 6. Share target, as another app would send it: a URL inside text opens as a tab; plain
        //    text and a web search go to the profile's engine (DuckDuckGo, not the hard-coded one).
        send("Worth a read: https://en.wikipedia.org/wiki/Damping")
        SystemClock.sleep(7_000)
        shot("10-send-url")
        send("hyper text coffee pot control protocol")
        SystemClock.sleep(7_000)
        shot("11-send-text-duckduckgo")
        webSearch("zenium browser share target")
        SystemClock.sleep(7_000)
        shot("12-web-search-duckduckgo")
    }

    // --- moves -----------------------------------------------------------------------------------

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

    /** Take down whatever a step left up: another app's window (the chooser), then an open menu. */
    private fun dismiss() {
        val top = ui.rootInActiveWindow?.packageName?.toString()
        if (top != null && top != app.packageName) {
            back()
            SystemClock.sleep(2_000)
        }
        if (findByLabel(HANDLE_LABEL) != null) {
            back()
            SystemClock.sleep(1_500)
        }
        SystemClock.sleep(500)
    }

    private fun link(index: Int): PointF? = links.getOrNull(index).also {
        if (it == null) Log.w(tag, "demo link $index was not planted")
    }

    /** `am start` of the share intent another app would send, through the shell like adb does. */
    private fun send(text: String) {
        val out = shell(
            "am start -a android.intent.action.SEND -t text/plain " +
                "--es android.intent.extra.TEXT ${quote(text)} -p ${app.packageName}"
        )
        Log.i(tag, "am start SEND: ${out.trim()}")
    }

    private fun webSearch(query: String) {
        val out = shell("am start -a android.intent.action.WEB_SEARCH --es query ${quote(query)} -p ${app.packageName}")
        Log.i(tag, "am start WEB_SEARCH: ${out.trim()}")
    }

    // --- the page --------------------------------------------------------------------------------

    /** The tab's WebView that is on screen (the test shares the app's process and its views). */
    private fun pageWebView(): TabWebView? {
        var found: TabWebView? = null
        instrumentation.runOnMainSync {
            fun walk(view: View) {
                if (found != null) return
                if (view is TabWebView && view.isShown) {
                    found = view
                    return
                }
                if (view is ViewGroup) for (i in 0 until view.childCount) walk(view.getChildAt(i))
            }
            walk(activity.window.decorView)
        }
        return found
    }

    /** Add the demo links to the page (once it is there) and return where they are on screen. */
    private fun plantLinks(): List<PointF> {
        val web = pageWebView() ?: run {
            Log.w(tag, "no tab WebView on screen")
            return emptyList()
        }
        val deadline = SystemClock.uptimeMillis() + 20_000
        while (evalJs(web, PAGE_STATE_JS) != "example.com:complete" && SystemClock.uptimeMillis() < deadline) {
            SystemClock.sleep(500)
        }
        val origin = IntArray(2)
        instrumentation.runOnMainSync { web.getLocationOnScreen(origin) }
        val text = evalJs(web, PLANT_LINKS_JS) ?: run {
            Log.w(tag, "planting the links returned nothing")
            return emptyList()
        }
        val array = JSONArray(text)
        return (0 until array.length()).map { i ->
            val point = array.getJSONObject(i)
            PointF(origin[0] + point.getDouble("x").toFloat(), origin[1] + point.getDouble("y").toFloat())
        }
    }

    /** The string a script evaluates to in the page, or null when it did not answer in time. */
    private fun evalJs(web: TabWebView, script: String): String? {
        val latch = CountDownLatch(1)
        var result: String? = null
        instrumentation.runOnMainSync {
            web.evaluateJavascript(script) {
                result = it
                latch.countDown()
            }
        }
        latch.await(10, TimeUnit.SECONDS)
        // evaluateJavascript hands the value back as a JSON literal: a quoted string here.
        return runCatching { JSONTokener(result ?: "null").nextValue() as? String }.getOrNull()
    }

    /**
     * Run a shell command as adb would. UiAutomation hands the string to `Runtime.exec`, which
     * splits on whitespace and knows nothing of quotes, so the script travels base64-encoded in a
     * single token and `sh` decodes it.
     */
    private fun shell(script: String): String {
        val encoded = Base64.encodeToString(script.toByteArray(), Base64.NO_WRAP)
        val descriptor = ui.executeShellCommand("sh -c echo\${IFS}$encoded|base64\${IFS}-d|sh")
        return ParcelFileDescriptor.AutoCloseInputStream(descriptor).use { it.bufferedReader().readText() }
    }

    private fun quote(text: String) = "'" + text.replace("'", "'\\''") + "'"

    companion object {
        private const val MENU_LABEL = "Menu"
        private const val HANDLE_LABEL = "Resize menu"
        private const val DECLINE_LABEL = "Not now"
        private const val OPEN_LABEL = "Open"
        private const val ALWAYS_LABEL = "Always allow"

        private const val LINK_WEB = 0
        private const val LINK_MAIL = 1
        private const val LINK_TEL = 2
        private const val LINK_INTENT = 3

        /** Which page is showing and whether it has finished loading. */
        private const val PAGE_STATE_JS = "location.host + ':' + document.readyState"

        /**
         * Four tall links over the page, in `LINK_*` order; returns their centres in device
         * pixels relative to the WebView (CSS px through the visual viewport and the pixel ratio).
         */
        private val PLANT_LINKS_JS = """
            (function () {
              var box = document.createElement('div');
              box.style.cssText = 'position:fixed;left:16px;right:16px;top:34%;display:flex;flex-direction:column;gap:12px;' +
                'z-index:2147483647;font:600 18px/1.3 system-ui,sans-serif';
              var specs = [
                ['https://en.wikipedia.org/wiki/Damping', 'Damping on Wikipedia'],
                ['mailto:hello@example.com?subject=Zenium', 'Email hello@example.com'],
                ['tel:+15550100', 'Call +1 555 0100'],
                ['intent://scan/#Intent;scheme=zxing;package=com.google.zxing.client.android;' +
                  'S.browser_fallback_url=https%3A%2F%2Fexample.org%2F;end', 'Scan a code in the scanner app']
              ];
              specs.forEach(function (spec) {
                var a = document.createElement('a');
                a.href = spec[0];
                a.textContent = spec[1];
                a.style.cssText = 'display:block;padding:20px 18px;border-radius:14px;background:#fff;color:#1d1d2c;' +
                  'text-decoration:none;box-shadow:0 2px 10px rgba(0,0,0,.14)';
                box.appendChild(a);
              });
              document.body.appendChild(box);
              var vv = window.visualViewport;
              var scale = (vv ? vv.scale : 1) * (window.devicePixelRatio || 1);
              var dx = vv ? vv.offsetLeft : 0;
              var dy = vv ? vv.offsetTop : 0;
              return JSON.stringify(Array.prototype.map.call(box.children, function (a) {
                var r = a.getBoundingClientRect();
                return { x: (r.left + r.width / 2 - dx) * scale, y: (r.top + r.height / 2 - dy) * scale };
              }));
            })()
        """.trimIndent()
    }
}
