package app.zen.chromium

import android.os.Build
import android.os.SystemClock
import android.util.Log
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONArray
import org.json.JSONObject
import org.json.JSONTokener
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import kotlin.math.abs
import kotlin.math.roundToInt

/**
 * The phone chrome against the system bars (Bennett's 0.3.79 report: the pill drawn over the
 * clock, the page frame right under it). The claim, in every scene: the bar's row starts at or
 * below the status bar inset when docked top and ends at or above the gesture bar's inset when
 * docked bottom, the page frame keeps the other edge's inset, the chrome's `--zen-inset-*` are
 * the window's own insets (read from the window here, never a constant), the status bar is
 * showing, and its icons match the chrome's scheme (dark chrome, light icons).
 *
 * The condition that reproduced the report is part of the seed: a profile with a boot document
 * over `BootHandoff.BOOT_INLINE_LIMIT` (a `history.json` of a few thousand visits, as a phone
 * that has browsed for a while has – the Safe Browsing feed documents put every profile past the
 * limit from its second start). The boot payload then names the document instead of carrying it
 * and `bootAndroid` yields to fetch it, which is when Kotlin's queued `insets` used to reach the
 * chrome before React had subscribed and be dropped (`InProcessEvents` had no replay). So the
 * scenes are cold chrome boots first of all – at each dock, three times each – then the scheme
 * flips, a fullscreen video's exit, the screen turned off and on, and the system font at 1.3.
 *
 * Stills land as `android-status-bar-<scene>.png`; the findings in `android-status-bar-notes.txt`.
 * With `-e assert true` the run fails when a claim did not hold; without it, it only reports
 * (the `before` take of the workflow, on an APK built from main).
 */
@RunWith(AndroidJUnit4::class)
class StatusBarDemo : MediaDemoBase("android-status-bar") {
    override val tag = "StatusBarDemo"
    private val assertive = InstrumentationRegistry.getArguments().getString("assert") == "true"
    /**
     * How a cold chrome boot is brought about (`-e relaunch quiet|clear`). `quiet` finishes the
     * old activity, lets its teardown land and re-seeds the session before the launch, so the
     * page is live in every boot still. `clear` starts the new activity over the old one
     * (`FLAG_ACTIVITY_CLEAR_TASK`, the old host torn down while the new chrome boots), the way
     * run 35550794593 relaunched: the busier process makes the unfixed chrome's drop the rule
     * (six boots of seven there against two of nine quiet), at the price of the seeded tab (the
     * old core's last write is a session with its tabs closed). The `before` take uses it.
     */
    private val relaunchMode = InstrumentationRegistry.getArguments().getString("relaunch") ?: "quiet"
    private var failures = 0
    private var checks = 0

    @Test
    fun record() {
        val page = "text/html; charset=utf-8" to readAsset("fullscreen-demo-page.html").toByteArray()
        val embed = "text/html; charset=utf-8" to readAsset("fullscreen-demo-embed.html").toByteArray()
        server = DemoServer(
            PORT,
            mapOf(
                "/fullscreen" to page,
                "/embed" to embed,
                "/land.webm" to ("video/webm" to readAssetBytes("media-demo-clip.webm")),
                "/port.webm" to ("video/webm" to readAssetBytes("fullscreen-demo-portrait.webm"))
            )
        ).also { it.start() }
        try {
            runDemo()
        } finally {
            server.close()
        }
        Log.i(tag, "$checks checks, $failures failed (assert=$assertive)")
        if (assertive) assertEquals("claims that did not hold (see android-status-bar-notes.txt)", 0, failures)
    }

    /** The media demos' profile with its tab on the fullscreen page, the bar docked top, the light scheme, the hints shown. */
    override fun patchState(json: String): String = seedState(json, dock = "top", scheme = "light")

    /** The seeded session: the demo tab on the fullscreen page, the bar at `dock`, the `scheme`, the hints shown. */
    private fun seedState(json: String, dock: String, scheme: String): String {
        val state = JSONObject(json)
        val tabs = state.getJSONArray("tabs")
        for (i in 0 until tabs.length()) {
            val tab = tabs.getJSONObject(i)
            if (tab.optString("id") == TAB) {
                tab.put("url", "http://127.0.0.1:$PORT/fullscreen")
                tab.put("title", "Zenium status bar demo")
            }
        }
        state.getJSONObject("settings")
            .put("phoneBarPosition", dock)
            .put("colorScheme", scheme)
            .put("gestureHintDone", true)
            .put("fullscreenHintDone", true)
        return state.toString()
    }

