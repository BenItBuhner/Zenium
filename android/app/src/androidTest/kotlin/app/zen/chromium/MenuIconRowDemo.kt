package app.zen.chromium

import android.os.Build
import android.os.SystemClock
import android.util.Log
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.io.FileInputStream

/**
 * Records the phone app menu's icon row (matrix TB-08, TB-16's row half): Chrome's Forward,
 * star, Download Page, Page Info and Reload / Stop as the sheet's first group. Every press on the
 * row is a real touch (the REAL TOUCH RULE), and each outcome is read off the core's state or the
 * chrome's DOM: the disabled Forward (opacity .4, its node disabled, a touch on it doing nothing),
 * Forward enabled after a navigation and a system back, the touch going forward; Stop while a
 * page of the loopback [DemoServer] waits on a slow script, the touch halting the load, Reload
 * fetching the page again; the star's fill spring running as the sheet leaves, the "Saved to
 * Bookmarks" toast, the star reopening filled as "Edit Bookmark"; Page Info opening the site-info
 * sheet; Download Page saving an archive ("Page saved", one more download); a finger held on
 * Reload for the press fill; and the row in dark once the device's night mode flips.
 *
 * Driven by the `android-menu-row-demo` workflow. See [DemoHarness] for the plumbing. Findings
 * land in `menu-row-findings.txt` next to the stills (one PASS or FAIL per claim, ALL CHECKS
 * PASSED at the end); the run fails on any FAIL. Profile `history-bookmarks-demo-state.json`
 * with its two tabs pointed at the loopback pages, the colour scheme following the device.
 */
@RunWith(AndroidJUnit4::class)
class MenuIconRowDemo : DemoHarness("history-bookmarks-demo-state.json", "menu-row", "menu-row-demo") {
    override val tag = "MenuIconRowDemo"
    private lateinit var server: DemoServer
    private lateinit var findings: File
    private var failures = 0
    private var shots = 0

    @Test
    fun record() {
        server = DemoServer(
            PORT,
            mapOf(
                "/" to DemoServer.page(FIRST_TITLE, "<p>The first page: the menu's row opens on it.</p>"),
                "/second.html" to DemoServer.page(SECOND_TITLE, "<p>The page after it: Back leaves a forward entry.</p>"),
                "/slow" to DemoServer.page(
                    SLOW_TITLE,
                    "<p>Its script takes its time to arrive; Stop cuts the wait short.</p>" +
                        "<script src=\"/slow.js\"></script><p>Loaded.</p>"
                ),
                "/slow.js" to ("text/javascript" to "document.body.dataset.slow='1'".toByteArray())
            ),
            delays = mapOf("/slow.js" to SLOW_MS)
        ).also { it.start() }
        try {
            runDemo()
        } finally {
            server.close()
        }
        if (failures > 0) error("$failures check(s) failed; see menu-row-findings.txt")
    }

    // --- seed ------------------------------------------------------------------------------------

    /** The seeded tabs point at the loopback pages; the scheme follows the device's night mode. */
    override fun patchState(json: String): String =
        json
            .replace("https://example.com/", "$ORIGIN/")
            .replace("\"Example Domain\"", "\"$FIRST_TITLE\"")
            .replace("https://en.wikipedia.org/wiki/Coffee", "$ORIGIN/second.html")
            .replace("\"Coffee - Wikipedia\"", "\"$SECOND_TITLE\"")
            .replace("\"colorScheme\": \"light\"", "\"colorScheme\": \"system\"")

    override fun beforeLaunch() {
        shell("cmd uimode night no")
        SystemClock.sleep(1_500)
    }

    // --- sequence --------------------------------------------------------------------------------

