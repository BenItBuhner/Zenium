package app.zen.chromium

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.LinearGradient
import android.graphics.Paint
import android.graphics.Rect
import android.graphics.Shader
import android.os.Build
import android.os.SystemClock
import android.util.Base64
import android.util.Log
import android.view.accessibility.AccessibilityNodeInfo
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.json.JSONObject
import org.junit.Test
import org.junit.runner.RunWith
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FileInputStream

/**
 * Drives the phone's new tab page for the `android-newtab-demo` recording and writes what it
 * measured to `newtab-findings.txt` next to the screenshots (one `PASS` or `FAIL` per check;
 * the test itself only fails when the driver could not run):
 *
 *  - a new tab from the bar's plus: the page grows out of the button (MOT-03) and comes up with
 *    the search field and the most visited tiles (NTP-01, NTP-05);
 *  - the tiles are the sites visited during the warm-up – eight loopback hosts served from this
 *    process ([DemoServer], one per 127.0.0.n), each with its own favicon – ranked by the core's
 *    `history.topSites`;
 *  - a tap on a tile opens the site in the tab; a hold on one opens the tile's menu (Open in New
 *    Tab, Copy Link, Pin Shortcut, Remove);
 *  - a tap on the field opens the omnibox attached above the keyboard;
 *  - the gear opens the customise sheet (NTP-21): the Inspirational preset puts the space's
 *    colours behind the page (NTP-22), the Image source the picture stored ahead of the run;
 *  - the predictive back gesture on the sheet: held, the sheet follows the finger; let go, it is
 *    dismissed.
 *
 * The picture behind the Image source is written through `newtab.setWallpaper` in the warm-up –
 * the system's file picker is not driven – and the source is set back to the space's colours so
 * the recording shows the change. Gesture navigation is turned on for the run, since the
 * predictive back is an edge swipe. The seeded profile has HTTPS-only mode off: on (`ask`, the
 * default) it upgrades every dotted host but `localhost` and `127.0.0.1`, so the other seven
 * loopback sites would be asked for over https, which their plain servers cannot answer. See
 * [DemoHarness] for the plumbing.
 */
@RunWith(AndroidJUnit4::class)
class NewTabDemo : DemoHarness("newtab-demo-state.json", "android-ntp", "newtab-demo") {
    override val tag = "NewTabDemo"
    private val servers = ArrayList<DemoServer>()
    private lateinit var findings: File
    private val host get() = (activity as MainActivity).host

    /** The sites: a host each, the page's title (the tile's caption is its first word) and an icon colour. */
    private class Site(val n: Int, val title: String, val color: Int) {
        val address get() = "127.0.0.$n"
        val url get() = "http://$address:$PORT/"
    }

    private val sites = listOf(
        Site(1, "Orchard - Fresh fruit, delivered", 0xFF2E7D32.toInt()),
        Site(2, "Tides - Coastal weather", 0xFF0277BD.toInt()),
        Site(3, "Atlas - Maps for walkers", 0xFFEF6C00.toInt()),
        Site(4, "Ledger - Personal finance", 0xFF5E35B1.toInt()),
        Site(5, "Foundry - Type design", 0xFFC62828.toInt()),
        Site(6, "Meadow - Field notes", 0xFF00897B.toInt()),
        Site(7, "Lantern - Late reading", 0xFFF9A825.toInt()),
        Site(8, "Quarry - Stone and slate", 0xFF546E7A.toInt())
    )

    @Test
    fun record() {
        for (site in sites) {
            servers += DemoServer(
                PORT,
                mapOf(
                    "/" to ("text/html; charset=utf-8" to pageHtml(site).toByteArray()),
                    "/icon.png" to ("image/png" to iconPng(site))
                ),
                site.address
            ).also { it.start() }
        }
        try {
            runDemo()
        } finally {
            servers.forEach { it.close() }
        }
    }

    /** The predictive back is an edge swipe: gesture navigation for the run (the shared script sets three buttons). */
    override fun beforeLaunch() {
        shell("cmd overlay disable com.android.internal.systemui.navbar.threebutton")
        shell("cmd overlay enable com.android.internal.systemui.navbar.gestural")
        SystemClock.sleep(1_500)
    }

    // --- warm-up ---------------------------------------------------------------------------------