    /**
     * The reproduction condition: a boot document over the inline limit. A history of
     * [SEEDED_VISITS] visits (version 2 of `history.json`, the shape the core writes), dated within
     * the retention window so nothing is pruned away before the size is measured.
     */
    override fun seedMore(zen: File) {
        val now = System.currentTimeMillis()
        val entries = JSONArray()
        val visits = JSONArray()
        for (i in 0 until SEEDED_VISITS) {
            val url = "https://example.org/articles/${i / 4}/section-${i % 4}?ref=history-seed-$i"
            val title = "Example article ${i / 4}, section ${i % 4}: a title long enough to look like a real page"
            val at = now - (i.toLong() * 90_000L)
            visits.put(
                JSONObject()
                    .put("id", "visit-$i")
                    .put("url", url)
                    .put("title", title)
                    .put("favicon", JSONObject.NULL)
                    .put("visitTime", at)
                    .put("transition", if (i % 7 == 0) "typed" else "link")
            )
            if (i % 4 == 0) {
                entries.put(
                    JSONObject()
                        .put("url", url)
                        .put("title", title)
                        .put("visitCount", 4)
                        .put("lastVisit", at)
                        .put("favicon", JSONObject.NULL)
                        .put("firstVisit", at - 3 * 90_000L)
                        .put("typedCount", 1)
                )
            }
        }
        val history = JSONObject().put("version", 2).put("entries", entries).put("visits", visits)
        File(zen, "history.json").writeText(history.toString())
    }

    override fun warmUp() {
        notes = File(out, "android-status-bar-notes.txt")
        val version = runCatching { app.packageManager.getPackageInfo(app.packageName, 0).versionName }.getOrNull() ?: "?"
        notes.writeText(
            "Zenium Android status bar checks (API ${Build.VERSION.SDK_INT}, ${width}x$height, density $density, " +
                "app $version)\n\n"
        )
        shell("settings put secure immersive_mode_confirmations confirmed")
        shell("settings put system font_scale 1.0")
        val history = File(app.filesDir, "zen/history.json")
        note("seeded history.json: ${history.length()} bytes (inline limit ${BootHandoff.BOOT_INLINE_LIMIT}); deferred boot documents: ${deferredDocuments()}")
        check("the seeded profile has a boot document over the inline limit", history.length() > BootHandoff.BOOT_INLINE_LIMIT)
        note("demo server: ${server.selfCheck()}")
        waitTitle(TAB, 20_000) { it.startsWith("FS|") }
        note("seeded tab: ${describeTab(TAB)}")
        Log.i(tag, "warm-up done")
    }

    override fun demo() {
        // 1. The first cold chrome boot at the top dock, light: the boot the report is about.
        checkChrome("boot-1-top-light", dock = "top", dark = false)
        shot("boot-1-top-light")

        // 2. A fullscreen video in and out, in the first session.
        fullscreenExit()

        // 3. The scheme and the dock switched in place: the inset kept, the status bar icons
        //    following the scheme. (On an unfixed chrome the scheme switch happens to heal a
        //    lost inset: the appearance change makes Android dispatch the insets again.)
        setScheme("dark")
        checkChrome("switch-top-dark", dock = "top", dark = true)
        setDock("bottom")
        checkChrome("switch-bottom-dark", dock = "bottom", dark = true)
        setScheme("light")
        checkChrome("switch-bottom-light", dock = "bottom", dark = false)

        // 4. Cold chrome boots in every dock and scheme, two each: the claim of this driver. The
        //    stills the fix is judged by are these (boot-N-<dock>-<scheme>), each taken right
        //    after its boot, before anything could make Android dispatch the insets again.
        var boot = 1
        for ((dock, scheme) in listOf("top" to "dark", "bottom" to "dark", "bottom" to "light", "top" to "light")) {
            repeat(2) {
                boot++
                relaunch(dock, scheme)
                val scene = "boot-$boot-$dock-$scheme"
                checkChrome(scene, dock = dock, dark = scheme == "dark")
                shot(scene)
            }
        }

        // 5. The paths that leave and return: the screen off and on, the system font at 1.3.
        screenOffAndOn()
        fontScale()
        note("\nend: $checks checks, $failures failed")
    }

    // --- the scenes ------------------------------------------------------------------------------

