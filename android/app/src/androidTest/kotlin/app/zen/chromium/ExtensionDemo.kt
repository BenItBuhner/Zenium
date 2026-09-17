package app.zen.chromium

import android.accessibilityservice.AccessibilityService
import android.app.UiAutomation
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Rect
import android.os.ParcelFileDescriptor
import android.os.SystemClock
import android.util.Log
import android.view.InputDevice
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.accessibility.AccessibilityNodeInfo
import android.webkit.WebView
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.webkit.WebViewCompat
import app.zen.chromium.ext.ExtensionFiles
import app.zen.chromium.ext.ExtensionWebView
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * Drives the extension runtime on an emulator for the `android-ext-prototype` workflow: the
 * workflow pushes the unpacked demo extensions into `files/zen/extensions/`, this driver lays them
 * out as store installs with a registry (see [seed]), adds the probe extension from its assets,
 * seeds a one-tab profile on the local probe page, launches the app and then records, per
 * extension and per stage, what worked:
 *
 *  - load (the core parsed the manifest and configured it),
 *  - content script (ran, at the right `run_at`, without throwing),
 *  - messaging and storage (round trips through the shim, the bridge and the background host),
 *  - popup (the bottom sheet loaded the extension's page and its scripts ran),
 *  - core function (the page went dark, link hints appeared, ad requests were blocked, …).
 *
 * The visible part runs while the workflow records the screen (same `record` / `recording` /
 * `done` handshake as the gesture demo); measurements without a picture come after. Everything
 * lands in `files/ext-demo/results.json` and `ext-android-prototype-*.png`.
 */
@RunWith(AndroidJUnit4::class)
class ExtensionDemo {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val ui: UiAutomation = instrumentation.uiAutomation
    private val app: Context = instrumentation.targetContext
    private val out = File(app.filesDir, "ext-demo")
    private lateinit var activity: MainActivity
    private val host: Host get() = activity.host
    private val results = JSONObject()
    private val stages = JSONObject()
    private var width = 0
    private var height = 0
    /** The seeded probe tab; every measurement targets it explicitly (other tabs come and go). */
    private var probeTab = ""
    /** Whether content scripts run in real isolated worlds on this WebView (`Extensions.isolatedWorlds`). */
    private var worlds = false

    @Test
    fun record() {
        seed()
        launch()
        val loaded = waitForExtensions()
        results.put("extensions", loaded)
        results.put("scriptUnits", scriptUnits())
        instrumentation.runOnMainSync { worlds = host.extensions.isolatedWorlds }
        results.put("isolatedWorlds", worlds)
        results.put("webView", WebViewCompat.getCurrentWebViewPackage(app)?.let { "${it.packageName} ${it.versionName}" })
        handshake()
        try {
            visibleDemo()
        } finally {
            File(out, "done").writeText("done\n")
        }
        measurements()
        results.put("stages", stages)
        results.put("logcat", logcat())
        File(out, "results.json").writeText(results.toString(2))
        Log.i(TAG, "results written")
        SystemClock.sleep(2_000)
    }

    // --- setup -----------------------------------------------------------------------------------

    /**
     * The runtime runs what the store installed: `<root>/<id>/<version>/` directories and the
     * records of `extensions.json` pointing at them. The workflow pushes the demo extensions as
     * unpacked folders (`<root>/<id>/manifest.json`); the driver lays them out as installs, adds the
     * probe from its assets the same way and writes the registry, so the store attaches every one
     * of them on start exactly as it attaches a Web Store install.
     */
    private fun seed() {
        val zen = File(app.filesDir, "zen").apply { mkdirs() }
        zen.listFiles()?.filter { it.isFile }?.forEach { it.delete() }
        instrumentation.context.assets.open("ext-demo-state.json").use { input ->
            File(zen, "state.json").outputStream().use { input.copyTo(it) }
        }
        val root = File(zen, "extensions").apply { mkdirs() }
        val probe = File(root, PROBE_ID)
        probe.deleteRecursively()
        copyAssets("ext-probe", probe)
        // AAPT drops asset directories whose name starts with `_`, so the probe ships `locales/`.
        File(probe, "locales").renameTo(File(probe, "_locales"))
        val records = JSONArray()
        val installed = JSONObject()
        for (dir in root.listFiles().orEmpty().filter { it.isDirectory && ExtensionFiles.isExtensionId(it.name) }.sortedBy { it.name }) {
            val versionDir = layOutInstall(dir) ?: continue
            val manifest = runCatching { JSONObject(File(versionDir, "manifest.json").readText()) }.getOrNull() ?: continue
            records.put(record(dir.name, versionDir, manifest))
            installed.put(dir.name, versionDir.name)
        }
        results.put("seededInstalls", installed)
        val registry = JSONObject().put("version", 2).put("extensions", records).put("lastUpdateCheck", JSONObject.NULL)
        File(zen, "extensions.json").writeText(registry.toString())
        out.deleteRecursively()
        out.mkdirs()
    }

    /**
     * `<root>/<id>/manifest.json` (an unpacked folder) becomes `<root>/<id>/<version>/`, which is
     * returned; a folder already laid out as an install returns its version directory.
     */
    private fun layOutInstall(idDir: File): File? {
        val flat = File(idDir, "manifest.json")
        if (!flat.isFile) return idDir.listFiles()?.firstOrNull { it.isDirectory && File(it, "manifest.json").isFile }
        val version = runCatching { JSONObject(flat.readText()).optString("version", "") }.getOrDefault("")
        val moving = File(idDir.parentFile, "${idDir.name}.moving")
        moving.deleteRecursively()
        if (!idDir.renameTo(moving)) return null
        if (!idDir.mkdirs()) return null
        val target = File(idDir, ExtensionFiles.versionDirName(version))
        return if (moving.renameTo(target)) target else null
    }

    /** A registry record (the desktop's schema, version 2) for an install, from its manifest. */
    private fun record(id: String, dir: File, manifest: JSONObject): JSONObject {
        val now = System.currentTimeMillis()
        val action = manifest.optJSONObject("action") ?: manifest.optJSONObject("browser_action")
        val options = manifest.optJSONObject("options_ui")?.optString("page", "")?.ifEmpty { null } ?: manifest.optString("options_page", "").ifEmpty { null }
        val permissions = JSONArray()
        val hostPermissions = JSONArray()
        manifest.optJSONArray("permissions")?.let { a ->
            for (i in 0 until a.length()) {
                val p = a.optString(i, "")
                if (p.contains("://") || p == "<all_urls>") hostPermissions.put(p) else if (p.isNotEmpty()) permissions.put(p)
            }
        }
        manifest.optJSONArray("host_permissions")?.let { a -> for (i in 0 until a.length()) hostPermissions.put(a.optString(i, "")) }
        return JSONObject()
            .put("id", id)
            .put("source", "unpacked")
            .put("path", dir.absolutePath)
            .put("version", manifest.optString("version", ""))
            .put("publisher", JSONObject.NULL)
            .put("updateUrl", JSONObject.NULL)
            .put("installedAt", now)
            .put("updatedAt", now)
            .put("enabled", true)
            .put("pinned", false)
            .put("allowFileAccess", false)
            .put("manifestVersion", manifest.optInt("manifest_version", 2))
            .put("name", manifest.optString("name", "").takeUnless { it.startsWith("__MSG_") } ?: "")
            .put("description", manifest.optString("description", "").takeUnless { it.startsWith("__MSG_") } ?: "")
            .put("permissions", permissions)
            .put("hostPermissions", hostPermissions)
            .put("optionsPage", options ?: JSONObject.NULL)
            .put("popup", action?.optString("default_popup", "")?.ifEmpty { null } ?: JSONObject.NULL)
            .put("pendingWarnings", JSONObject.NULL)
    }

    private fun copyAssets(path: String, target: File) {
        val assets = instrumentation.context.assets
        val children = assets.list(path) ?: emptyArray()
        if (children.isEmpty()) {
            target.parentFile?.mkdirs()
            assets.open(path).use { input -> target.outputStream().use { input.copyTo(it) } }
            return
        }
        target.mkdirs()
        for (child in children) copyAssets("$path/$child", File(target, child))
    }

    private fun launch() {
        // The launcher entry is an icon alias that hands over to MainActivity and finishes at
        // once; the demo needs the browser's own activity, so it starts that directly.
        val intent = Intent(app, MainActivity::class.java).setAction(Intent.ACTION_MAIN)
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)
        activity = instrumentation.startActivitySync(intent) as MainActivity
        val deadline = SystemClock.uptimeMillis() + 40_000
        while (findByLabel("Address") == null && SystemClock.uptimeMillis() < deadline) SystemClock.sleep(500)
        instrumentation.runOnMainSync {
            width = activity.window.decorView.width
            height = activity.window.decorView.height
        }
        SystemClock.sleep(3_000)
    }

    /** The store attaches every enabled record on start and the runtime configures it; wait until the seeded extensions are listed. */
    private fun waitForExtensions(): JSONArray {
        var list = JSONArray()
        val started = SystemClock.uptimeMillis()
        waitFor(90_000, 1_000) {
            val state = state()
            list = state.optJSONArray("extensions") ?: JSONArray()
            val units = scriptUnitsCount()
            if (list.length() >= 2 && units > 0) true else null
        }
        results.put("configureMs", SystemClock.uptimeMillis() - started)
        // Rules and background pages come after the units. The probe's background adds its dynamic
        // rule on startup and `updateDynamicRules` resolves once Kotlin has the compiled rule set
        // (Chrome semantics); the dyn=1 pixel of the probe page is graded against that rule, so
        // the demo waits for the background to report it instead of a fixed grace period (on a
        // slow runner the rule set came 16 s after the units and the pixel had loaded before it).
        val rulesStarted = SystemClock.uptimeMillis()
        val dynamicReady = waitFor(90_000, 500) {
            val bg = backgroundView(PROBE_ID) ?: return@waitFor null
            if (tabEval(bg, "String(typeof report === 'object' && report.dynamicRules >= 1)") == "true") true else null
        }
        results.put("dynamicRuleReadyMs", if (dynamicReady == true) SystemClock.uptimeMillis() - rulesStarted else -1)
        SystemClock.sleep(2_000)
        for (i in 0 until list.length()) {
            val ext = list.getJSONObject(i)
            stage(ext.getString("id"), "load", if (ext.isNull("error")) "PASS" else "FAIL", if (ext.isNull("error")) ext.optString("name") else ext.optString("error"))
        }
        return list
    }

    private fun handshake() {
        File(out, "record").writeText("ready\n")
        val deadline = SystemClock.uptimeMillis() + 30_000
        while (!File(out, "recording").exists() && SystemClock.uptimeMillis() < deadline) SystemClock.sleep(200)
        SystemClock.sleep(1_000)
    }

    // --- the recorded sequence -------------------------------------------------------------------

    private fun visibleDemo() {
        // 1. The probe page with every content script: Dark Reader darkens it, the probe reports.
        // The seeded tab is found by URL, not taken as "the active tab": Return YouTube Dislike's
        // background opens its changelog with `tabs.create` on install, which is active by then.
        probeTab = tabIdByUrl("$BASE/probe.html") ?: createTab("$BASE/probe.html")
        chromeInvoke("tab.activate", """{"tabId":${JSONObject.quote(probeTab)}}""")
        SystemClock.sleep(500)
        chromeInvoke("tab.reload", """{"tabId":${JSONObject.quote(probeTab)}}""")
        val probeView = waitForView(probeTab)
        waitFor(30_000) { if (tabEval(probeView, PROBE_DONE) == "true") true else null }
        SystemClock.sleep(2_500)
        shot("01-probe-page-dark-reader")
        val probe = json(tabEval(probeView, PROBE_REPORT))
        if (worlds) mergeWorldReports(probeView, probe)
        results.put("probePage", probe)
        gradeProbe(probe)
        val dark = json(tabEval(probeView, DARK_READER_REPORT))
        results.put("darkReader", dark)
        stage(
            DARK_READER, "coreFunction",
            if (dark.optInt("styles") > 0 && dark.optString("bodyBackground") != "rgb(255, 255, 255)") "PASS" else "FAIL",
            "styles=${dark.optInt("styles")} mode=${dark.optString("mode")} body=${dark.optString("bodyBackground")} " +
                "styleSheetsGetter=${if (dark.optBoolean("styleSheetsGetterNative")) "native" else "patched by its proxy.js"} " +
                "drSheetsVisible=${dark.optInt("drSheetsVisible")} wasEnabledForHost=${dark.optString("wasEnabledForHost")}"
        )

        // 2. Vimium: focus the page, press f, expect link hints.
        tap(width / 2f, height * 0.42f)
        SystemClock.sleep(600)
        key(KeyEvent.KEYCODE_F)
        SystemClock.sleep(1_800)
        shot("02-vimium-hints")
        val vimium = json(tabEval(probeView, VIMIUM_REPORT))
        results.put("vimium", vimium)
        stage(VIMIUM, "coreFunction", if (vimium.optInt("hints") > 0) "PASS" else "FAIL", "hints=${vimium.optInt("hints")} ui=${vimium.optInt("ui")}")
        key(KeyEvent.KEYCODE_ESCAPE)
        SystemClock.sleep(800)

        // 3. The probe's popup: tabs, storage, messaging and executeScript from the page context.
        // The probe page is made the active tab first: Return YouTube Dislike opens its changelog
        // as a tab on install, and `executeScript` targets the active tab.
        chromeInvoke("tab.activate", """{"tabId":${JSONObject.quote(probeTab)}}""")
        SystemClock.sleep(800)
        results.put("extensionTabPages", extensionTabPages())
        val probePopupReady = popupDemo(PROBE_ID, "03-probe-popup", 20_000, { view -> tabEval(view, "document.title") == "probe-popup-ready" }) { view ->
            val report = json(tabEval(view, "JSON.stringify(window.__popupReport || null)"))
            results.put("probePopup", report)
            val steps = report.optJSONObject("steps") ?: JSONObject()
            stage(PROBE_ID, "popup", if (steps.has("activeTab") && steps.optJSONObject("background") != null) "PASS" else "PARTIAL", steps.toString().take(600))
        }
        if (!probePopupReady) stage(PROBE_ID, "popup", "FAIL", "popup never reported ready")

        // 4. Dark Reader's popup.
        val darkPopup = popupDemo(DARK_READER, "04-dark-reader-popup", 15_000, { view -> tabEval(view, "String(document.body && document.body.innerText.length > 40)") == "true" }) { view ->
            val text = tabEval(view, "document.body.innerText.slice(0, 300)")
            results.put("darkReaderPopupText", text)
            stage(DARK_READER, "popup", "PASS", text.take(120))
        }
        if (!darkPopup) stage(DARK_READER, "popup", "FAIL", "popup document stayed empty")

        // 5. uBlock Origin Lite: the ad-request page, then its popup.
        val adsTab = createTab("$BASE/ads.html")
        val adsView = waitForView(adsTab)
        waitFor(25_000) { if (tabEval(adsView, "String(Object.keys(window.__ads || {}).length >= 5)") == "true") true else null }
        SystemClock.sleep(1_000)
        shot("05-ubol-ads-page")
        val ads = json(tabEval(adsView, "JSON.stringify(window.__ads || {})"))
        results.put("adsPage", ads)
        val all = decisions()
        results.put("decisions", JSONArray(all.takeLast(80)))
        results.put("decisionMicros", decisionMicros(all))
        // uBOL's rules answer these with `redirect` to a neutered script in its web-accessible
        // resources (Chrome does the same, and the page's onload still fires), so the verdict comes
        // from the layer's own decision log: block or redirect for the four trackers, none for the control.
        val trackerUrls = mapOf(
            "gtag" to "https://www.googletagmanager.com/gtag/js",
            "analytics" to "https://www.google-analytics.com/analytics.js",
            "adsbygoogle" to "https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js",
            "doubleclick" to "https://securepubads.g.doubleclick.net/tag/js/gpt.js"
        )
        val verdicts = trackerUrls.mapValues { (_, url) -> all.lastOrNull { it.endsWith(" $url") || it.contains(" $url?") }?.substringBefore(' ') ?: "unseen" }
        val control = all.lastOrNull { it.contains("probe-page.css?control=1") }?.substringBefore(' ') ?: "unseen"
        results.put("trackerDecisions", JSONObject().apply { verdicts.forEach { (k, v) -> put(k, v) } }.put("control", control))
        val stopped = verdicts.values.count { it == "block" || it == "redirect" }
        stage(
            UBOL, "coreFunction",
            when {
                stopped == trackerUrls.size && ads.optString("control") == "loaded" && control != "block" -> "PASS"
                stopped > 0 -> "PARTIAL"
                else -> "FAIL"
            },
            "decisions ${verdicts.entries.joinToString { "${it.key}=${it.value}" }}, control=${ads.optString("control")}/$control, page saw ${trackerUrls.keys.count { ads.optString(it) == "error" }} onerror"
        )
        val ubolPopup = popupDemo(UBOL, "06-ubol-popup", 15_000, { view -> tabEval(view, "String(document.body && document.body.innerText.length > 20)") == "true" }) { view ->
            stage(UBOL, "popup", "PASS", tabEval(view, "document.body.innerText.slice(0, 200)").take(120))
        }
        if (!ubolPopup) stage(UBOL, "popup", "FAIL", "popup document stayed empty")

        // 6. Stylus: the popup for the probe page (no styles installed: the empty state).
        chromeInvoke("tab.activate", """{"tabId":${JSONObject.quote(probeTab)}}""")
        SystemClock.sleep(1_500)
        val stylusPopup = popupDemo(STYLUS, "07-stylus-popup", 15_000, { view -> tabEval(view, "String(document.body && document.body.innerText.length > 20)") == "true" }) { view ->
            stage(STYLUS, "popup", "PASS", tabEval(view, "document.body.innerText.slice(0, 200)").take(120))
        }
        if (!stylusPopup) stage(STYLUS, "popup", "FAIL", "popup document stayed empty")

        // 7. Return YouTube Dislike on a real watch page (network permitting).
        val ytTab = createTab("https://www.youtube.com/watch?v=dQw4w9WgXcQ")
        val ytView = waitForView(ytTab)
        waitFor(60_000, 1_000) {
            val ryd = json(tabEval(ytView, RYD_REPORT))
            if (ryd.optJSONArray("apiEntries")?.length() ?: 0 > 0 || ryd.optInt("elements") > 0 || (ryd.optString("readyState") == "complete" && ryd.optInt("groups") > 0)) true else null
        }
        SystemClock.sleep(4_000)
        shot("08-ryd-youtube")
        val ryd = json(tabEval(ytView, RYD_REPORT))
        results.put("returnYouTubeDislike", ryd)
        results.put("youtubeConsole", JSONArray(consoleOf(ytView)))
        val api = ryd.optJSONArray("apiEntries")?.length() ?: 0
        stage(RYD, "contentScript", if (ryd.optInt("groups") > 0) "PASS" else "FAIL", "groups=${ryd.optInt("groups")} readyState=${ryd.optString("readyState")} url=${ryd.optString("url")}")
        stage(
            RYD, "coreFunction",
            when {
                ryd.optInt("elements") > 0 -> "PASS"
                api > 0 -> "PARTIAL"
                else -> "FAIL"
            },
            "api requests seen by the page=$api, dislike elements=${ryd.optInt("elements")}"
        )
        chromeInvoke("tab.close", """{"tabId":${JSONObject.quote(ytTab)},"force":true}""")
        chromeInvoke("tab.close", """{"tabId":${JSONObject.quote(adsTab)},"force":true}""")
        SystemClock.sleep(1_500)
        results.put("probeConsole", JSONArray(consoleOf(probeView).takeLast(40)))
        gradeCalls()
        val traces = JSONObject()
        instrumentation.runOnMainSync {
            for (id in listOf(DARK_READER, STYLUS)) traces.put(id, JSONArray(host.extensions.traceSnapshot(id).takeLast(150)))
        }
        results.put("bridgeTrace", traces)
    }

    /**
     * Messaging and storage per real extension, from what actually crossed the bridge: a stage
     * passes when the extension made such calls and every reply was `ok`, is PARTIAL when some
     * failed, FAIL when all failed, and N/A when the extension never made one during the demo.
     */
    private fun gradeCalls() {
        var stats: Map<String, IntArray> = emptyMap()
        instrumentation.runOnMainSync { stats = host.extensions.callStatsSnapshot() }
        val table = JSONObject()
        for ((key, counts) in stats.toSortedMap()) table.put(key, JSONArray().put(counts[0]).put(counts[1]))
        results.put("callStats", table)
        val messaging = listOf("runtime.sendMessage", "runtime.connect", "port.postMessage", "tabs.sendMessage", "tabs.connect")
        val storage = listOf("storage.get", "storage.set", "storage.remove", "storage.clear", "storage.getBytesInUse")
        for (id in listOf(DARK_READER, VIMIUM, RYD, STYLUS, UBOL)) {
            for ((stage, members) in listOf("messaging" to messaging, "storage" to storage)) {
                val rows = stats.filterKeys { k -> k.startsWith("$id ") && members.any { k.endsWith(" $it") } }
                val calls = rows.values.sumOf { it[0] }
                val failures = rows.values.sumOf { it[1] }
                val detail = rows.entries.sortedBy { it.key }.joinToString(", ") { "${it.key.substringAfter(' ')}=${it.value[0]} calls/${it.value[1]} failed" }
                stage(
                    id, stage,
                    when {
                        calls == 0 -> "N/A"
                        failures == 0 -> "PASS"
                        failures < calls -> "PARTIAL"
                        else -> "FAIL"
                    },
                    if (calls == 0) "no such calls crossed the bridge during the demo" else detail
                )
            }
        }
    }

    /**
     * Open an extension's popup through the core, wait for `ready`, screenshot, hand the live
     * WebView to `use` (the sheet is dismissed – and its WebView destroyed – right after), and
     * report whether the popup became ready at all.
     */
    private fun popupDemo(id: String, shotName: String, timeoutMs: Long, ready: (WebView) -> Boolean, use: (WebView) -> Unit): Boolean {
        chromeInvoke("extension.openPopup", """{"id":${JSONObject.quote(id)},"anchor":{"x":0,"y":0,"width":0,"height":0}}""")
        val view = waitFor(timeoutMs, 400) {
            val v = popupView()
            if (v != null && ready(v)) v else null
        }
        SystemClock.sleep(1_200)
        shot(shotName)
        val live = popupView()
        val console = live?.console?.let { synchronized(it) { it.toList() } } ?: emptyList()
        results.put("popupConsole-$id", JSONArray(console.takeLast(20)))
        if (live != null) results.put("popupUrl-$id", tabEval(live, "location.href + ' title=' + document.title + ' text=' + (document.body ? document.body.innerText.length : -1)"))
        if (view != null) use(view)
        SystemClock.sleep(800)
        chromeInvoke("extension.closePopup", null)
        SystemClock.sleep(900)
        return view != null
    }

    // --- measurements after the recording -------------------------------------------------------

    private fun measurements() {
        // The price of `with (proxy)` isolation: the same loop in a plain function scope and under
        // a `with` over a proxy with the bootstrap's `has`/`get` traps (median of 5). On the probe
        // page: the benchmark builds functions with `new Function`, which a strict CSP forbids.
        chromeInvoke("tab.activate", """{"tabId":${JSONObject.quote(probeTab)}}""")
        SystemClock.sleep(500)
        val probeView = waitForView(probeTab)
        results.put("withProxyBenchmark", json(tabEval(probeView, WITH_BENCH, 60)))
        // Content-script fetches under a strict page CSP (main-world limitation).
        val cspTab = createTab("$BASE/csp.html")
        val cspView = waitForView(cspTab)
        waitFor(30_000) { if (tabEval(cspView, PROBE_DONE) == "true") true else null }
        results.put("cspPage", json(tabEval(cspView, PROBE_REPORT)))
        chromeInvoke("tab.close", """{"tabId":${JSONObject.quote(cspTab)},"force":true}""")
        instrumentation.runOnMainSync { results.put("lateOnPageStarted", host.extensions.lateOnPageStarted) }

        // Background pages: console output and errors of every extension.
        val backgrounds = JSONObject()
        for (id in listOf(PROBE_ID, DARK_READER, VIMIUM, RYD, STYLUS, UBOL)) {
            var lines: List<String> = emptyList()
            instrumentation.runOnMainSync {
                lines = host.extensions.backgroundView(id)?.console?.let { synchronized(it) { it.toList() } } ?: listOf("(no background view)")
            }
            val errors = lines.count { it.startsWith("ERROR") }
            backgrounds.put(id, JSONObject().put("lines", lines.size).put("errors", errors).put("tail", JSONArray(lines.takeLast(12))))
        }
        results.put("backgrounds", backgrounds)

        // Memory with everything running, then with every extension disabled (backgrounds gone).
        results.put("memoryWithExtensions", meminfo())
        val timingWith = timing(3)
        val ids = listOf(PROBE_ID, DARK_READER, VIMIUM, RYD, STYLUS, UBOL)
        for (id in ids) chromeInvoke("extension.setEnabled", """{"id":${JSONObject.quote(id)},"enabled":false}""")
        waitFor(30_000, 500) { if (scriptUnitsCount() == 0) true else null }
        SystemClock.sleep(3_000)
        results.put("memoryWithoutExtensions", meminfo())
        val timingWithout = timing(3)
        results.put("pageTiming", JSONObject().put("withExtensions", timingWith).put("withoutExtensions", timingWithout))
        for (id in ids) chromeInvoke("extension.setEnabled", """{"id":${JSONObject.quote(id)},"enabled":true}""")
        SystemClock.sleep(3_000)
    }

    /** Reload the probe tab `n` times and report navigation timing plus the bootstrap's own numbers. */
    private fun timing(n: Int): JSONArray {
        val tab = probeTab
        val list = JSONArray()
        repeat(n) {
            chromeInvoke("tab.reload", """{"tabId":${JSONObject.quote(tab)}}""")
            SystemClock.sleep(400)
            val view = waitForView(tab)
            waitFor(30_000) { if (tabEval(view, "document.readyState") == "complete") true else null }
            SystemClock.sleep(800)
            list.put(json(tabEval(view, NAV_TIMING)))
        }
        return list
    }

    private fun meminfo(): JSONObject {
        val text = shell("dumpsys meminfo")
        val result = JSONObject()
        // "Total PSS by process:" block: lines like "    123,456K: process (pid 1234)".
        val section = text.substringAfter("Total PSS by process:", "").substringBefore("Total PSS by OOM adjustment:")
        val processes = JSONObject()
        var appTotalKb = 0L
        for (line in section.lines()) {
            val m = Regex("""^\s*([\d,]+)K:\s+(\S+)\s+\(pid\s+(\d+)""").find(line) ?: continue
            val name = m.groupValues[2]
            if (!name.startsWith(app.packageName) && !name.contains("webview")) continue
            val kb = m.groupValues[1].replace(",", "").toLong()
            processes.put(name, kb)
            appTotalKb += kb
        }
        result.put("processesKb", processes)
        result.put("totalKb", appTotalKb)
        result.put("summary", text.substringAfter("Total RAM:", "").substringBefore("\n").trim())
        return result
    }

    private fun logcat(): JSONArray {
        val text = shell("logcat -d -s ZenExt:I")
        return JSONArray(text.lines().filter { it.contains("configured") || it.contains("rules:") || it.contains("script unit") }.takeLast(20))
    }

    // --- grading ---------------------------------------------------------------------------------

    private fun gradeProbe(probe: JSONObject) {
        val stats = probe.optJSONObject("stats")
        val groups = stats?.optJSONArray("groups") ?: JSONArray()
        val byExt = HashMap<String, MutableList<JSONObject>>()
        for (i in 0 until groups.length()) {
            val g = groups.getJSONObject(i)
            byExt.getOrPut(g.getString("ext")) { ArrayList() }.add(g)
        }
        for ((id, list) in byExt) {
            val errors = list.filter { !it.isNull("error") }
            val startOk = list.filter { it.getString("runAt") == "document_start" }.all { it.optString("readyState") == "loading" }
            stage(
                id, "contentScript",
                if (errors.isEmpty() && startOk) "PASS" else if (errors.size < list.size) "PARTIAL" else "FAIL",
                list.joinToString(" ") { "${it.getString("runAt")}@${it.optDouble("at").toInt()}ms(${it.optString("readyState")},${it.optInt("nodes")} nodes,${it.optDouble("ms").toInt()}ms)" } +
                    errors.joinToString { " error=${it.optString("error")}" }
            )
        }
        for (id in listOf(DARK_READER, VIMIUM, STYLUS)) if (!byExt.containsKey(id)) stage(id, "contentScript", "FAIL", "no group ran on the probe page")
        val idle = probe.optJSONObject("idle") ?: JSONObject()
        val steps = idle.optJSONObject("steps") ?: JSONObject()
        val send = steps.optJSONObject("sendMessage")
        val port = steps.optJSONObject("port")
        stage(PROBE_ID, "messaging", if (send?.optJSONObject("response")?.optBoolean("pong") == true && port?.has("echo") == true) "PASS" else "FAIL", "sendMessage=$send port=$port")
        stage(
            PROBE_ID, "storage",
            if (steps.optString("storage") == "roundtrip-ok" && steps.optString("storageSync") == "ok") "PASS" else "FAIL",
            "local=${steps.optString("storage")} sync=${steps.optString("storageSync")} events=${idle.optJSONArray("storageEvents")}"
        )
        val bg = steps.optJSONObject("bgReport")
        stage(
            PROBE_ID, "coreFunction",
            if (bg != null && bg.optString("installed").isNotEmpty() && bg.optString("alarm").isNotEmpty() && bg.optBoolean("libLoaded")) "PASS" else if (bg != null) "PARTIAL" else "FAIL",
            "background=${bg?.toString()?.take(600)}"
        )
        val page = probe.optJSONObject("page") ?: JSONObject()
        val images = page.optJSONObject("images") ?: JSONObject()
        val ads = images.optString("ads")
        val dyn = images.optString("dyn")
        val ok = images.optString("ok")
        stage(
            PROBE_ID, "declarativeNetRequest",
            when {
                ads == "error" && dyn == "error" && ok == "loaded" -> "PASS"
                ok == "loaded" && (ads == "error" || dyn == "error") -> "PARTIAL"
                else -> "FAIL"
            },
            "static rule (ads=1)=$ads dynamic rule (dyn=1)=$dyn control (ok=1)=$ok"
        )
        results.put(
            "isolation",
            JSONObject()
                .put("pageSeesChrome", page.optString("chrome"))
                .put("pageSeesProbeVar", page.optString("probeVar"))
                .put("pageSeesProbeFn", page.optString("probeFn"))
                .put("pageSeesExpando", page.optString("probeExpando"))
                .put("pageSeesImplicitGlobal", page.optString("implicitLeak"))
                .put("pageSeesBridge", page.optString("bridge"))
                .put("pageZenGlobals", page.optJSONArray("zenGlobals"))
                .put("extensionSeesPageGlobalFree", idle.optString("pageGlobalFree"))
                .put("extensionSeesPageGlobalOnWindow", idle.optString("pageGlobalOnWindow"))
                .put("extensionSeesPagePatch", idle.optBoolean("querySelectorPatched"))
                .put("startGroupVarVisibleAtIdle", idle.optString("probeVarFromStartGroup"))
                .put("startGroupExpandoVisibleAtIdle", idle.optString("probeExpandoFromStartGroup"))
        )
    }

    /**
     * On a WebView with isolated worlds the probe's document expandos (`__zenProbeStart/Idle`)
     * and every extension's bootstrap statistics (`__zenExtStats`) live in their worlds, where
     * `evaluateJavascript` cannot see them. Read them through the reply proxies and merge them into
     * the main-world report, which keeps the page's own view (`window.__page`) and the groups of
     * `world: "MAIN"` declarations.
     */
    private fun mergeWorldReports(view: TabWebView, probe: JSONObject) {
        val perWorld = JSONObject()
        val groups = probe.optJSONObject("stats")?.optJSONArray("groups") ?: JSONArray()
        for (id in listOf(PROBE_ID, DARK_READER, VIMIUM, RYD, STYLUS, UBOL)) {
            val raw = worldEval(view, id, WORLD_REPORT) ?: continue
            val report = json(raw)
            perWorld.put(id, report)
            report.optJSONObject("stats")?.optJSONArray("groups")?.let { for (i in 0 until it.length()) groups.put(it.get(i)) }
            if (id == PROBE_ID) {
                if (!report.isNull("start")) probe.put("start", report.opt("start"))
                if (!report.isNull("idle")) probe.put("idle", report.opt("idle"))
            }
        }
        val stats = probe.optJSONObject("stats") ?: JSONObject().also { probe.put("stats", it) }
        stats.put("groups", groups)
        probe.put("worlds", perWorld)
    }

    private fun stage(id: String, stage: String, verdict: String, detail: String) {
        val ext = stages.optJSONObject(id) ?: JSONObject().also { stages.put(id, it) }
        ext.put(stage, JSONObject().put("verdict", verdict).put("detail", detail))
        Log.i(TAG, "$id $stage $verdict – $detail")
    }

    // --- core access -----------------------------------------------------------------------------

    /** Run a browser-core command in the chrome WebView and return its JSON result. */
    private fun chromeInvoke(name: String, argsJson: String?): String {
        val script = "(function(){window.__demo='__pending__';Promise.resolve(window.zen.invoke(${JSONObject.quote(name)},${argsJson ?: "undefined"}))" +
            ".then(function(v){window.__demo=JSON.stringify(v===undefined?null:v)},function(e){window.__demo=JSON.stringify({__error:String(e&&e.message||e)})})})()"
        var chrome: WebView? = null
        instrumentation.runOnMainSync { chrome = host.chrome }
        val view = chrome ?: error("no chrome")
        tabEval(view, script)
        return waitFor(20_000, 100) {
            val v = tabEval(view, "window.__demo")
            if (v == "__pending__") null else v
        } ?: error("command $name never settled")
    }

    private fun state(): JSONObject = json(chromeInvoke("app.getState", null))

    private fun createTab(url: String): String {
        val raw = chromeInvoke("tab.create", """{"url":${JSONObject.quote(url)},"active":true}""")
        return raw.trim('"')
    }

    /** The id of the first tab whose URL starts with `prefix`, or null. */
    private fun tabIdByUrl(prefix: String): String? {
        val tabs = state().optJSONObject("tabs") ?: return null
        for (tabId in tabs.keys()) {
            if (tabs.optJSONObject(tabId)?.optString("url")?.startsWith(prefix) == true) return tabId
        }
        return null
    }

    private fun waitForView(tabId: String): TabWebView =
        waitFor(15_000, 200) {
            var v: TabWebView? = null
            instrumentation.runOnMainSync { v = host.tabs.get(tabId) }
            v
        } ?: error("no WebView for tab $tabId")

    private fun popupView(): ExtensionWebView? {
        var v: ExtensionWebView? = null
        instrumentation.runOnMainSync { v = host.extensions.popupView() }
        return v
    }

    private fun backgroundView(id: String): ExtensionWebView? {
        var v: ExtensionWebView? = null
        instrumentation.runOnMainSync { v = host.extensions.backgroundView(id) }
        return v
    }

    private fun decisions(): List<String> {
        var list: List<String> = emptyList()
        instrumentation.runOnMainSync { list = synchronized(host.extensions.decisions) { host.extensions.decisions.toList() } }
        return list
    }

    /** Matcher latency from the decision log ("verdict type <micros>us url"): count, median, p90, max. */
    private fun decisionMicros(all: List<String>): JSONObject {
        val micros = all.mapNotNull { line -> line.split(' ').getOrNull(2)?.removeSuffix("us")?.toLongOrNull() }.sorted()
        if (micros.isEmpty()) return JSONObject().put("count", 0)
        return JSONObject()
            .put("count", micros.size)
            .put("medianUs", micros[micros.size / 2])
            .put("p90Us", micros[(micros.size * 9) / 10])
            .put("maxUs", micros.last())
            .put("firstUs", all.firstOrNull()?.split(' ')?.getOrNull(2))
    }

    /**
     * Tabs whose document is an extension page (Return YouTube Dislike opens its changelog on
     * install): does the page render, and does it have `chrome.runtime`?
     */
    private fun extensionTabPages(): JSONArray {
        val list = JSONArray()
        val tabs = state().optJSONObject("tabs") ?: JSONObject()
        for (tabId in tabs.keys()) {
            val tab = tabs.optJSONObject(tabId) ?: continue
            val url = tab.optString("url")
            if (!url.contains(".ext.zenium.invalid/")) continue
            var view: TabWebView? = null
            instrumentation.runOnMainSync { view = host.tabs.get(tabId) }
            val v = view
            val entry = JSONObject().put("tabId", tabId).put("url", url)
            if (v != null) {
                entry.put(
                    "page",
                    json(
                        tabEval(
                            v,
                            "JSON.stringify({title: document.title, text: document.body ? document.body.innerText.length : -1, " +
                                "runtimeId: (typeof chrome === 'object' && chrome.runtime) ? chrome.runtime.id : null, readyState: document.readyState})"
                        )
                    )
                )
            }
            list.put(entry)
        }
        return list
    }

    private fun consoleOf(view: TabWebView): List<String> {
        var list: List<String> = emptyList()
        instrumentation.runOnMainSync { list = synchronized(view.console) { view.console.toList() } }
        return list
    }

    private fun scriptUnitsCount(): Int {
        var n = 0
        instrumentation.runOnMainSync { n = host.extensions.scriptUnits().size }
        return n
    }

    private fun scriptUnits(): JSONArray {
        val list = JSONArray()
        instrumentation.runOnMainSync {
            for (unit in host.extensions.scriptUnits())
                list.put(JSONObject().put("origins", JSONArray(unit.origins.toList())).put("chars", unit.script.length).put("world", unit.world))
        }
        return list
    }

    /** `evaluateJavascript` on the main thread; JSON strings are decoded to their text. */
    private fun tabEval(view: WebView, script: String, timeoutSeconds: Long = 10): String {
        val latch = CountDownLatch(1)
        var value = "null"
        instrumentation.runOnMainSync {
            view.evaluateJavascript(script) { raw ->
                value = raw?.let { if (it.startsWith("\"")) runCatching { JSONObject("{\"v\":$it}").getString("v") }.getOrDefault(it) else it } ?: "null"
                latch.countDown()
            }
        }
        latch.await(timeoutSeconds, TimeUnit.SECONDS)
        return value
    }

    /**
     * `script` in `ext`'s isolated world on `view` through its reply proxy (main thread); null when
     * the extension has no world endpoint in that frame. Decodes JSON strings like [tabEval].
     */
    private fun worldEval(view: WebView, ext: String, script: String, timeoutSeconds: Long = 10): String? {
        val latch = CountDownLatch(1)
        var value: String? = null
        instrumentation.runOnMainSync {
            host.extensions.evalInWorld(view, ext, script) { raw ->
                value = raw?.let { if (it.startsWith("\"")) runCatching { JSONObject("{\"v\":$it}").getString("v") }.getOrDefault(it) else it }
                latch.countDown()
            }
        }
        latch.await(timeoutSeconds, TimeUnit.SECONDS)
        return value
    }

    private fun json(text: String): JSONObject = runCatching { JSONObject(text) }.getOrElse { JSONObject().put("raw", text) }

    private fun <T> waitFor(timeoutMs: Long, pollMs: Long = 250, probe: () -> T?): T? {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            val v = probe()
            if (v != null) return v
            SystemClock.sleep(pollMs)
        }
        return null
    }

    private fun shell(command: String): String {
        val fd: ParcelFileDescriptor = ui.executeShellCommand(command)
        return ParcelFileDescriptor.AutoCloseInputStream(fd).bufferedReader().use { it.readText() }
    }

    // --- input and pictures ----------------------------------------------------------------------

    private fun shot(name: String) {
        val bitmap = ui.takeScreenshot() ?: return
        File(out, "ext-android-prototype-$name.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
        bitmap.recycle()
    }

    private fun tap(x: Float, y: Float) {
        val down = SystemClock.uptimeMillis()
        inject(MotionEvent.ACTION_DOWN, down, down, x, y)
        SystemClock.sleep(60)
        inject(MotionEvent.ACTION_UP, down, SystemClock.uptimeMillis(), x, y)
    }

    private fun inject(action: Int, downTime: Long, eventTime: Long, x: Float, y: Float) {
        val properties = MotionEvent.PointerProperties().apply { id = 0; toolType = MotionEvent.TOOL_TYPE_FINGER }
        val coords = MotionEvent.PointerCoords().apply { this.x = x; this.y = y; pressure = 1f; size = 1f }
        val event = MotionEvent.obtain(downTime, eventTime, action, 1, arrayOf(properties), arrayOf(coords), 0, 0, 1f, 1f, 0, 0, InputDevice.SOURCE_TOUCHSCREEN, 0)
        try {
            ui.injectInputEvent(event, true)
        } finally {
            event.recycle()
        }
    }

    private fun key(code: Int) {
        val now = SystemClock.uptimeMillis()
        ui.injectInputEvent(KeyEvent(now, now, KeyEvent.ACTION_DOWN, code, 0), true)
        ui.injectInputEvent(KeyEvent(now, SystemClock.uptimeMillis(), KeyEvent.ACTION_UP, code, 0), true)
    }

    private fun findByLabel(label: String): Rect? {
        val root = ui.rootInActiveWindow ?: return null
        val queue = ArrayDeque<AccessibilityNodeInfo>()
        queue.add(root)
        var visited = 0
        while (queue.isNotEmpty() && visited < 6_000) {
            val node = queue.removeFirst()
            visited++
            if (node.contentDescription?.toString() == label || node.text?.toString() == label) return Rect().also { node.getBoundsInScreen(it) }
            for (i in 0 until node.childCount) node.getChild(i)?.let(queue::add)
        }
        if (visited == 0) ui.performGlobalAction(AccessibilityService.GLOBAL_ACTION_BACK)
        return null
    }

    companion object {
        private const val TAG = "ExtensionDemo"
        private const val BASE = "http://10.0.2.2:8765"
        const val PROBE_ID = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        const val DARK_READER = "eimadpbcbfnmbkopoojfekhnkhdbieeh"
        const val VIMIUM = "dbepggeogbaibhgnhhndojpepiihcmeb"
        const val RYD = "gebbhagfogifgggkldgodflihgfeippi"
        const val STYLUS = "clngdbkpkpeebahjckkjfobafhncgmne"
        const val UBOL = "ddkjiahejlhfcafbddmgiahcphecmpfh"

        private const val PROBE_DONE = "String(document.documentElement.getAttribute('data-zen-probe-done') === '1')"
        private const val PROBE_REPORT =
            "JSON.stringify({start: document.__zenProbeStart || null, idle: document.__zenProbeIdle || null, page: window.__page || null, stats: window.__zenExtStats || null, readyState: document.readyState, url: location.href})"
        /** What one extension's world sees: the probe's document expandos, the bootstrap's stats, and the world/page boundary. */
        private const val WORLD_REPORT =
            "JSON.stringify({start: document.__zenProbeStart || null, idle: document.__zenProbeIdle || null, stats: window.__zenExtStats || null, " +
                "pageGlobal: typeof pageGlobal, page: typeof window.__page, chrome: typeof chrome, runtimeId: (typeof chrome === 'object' && chrome && chrome.runtime) ? chrome.runtime.id : null})"
        private const val DARK_READER_REPORT =
            "JSON.stringify({mode: document.documentElement.getAttribute('data-darkreader-mode'), scheme: document.documentElement.getAttribute('data-darkreader-scheme'), " +
                "styles: document.querySelectorAll('style.darkreader, style[class*=darkreader], link.darkreader').length, bodyBackground: getComputedStyle(document.body).backgroundColor, " +
                "htmlBackground: getComputedStyle(document.documentElement).backgroundColor, color: getComputedStyle(document.body).color, " +
                // Root-cause evidence for the same-realm failure: Dark Reader's MAIN-world proxy.js
                // replaces Document.prototype.styleSheets with a list that hides its own sheets; its
                // dark-theme detector (isolated world in Chrome) disables those sheets through that
                // getter before sampling colours. In one realm the getter is the patched one.
                "styleSheetsGetterNative: /native code/.test(String((Object.getOwnPropertyDescriptor(Document.prototype, 'styleSheets') || {}).get)), " +
                "drSheetsVisible: Array.prototype.filter.call(document.styleSheets, function (s) { return s.ownerNode && s.ownerNode.classList && s.ownerNode.classList.contains('darkreader') }).length, " +
                "colorScheme: getComputedStyle(document.documentElement).colorScheme, wasEnabledForHost: sessionStorage.getItem('__darkreader__wasEnabledForHost')})"
        private const val VIMIUM_REPORT =
            "(function(){var n=document.querySelectorAll('.vimiumHintMarker').length,roots=0;document.querySelectorAll('*').forEach(function(el){if(el.shadowRoot){roots++;n+=el.shadowRoot.querySelectorAll('.vimiumHintMarker').length}});" +
                "return JSON.stringify({hints:n,shadowRoots:roots,ui:document.querySelectorAll('.vimiumUIComponent,iframe[src*=\"vimium\"],[class*=\"vimium\"]').length})})()"
        private const val RYD_REPORT =
            "JSON.stringify({elements: document.querySelectorAll('[id*=\"return-youtube-dislike\"],[class*=\"ryd-\"],#ryd-dislike-text').length, " +
                "apiEntries: performance.getEntriesByType('resource').filter(function(e){return e.name.indexOf('returnyoutubedislike')>=0}).map(function(e){return {name:e.name,size:e.transferSize,duration:Math.round(e.duration)}}), " +
                "groups: (window.__zenExtStats && window.__zenExtStats.groups ? window.__zenExtStats.groups.length : 0), stats: window.__zenExtStats || null, readyState: document.readyState, title: document.title, url: location.href})"
        private const val NAV_TIMING =
            "(function(){var n=performance.getEntriesByType('navigation')[0]||{};var s=window.__zenExtStats||{};return JSON.stringify({responseEnd:Math.round(n.responseEnd||0),domContentLoaded:Math.round(n.domContentLoadedEventEnd||0),load:Math.round(n.loadEventEnd||0),bootMs:s.bootMs||0,matchMs:s.matchMs||0,applied:s.applied||0})})()"
        private val WITH_BENCH = """
            (function () {
              var N = 300000;
              function plain() { var s = 0; for (var i = 0; i < N; i++) { s += Math.floor(i * 1.5) + (document.body ? 1 : 0); } return s; }
              var builtins = new Set(); var o = window;
              while (o) { Reflect.ownKeys(o).forEach(function (k) { builtins.add(k); }); o = Object.getPrototypeOf(o); }
              var store = Object.create(null);
              var proxy = new Proxy(Object.create(null), {
                has: function (t, k) { return (k in store) || builtins.has(k); },
                get: function (t, k) { if (k in store) return store[k]; if (!builtins.has(k)) return undefined; var v = window[k]; return typeof v === 'function' ? v.bind(window) : v; }
              });
              var withFn = new Function('window', 'N', 'with (window) { var s = 0; for (var i = 0; i < N; i++) { s += Math.floor(i * 1.5) + (document.body ? 1 : 0); } return s; }');
              var domPlain = function () { var n = 0; for (var i = 0; i < 20000; i++) { n += document.querySelectorAll('p').length; } return n; };
              var domWith = new Function('window', 'with (window) { var n = 0; for (var i = 0; i < 20000; i++) { n += document.querySelectorAll(\'p\').length; } return n; }');
              function time(f) { var t = performance.now(); f(); return performance.now() - t; }
              plain(); withFn(proxy, N); domPlain(); domWith(proxy);
              var p = [], w = [], dp = [], dw = [];
              for (var r = 0; r < 5; r++) { p.push(time(plain)); w.push(time(function () { withFn(proxy, N); })); dp.push(time(domPlain)); dw.push(time(function () { domWith(proxy); })); }
              var med = function (a) { a.sort(function (x, y) { return x - y; }); return a[2]; };
              return JSON.stringify({
                iterations: N, plainMs: +med(p).toFixed(2), withProxyMs: +med(w).toFixed(2), slowdown: +(med(w) / med(p)).toFixed(1),
                domIterations: 20000, domPlainMs: +med(dp).toFixed(2), domWithProxyMs: +med(dw).toFixed(2), domSlowdown: +(med(dw) / med(dp)).toFixed(2)
              });
            })()
        """.trimIndent()
    }
}