    /**
     * Off camera: visit every site once (typed, so the visits weigh in the ranking), the first
     * ones twice so the order is not the visiting order alone; store the picture for the Image
     * source and put the source back to the space's colours; open the new tab page once so the
     * recorded open pays for no first layout; end on the first site.
     */
    override fun warmUp() {
        findings = File(out, "newtab-findings.txt")
        findings.writeText("Zenium Android new tab page checks (API ${Build.VERSION.SDK_INT}, ${width}x$height, density $density)\n\n")
        for (server in servers) finding("demo server: ${server.selfCheck()}")
        val tabId = activeCoreTab()?.optString("id").orEmpty()
        finding("start: ${describeActive()}")

        for (site in sites) visit(tabId, site)
        for (site in sites.take(3)) visit(tabId, site)
        val ranked = coreInvoke("history.topSites", "{\"n\":8}")
        finding("history.topSites after the visits: ${summarise(ranked)}")

        coreInvoke("newtab.setWallpaper", "{\"dataUrl\":${JSONObject.quote(wallpaperDataUrl())}}")
        updateNewTab { it.put("wallpaper", "space") }
        finding("wallpaper picture stored (${newTabSettings()})")

        // The first new tab page pays for its layout; open and close one off camera.
        if (tapLabel(Finger(), NEW_TAB_LABEL)) {
            SystemClock.sleep(3_000)
            val fresh = activeCoreTab()
            if (fresh != null && fresh.optString("url") == BLANK_URL) {
                awaitTile(sites[0], 6_000)
                coreInvoke("tab.close", "{\"tabId\":${JSONObject.quote(fresh.optString("id"))}}")
                SystemClock.sleep(2_000)
            }
        }
        ensureActive(tabId)
        // The recording opens on the first site, where the round of visits started.
        visit(tabId, sites[0])
        SystemClock.sleep(1_500)
        finding("warm-up done: ${describeActive()}")
    }

    /** A loopback page loads in well under a second; a visit that does not is noted, not waited out. */
    private fun visit(tabId: String, site: Site) {
        coreInvoke("tab.navigate", "{\"tabId\":${JSONObject.quote(tabId)},\"input\":${JSONObject.quote(site.url)}}")
        if (!awaitLoaded(site.url, 8_000)) finding("  visit of ${site.url} never finished: ${describeActive()}")
        SystemClock.sleep(600)
    }

    // --- the sequence ----------------------------------------------------------------------------

    override fun demo() {
        shot("00-page")
        newTabFromPlus()
        tileTap()
        tileMenu()
        fieldToOmnibox()
        customiseSheet()
        finding("\nend: ${describeActive()}")
    }

    /** MOT-03, NTP-01, NTP-05: the plus grows the page out of the button; the tiles come up. */
    private fun newTabFromPlus() {
        finding("\nnew tab from the plus")
        val before = tabCount()
        val plus = findByLabel(NEW_TAB_LABEL) ?: run {
            finding("  no '$NEW_TAB_LABEL' button on the bar")
            return
        }
        Finger().tap(plus.exactCenterX(), plus.exactCenterY())
        // The grow takes 300 ms from the press; a screenshot now catches it under way.
        SystemClock.sleep(120)
        shot("01-grow")
        SystemClock.sleep(2_500)
        val tab = activeCoreTab()
        val tiles = awaitTile(sites[0], 6_000) != null
        SystemClock.sleep(800)
        shot("02-new-tab")
        val captions = sites.count { tile(it) != null }
        finding(
            "  active ${tab?.optString("id")} url '${tab?.optString("url")}', tabs ${tabCount()} (were $before); " +
                "field ${if (findByLabel(FIELD_LABEL) != null) "shown" else "MISSING"}; tiles $captions of ${sites.size} " +
                verdict(tab?.optString("url") == BLANK_URL && tabCount() == before + 1 && tiles && captions >= 4)
        )
    }

    /** A tap on a tile opens the site in this tab. */
    private fun tileTap() {
        finding("\ntile tap")
        val site = sites[1]
        val tile = tile(site) ?: run {
            finding("  no tile for ${site.caption}")
            return
        }
        Finger().tap(tile.exactCenterX(), tile.exactCenterY())
        awaitLoaded(site.url, 15_000)
        SystemClock.sleep(1_500)
        shot("03-tile-opened")
        finding("  ${site.caption}: ${describeActive()} ${verdict(activeUrl() == site.url)}")
        // Back to a new tab page for the rest: the plus again.
        tapLabel(Finger(), NEW_TAB_LABEL)
        SystemClock.sleep(3_000)
        awaitTile(sites[0], 6_000)
    }