    /** Let the page come up, then open and close the menu once off camera: layout and compilation. */
    override fun warmUp() {
        findings = File(out, "menu-row-findings.txt")
        findings.writeText(
            "Zenium Android app menu icon row checks (API ${Build.VERSION.SDK_INT}, ${width}x$height, density $density)\n\n"
        )
        finding("demo server: ${server.selfCheck()}")
        awaitActive("$ORIGIN/")
        chromeJs(FILL_SAMPLER)
        if (openMenu()) {
            SystemClock.sleep(1_000)
            back()
            awaitSurface(false)
        }
        SystemClock.sleep(1_500)
        finding("start: active ${activeCoreTab()?.optString("url")}, bookmarks ${bookmarkCount()}, downloads ${downloadCount()}")
        Log.i(tag, "warm-up done")
    }

    override fun demo() {
        rowIdle()
        pressed()
        forward()
        reloadAndStop()
        star()
        pageInfo()
        downloadPage()
        dark()
        finding("")
        finding(if (failures == 0) "ALL CHECKS PASSED" else "$failures CHECK(S) FAILED")
    }

    // 1. The row as the menu opens on a page with nothing ahead of it, not bookmarked, at rest.
    private fun rowIdle() {
        finding("\n1. The row at rest (no forward entry, not bookmarked, idle)")
        record("the menu opened", openMenu())
        val row = readRow()
        still("row-idle")
        val labels = row.map { it.getString("label") }
        record("five buttons in Chrome's order: ${labels.joinToString(" | ")}", labels == EXPECTED_LABELS)
        val boxes = row.map { "${it.optDouble("w")}x${it.optDouble("h")}/${it.optDouble("glyph")}" }
        record(
            "each a 44 x 44 box with a 20 px glyph (CSS px): ${boxes.joinToString(" ")}",
            row.all { near(it.optDouble("w"), 44.0) && near(it.optDouble("h"), 44.0) && near(it.optDouble("glyph"), 20.0) }
        )
        record("the row draws on the sheet's page surface", row.firstOrNull()?.optString("surface") == "page")
        val forward = row.firstOrNull()
        record(
            "Forward disabled at opacity .4 with no forward entry (disabled ${forward?.optBoolean("disabled")}, opacity ${forward?.optString("opacity")})",
            forward != null && forward.optBoolean("disabled") && forward.optString("opacity") == "0.4"
        )
        record("the other four enabled at opacity 1", row.drop(1).all { !it.optBoolean("disabled") && it.optString("opacity") == "1" })
        val forwardNode = findNode { it == LABEL_FORWARD }
        record("Forward's accessibility node reports disabled", forwardNode != null && !forwardNode.isEnabled)
        val star = row.getOrNull(1)
        record(
            "the star opens unfilled (data-filled ${star?.optString("filled")}, fill opacity ${star?.optString("fill")})",
            star != null && star.optString("filled") == "false" && star.optString("fill") == "0"
        )
        record("Reload / Stop reads Reload while idle", labels.lastOrNull() == LABEL_RELOAD)
        // A real finger on the disabled Forward: nothing happens, the menu stays, the page stays.
        val touched = touchTapLabel(LABEL_FORWARD)
        SystemClock.sleep(1_200)
        record(
            "a touch on the disabled Forward did nothing: menu still up ${chromeSurfaceUp()}, page ${activeCoreTab()?.optString("url")}",
            touched && chromeSurfaceUp() && menuOpen() && activeCoreTab()?.optString("url") == "$ORIGIN/"
        )
        closeMenu()
    }

    // 2. A finger resting on Reload: the press fill (§9.3), then the touch cancelled – no reload.
    private fun pressed() {
        finding("\n2. A finger held on Reload (the press fill)")
        record("the menu opened", openMenu())
        val reload = findByLabel(LABEL_RELOAD)
        if (reload == null) {
            record("Reload on screen to hold", false)
            closeMenu()
            return
        }
        val hits = server.hits("/")
        val f = Finger()
        f.down(reload.exactCenterX(), reload.exactCenterY())
        f.hold(450)
        still("row-pressed")
        val held = readRow().lastOrNull()
        f.cancel()
        record(
            "the held Reload shows the press fill (background ${held?.optString("background")}, :active ${held?.optBoolean("active")})",
            held != null && held.optString("background") != "rgba(0, 0, 0, 0)"
        )
        SystemClock.sleep(1_000)
        record(
            "the cancelled touch did not reload (hits on / ${hits} -> ${server.hits("/")}) and left the menu up",
            server.hits("/") == hits && menuOpen()
        )
        closeMenu()
    }