    /** A landscape clip into fullscreen (the bars hide, the screen may turn) and back out: the chrome returns under the bars. */
    private fun fullscreenExit() {
        note("\nfullscreen video: in and out")
        val entered = tapPageButton("fs-land", "Play landscape fullscreen", "the video goes fullscreen", 15_000) {
            host.fullscreenTab?.tabId == TAB || field("fs") == "1"
        }
        if (!entered) {
            check("the clip went fullscreen", false)
            return
        }
        SystemClock.sleep(2_500)
        val hidden = statusBarsVisible()
        note("  in fullscreen: rotation ${rotation()}, status bar visible=$hidden, host holds landscape=${host.fullscreenLandscape}")
        check("the status bar hides for the fullscreen video", !hidden)
        shot("fullscreen")
        back()
        val left = poll(10_000) { host.fullscreenTab == null }
        check("back leaves the fullscreen", left)
        poll(10_000) { rotation() == 0 }
        // The chrome's return fade waits for the page to land (lib/fullscreenLanding.ts), 2.5 s at
        // the outside; the bars' own way back is judged again by the landing (FullscreenLanding.kt).
        SystemClock.sleep(4_000)
        checkChrome("after-fullscreen-exit", dock = "top", dark = false)
        shot("after-fullscreen-exit")
    }

    /** The screen off and on again (the lock screen dismissed): the chrome comes back where it was. */
    private fun screenOffAndOn() {
        note("\nscreen off and on")
        shell("svc power stayon false")
        shell("input keyevent KEYCODE_SLEEP")
        SystemClock.sleep(2_500)
        shell("input keyevent KEYCODE_WAKEUP")
        SystemClock.sleep(1_500)
        shell("wm dismiss-keyguard")
        shell("svc power stayon true")
        val front = poll(8_000) { ui.rootInActiveWindow?.packageName?.toString() == app.packageName }
        note("  browser in front again: $front")
        SystemClock.sleep(2_500)
        checkChrome("after-screen-off-on", dock = "top", dark = false)
        shot("after-screen-off-on")
    }

    /** The system font at 1.3: the chrome's text grows (A11Y-05) and the bar stays under the status bar. */
    private fun fontScale() {
        note("\nfont scale 1.3")
        shell("settings put system font_scale 1.3")
        val zoomed = poll(12_000) { textZoom() >= 128 }
        note("  chrome text zoom: ${textZoom()} (zoomed=$zoomed)")
        check("the chrome's text followed font_scale 1.3", zoomed)
        SystemClock.sleep(1_500)
        checkChrome("font-scale-1.3-top-light", dock = "top", dark = false)
        shot("font-scale-1.3")
        shell("settings put system font_scale 1.0")
        poll(12_000) { textZoom() <= 100 }
    }

    // --- the claim -------------------------------------------------------------------------------

