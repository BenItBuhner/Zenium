package app.zen.chromium

import android.accessibilityservice.AccessibilityService
import android.graphics.Rect
import android.os.Build
import android.os.SystemClock
import android.util.Log
import android.view.accessibility.AccessibilityNodeInfo
import androidx.core.content.pm.ShortcutManagerCompat
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.json.JSONArray
import org.json.JSONObject
import org.json.JSONTokener
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/**
 * Drives "Add to Home screen" on a device so the `android-pwa-demo` workflow can record it: the
 * name-edit sheet for a page without a manifest; the ambient banner (#72's top card) coming up on
 * the app page's second visit and swiped away; the app menu's Add to Home Screen opening the
 * install sheet built from the manifest (tile, name, origin, description, the screenshot strip),
 * its Add handing the request to the launcher's own pin dialog, the launcher's confirmation
 * toasting "Added Sketch to Home screen" with Open; the menu then reading "Open Sketch" inside
 * the app; and, from the Home screen, the pinned tile opening the app's URL in Zenium.
 *
 * The pages come from a loopback server inside this process ([DemoServer]): `/notes.html` has no
 * manifest, `/app/` declares one whose icon and screenshots are the preview host's demo app
 * (`src/android/preview-assets/webapp`, an androidTest asset dir). A loopback origin is a secure
 * context, so the app is installable the way it is from `localhost` in Chromium. The profile
 * (`pwa-demo-state.json`) opens on the plain page; `webapps.json` is seeded with one visit to the
 * app a day ago, so loading it once more is the second visit that makes the prompt due. What it
 * measures goes to `pwa-findings.txt` next to the screenshots (`PASS` or `FAIL` per check; the
 * test itself only fails when the driver could not run). See [DemoHarness] for the plumbing.
 */
@RunWith(AndroidJUnit4::class)
class PwaDemo : DemoHarness("pwa-demo-state.json", "android-pwa", "pwa-demo") {
    override val tag = "PwaDemo"
    private lateinit var server: DemoServer
    private lateinit var findings: File

    @Test
    fun record() {
        server = DemoServer(PORT, routes()).also { it.start() }
        try {
            runDemo()
        } finally {
            server.close()
        }
    }

    /** The app was visited once, a day ago: the load in the demo is the second visit, and the prompt is due. */
    override fun seedMore(zen: File) {
        val dayAgo = System.currentTimeMillis() - 24 * 60 * 60 * 1000L
        val record = JSONObject()
            .put("visits", 1)
            .put("firstVisitAt", dayAgo)
            .put("lastVisitAt", dayAgo)
            .put("dismissedAt", JSONObject.NULL)
            .put("promptedAt", JSONObject.NULL)
        val doc = JSONObject()
            .put("version", 1)
            .put("pinned", JSONArray())
            .put("engagement", JSONObject().put(APP_ID, record))
        File(zen, "webapps.json").writeText(doc.toString())
    }

    override fun warmUp() {
        findings = File(out, "pwa-findings.txt")
        findings.writeText(
            "Zenium Android Add to Home screen checks (API ${Build.VERSION.SDK_INT}, ${width}x$height, density $density)\n\n"
        )
        finding("demo server: ${server.selfCheck()}")
        finding("launcher takes pinned shortcuts: ${ShortcutManagerCompat.isRequestPinShortcutSupported(app)}")
        awaitActiveUrl("$ORIGIN/notes.html")
        // The first menu pays for layout and compilation: open it once off camera.
        tapMenuButton()
        if (waitFor(MENU_HANDLE_LABEL, 6_000) != null) {
            SystemClock.sleep(800)
            back()
        }
        SystemClock.sleep(1_500)
        val close = closeUrlField()
        if (!close.ok) finding("warm-up: ${close.describe()}")
        finding("start: active ${activeCoreTab()?.optString("url")}")
    }

    override fun demo() {
        val f = Finger()
        nameEditSheet(f)
        ambientBanner(f)
        val pinned = installSheetAndPin(f)
        menuInsideApp()
        homeScreenTile(f, pinned)
        finding("\nend: active ${activeCoreTab()?.optString("url")}, toasts ${liveMessages("toasts")}, banners ${liveMessages("banners")}")
    }