    // 3. Forward: a navigation on, a system back, then the row's Forward enabled and a touch on it.
    private fun forward() {
        finding("\n3. Forward after a navigation and a system back")
        navigate("$ORIGIN/second.html")
        awaitActive("$ORIGIN/second.html")
        SystemClock.sleep(800)
        back()
        awaitActive("$ORIGIN/")
        SystemClock.sleep(1_200)
        record(
            "the core has a forward entry after back (canGoForward ${activeCoreTab()?.optBoolean("canGoForward")})",
            activeCoreTab()?.optBoolean("canGoForward") == true
        )
        record("the menu opened", openMenu())
        val forward = readRow().firstOrNull()
        still("row-forward")
        record(
            "Forward enabled at opacity 1 with a forward entry (disabled ${forward?.optBoolean("disabled")}, opacity ${forward?.optString("opacity")})",
            forward != null && !forward.optBoolean("disabled") && forward.optString("opacity") == "1"
        )
        record(
            "a touch on Forward went forward to the second page",
            touchTapLabelExpecting(LABEL_FORWARD, "the active tab is the second page", 8_000) {
                activeCoreTab()?.optString("url") == "$ORIGIN/second.html"
            }
        )
        awaitActive("$ORIGIN/second.html")
        record("the sheet left after the pick", awaitSurface(false))
        SystemClock.sleep(600)
        still("forward-landed")
        back()
        awaitActive("$ORIGIN/")
        SystemClock.sleep(1_000)
    }

    // 4. Reload / Stop: the slot reads Stop on a slow page, a touch halts the load; Reload fetches again.
    private fun reloadAndStop() {
        finding("\n4. Reload / Stop on a page whose script is $SLOW_MS ms late")
        navigate("$ORIGIN/slow")
        awaitLoading(true)
        SystemClock.sleep(600)
        record("the slow page is loading (loading ${activeCoreTab()?.optBoolean("loading")})", activeCoreTab()?.optBoolean("loading") == true)
        record("the menu opened during the load", openMenu())
        val row = readRow()
        still("row-loading-stop")
        record(
            "Reload / Stop reads Stop while the page loads (last slot '${row.lastOrNull()?.optString("label")}')",
            row.lastOrNull()?.optString("label") == LABEL_STOP
        )
        record(
            "a touch on Stop halted the load",
            touchTapLabelExpecting(LABEL_STOP, "the active tab is no longer loading", 6_000) {
                activeCoreTab()?.optBoolean("loading") == false
            }
        )
        record("the sheet left after the pick", awaitSurface(false))
        SystemClock.sleep(800)
        still("stopped")
        record("the page stayed where it was (${activeCoreTab()?.optString("url")})", activeCoreTab()?.optString("url") == "$ORIGIN/slow")
        // Wait out the late script's timer so the next load is a clean one.
        SystemClock.sleep(SLOW_MS)
        val hits = server.hits("/slow")
        record("the menu opened", openMenu())
        val idle = readRow()
        record("Reload / Stop reads Reload once the load has stopped ('${idle.lastOrNull()?.optString("label")}')", idle.lastOrNull()?.optString("label") == LABEL_RELOAD)
        record(
            "a touch on Reload fetched the page again (hits on /slow $hits -> ${hits + 1})",
            touchTapLabelExpecting(LABEL_RELOAD, "the page was requested again", 8_000) { server.hits("/slow") > hits }
        )
        awaitSurface(false)
        SystemClock.sleep(600)
        still("reloading")
        awaitLoading(false, SLOW_MS + 10_000)
        navigate("$ORIGIN/")
        awaitActive("$ORIGIN/")
        SystemClock.sleep(1_000)
    }