    /** A hold on a tile opens its menu; back closes it. */
    private fun tileMenu() {
        finding("\ntile long press")
        val site = sites[2]
        val tile = tile(site) ?: run {
            finding("  no tile for ${site.caption}")
            return
        }
        Finger().apply {
            press(tile.exactCenterX(), tile.exactCenterY())
            up()
        }
        val menu = waitFor("Pin Shortcut", 8_000) != null
        SystemClock.sleep(1_200)
        shot("04-tile-menu")
        val items = listOf("Open in New Tab", "Copy Link", "Pin Shortcut", "Remove").filter { findByLabel(it) != null }
        finding("  menu ${if (menu) "opened" else "MISSING"}: ${items.joinToString(", ")} ${verdict(menu && items.size == 4)}")
        back()
        SystemClock.sleep(2_000)
        finding("  back: menu ${if (findByLabel("Pin Shortcut") == null) "closed" else "STILL UP"}")
    }

    /** A tap on the field opens the omnibox, attached above the keyboard. */
    private fun fieldToOmnibox() {
        finding("\nsearch field")
        val field = findByLabel(FIELD_LABEL) ?: run {
            finding("  no '$FIELD_LABEL' on the page")
            return
        }
        Finger().tap(field.exactCenterX(), field.exactCenterY())
        val keyboard = awaitIme(shown = true, timeoutMs = 8_000)
        SystemClock.sleep(1_500)
        val input = omniboxInput()
        shot("05-omnibox-keyboard")
        finding(
            "  keyboard ${if (keyboard) "up (inset ${imeInset()} px)" else "DOWN"}; omnibox input ${if (input != null) "focused at $input" else "MISSING"} " +
                verdict(keyboard && input != null)
        )
        // Back takes the keyboard, then the omnibox.
        back()
        awaitIme(shown = false, timeoutMs = 4_000)
        SystemClock.sleep(600)
        if (omniboxInput() != null) {
            back()
            SystemClock.sleep(1_500)
        }
        finding("  back: omnibox ${if (omniboxInput() == null) "closed" else "STILL UP"}, page ${if (findByLabel(FIELD_LABEL) != null) "shown" else "MISSING"}")
    }

    /** NTP-21, NTP-22: the gear's sheet, a preset change, a wallpaper source change, predictive back. */
    private fun customiseSheet() {
        finding("\ncustomise sheet")
        if (!tapLabel(Finger(), GEAR_LABEL)) {
            finding("  no '$GEAR_LABEL' button on the page")
            return
        }
        val opened = waitFor(SHEET_HANDLE_LABEL, 8_000) != null
        SystemClock.sleep(2_000)
        shot("06-customize-sheet")
        finding("  sheet ${if (opened) "opened" else "MISSING"}: presets ${listOf("Focused", "Inspirational", "Custom").count { findByLabel(it) != null }} shown; ${newTabSettings()} ${verdict(opened)}")

        if (reveal("Inspirational") != null && tapLabel(Finger(), "Inspirational", 4_000)) {
            SystemClock.sleep(2_000)
            shot("07-preset-inspirational")
            finding("  Inspirational: ${newTabSettings()} ${verdict(newTabSetting("preset") == "inspirational")}")
        } else {
            finding("  no Inspirational card in reach")
        }
        // The Wallpaper rows sit lower in the sheet: pull it up first so they are in reach.
        findByLabel(SHEET_HANDLE_LABEL)?.let { handle ->
            Finger().apply {
                down(handle.exactCenterX(), handle.exactCenterY())
                moveBy(0f, -0.35f * height, 160)
                up()
            }
            SystemClock.sleep(2_000)
        }
        if (reveal("Image") != null && tapLabel(Finger(), "Image", 4_000)) {
            SystemClock.sleep(2_200)
            shot("08-wallpaper-image")
            finding("  Image source: ${newTabSettings()} ${verdict(newTabSetting("wallpaper") == "image")}")
        } else {
            finding("  no Image row in reach")
        }

        // Predictive back on the sheet: held, the sheet follows the finger; let go, it goes. Only
        // with the sheet up: on the bare page the gesture would be the tab's own back.
        finding("\npredictive back on the sheet")
        if (findByLabel(SHEET_HANDLE_LABEL) == null) {
            finding("  the sheet is not up; skipped")
            return
        }
        val f = Finger()
        f.down(EDGE_X, height * 0.45f)
        f.moveBy(0.3f * width, 0f, 650)
        f.hold(900)
        shot("09-predictive-back-held")
        val heldUp = findByLabel(SHEET_HANDLE_LABEL) != null
        f.up()
        SystemClock.sleep(2_500)
        shot("10-after-back")
        val gone = findByLabel(SHEET_HANDLE_LABEL) == null
        finding(
            "  held: sheet ${if (heldUp) "still up" else "GONE EARLY"}; released: sheet ${if (gone) "dismissed" else "STILL UP"}; " +
                "page ${if (findByLabel(FIELD_LABEL) != null) "shown" else "MISSING"} ${verdict(heldUp && gone)}"
        )
        if (!gone) {
            back()
            SystemClock.sleep(2_000)
        }
    }