    /**
     * Read the window's insets and the chrome's geometry and judge the scene: the bar's row
     * against the dock's inset, the page frame against the other edge's, the chrome's inset
     * variables against the window, the status bar showing with the scheme's icons.
     */
    private fun checkChrome(scene: String, dock: String, dark: Boolean) {
        note("\n[$scene] dock=$dock dark=$dark")
        // Give the chrome its layout after a boot or a switch; the claim is about the rest.
        val ready = poll(15_000) { chromeGeometry()?.optJSONObject("row") != null }
        if (!ready) {
            check("[$scene] the chrome painted its bar", false)
            return
        }
        SystemClock.sleep(600)
        val insets = windowBars()
        val geometry = chromeGeometry() ?: JSONObject()
        val origin = chromeOrigin()
        val row = geometry.optJSONObject("row")
        val frame = geometry.optJSONObject("frame")
        val chromeDark = geometry.optString("dark") == "true"
        val insetTopCss = geometry.optString("insetTop").removeSuffix("px").toDoubleOrNull() ?: -1.0
        val insetBottomCss = geometry.optString("insetBottom").removeSuffix("px").toDoubleOrNull() ?: -1.0
        val rowTop = row?.optDouble("top")?.let { it * density + origin[1] } ?: -1.0
        val rowBottom = row?.optDouble("bottom")?.let { it * density + origin[1] } ?: -1.0
        val frameTop = frame?.optDouble("top")?.let { it * density + origin[1] } ?: -1.0
        val frameBottom = frame?.optDouble("bottom")?.let { it * density + origin[1] } ?: -1.0
        val pillTree = findByLabelPrefix(PILL_LABEL)
        note(
            "  window insets top=${insets.top} bottom=${insets.bottom} px (${insets.windowWidth}x${insets.windowHeight}); " +
                "status bar visible=${statusBarsVisible()} lightAppearance=${lightStatusBarIcons()}; " +
                "chrome --zen-inset-top=${geometry.optString("insetTop")} --zen-inset-bottom=${geometry.optString("insetBottom")} " +
                "data-dark=${geometry.optString("dark")} text-zoom=${geometry.optString("textZoom")}"
        )
        note(
            "  bar row ${rowTop.roundToInt()}..${rowBottom.roundToInt()} px, page frame ${frameTop.roundToInt()}..${frameBottom.roundToInt()} px, " +
                "pill (accessibility) ${pillTree?.top}..${pillTree?.bottom} px, chrome view at ${origin[0]},${origin[1]}"
        )
        // The window's own word, in CSS px, is what the chrome must hold (a constant would pass here too).
        val expectedTop = insets.top / density.toDouble()
        val expectedBottom = insets.bottom / density.toDouble()
        check("[$scene] --zen-inset-top is the window's status bar inset (${fmt(expectedTop)} px)", abs(insetTopCss - expectedTop) <= 1.0)
        check("[$scene] --zen-inset-bottom is the window's navigation bar inset (${fmt(expectedBottom)} px)", abs(insetBottomCss - expectedBottom) <= 1.0)
        check("[$scene] the status bar is showing", statusBarsVisible())
        check("[$scene] the status bar icons match the scheme (dark chrome, light icons)", lightStatusBarIcons() == !chromeDark)
        check("[$scene] the chrome's scheme is the one set", chromeDark == dark)
        // The dock as drawn (the row above or below the page frame), not as asked: a session the
        // old core wrote late can bring the bar up at the other edge, and the edge's claim must
        // be judged where the bar is.
        val drawnDock = if (rowTop >= 0 && frameTop >= 0 && rowTop < frameTop) "top" else "bottom"
        check("[$scene] the bar is docked where the setting says ($dock)", drawnDock == dock)
        if (drawnDock == "top") {
            check("[$scene] the bar's row starts at or below the status bar inset", rowTop >= insets.top - 1)
            check("[$scene] the page frame ends at or above the navigation bar inset", frameBottom <= insets.windowHeight - insets.bottom + 1)
            pillTree?.let { check("[$scene] the pill's accessibility bounds start below the status bar", it.top >= insets.top - 1) }
        } else {
            check("[$scene] the bar's row ends at or above the navigation bar inset", rowBottom <= insets.windowHeight - insets.bottom + 1)
            check("[$scene] the page frame starts at or below the status bar inset", frameTop >= insets.top - 1)
            pillTree?.let { check("[$scene] the pill's accessibility bounds end above the navigation bar", it.bottom <= insets.windowHeight - insets.bottom + 1) }
        }
    }

    /** The bar's row, the pill, the content frame and the root's inset variables, in the chrome's CSS px. */
    private fun chromeGeometry(): JSONObject? {
        val raw = chromeJs(
            "(function(){function rc(e){if(!e)return null;var b=e.getBoundingClientRect();" +
                "return {top:b.top,bottom:b.bottom,left:b.left,right:b.right}}" +
                "var cs=getComputedStyle(document.documentElement);var w=document.querySelector('.zen-window');" +
                "return JSON.stringify({row:rc(document.querySelector('.zen-phone-bar-row')),pill:rc(document.querySelector('.zen-phone-pill'))," +
                "frame:rc(document.querySelector('.zen-content-frame')),insetTop:cs.getPropertyValue('--zen-inset-top').trim()," +
                "insetBottom:cs.getPropertyValue('--zen-inset-bottom').trim(),dark:w?String(w.dataset.dark):'',textZoom:document.documentElement.dataset.textZoom||''})})()"
        )
        val text = runCatching { JSONTokener(raw).nextValue() as? String }.getOrNull() ?: return null
        return runCatching { JSONObject(text) }.getOrNull()
    }

    /** Where the chrome WebView sits on the screen (its CSS px are measured from here). */
    private fun chromeOrigin(): IntArray {
        val origin = IntArray(2)
        instrumentation.runOnMainSync { host.chrome.getLocationOnScreen(origin) }
        return origin
    }

    /**
     * The window's insets as the app reads them (`MainActivity.applyInsets`: the system bars and
     * the display cutout together), from the window itself.
     */
    private fun windowBars(): Insets {
        var result = windowInsets()
        instrumentation.runOnMainSync {
            val root = activity.window.decorView
            val bars = ViewCompat.getRootWindowInsets(root)
                ?.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
                ?: return@runOnMainSync
            result = Insets(result.windowWidth, result.windowHeight, bars.top, bars.bottom, result.tappableBottom)
        }
        return result
    }