    // 5. The star: a touch fills it on the spring as the sheet leaves; the toast; reopened filled.
    private fun star() {
        finding("\n5. The star (TB-16: the menu's bookmark entry)")
        val before = bookmarkCount()
        watchToasts()
        record("the menu opened", openMenu())
        val star = findByLabel(LABEL_STAR)
        if (star == null) {
            record("the star on screen to touch", false)
            closeMenu()
            return
        }
        chromeJs("window.__rowFillStart()")
        Finger().tap(star.exactCenterX(), star.exactCenterY())
        SystemClock.sleep(90)
        still("star-filling")
        val toasted = awaitToastSeen(TOAST_SAVED, 8_000)
        SystemClock.sleep(600)
        val samples = fillSamples()
        val opacities = (0 until samples.length()).mapNotNull { i ->
            val s = samples.getJSONArray(i)
            if (s.isNull(1)) null else s.getDouble(1)
        }
        val climbs = opacities.indices.count { it > 0 && opacities[it] > opacities[it - 1] + 0.001 }
        val peak = opacities.maxOrNull() ?: 0.0
        // The frame that lands the fill: on the unit-scaled spring it closes under .02 whatever the
        // frame length (the motion clamps a stalled frame to 64 ms); the px-scaled rest thresholds
        // snapped the last half of the fill in one frame (run 1 sampled .16 -> 1.00), which the
        // climb-and-peak claim alone let through. A cut lands on exactly 1, so it is always sampled.
        val landing = opacities.indexOfFirst { it >= 0.999 }
        val landingStep = if (landing > 0) opacities[landing] - opacities[landing - 1] else 0.0
        // SPRING_SNAPPY reaches .9 in about 200 ms and rests by 370; the software GPU paints few
        // frames in that time, so the claim is a climb over more than one frame to the fill with no
        // cut at the end, not a frame count.
        record(
            "the fill climbed on its spring over several frames as the sheet left, with no cut into the fill (${samples.length()} frames, $climbs climbing, peak ${"%.2f".format(peak)}, landing step ${"%.3f".format(landingStep)}; path ${opacities.joinToString(" ") { "%.2f".format(it) }})",
            climbs >= 2 && peak > 0.8 && landingStep < 0.1
        )
        record("the toast '$TOAST_SAVED' came", toasted)
        still("saved-toast")
        val after = bookmarkCount()
        record("one bookmark node more ($before -> $after)", after == before + 1)
        record("the sheet left after the pick", awaitSurface(false))
        SystemClock.sleep(4_500)
        record("the menu opened", openMenu())
        val filled = readRow().getOrNull(1)
        still("row-star-filled")
        record(
            "the star reopens filled as '$LABEL_EDIT' (label '${filled?.optString("label")}', data-filled ${filled?.optString("filled")}, fill opacity ${filled?.optString("fill")})",
            filled != null && filled.optString("label") == LABEL_EDIT && filled.optString("filled") == "true" && filled.optString("fill") == "1"
        )
        closeMenu()
    }

    // 6. Page Info opens the site-info sheet once the menu has left.
    private fun pageInfo() {
        finding("\n6. Page Info")
        record("the menu opened", openMenu())
        record(
            "a touch on Page Info opened the site-info sheet",
            touchTapLabelExpecting(LABEL_INFO, "the site-info sheet is up", 8_000) { findAny(SITE_INFO_GRIP, "Connection") != null }
        )
        SystemClock.sleep(1_500)
        still("page-info-sheet")
        record("the menu is gone under the site-info sheet", !menuOpen())
        back()
        awaitSurface(false)
        SystemClock.sleep(1_000)
    }

    // 7. Download Page: the host saves an archive; the core toasts and files it.
    private fun downloadPage() {
        finding("\n7. Download Page")
        val before = downloadCount()
        watchToasts()
        record("the menu opened", openMenu())
        record(
            "a touch on Download Page saved the page ('$TOAST_PAGE_SAVED')",
            touchTapLabelExpecting(LABEL_DOWNLOAD, "the '$TOAST_PAGE_SAVED' toast came", 15_000) { toastSeen(TOAST_PAGE_SAVED) }
        )
        SystemClock.sleep(800)
        still("page-saved")
        val after = downloadCount()
        record("one download more ($before -> $after)", after == before + 1)
        awaitSurface(false)
        SystemClock.sleep(3_500)
    }