    // --- 1. a page without a manifest --------------------------------------------------------------

    private fun nameEditSheet(f: Finger) {
        finding("\nName-edit sheet (page without a manifest)")
        shot("01-page-without-manifest")
        if (!openMenuItem(ADD_ITEM)) {
            finding("FAIL the app menu has no '$ADD_ITEM' on the plain page")
            back()
            SystemClock.sleep(1_200)
            return
        }
        val sheet = awaitSheet(8_000)
        SystemClock.sleep(1_500)
        shot("02-name-edit-sheet")
        val field = json("(document.getElementById('zen-install-name')||{}).value||''")
        finding("${verdict(sheet)} the sheet opened; ${verdict(field == "Notes on damping")} the name field holds the page title ('$field')")
        // The name-edit sheet's injected touch (the rule in DemoHarness): a finger on the name
        // field must raise the keyboard for it (a touch through to the scrim closes the sheet
        // instead). Back takes the keyboard down again – the sheet's buttons sit under it – and
        // Cancel then closes the sheet.
        val nameField = if (sheet) findNodeWhere { it.isEditable } else null
        if (nameField != null && touchTap(nameField)) {
            val keyboard = awaitIme(shown = true)
            finding("${verdict(keyboard)} a finger on the name field raised the keyboard")
            if (keyboard) {
                back()
                awaitIme(shown = false)
                SystemClock.sleep(600)
            } else {
                touchFault("the touch on the name-edit sheet's name field raised no keyboard")
            }
        } else if (sheet) {
            finding("FAIL no name field on the tree to touch")
        }
        if (!tapLabel(f, "Cancel", 3_000)) back()
        SystemClock.sleep(1_500)
    }

    // --- 2. the ambient banner ---------------------------------------------------------------------

    /** Switch to the app tab (a fling on the pill, the way a thumb does); the load is the second visit. */
    private fun ambientBanner(f: Finger) {
        finding("\nAmbient banner (second visit to the app)")
        flingLeft()
        settle()
        if (activeCoreTab()?.optString("id") != "tab_app") {
            Log.w(tag, "the fling did not switch tabs; activating through the core")
            coreInvoke("tab.activate", "{\"tabId\":\"tab_app\"}")
            SystemClock.sleep(2_500)
        }
        awaitActiveUrl(APP_URL)
        var title = awaitBanner(8_000)
        if (title == null) {
            // The tab was loaded off screen (no banner behind an inactive tab): a fresh document
            // posts its manifest again, and the prompt that was due comes up.
            Log.i(tag, "no banner after the switch; reloading the app page")
            coreInvoke("tab.reload", "{\"tabId\":\"tab_app\"}")
            awaitActiveUrl(APP_URL)
            title = awaitBanner(10_000)
        }
        SystemClock.sleep(1_500)
        shot("03-ambient-banner")
        val manifest = activeCoreTab()?.optJSONObject("webApp")
        finding("${verdict(manifest != null)} the tab carries the manifest (${manifest?.optString("name")}, ${manifest?.optJSONArray("screenshots")?.length() ?: 0} screenshots)")
        finding("${verdict(title != null)} the ambient banner came up: ${title ?: "none"}")
        if (title == null) return
        val card = findByLabel(title) ?: run {
            finding("FAIL the banner's title is not in the accessibility tree")
            return
        }
        // A fling sideways: the card leaves the way it was thrown and the core hears 'swipe'.
        f.down(card.exactCenterX(), card.exactCenterY())
        f.moveBy(-0.55f * width, 0f, 140)
        f.up()
        val gone = awaitNoBanner(5_000)
        SystemClock.sleep(1_000)
        shot("04-banner-swiped-away")
        finding("${verdict(gone)} the banner left on the swipe (cooldown starts)")
    }

    // --- 3. the install sheet and the launcher's pin dialog ---------------------------------------

