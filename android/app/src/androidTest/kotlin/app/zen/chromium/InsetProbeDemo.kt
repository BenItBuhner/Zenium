package app.zen.chromium

import android.os.SystemClock
import android.util.Log
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.json.JSONObject
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import kotlin.math.roundToInt

/**
 * A measurement, not a demo: what the window says the bottom system bar is, against what the
 * bar's window is, under the emulator recipe's display (`wm size 720x1600`, `wm density 280`,
 * the three-button overlay enabled), the AVD's native display, a second density on the native
 * size, and – the recipe's overlay step redone exclusively – the three-button overlay with the
 * gestural one switched off. At each configuration the app is relaunched (a fresh activity on
 * the new metrics), the menu sheet opened, and the numbers taken from four places: `wm`, the
 * activity's resources and root insets, `dumpsys window` (the nav bar's frame and the overlays
 * in force) and the chrome (`--zen-inset-bottom`, the sheet's DOM). One table line per
 * configuration in `inset-probe-notes.txt`, a still `inset-<config>.png` of the sheet over the bar.
 */
@RunWith(AndroidJUnit4::class)
class InsetProbeDemo : DemoHarness("gesture-demo-state.json", "inset", "inset-probe") {
    override val tag = "InsetProbeDemo"
    private lateinit var notes: File
    private val table = ArrayList<String>()

    @Test
    fun record() = runDemo()

    override fun warmUp() {
        notes = File(out, "inset-probe-notes.txt")
        notes.writeText("Zenium Android inset probe\n\n")
        note("overlays at start:\n" + navbarOverlays())
        ensureForeground()
    }

    override fun demo() {
        // (1) The recipe's display, as the script left it: nothing changed, the app as launched.
        probe("recipe-720x1600at280")

        // (2) The AVD's native display.
        shellCommand("wm size reset")
        shellCommand("wm density reset")
        val nativeDensity = physicalDensity()
        note("native display after reset: ${shellCommand("wm size").trim()} / ${shellCommand("wm density").trim()}")
        relaunch()
        probe("native-at$nativeDensity")

        // (3) A second density on the native size.
        val second = if (nativeDensity == 420) 560 else 420
        shellCommand("wm density $second")
        relaunch()
        probe("native-at$second")

        // (4) The recipe's overlay step redone the way Settings does it: the three-button overlay
        // alone in its category (the recipe's plain `enable` leaves the gestural overlay on).
        shellCommand("cmd overlay enable-exclusive --category com.android.internal.systemui.navbar.threebutton")
        SystemClock.sleep(3_000)
        note("overlays after enable-exclusive:\n" + navbarOverlays())
        relaunch()
        probe("native-at$second-exclusive-threebutton")

        note("\nTABLE config | wm density | displayMetrics.density (dpi) | navBar frame px | systemBars.bottom px | navigationBars.bottom px | tappable.bottom px | host dp (px/density) | --zen-inset-bottom | bar true dp (frame/density) | verdict")
        for (line in table) note(line)
    }

    private fun relaunch() {
        SystemClock.sleep(4_000)
        shellCommand("am force-stop com.google.android.apps.nexuslauncher")
        launch()
        SystemClock.sleep(3_000)
        ensureForeground()
    }