    // 8. Dark: the system and the chrome go dark (as `SelectionDemo`'s design record does), the row
    // follows in the page family's dark tokens.
    private fun dark() {
        finding("\n8. The row in dark")
        shell("cmd uimode night yes")
        coreInvoke("settings.update", "{\"colorScheme\":\"dark\"}")
        SystemClock.sleep(5_000)
        ensureForeground()
        record("the menu opened", openMenu())
        val row = readRow()
        still("row-dark")
        record(
            "the chrome is dark (data-theme '${row.firstOrNull()?.optString("theme")}') and the row still five buttons",
            row.firstOrNull()?.optString("theme") == "dark" && row.size == 5
        )
        record("the star is still filled in dark", row.getOrNull(1)?.optString("filled") == "true")
        closeMenu()
        coreInvoke("settings.update", "{\"colorScheme\":\"system\"}")
        shell("cmd uimode night no")
        SystemClock.sleep(2_000)
    }

    // --- helpers ---------------------------------------------------------------------------------

    /** A finger on the bar's Menu button, then the row on screen (the sheet opens at its peek with the row in view). */
    private fun openMenu(): Boolean {
        ensureForeground()
        tapMenuButton()
        if (waitFor(MENU_HANDLE_LABEL, 6_000) == null) {
            Log.w(tag, "the menu never opened")
            return false
        }
        val deadline = SystemClock.uptimeMillis() + 6_000
        while (SystemClock.uptimeMillis() < deadline) {
            if (menuOpen()) break
            SystemClock.sleep(150)
        }
        SystemClock.sleep(1_500)
        return menuOpen()
    }

    private fun closeMenu() {
        back()
        awaitSurface(false)
        SystemClock.sleep(1_000)
    }

    private fun menuOpen(): Boolean = chromeJs("!!document.querySelector('.zen-menu-icon-row')") == "true"

    /**
     * The row's buttons as the chrome's DOM has them: label, disabled, the computed opacity and
     * background, the box and glyph sizes in CSS px, the star's fill state, the surface family
     * and the theme the root is painted in.
     */
    private fun readRow(): List<JSONObject> {
        val raw = chromeJs(
            "JSON.stringify(Array.prototype.map.call(document.querySelectorAll('.zen-menu-icon-row button'),function(b){" +
                "var r=b.getBoundingClientRect();var s=b.querySelector('svg');var g=s?s.getBoundingClientRect():null;" +
                "var cs=getComputedStyle(b);var f=b.querySelector('.zen-menu-star > span:last-child');" +
                "var sf=b.closest('[data-surface]');" +
                "return {label:b.getAttribute('aria-label'),disabled:b.disabled,opacity:cs.opacity,background:cs.backgroundColor," +
                "active:b.matches(':active'),w:r.width,h:r.height,glyph:g?g.width:0,filled:b.getAttribute('data-filled')," +
                "fill:f?f.style.opacity:null,surface:sf?sf.getAttribute('data-surface'):null," +
                "theme:document.documentElement.dataset.theme||null}}))"
        )
        val text = runCatching { JSONObject("{\"v\":$raw}").getString("v") }.getOrDefault("[]")
        val arr = runCatching { JSONArray(text) }.getOrDefault(JSONArray())
        return (0 until arr.length()).map { arr.getJSONObject(it) }
    }

    private fun fillSamples(): JSONArray {
        val raw = chromeJs("window.__rowFillStop()")
        val text = runCatching { JSONObject("{\"v\":$raw}").getString("v") }.getOrDefault("[]")
        return runCatching { JSONArray(text) }.getOrDefault(JSONArray())
    }

    private fun navigate(url: String) {
        val tabId = activeCoreTab()?.optString("id").orEmpty()
        coreInvoke("tab.navigate", JSONObject().put("tabId", tabId).put("input", url).toString())
    }