    /** True once the launcher confirmed the pin (the toast is up). */
    private fun installSheetAndPin(f: Finger): Boolean {
        finding("\nInstall sheet -> Add -> system pin dialog -> confirmation toast")
        if (!openMenuItem(ADD_ITEM)) {
            finding("FAIL the app menu has no '$ADD_ITEM' on the app page")
            back()
            return false
        }
        val sheet = awaitSheet(8_000)
        SystemClock.sleep(2_500)
        shot("05-install-sheet")
        val shots = json("String(document.querySelectorAll('.zen-install-shot').length)")
        val name = json("(document.querySelector('.zen-install-name')||{}).textContent||''")
        finding("${verdict(sheet)} the install sheet opened; ${verdict(name == "Sketch Studio")} it names the app ('$name'); ${verdict(shots == "3")} the screenshot strip holds the manifest's 3 shots ($shots)")
        if (!tapLabel(f, "Add")) {
            finding("FAIL no Add button in the sheet")
            back()
            return false
        }
        val system = awaitSystemWindow(12_000)
        SystemClock.sleep(2_000)
        shot("06-system-pin-dialog")
        finding("${verdict(system)} the system's pin dialog came up (${ui.rootInActiveWindow?.packageName})")
        // The install sheet's injected touch (the rule in DemoHarness): Add under a finger hands
        // the request to the launcher – a finding, and a fault of the run when it did not.
        if (!system) {
            touchFault("the touch on the install sheet's Add brought no system pin dialog in 12 s")
            return false
        }
        val accepted = PIN_ACCEPT_LABELS.any { tapInWindows(f, it) }
        finding("${verdict(accepted)} accepted the pin dialog")
        val toast = awaitToast(15_000)
        SystemClock.sleep(600)
        shot("07-pinned-toast")
        finding("${verdict(toast != null)} confirmation toast: ${toast ?: "none"}")
        SystemClock.sleep(1_500)
        return toast != null
    }

    // --- 4. the menu inside a pinned app --------------------------------------------------------------

    private fun menuInsideApp() {
        finding("\nApp menu inside the pinned app")
        tapMenuButton()
        if (waitFor(MENU_HANDLE_LABEL, 6_000) == null) {
            finding("FAIL the menu never opened")
            return
        }
        SystemClock.sleep(1_200)
        findByLabel(MENU_HANDLE_LABEL)?.let { handle ->
            Finger().apply {
                down(handle.exactCenterX(), handle.exactCenterY())
                moveBy(0f, -0.4f * height, 130)
                up()
            }
            SystemClock.sleep(2_000)
        }
        val open = reveal(OPEN_ITEM)
        SystemClock.sleep(800)
        shot("08-menu-open-app")
        finding("${verdict(open != null)} the menu reads '$OPEN_ITEM' (Add to Home Screen still there: ${findByLabel(ADD_ITEM) != null})")
        back()
        SystemClock.sleep(1_500)
    }

    // --- 5. the tile on the Home screen ---------------------------------------------------------------

    private fun homeScreenTile(f: Finger, pinned: Boolean) {
        finding("\nHome screen tile")
        ui.performGlobalAction(AccessibilityService.GLOBAL_ACTION_HOME)
        SystemClock.sleep(3_500)
        val tile = if (pinned) findTile() else null
        shot("09-home-screen-tile")
        finding("${verdict(tile != null)} the '$TILE_LABEL' tile is on the Home screen")
        if (tile != null) {
            f.tap(tile.exactCenterX(), tile.exactCenterY())
        } else {
            // Nothing to tap: come back the way the tile would, so the recording ends on the app.
            openLink(APP_URL)
        }
        val front = awaitForeground(10_000)
        awaitActiveUrl(APP_URL, 12_000)
        SystemClock.sleep(2_500)
        shot("10-opened-from-tile")
        val url = activeCoreTab()?.optString("url")
        finding("${verdict(front && url == APP_URL)} Zenium is in front on the app's URL ($url)")
    }