    private fun probe(config: String) {
        ensureForeground()
        closeUrlbar()
        tapMenuButton()
        val opened = waitFor(MENU_HANDLE_LABEL, 8_000) != null
        SystemClock.sleep(2_500)
        shot(config)

        val wmDensity = shellCommand("wm density").trim().replace("\n", "; ")
        val wmSize = shellCommand("wm size").trim().replace("\n", "; ")

        var density = 0f
        var densityDpi = 0
        var rootHeight = 0
        var systemBarsBottom = 0
        var navBottom = 0
        var tappableBottom = 0
        var cutoutBottom = 0
        var hostInsets = "?"
        instrumentation.runOnMainSync {
            val a = activity
            val metrics = a.resources.displayMetrics
            density = metrics.density
            densityDpi = metrics.densityDpi
            val root = a.window.decorView
            rootHeight = root.height
            val all = ViewCompat.getRootWindowInsets(root)
            systemBarsBottom = all?.getInsets(WindowInsetsCompat.Type.systemBars())?.bottom ?: -1
            navBottom = all?.getInsets(WindowInsetsCompat.Type.navigationBars())?.bottom ?: -1
            tappableBottom = all?.getInsets(WindowInsetsCompat.Type.tappableElement())?.bottom ?: -1
            cutoutBottom = all?.getInsets(WindowInsetsCompat.Type.displayCutout())?.bottom ?: -1
            hostInsets = (a as? MainActivity)?.currentInsets()?.toString() ?: "?"
        }

        val dump = shellCommand("dumpsys window displays") + "\n" + shellCommand("dumpsys window windows")
        val lines = dump.lines()
        val navLines = ArrayList<String>()
        var afterNavWindow = 0
        for (line in lines) {
            val t = line.trim()
            if (t.contains("NavigationBar0")) afterNavWindow = 14
            val frameOfNavWindow = afterNavWindow > 0 && (t.contains("Frame=") || t.contains("frame=") || t.contains("Frames:"))
            if (afterNavWindow > 0) afterNavWindow--
            if (t.contains("navigationBars") || t.contains("NavigationBar0") || t.contains("mNavigationBarHeight") ||
                t.contains("tappableElement") || t.contains("mDisplayInfo") || frameOfNavWindow
            ) navLines += t
        }
        val navFrame = Regex("navigationBars[^\\n]*?[fF]rame=\\[(-?\\d+),(-?\\d+)\\]\\[(-?\\d+),(-?\\d+)\\]").find(dump)
        val navFramePx = navFrame?.let { it.groupValues[4].toInt() - it.groupValues[2].toInt() } ?: -1
        val screenHeightPx = Regex("real (\\d+) x (\\d+)").find(dump)?.groupValues?.get(2)?.toIntOrNull() ?: -1

        val chrome = runCatching {
            JSONObject(
                chromeJs(
                    "(function(){var cs=getComputedStyle(document.documentElement);" +
                        "var sheet=document.querySelector('.zen-sheet');var r=sheet?sheet.getBoundingClientRect():null;" +
                        "var controls=sheet?Array.prototype.slice.call(sheet.querySelectorAll('button,[role=button],a,input,[role=menuitem]')):[];" +
                        "var low=controls.reduce(function(m,e){var b=e.getBoundingClientRect();return b.height>0&&b.bottom>m?b.bottom:m;},0);" +
                        "return JSON.stringify({inset:cs.getPropertyValue('--zen-inset-bottom').trim(),innerHeight:window.innerHeight," +
                        "dpr:window.devicePixelRatio,sheetBottom:r?r.bottom:null,sheetPaddingBottom:sheet?getComputedStyle(sheet).paddingBottom:null," +
                        "lowestControlBottom:low,controls:controls.length});})()"
                ).trim().removeSurrounding("\"").replace("\\\"", "\"")
            )
        }.getOrElse { JSONObject().put("error", it.toString()) }

        val hostDp = if (density > 0) systemBarsBottom / density else -1f
        val barDp = if (density > 0 && navFramePx > 0) navFramePx / density else -1f
        val innerHeight = chrome.optDouble("innerHeight", -1.0)
        val lowest = chrome.optDouble("lowestControlBottom", -1.0)
        val gapCss = if (innerHeight > 0 && lowest > 0) innerHeight - lowest else -1.0
        // The chrome's window ends at the bar's inset; the gap to the screen's edge adds the inset.
        val gapToEdgeDp = if (gapCss >= 0) gapCss + hostDp else -1.0
        val verdict = when {
            navFramePx <= 0 -> "no nav bar frame in dumpsys"
            (hostDp - barDp).let { it > -1 && it < 1 } -> "equal"
            else -> "host reads ${hostDp.roundToInt()} dp for a ${barDp.roundToInt()} dp bar"
        }
        note(
            "\n== $config ==\nmenu opened: $opened\nwm: $wmSize | $wmDensity\n" +
                "app: density=$density densityDpi=$densityDpi rootHeight=$rootHeight screenHeightPx(dumpsys)=$screenHeightPx\n" +
                "root insets px: systemBars.bottom=$systemBarsBottom navigationBars.bottom=$navBottom tappableElement.bottom=$tappableBottom displayCutout.bottom=$cutoutBottom\n" +
                "host currentInsets (dp): $hostInsets\nchrome: $chrome\n" +
                "sheet lowest control to window bottom: ${fmt(gapCss)} css px; to the screen's edge (adding the inset): ${fmt(gapToEdgeDp)} dp = ${fmt(gapToEdgeDp * density)} px\n" +
                "nav bar frame px: $navFramePx (${fmt(barDp)} dp); dumpsys lines:\n" + navLines.distinct().take(60).joinToString("\n") { "  $it" }
        )
        table += "$config | $wmDensity | $density ($densityDpi) | $navFramePx | $systemBarsBottom | $navBottom | $tappableBottom | ${fmt(hostDp)} | ${chrome.optString("inset", "?")} | ${fmt(barDp)} | $verdict"
        back()
        SystemClock.sleep(1_500)
    }

    private fun physicalDensity(): Int =
        Regex("Physical density: (\\d+)").find(shellCommand("wm density"))?.groupValues?.get(1)?.toIntOrNull() ?: 420

    private fun navbarOverlays(): String =
        shellCommand("cmd overlay list").lines().filter { it.contains("navbar") }.joinToString("\n") { "  ${it.trim()}" }

    private fun fmt(v: Float): String = if (v < 0) "?" else String.format("%.2f", v)
    private fun fmt(v: Double): String = if (v < 0) "?" else String.format("%.2f", v)

    private fun note(line: String) {
        Log.i(tag, line)
        notes.appendText(line + "\n")
    }
}