    /** Poll until the active tab per the core is `url` and has finished loading. */
    private fun awaitActive(url: String, timeoutMs: Long = 20_000) {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            val tab = activeCoreTab()
            if (tab != null && tab.optString("url") == url && !tab.optBoolean("loading")) return
            SystemClock.sleep(300)
        }
        Log.w(tag, "the active tab never settled on $url: ${activeCoreTab()}")
    }

    private fun awaitLoading(loading: Boolean, timeoutMs: Long = 8_000) {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            if (activeCoreTab()?.optBoolean("loading") == loading) return
            SystemClock.sleep(120)
        }
        Log.w(tag, "the active tab never reached loading=$loading: ${activeCoreTab()}")
    }

    private fun bookmarkCount(): Int = coreState().optJSONArray("bookmarks")?.length() ?: 0

    private fun downloadCount(): Int = coreState().optJSONArray("downloads")?.length() ?: 0

    private fun near(value: Double, target: Double, tolerance: Double = 0.6): Boolean = Math.abs(value - target) <= tolerance

    private fun shell(command: String): String {
        val fd = ui.executeShellCommand(command)
        return FileInputStream(fd.fileDescriptor).bufferedReader().use { it.readText() }.also { fd.close() }
    }

    private fun record(line: String, ok: Boolean) {
        if (!ok) failures++
        finding("$line ${if (ok) "PASS" else "FAIL"}")
    }

    private fun finding(line: String) {
        Log.i(tag, line.trim())
        findings.appendText(line + "\n")
    }

    /** Numbered stills: `menu-row-NN-<state>.png`. */
    private fun still(state: String) {
        shots++
        shot("%02d-%s".format(shots, state))
    }

    companion object {
        private const val PORT = 18141
        private const val ORIGIN = "http://127.0.0.1:$PORT"
        private const val FIRST_TITLE = "The first page"
        private const val SECOND_TITLE = "The second page"
        private const val SLOW_TITLE = "A slow page"
        /** How late the slow page's script answers: long enough to open the menu and touch Stop. */
        private const val SLOW_MS = 9_000L

        // The row's labels (v2 §9.1 Title Case for menu items; the star reads by the page's state).
        private const val LABEL_FORWARD = "Forward"
        private const val LABEL_STAR = "Bookmark This Page"
        private const val LABEL_EDIT = "Edit Bookmark"
        private const val LABEL_DOWNLOAD = "Download Page"
        private const val LABEL_INFO = "Page Info"
        private const val LABEL_RELOAD = "Reload"
        private const val LABEL_STOP = "Stop"
        private val EXPECTED_LABELS = listOf(LABEL_FORWARD, LABEL_STAR, LABEL_DOWNLOAD, LABEL_INFO, LABEL_RELOAD)
        private const val TOAST_SAVED = "Saved to Bookmarks"
        private const val TOAST_PAGE_SAVED = "Page saved"
        /** The site-info sheet's grip (`SiteInfoDemo`). */
        private const val SITE_INFO_GRIP = "Dismiss"

        /**
         * Installed in the chrome once: a frame-by-frame sampler of the star's fill layer between
         * `__rowFillStart()` and `__rowFillStop()` (which answers with the samples as JSON text),
         * each sample `[ms since start, fill opacity, fill transform, row still mounted]`.
         */
        private const val FILL_SAMPLER =
            "(function(){window.__rowFill=[];window.__rowFillOn=false;" +
                "window.__rowFillStart=function(){window.__rowFill=[];window.__rowFillOn=true;var t0=performance.now();" +
                "var tick=function(){if(!window.__rowFillOn)return;var s=document.querySelector('.zen-menu-star > span:last-child');" +
                "window.__rowFill.push([Math.round(performance.now()-t0),s?parseFloat(s.style.opacity):null,s?s.style.transform:null," +
                "!!document.querySelector('.zen-menu-icon-row')]);requestAnimationFrame(tick)};requestAnimationFrame(tick)};" +
                "window.__rowFillStop=function(){window.__rowFillOn=false;return JSON.stringify(window.__rowFill)}})()"
    }
}