    /** The shortcut's icon on the launcher's workspace, looking one page to each side when needed. */
    private fun findTile(): Rect? {
        waitFor(TILE_LABEL, 4_000)?.let { return it }
        for (direction in listOf(-1f, 1f, 1f)) {
            Finger().apply {
                down(width / 2f, height * 0.45f)
                moveBy(direction * 0.6f * width, 0f, 220)
                up()
            }
            SystemClock.sleep(1_800)
            waitFor(TILE_LABEL, 2_000)?.let { return it }
        }
        return null
    }

    // --- helpers -----------------------------------------------------------------------------------------

    /** The browser's own window in front again (the launcher's dialog or the Home screen gone). */
    private fun awaitForeground(timeoutMs: Long): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            if (ui.rootInActiveWindow?.packageName?.toString() == app.packageName) return true
            SystemClock.sleep(200)
        }
        return false
    }

    /**
     * A real tap on the button labelled `label` in any window on screen (the launcher's pin dialog
     * is a window of its own). Only a node that is clickable itself counts: the dialog's title can
     * carry the same words as its button, and a tap on the title would do nothing.
     */
    private fun tapInWindows(f: Finger, label: String): Boolean {
        for (window in ui.windows) {
            val root = window.root ?: continue
            val queue = ArrayDeque<AccessibilityNodeInfo>().apply { add(root) }
            var visited = 0
            while (queue.isNotEmpty() && visited < 4_000) {
                val node = queue.removeFirst()
                visited++
                val text = node.text?.toString()
                val description = node.contentDescription?.toString()
                if ((text == label || description == label) && node.isClickable) {
                    val bounds = Rect().also { node.getBoundsInScreen(it) }
                    Log.i(tag, "tapping '$label' (${node.className}) at $bounds")
                    f.tap(bounds.exactCenterX(), bounds.exactCenterY())
                    SystemClock.sleep(1_500)
                    return true
                }
                for (i in 0 until node.childCount) node.getChild(i)?.let(queue::add)
            }
        }
        return false
    }

    /** Whether the install (or name-edit) sheet is mounted in the chrome, waiting up to `timeoutMs`. */
    private fun awaitSheet(timeoutMs: Long): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            if (json("String(!!document.getElementById('zen-install-title'))") == "true") return true
            SystemClock.sleep(200)
        }
        return false
    }

    private fun awaitActiveUrl(url: String, timeoutMs: Long = 20_000) {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            val tab = activeCoreTab()
            if (tab?.optString("url") == url && !tab.optBoolean("loading", true)) return
            SystemClock.sleep(250)
        }
        Log.w(tag, "gave up waiting for $url")
    }

    /** The title of the banner up in the chrome, once one is (null when none came in time). */
    private fun awaitBanner(timeoutMs: Long): String? {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            val titles = JSONArray(json("JSON.stringify(window.__zenStores.ui.get().banners.filter(b => !b.leaving).map(b => b.title))"))
            if (titles.length() > 0) return titles.getString(0)
            SystemClock.sleep(250)
        }
        return null
    }

    private fun awaitNoBanner(timeoutMs: Long): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            if (liveMessages("banners") == 0) return true
            SystemClock.sleep(200)
        }
        return false
    }

    /** The text of the pin confirmation toast, once the launcher's confirmation reached the chrome. */
    private fun awaitToast(timeoutMs: Long): String? {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            val messages = JSONArray(json("JSON.stringify(window.__zenStores.ui.get().toasts.filter(t => !t.leaving).map(t => t.message + (t.action ? ' [' + t.action.label + ']' : '')))"))
            for (i in 0 until messages.length()) {
                val message = messages.getString(i)
                if (message.contains("Home screen")) return message
            }
            SystemClock.sleep(250)
        }
        return null
    }

    private fun liveMessages(kind: String): Int =
        json("String(window.__zenStores.ui.get().$kind.filter(m => !m.leaving).length)").toIntOrNull() ?: -1

    /** A JS expression that evaluates to a string in the chrome, decoded. */
    private fun json(code: String): String = (JSONTokener(chromeJs(code)).nextValue() as? String).orEmpty()

    private fun verdict(ok: Boolean) = if (ok) "PASS" else "FAIL"

    private fun finding(line: String) {
        Log.i(tag, line.trim())
        findings.appendText(line + "\n")
    }

    // --- the pages -------------------------------------------------------------------------------------------

    private fun asset(name: String): ByteArray = instrumentation.context.assets.open(name).use { it.readBytes() }

    private fun routes(): Map<String, Pair<String, ByteArray>> = mapOf(
        "/notes.html" to DemoServer.page(
            "Notes on damping",
            "<p>A page with no web app manifest: adding it to the Home screen names the shortcut after the page.</p>"
        ),
        "/app/" to ("text/html; charset=utf-8" to APP_PAGE.toByteArray()),
        "/app/manifest.webmanifest" to ("application/manifest+json" to MANIFEST.toByteArray()),
        "/webapp/icon.svg" to ("image/svg+xml" to asset("webapp/icon.svg")),
        "/webapp/icon-192.png" to ("image/png" to asset("webapp/icon-192.png")),
        "/webapp/shot-canvas.svg" to ("image/svg+xml" to asset("webapp/shot-canvas.svg")),
        "/webapp/shot-colours.svg" to ("image/svg+xml" to asset("webapp/shot-colours.svg")),
        "/webapp/shot-gallery.svg" to ("image/svg+xml" to asset("webapp/shot-gallery.svg"))
    )

    companion object {
        private const val PORT = 18131
        private const val ORIGIN = "http://127.0.0.1:$PORT"
        private const val APP_URL = "$ORIGIN/app/"
        /** The manifest's `id` (`/app/`) resolved against the origin: the engagement record's key. */
        private const val APP_ID = APP_URL

        private const val ADD_ITEM = "Add to Home Screen"
        private const val OPEN_ITEM = "Open Sketch"
        private const val TILE_LABEL = "Sketch"
        /** The launcher's pin dialog accepts on one of these (Launcher3 says "Add automatically"). */
        private val PIN_ACCEPT_LABELS = listOf("Add automatically", "Add to Home screen", "Add to home screen", "Add")

        private val APP_PAGE = """
            <!doctype html><html><head><meta charset=utf-8>
            <meta name=viewport content="width=device-width,initial-scale=1">
            <title>Sketch Studio</title>
            <link rel=manifest href="/app/manifest.webmanifest">
            <meta name=theme-color content="#2f6f8f">
            <style>body{margin:0;font-family:sans-serif;color:#15141a;background:#e8f1f5}
            h1{font-size:28px;padding:40px 24px 8px}p{padding:0 24px;font-size:20px;line-height:1.4}
            .canvas{margin:24px;height:38vh;border-radius:16px;background:#fff;box-shadow:0 2px 12px rgba(0,0,0,.12)}</style></head>
            <body><h1>Sketch Studio</h1><p>Draw, ink and colour on an endless canvas. This page declares a web app manifest.</p>
            <div class=canvas></div></body></html>
        """.trimIndent()

        private val MANIFEST = """
            {
              "id": "/app/",
              "name": "Sketch Studio",
              "short_name": "Sketch",
              "description": "Draw, ink and colour on an endless canvas. Sketches sync between your devices and open offline.",
              "start_url": "/app/",
              "scope": "/app/",
              "display": "standalone",
              "theme_color": "#2f6f8f",
              "background_color": "#e8f1f5",
              "icons": [
                { "src": "/webapp/icon.svg", "sizes": "any", "type": "image/svg+xml", "purpose": "any" },
                { "src": "/webapp/icon-192.png", "sizes": "192x192", "type": "image/png", "purpose": "maskable" }
              ],
              "screenshots": [
                { "src": "/webapp/shot-canvas.svg", "sizes": "540x1080", "type": "image/svg+xml", "form_factor": "narrow", "label": "An ink sketch on the canvas" },
                { "src": "/webapp/shot-colours.svg", "sizes": "540x1080", "type": "image/svg+xml", "form_factor": "narrow", "label": "The colour palette" },
                { "src": "/webapp/shot-gallery.svg", "sizes": "540x1080", "type": "image/svg+xml", "form_factor": "narrow", "label": "The sketch gallery" }
              ]
            }
        """.trimIndent()
    }
}