    private fun statusBarsVisible(): Boolean {
        var visible = false
        instrumentation.runOnMainSync {
            visible = ViewCompat.getRootWindowInsets(activity.window.decorView)?.isVisible(WindowInsetsCompat.Type.statusBars()) ?: false
        }
        return visible
    }

    /** Whether the status bar is set for a light background, i.e. draws dark icons (`isAppearanceLightStatusBars`). */
    private fun lightStatusBarIcons(): Boolean {
        var light = false
        instrumentation.runOnMainSync {
            light = WindowInsetsControllerCompat(activity.window, activity.window.decorView).isAppearanceLightStatusBars
        }
        return light
    }

    private fun textZoom(): Int = chromeGeometry()?.optString("textZoom")?.toIntOrNull() ?: 0

    private fun deferredDocuments(): String {
        val zen = File(app.filesDir, "zen")
        val over = zen.listFiles { f -> f.isFile && f.name.endsWith(".json") && f.length() > BootHandoff.BOOT_INLINE_LIMIT }
            ?.map { "${it.name} (${it.length()} B)" } ?: emptyList()
        val feeds = File(zen, "safebrowsing").listFiles { f -> f.isFile && f.name.endsWith(".json") && f.length() > BootHandoff.BOOT_INLINE_LIMIT }
            ?.map { "safebrowsing/${it.name} (${it.length()} B)" } ?: emptyList()
        return (over + feeds).ifEmpty { listOf("none") }.joinToString(", ")
    }

    // --- switches ----------------------------------------------------------------------------------

    private fun setScheme(scheme: String) {
        coreInvoke("settings.update", """{"colorScheme":"$scheme"}""")
        poll(8_000) { (chromeGeometry()?.optString("dark") == "true") == (scheme == "dark") }
        SystemClock.sleep(1_200)
    }

    private fun setDock(dock: String) {
        coreInvoke("settings.update", """{"phoneBarPosition":"$dock"}""")
        SystemClock.sleep(2_500)
    }

    /**
     * A cold chrome boot on the profile as it stands (the deferred documents included), the
     * session seeded again at `dock` and `scheme`. The old activity is finished first and its
     * teardown given time: the old host's `destroyed` view events reach the old core as it goes,
     * and a session it writes then (its tabs closed) would otherwise be what the next boot reads,
     * as run 2's tabless relaunches showed; the session is written after that, before the launch.
     */
    private fun relaunch(dock: String, scheme: String) {
        if (relaunchMode == "clear") {
            // The running core persists the dock and the scheme itself; the new activity comes
            // up over it and the old host is torn down under the new chrome's boot.
            setDock(dock)
            setScheme(scheme)
        } else {
            val old = activity
            instrumentation.runOnMainSync { old.finish() }
            poll(10_000) { old.isDestroyed }
            SystemClock.sleep(1_500)
            File(app.filesDir, "zen/state.json").writeText(seedState(readAsset("media-demo-state.json"), dock, scheme))
        }
        launch()
        ensureForeground()
        poll(20_000) { chromeJs("typeof window.zen") == "\"object\"" }
        poll(15_000) { chromeGeometry()?.optJSONObject("row") != null }
        val live = poll(20_000) { field("fs") != null }
        note("  relaunched at $dock / $scheme: the seeded page ${if (live) "is live" else "did not come up"} (${describeTab(TAB)})")
    }

    private fun rotation(): Int {
        var value = -1
        instrumentation.runOnMainSync {
            value = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) activity.display?.rotation ?: -1
            else @Suppress("DEPRECATION") activity.windowManager.defaultDisplay.rotation
        }
        return value
    }

    private fun check(claim: String, holds: Boolean) {
        checks++
        if (!holds) failures++
        note("  ${if (holds) "PASS" else "FAIL"}: $claim")
    }

    private fun fmt(value: Double): String = if (value == value.roundToInt().toDouble()) value.roundToInt().toString() else "%.2f".format(value)

    companion object {
        /**
         * Visits in the seeded history: about 125 bytes each, some 5.6 MB, what a phone's
         * deferred documents add up to once the Safe Browsing phishing-database feed (4 MB) has
         * refreshed. The drop is a race against the fetch of the deferred documents: at 0.8 MB
         * the unfixed chrome won its first three boots and lost every boot from 4.9 MB on (run
         * 35549548671); at 2.3 MB it lost one boot in nine (run 35552348291). This size makes
         * the loss the rule, so the `before` take shows it in every dock and scheme. Under the
         * core's `MAX_VISITS` (50 000), all within the retention window.
         */
        const val SEEDED_VISITS = 45_000
    }
}