    // --- the sites -------------------------------------------------------------------------------

    private val Site.caption: String get() = title.substringBefore(" - ")

    /**
     * The site's tile on the page: the button named after the site (not a page heading of the
     * same word, which is not clickable). The WebView reports a button's name as its description
     * or as its text depending on the version, so both are checked.
     */
    private fun tile(site: Site): Rect? =
        findNodeWhere {
            it.isClickable &&
                (it.contentDescription?.toString() == site.caption || it.text?.toString() == site.caption)
        }?.let { node -> Rect().also { node.getBoundsInScreen(it) } }

    private fun awaitTile(site: Site, timeoutMs: Long): Rect? {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            tile(site)?.let { return it }
            SystemClock.sleep(200)
        }
        return null
    }

    private fun pageHtml(site: Site): String {
        val hex = String.format("#%06X", site.color and 0xFFFFFF)
        return "<!doctype html><html><head><meta charset=utf-8>" +
            "<meta name=viewport content=\"width=device-width,initial-scale=1\"><title>${site.title}</title>" +
            "<link rel=icon type=image/png href=/icon.png>" +
            "<style>body{margin:0;font-family:sans-serif;color:#15141a;background:#fff}" +
            "header{background:$hex;color:#fff;padding:56px 24px 40px}h1{margin:0;font-size:32px}" +
            "p{padding:24px;font-size:19px;line-height:1.5;color:#3c3c43}</style></head>" +
            "<body><header><h1>${site.caption}</h1></header>" +
            "<p>${site.title.substringAfter(" - ")}. One of the eight sites the demo visits so the new tab page has most visited tiles to show.</p>" +
            "</body></html>"
    }

    /** A 64 px icon: the site's colour with its initial in white. */
    private fun iconPng(site: Site): ByteArray {
        val size = 64
        val bitmap = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(bitmap)
        val paint = Paint(Paint.ANTI_ALIAS_FLAG)
        paint.color = site.color
        canvas.drawRoundRect(0f, 0f, size.toFloat(), size.toFloat(), 14f, 14f, paint)
        paint.color = Color.WHITE
        paint.textSize = 40f
        paint.textAlign = Paint.Align.CENTER
        paint.isFakeBoldText = true
        val baseline = size / 2f - (paint.descent() + paint.ascent()) / 2f
        canvas.drawText(site.caption.substring(0, 1), size / 2f, baseline, paint)
        return ByteArrayOutputStream().also { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }.toByteArray()
    }

    /** The picture for the Image source: a dusk gradient at phone proportions, as a JPEG data URL. */
    private fun wallpaperDataUrl(): String {
        val w = 540
        val h = 1080
        val bitmap = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(bitmap)
        val paint = Paint()
        paint.shader = LinearGradient(
            0f, 0f, w * 0.4f, h.toFloat(),
            intArrayOf(0xFF1B2A49.toInt(), 0xFF6A3D7A.toInt(), 0xFFE07A5F.toInt(), 0xFFF2CC8F.toInt()),
            floatArrayOf(0f, 0.45f, 0.8f, 1f),
            Shader.TileMode.CLAMP
        )
        canvas.drawRect(0f, 0f, w.toFloat(), h.toFloat(), paint)
        paint.shader = null
        paint.color = 0x33FFFFFF
        paint.isAntiAlias = true
        canvas.drawCircle(w * 0.72f, h * 0.22f, 110f, paint)
        val out = ByteArrayOutputStream()
        bitmap.compress(Bitmap.CompressFormat.JPEG, 82, out)
        return "data:image/jpeg;base64," + Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP)
    }

    // --- the chrome ------------------------------------------------------------------------------

    /** The omnibox's text field (editable, as the pill's button of the same name is not); its bounds. */
    private fun omniboxInput(): Rect? =
        findNodeWhere { it.isEditable && (it.contentDescription?.toString() == OMNIBOX_LABEL || it.isFocused) }
            ?.let { node -> Rect().also { node.getBoundsInScreen(it) } }

    private fun <T> onMain(block: () -> T): T {
        var result: T? = null
        instrumentation.runOnMainSync { result = block() }
        @Suppress("UNCHECKED_CAST")
        return result as T
    }

    private fun shownTabView(): TabWebView? = host.tabs.all().firstOrNull { it.isShown }

    private fun awaitLoaded(url: String, timeoutMs: Long = 20_000): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            val (current, progress) = onMain { shownTabView().let { (it?.url ?: "") to (it?.progress ?: 0) } }
            if (current == url && progress == 100) return true
            SystemClock.sleep(250)
        }
        Log.w(tag, "gave up waiting for $url")
        return false
    }

    /** Run a shell command with the instrumentation's shell permissions; returns its output. */
    private fun shell(command: String): String {
        val fd = ui.executeShellCommand(command)
        return FileInputStream(fd.fileDescriptor).bufferedReader().use { it.readText() }.also { fd.close() }
    }

    // --- the core --------------------------------------------------------------------------------

    private fun activeUrl(): String = activeCoreTab()?.optString("url").orEmpty()

    private fun tabCount(): Int = coreState().getJSONObject("tabs").length()

    private fun describeActive(): String = activeCoreTab().let { "active ${it?.optString("id")} ${it?.optString("url")}, ${tabCount()} tabs" }

    private fun ensureActive(tabId: String) {
        if (activeCoreTab()?.optString("id") == tabId) return
        coreInvoke("tab.activate", "{\"tabId\":${JSONObject.quote(tabId)}}")
        settle()
    }

    private fun newTabSettingsJson(): JSONObject = coreState().getJSONObject("settings").getJSONObject("newTab")

    private fun newTabSetting(key: String): String = newTabSettingsJson().optString(key)

    private fun newTabSettings(): String = newTabSettingsJson().let { "preset ${it.optString("preset")}, wallpaper ${it.optString("wallpaper")}, shortcuts ${it.optString("shortcutStyle")}" }

    /** Write the new tab settings back with `edit` applied (`settings.update` takes the whole object). */
    private fun updateNewTab(edit: (JSONObject) -> Unit) {
        val next = newTabSettingsJson()
        edit(next)
        coreInvoke("settings.update", "{\"newTab\":$next}")
    }

    private fun summarise(topSites: String): String = runCatching {
        val list = org.json.JSONArray(topSites)
        (0 until list.length()).joinToString(", ") { i ->
            val s = list.getJSONObject(i)
            "${s.optString("title").substringBefore(" - ")} (${"%.2f".format(s.optDouble("score"))}${if (s.isNull("favicon")) ", no icon" else ""})"
        }
    }.getOrElse { topSites.take(200) }

    private fun verdict(ok: Boolean) = if (ok) "PASS" else "FAIL"

    private fun finding(line: String) {
        Log.i(tag, line.trim())
        findings.appendText(line + "\n")
    }

    companion object {
        private const val PORT = 18131
        private const val BLANK_URL = "zen://blank"
        private const val NEW_TAB_LABEL = "New tab"
        private const val FIELD_LABEL = "Search or type URL"
        private const val GEAR_LABEL = "Customise the new tab page"
        private const val SHEET_HANDLE_LABEL = "Resize sheet"
        private const val OMNIBOX_LABEL = "Search or enter address"
        /** Inside the system's gesture inset at the left edge. */
        private const val EDGE_X = 2f
    }
}
