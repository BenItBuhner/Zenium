package app.zen.chromium

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.AccessibilityServiceInfo
import android.app.UiAutomation
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Rect
import android.net.Uri
import android.os.ParcelFileDescriptor
import android.os.SystemClock
import android.util.Log
import android.view.InputDevice
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.View
import android.view.accessibility.AccessibilityNodeInfo
import android.webkit.WebView
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.webkit.WebViewCompat
import app.zen.chromium.blocking.Request
import app.zen.chromium.blocking.ResourceType
import app.zen.chromium.blocking.RuleSetInfo
import app.zen.chromium.ext.ExtensionFiles
import app.zen.chromium.ext.ExtensionNotifications
import app.zen.chromium.ext.ExtensionUrls
import app.zen.chromium.ext.ExtensionWebView
import app.zen.chromium.ext.NavigationReports
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlin.math.abs

/**
 * Drives the extension runtime on an emulator for the `android-ext-runtime-demo` workflow: the
 * workflow pushes the unpacked demo extensions into `files/zen/extensions/`, this driver lays them
 * out as store installs with a registry (see [seed]), adds the probe extension from its assets,
 * seeds a one-tab profile on the local probe page, launches the app and then records, per
 * extension and per stage, what worked:
 *
 *  - load (the core parsed the manifest and configured it),
 *  - content script (ran, at the right `run_at`, without throwing),
 *  - messaging and storage (round trips through the shim, the bridge and the background host),
 *  - popup (the bottom sheet loaded the extension's page and its scripts ran),
 *  - core function (the page went dark, link hints appeared, ad requests were blocked, …),
 *  - the W2-2 surfaces on the probe: the popup sheet at the extension's own size, the options
 *    sheet, its `contextMenus` items in a link's long-press menu, a notification on the shade,
 *    an `identity.launchWebAuthFlow` in the auth sheet; then the CORS proxy (Dark Reader's
 *    Google image fetch is the acceptance case), `cookies`, `captureVisibleTab` and the
 *    `webNavigation` events of the run.
 *
 * The visible part runs while the workflow records the screen (same `record` / `recording` /
 * `done` handshake as the gesture demo); measurements without a picture come after. Everything
 * lands in `files/ext-demo/results.json` and `ext-android-runtime-*.png`.
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
        // Windows other than the app's (the notification shade) are only listed with this flag.
        runCatching {
            ui.serviceInfo = ui.serviceInfo.apply { flags = flags or AccessibilityServiceInfo.FLAG_RETRIEVE_INTERACTIVE_WINDOWS }
        }
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

    /**
     * The store attaches every enabled record on start and the runtime configures it. The demo
     * waits until every seeded extension is listed by the core, configured in Kotlin (its units
     * and served files installed) and has its background running: what the recording shows
     * afterwards is the extensions at work, not their start-up (Return YouTube Dislike's
     * `onInstalled` opens a changelog tab, which used to land in the middle of the probe step).
     */
    private fun waitForExtensions(): JSONArray {
        val seeded = results.getJSONObject("seededInstalls").keys().asSequence().toList()
        var list = JSONArray()
        val started = SystemClock.uptimeMillis()
        val everyOne = waitFor(150_000, 1_000) {
            val state = state()
            list = state.optJSONArray("extensions") ?: JSONArray()
            val listed = HashMap<String, JSONObject>()
            for (i in 0 until list.length()) list.getJSONObject(i).let { listed[it.getString("id")] = it }
            var configured: Set<String> = emptySet()
            instrumentation.runOnMainSync { configured = host.extensions.configureStats.keys.toSet() }
            val pending = seeded.filter { id ->
                val entry = listed[id]
                // A load error is final; anything else is still on its way.
                entry == null || (entry.isNull("error") && (id !in configured || backgroundView(id) == null))
            }
            if (pending.isEmpty()) true else null
        }
        results.put("configureMs", SystemClock.uptimeMillis() - started)
        results.put("everyExtensionUp", everyOne == true)
        // Backgrounds act on their start (`onInstalled`: tabs, storage); let the tab list settle.
        settleTabs()
        // Rules and background pages come after the units. The probe's background adds its dynamic
        // rule on startup and `updateDynamicRules` resolves once Kotlin has the compiled rule set
        // (Chrome semantics); the dyn=1 pixel of the probe page is graded against that rule, so
        // the demo waits for the background to report it instead of a fixed grace period (on a
        // slow runner the rule set came 16 s after the units and the pixel had loaded before it).
        val rulesStarted = SystemClock.uptimeMillis()
        val dynamicReady = waitFor(90_000, 500) {
            val bg = backgroundView(PROBE_ID) ?: return@waitFor null
            if (tabEval(bg, "String(typeof report === 'object' && report.dynamicRules >= 1 && report.sessionRules >= 1)") == "true") true else null
        }
        results.put("dynamicRuleReadyMs", if (dynamicReady == true) SystemClock.uptimeMillis() - rulesStarted else -1)
        // W2-3: the rules reach the request path when the engine has compiled the index the
        // core's translator wrote; wait for that snapshot (a build per index write, debounced).
        val engineReady = waitFor(30_000, 250) {
            var ready = false
            instrumentation.runOnMainSync {
                ready = host.blocking.snapshot.ruleSets.any { it.id.startsWith("ext:$PROBE_ID:") && it.id.endsWith(":_session") }
            }
            if (ready) true else null
        }
        results.put("engineRulesReadyMs", if (engineReady == true) SystemClock.uptimeMillis() - rulesStarted else -1)
        SystemClock.sleep(2_000)
        for (i in 0 until list.length()) {
            val ext = list.getJSONObject(i)
            stage(ext.getString("id"), "load", if (ext.isNull("error")) "PASS" else "FAIL", if (ext.isNull("error")) ext.optString("name") else ext.optString("error"))
        }
        return list
    }

    /** Wait until the number of tabs has stayed the same for two seconds (at most fifteen). */
    private fun settleTabs() {
        var last = -1
        var since = SystemClock.uptimeMillis()
        val deadline = since + 15_000
        while (SystemClock.uptimeMillis() < deadline) {
            val count = state().optJSONObject("tabs")?.length() ?: 0
            if (count != last) {
                last = count
                since = SystemClock.uptimeMillis()
            } else if (SystemClock.uptimeMillis() - since >= 2_000) return
            SystemClock.sleep(500)
        }
    }

    /**
     * Make a tab the visible one and wait until the core reports it active: input injected
     * afterwards (taps, keys) reaches its WebView and not whatever an extension opened meanwhile.
     */
    private fun showTab(tabId: String) {
        chromeInvoke("tab.activate", """{"tabId":${JSONObject.quote(tabId)}}""")
        waitFor(10_000, 200) { if (activeTabId() == tabId) true else null }
        SystemClock.sleep(600)
    }

    /** The toolbar action of an extension for the active tab (`ExtensionInfo.action`), as the core lists it. */
    private fun extensionAction(id: String): JSONObject? {
        val list = state().optJSONArray("extensions") ?: return null
        for (i in 0 until list.length()) {
            val ext = list.optJSONObject(i) ?: continue
            if (ext.optString("id") == id) return ext.optJSONObject("action")
        }
        return null
    }

    /** The active tab of the window's active space, as the core's snapshot reports it. */
    private fun activeTabId(): String? {
        val snapshot = state()
        val spaceId = snapshot.optString("activeSpaceId")
        val spaces = snapshot.optJSONArray("spaces") ?: return null
        for (i in 0 until spaces.length()) {
            val space = spaces.getJSONObject(i)
            if (space.optString("id") != spaceId) continue
            return if (space.isNull("activeTabId")) null else space.optString("activeTabId")
        }
        return null
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
        showTab(probeTab)
        chromeInvoke("tab.reload", """{"tabId":${JSONObject.quote(probeTab)}}""")
        val probeView = waitForView(probeTab)
        waitFor(30_000) { if (tabEval(probeView, PROBE_DONE) == "true") true else null }
        SystemClock.sleep(2_500)
        results.put("activeTabAtProbe", activeTabId() == probeTab)
        shot("01-probe-page-dark-reader")
        val probe = json(tabEval(probeView, PROBE_REPORT))
        if (worlds) mergeWorldReports(probeView, probe)
        results.put("probePage", probe)
        gradeProbe(probe)
        matchedRules()
        val dark = json(tabEval(probeView, DARK_READER_REPORT))
        results.put("darkReader", dark)
        val darkApplied = dark.optInt("styles") > 0 && dark.optString("bodyBackground") != "rgb(255, 255, 255)"
        // One realm (no isolated worlds): Dark Reader's own `world: "MAIN"` proxy.js hides its
        // sheets from `document.styleSheets`, its detector in the same realm cannot disable them
        // before sampling, reads its own dark colour scheme as the page's and removes the theme.
        val oneRealm = !worlds && !darkApplied && dark.optString("wasEnabledForHost") == "false"
        stage(
            DARK_READER, "coreFunction",
            if (darkApplied) "PASS" else "FAIL",
            "styles=${dark.optInt("styles")} mode=${dark.optString("mode")} body=${dark.optString("bodyBackground")} " +
                "styleSheetsGetter=${if (dark.optBoolean("styleSheetsGetterNative")) "native" else "patched by its proxy.js"} " +
                "drSheetsVisible=${dark.optInt("drSheetsVisible")} wasEnabledForHost=${dark.optString("wasEnabledForHost")}" +
                if (oneRealm) " (one realm below Chromium 146: its proxy.js hides its sheets from its own detector, which takes the theme for the page's and removes it)" else ""
        )

        // 2. Vimium: focus the page, press f, expect link hints. The page records the key events
        // it sees (Vimium listens on the window in its own world) so a miss can be told apart:
        // the key never reached the page, or Vimium ignored it. The focusing tap lands on the
        // heading, which is not a link: a tap at a fixed fraction of the screen hit a link once
        // the page's layout moved and the tab left for Wikipedia under every later stage.
        showTab(probeTab)
        tabEval(probeView, KEY_RECORDER)
        val heading = screenPoint(probeView, json(tabEval(probeView, ELEMENT_CENTRE.replace("%SELECTOR%", "h1"))))
        tap(heading?.first ?: (width / 2f), heading?.second ?: (height * 0.42f))
        SystemClock.sleep(600)
        key(KeyEvent.KEYCODE_F)
        SystemClock.sleep(1_800)
        shot("02-vimium-hints")
        val vimium = json(tabEval(probeView, VIMIUM_REPORT))
        vimium.put("pageKeys", json(tabEval(probeView, "JSON.stringify(window.__keys || null)")))
        vimium.put("activeTab", activeTabId() == probeTab)
        if (worlds) worldEval(probeView, VIMIUM, VIMIUM_WORLD_REPORT)?.let { vimium.put("world", json(it)) }
        results.put("vimium", vimium)
        stage(VIMIUM, "coreFunction", if (vimium.optInt("hints") > 0) "PASS" else "FAIL", "hints=${vimium.optInt("hints")} ui=${vimium.optInt("ui")}")
        key(KeyEvent.KEYCODE_ESCAPE)
        SystemClock.sleep(800)

        // 3. The probe's popup: tabs, storage, messaging and executeScript from the page context.
        // The probe page is made the active tab first: Return YouTube Dislike opens its changelog
        // as a tab on install, and `executeScript` targets the active tab.
        showTab(probeTab)
        results.put("extensionTabPages", extensionTabPages())
        val probePopupReady = popupDemo(PROBE_ID, "03-probe-popup", 45_000, { view -> tabEval(view, "document.title") == "probe-popup-ready" }) { view ->
            val report = json(tabEval(view, "JSON.stringify(window.__popupReport || null)"))
            results.put("probePopup", report)
            val steps = report.optJSONObject("steps") ?: JSONObject()
            stage(PROBE_ID, "popup", if (steps.has("activeTab") && steps.optJSONObject("background") != null) "PASS" else "PARTIAL", steps.toString().take(600))
            popupSheetSize(view)
        }
        if (!probePopupReady) stage(PROBE_ID, "popup", "FAIL", "popup never reported ready")

        // 4. Dark Reader's popup.
        val darkPopup = popupDemo(DARK_READER, "04-dark-reader-popup", 45_000, { view -> tabEval(view, "String(document.body && document.body.innerText.length > 40)") == "true" }) { view ->
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
        instrumentation.runOnMainSync {
            results.put("ruleSets", host.extensions.ruleSetStats())
            results.put("engine", host.blocking.stats())
        }
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
        // W2-3: the engine's decisions feed the action count. uBOL turns the badge on at startup
        // (`setExtensionActionOptions({ displayActionCountAsBadgeText: true })`), so the toolbar
        // action of the active tab, as the core lists it, carries the number of requests its
        // rules stopped on the ads page: one per tracker, and no more than the decisions taken.
        val badge = waitFor(10_000, 250) {
            val text = extensionAction(UBOL)?.optString("badgeText") ?: ""
            if ((text.toIntOrNull() ?: 0) >= stopped && stopped > 0) text else null
        } ?: (extensionAction(UBOL)?.optString("badgeText") ?: "")
        val badgeCount = badge.toIntOrNull() ?: 0
        val blockedDecisions = all.count { it.startsWith("block ") || it.startsWith("redirect ") }
        results.put("ubolBadge", JSONObject().put("badgeText", badge).put("stoppedTrackers", stopped).put("blockingDecisions", blockedDecisions))
        stage(
            UBOL, "badgeCount",
            when {
                stopped > 0 && badgeCount >= stopped && badgeCount <= blockedDecisions -> "PASS"
                badgeCount > 0 -> "PARTIAL"
                else -> "FAIL"
            },
            "badge=\"$badge\" trackers stopped=$stopped blocking decisions in the log=$blockedDecisions"
        )
        // W2-3: decision latency is what `EngineSnapshot.decide` took per request (the observer's
        // elapsed time), over every decision the log holds up to here: uBOL's ~18.5k enabled rules
        // plus the probe's and the default lists. The provisional matcher (`NetRules.kt`) measured
        // an 18–54 ms p90 on the same page; the engine-level target is single-digit milliseconds.
        val micros = results.optJSONObject("decisionMicros") ?: JSONObject()
        val p90Us = micros.optLong("p90Us", -1)
        // The wall-clock figure on an emulator's IO thread includes its scheduling and collection
        // pauses; the CPU figure is the matcher's own cost.
        val cpu = micros.optJSONObject("cpu")
        val cpuNote = if (cpu == null) "" else " cpu: median=${cpu.optLong("medianUs")}us p90=${cpu.optLong("p90Us")}us max=${cpu.optLong("maxUs")}us"
        stage(
            UBOL, "decisionLatency",
            when {
                p90Us < 0 -> "FAIL"
                p90Us < 10_000 -> "PASS"
                p90Us < 18_000 -> "PARTIAL"
                else -> "FAIL"
            },
            "n=${micros.optInt("count")} median=${micros.optLong("medianUs")}us p90=${p90Us}us max=${micros.optLong("maxUs")}us$cpuNote (provisional matcher p90: 18–54 ms)"
        )
        val ubolPopup = popupDemo(UBOL, "06-ubol-popup", 45_000, { view -> tabEval(view, "String(document.body && document.body.innerText.length > 20)") == "true" }) { view ->
            stage(UBOL, "popup", "PASS", tabEval(view, "document.body.innerText.slice(0, 200)").take(120))
        }
        if (!ubolPopup) stage(UBOL, "popup", "FAIL", "popup document stayed empty")

        // 6. Stylus: the popup for the probe page (no styles installed: the empty state).
        showTab(probeTab)
        SystemClock.sleep(900)
        val stylusPopup = popupDemo(STYLUS, "07-stylus-popup", 45_000, { view -> tabEval(view, "String(document.body && document.body.innerText.length > 20)") == "true" }) { view ->
            stage(STYLUS, "popup", "PASS", tabEval(view, "document.body.innerText.slice(0, 200)").take(120))
        }
        if (!stylusPopup) stage(STYLUS, "popup", "FAIL", "popup document stayed empty")

        // 7-10. W2-2 surfaces on the probe: its options sheet, its items in the long-press menu of
        // a link, a notification on the shade, and an identity flow in the auth sheet.
        showTab(probeTab)
        optionsSheet()
        contextMenu(probeView)
        notification()
        authSheet()

        // 11. Return YouTube Dislike on a real watch page (network permitting). m.youtube.com
        // renders the like/dislike bar the extension decorates well after `load`, from its
        // scripts, and the software-rendered emulator spends its CPU on decoding the video in the
        // meantime (measured: the bar was there 10 s after load while the video was blocked, not
        // after 13 s with it playing; pausing the player is no help, m.youtube.com answers a pause
        // with its "Watch in YouTube app" dialog over the page; the dialog also comes up on its
        // own now and then, pausing the video, and the extension writes nothing while it is up,
        // so the driver closes it from the page when it sees it). The driver waits for the bar
        // and then gives the extension 30 s to decorate it; its own DOM ends the wait.
        val ytStarted = SystemClock.uptimeMillis()
        val ytTab = createTab("https://www.youtube.com/watch?v=dQw4w9WgXcQ")
        val ytView = waitForView(ytTab)
        var barSeenAt = 0L
        var upsellsClosed = 0
        waitFor(90_000, 1_000) {
            val report = json(tabEval(ytView, RYD_REPORT))
            if (barSeenAt == 0L && report.optString("actionBar").isNotEmpty()) barSeenAt = SystemClock.uptimeMillis()
            if (report.optInt("dialogs") > 0 && tabEval(ytView, YT_CLOSE_UPSELL) == "closed") upsellsClosed++
            when {
                rydDecorated(report) -> true
                barSeenAt != 0L && SystemClock.uptimeMillis() - barSeenAt > 30_000 -> true
                else -> null
            }
        }
        SystemClock.sleep(1_500)
        shot("11-ryd-youtube")
        val ryd = json(tabEval(ytView, RYD_REPORT))
        ryd.put("upsellsClosed", upsellsClosed)
        // On a WebView with worlds the extension's bootstrap statistics live in its world.
        val rydWorld = if (worlds) worldEval(ytView, RYD, WORLD_REPORT)?.let(::json) else null
        val worldGroups = rydWorld?.optJSONObject("stats")?.optJSONArray("groups")?.length() ?: 0
        val groups = ryd.optInt("groups") + worldGroups
        ryd.put("groups", groups)
        if (rydWorld != null) ryd.put("world", rydWorld)
        // The extension's content script fetches its API from the page's origin, as in Chrome, so
        // the answer needs `Access-Control-Allow-Origin`. The same request from the emulator's
        // own stack tells a network that answers the runner without it (Cloudflare challenging
        // the runner's address) from a WebView that lost the header.
        val apiProbe = probeCors("https://returnyoutubedislikeapi.com/configs/selectors", "https://m.youtube.com")
        ryd.put("apiProbe", apiProbe)
        // What the request engine itself makes of that fetch from the watch page (a `fetch` of
        // unknown type, as WebView hands it over): a blocked answer has no CORS header either,
        // and looked, from the page's console alone, exactly like a network refusing the runner.
        val apiVerdict = engineVerdict(apiProbe.optString("url"), ryd.optString("url").ifEmpty { "https://m.youtube.com/watch?v=dQw4w9WgXcQ" })
        ryd.put("apiEngineVerdict", apiVerdict)
        results.put("returnYouTubeDislike", ryd)
        val youtubeConsole = consoleOf(ytView)
        results.put("youtubeConsole", JSONArray(youtubeConsole))
        val api = ryd.optJSONArray("apiEntries")?.length() ?: 0
        val apiWithoutCors = apiProbe.has("status") && apiProbe.isNull("allowOrigin")
        // Google answers a runner's address with a CAPTCHA now and then (www.google.com/sorry):
        // no watch page, so nothing of the extension's to grade. The Trusted Types check has a
        // page of the run's own in the measurements (`trustedTypesPage`).
        val ytUrl = ryd.optString("url")
        val ytHost = runCatching { Uri.parse(ytUrl).host ?: "" }.getOrDefault("")
        val onYouTube = ytHost == "youtube.com" || ytHost.endsWith(".youtube.com")
        val offSite = "network: the tab landed on $ytHost, not a watch page (Google served the runner a CAPTCHA)"
        stage(RYD, "contentScript", if (!onYouTube) "N/A" else if (groups > 0) "PASS" else "FAIL", if (!onYouTube) offSite else "groups=$groups readyState=${ryd.optString("readyState")} url=$ytUrl")
        // A phone WebView lands on m.youtube.com, whose CSP requires Trusted Types for script
        // sinks: the page's own realm refuses a plain `script.textContent`, the extension's own
        // code takes it through the bootstrap's pass-through policy (the shield): in its isolated
        // world outright, in the with-fallback as the retry the page's sinks grant its frames.
        val pageSink = tabEval(ytView, TT_SINK_PROBE)
        val worldSink = if (worlds) worldEval(ytView, RYD, TT_SINK_PROBE) else null
        val extensionSink = if (onYouTube) extEval(ytTab, RYD, TT_SINK_PROBE) else "n/a"
        val shield = if (worlds) rydWorld?.optJSONObject("stats")?.optJSONObject("trustedTypes")
        else tabEval(ytView, "JSON.stringify((window.__zenExtStats || {}).trustedTypes || null)").let { if (it == "null") null else json(it) }
        results.put(
            "trustedTypes",
            JSONObject().put("url", ytUrl).put("pageSink", pageSink).put("worldSink", worldSink ?: JSONObject.NULL)
                .put("extensionSink", extensionSink).put("shield", shield ?: JSONObject.NULL)
        )
        stage(
            RYD, "trustedTypes",
            when {
                !onYouTube -> "N/A"
                shield?.optBoolean("policy") == true && extensionSink == "ok" -> "PASS"
                shield != null || extensionSink == "ok" -> "PARTIAL"
                else -> "FAIL"
            },
            when {
                !onYouTube -> offSite
                !worlds -> "page sink=$pageSink extension sink=$extensionSink shield=$shield (one realm: the page's sinks retry a refused string for the extension's frames)"
                else -> "page sink=$pageSink world sink=$worldSink extension sink=$extensionSink shield=$shield"
            }
        )
        // The API answered the emulator's own request without a CORS header (a Cloudflare
        // challenge to the runner's address): the extension's fetch fails in Chrome as well, so
        // there is no core function to grade until the network lets the runner through.
        val apiRefused = "network: ${apiProbe.optString("url")} answered the emulator with status ${apiProbe.optInt("status")} and no Access-Control-Allow-Origin" +
            " (cf-mitigated=${apiProbe.optString("cfMitigated", "null")}, server=${apiProbe.optString("server", "null")})"
        val engineLine = "engine=${apiVerdict.optString("action")}" +
            (apiVerdict.optString("filter").takeIf { it.isNotEmpty() && it != "null" }?.let { " by $it" } ?: "") +
            (apiVerdict.optString("set").takeIf { it.isNotEmpty() && it != "null" }?.let { " ($it)" } ?: "")
        // The page never rendered the bar the extension decorates: nothing of the extension's
        // was exercised. The detail carries the page's state (its own console is in
        // `youtubeConsole`) so a page broken by the runtime would not pass as a slow one.
        val actionBar = ryd.optString("actionBar")
        val decorated = rydDecorated(ryd)
        val noBar = "YouTube's watch page had not rendered its like/dislike bar ${(SystemClock.uptimeMillis() - ytStarted) / 1000} s after the navigation" +
            " (readyState=${ryd.optString("readyState")}, title=${JSONObject.quote(ryd.optString("title"))}, video=${ryd.optString("video")}, dialogs=${ryd.optInt("dialogs")});" +
            " nothing for the extension to decorate"
        // In one realm the page's Trusted Types policy applies to the content script: its page-world
        // helper is a `<script src=chrome.runtime.getURL(...)>` and the `src` assignment throws
        // (`TrustedScriptURL`), which rejects the promise the script awaits before it looks for the
        // buttons. The extension's API request before that point goes through; the DOM is never
        // decorated. In a world the bootstrap's policy takes the assignment (the trustedTypes stage).
        val oneRealmScriptUrl = !worlds && youtubeConsole.any { it.contains("TrustedScriptURL") }
        stage(
            RYD, "coreFunction",
            when {
                !onYouTube -> "N/A"
                decorated -> "PASS"
                apiWithoutCors -> "N/A"
                actionBar.isEmpty() -> "N/A"
                api > 0 -> "PARTIAL"
                else -> "FAIL"
            },
            when {
                !onYouTube -> offSite
                !decorated && apiWithoutCors -> apiRefused
                !decorated && actionBar.isEmpty() -> noBar
                else -> "api requests seen by the page=$api, extension elements=${ryd.optInt("elements")}, dislike text=${JSONObject.quote(ryd.optString("dislikeText"))}, bar=$actionBar" +
                    ", api probe=${apiProbe.optInt("status")}/${apiProbe.optString("allowOrigin", "null")}, $engineLine" +
                    (if (!decorated && oneRealmScriptUrl) " (one realm below Chromium 146: the page's Trusted Types policy refused the src of the extension's page-world helper script, the content script stopped there)" else "")
            }
        )
        chromeInvoke("tab.close", """{"tabId":${JSONObject.quote(ytTab)},"force":true}""")
        chromeInvoke("tab.close", """{"tabId":${JSONObject.quote(adsTab)},"force":true}""")
        SystemClock.sleep(1_500)
        results.put("probeConsole", JSONArray(consoleOf(probeView).takeLast(40)))
        gradeCalls()
        val traces = JSONObject()
        val failures = JSONObject()
        val seeded = results.getJSONObject("seededInstalls").keys().asSequence().toList()
        instrumentation.runOnMainSync {
            for (id in seeded) {
                val trace = host.extensions.traceSnapshot(id)
                traces.put(id, JSONArray(trace.takeLast(150)))
                // Every failed reply of the whole run, so a PARTIAL messaging stage names its errors.
                failures.put(id, JSONArray(trace.filter { it.contains(" reply error=") }.takeLast(40)))
            }
        }
        results.put("bridgeTrace", traces)
        results.put("bridgeErrors", failures)
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
        for ((key, counts) in stats.toSortedMap()) table.put(key, JSONArray().put(counts[0]).put(counts[1]).put(counts[2]))
        results.put("callStats", table)
        val messaging = listOf("runtime.sendMessage", "runtime.connect", "port.postMessage", "tabs.sendMessage", "tabs.connect")
        val storage = listOf("storage.get", "storage.set", "storage.remove", "storage.clear", "storage.getBytesInUse")
        for (id in listOf(DARK_READER, VIMIUM, RYD, STYLUS, UBOL)) {
            for ((stage, members) in listOf("messaging" to messaging, "storage" to storage)) {
                val rows = stats.filterKeys { k -> k.startsWith("$id ") && members.any { k.endsWith(" $it") } }
                val calls = rows.values.sumOf { it[0] }
                // A message nobody answered (a tab without the extension's listener, a listener
                // that returned nothing) is Chrome's runtime.lastError in a normal run, not a failure.
                val failures = rows.values.sumOf { it[1] }
                val detail = rows.entries.sortedBy { it.key }.joinToString(", ") {
                    "${it.key.substringAfter(' ')}=${it.value[0]} calls/${it.value[1]} failed" + if (it.value[2] > 0) "/${it.value[2]} unanswered" else ""
                }
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
     * report whether the popup became ready at all. The callers' 45 s is for the emulator's
     * software renderer, not the popups: measured on WebView 156 under swangle, uBlock Origin
     * Lite's popup had its text (123 characters) when the sheet was read after a 15 s wait had
     * given up on it; a popup that is ready sooner costs nothing of the wait.
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
        showTab(probeTab)
        val probeView = waitForView(probeTab)
        results.put("withProxyBenchmark", json(tabEval(probeView, WITH_BENCH, 60)))
        // Content-script fetches under a strict page CSP (main-world limitation).
        val cspTab = createTab("$BASE/csp.html")
        val cspView = waitForView(cspTab)
        waitFor(30_000) { if (tabEval(cspView, PROBE_DONE) == "true") true else null }
        val csp = json(tabEval(cspView, PROBE_REPORT))
        if (worlds) mergeWorldReports(cspView, csp)
        results.put("cspPage", csp)
        // The probe inserts <script src=chrome.runtime.getURL('page-script.js')> into the page; the
        // page's script-src ('self' 'unsafe-inline') refuses the extension origin, Chrome would
        // not, and the layer runs the file in the main world through the host instead.
        val pageScriptRan = csp.optJSONObject("pageScript")?.optBoolean("ran") == true
        val pageScriptEvent = csp.optJSONObject("idle")?.optJSONObject("steps")?.opt("pageScript")?.toString() ?: "unreported"
        stage(
            PROBE_ID, "pageScriptUnderCsp",
            when {
                pageScriptRan && pageScriptEvent == "load" -> "PASS"
                pageScriptRan || pageScriptEvent == "load" -> "PARTIAL"
                else -> "FAIL"
            },
            "main world saw the script run=$pageScriptRan, element event=$pageScriptEvent, page CSP script-src 'self' 'unsafe-inline'"
        )
        chromeInvoke("tab.close", """{"tabId":${JSONObject.quote(cspTab)},"force":true}""")
        trustedTypesPage()
        instrumentation.runOnMainSync { results.put("lateOnPageStarted", host.extensions.lateOnPageStarted) }
        lateInjection()
        privateTabs()
        frames()
        corsProxy()
        cookies()
        captureVisibleTab()
        webNavigation()

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
        // Page milestones three ways: the six extensions, the probe alone (one 77 KB unit, so the
        // fixed cost of a world and the bootstrap reads apart from the megabytes of the others'
        // content scripts), and none.
        results.put("memoryWithExtensions", meminfo())
        val timingWith = timing(3)
        val ids = listOf(PROBE_ID, DARK_READER, VIMIUM, RYD, STYLUS, UBOL)
        for (id in ids) if (id != PROBE_ID) chromeInvoke("extension.setEnabled", """{"id":${JSONObject.quote(id)},"enabled":false}""")
        val probeUnits = waitFor(30_000, 500) { scriptUnitsCount().takeIf { it <= 1 } }
        SystemClock.sleep(2_000)
        val timingProbeOnly = timing(3)
        chromeInvoke("extension.setEnabled", """{"id":${JSONObject.quote(PROBE_ID)},"enabled":false}""")
        waitFor(30_000, 500) { if (scriptUnitsCount() == 0) true else null }
        SystemClock.sleep(3_000)
        results.put("memoryWithoutExtensions", meminfo())
        val timingWithout = timing(3)
        results.put(
            "pageTiming",
            JSONObject()
                .put("withExtensions", timingWith)
                .put("probeOnly", timingProbeOnly)
                .put("probeOnlyUnits", probeUnits ?: JSONObject.NULL)
                .put("withoutExtensions", timingWithout)
        )
        for (id in ids) chromeInvoke("extension.setEnabled", """{"id":${JSONObject.quote(id)},"enabled":true}""")
        SystemClock.sleep(3_000)
    }

    /**
     * Trusted Types on a page the run controls (`require-trusted-types-for 'script'`, the
     * directive m.youtube.com sends): the page's realm refuses a string into a script sink; the
     * probe's own code takes it through the bootstrap's pass-through policy (the shield), as
     * Chrome's own worlds do under the extension's CSP. In a WebView isolated world the world's
     * sinks are shielded outright; in the with-fallback the page's sinks retry a refused string
     * for the extension's frames only, so the page's own write must stay refused after the
     * extension's went through (`pageSinkAfter`).
     */
    private fun trustedTypesPage() {
        val tab = createTab("$BASE/trusted-types.html")
        val view = waitForView(tab)
        waitFor(30_000) { if (tabEval(view, "document.readyState") == "complete") true else null }
        waitFor(10_000) { if (tabEval(view, PROBE_DONE) == "true") true else null }
        val pageSink = tabEval(view, "String((window.__page || {}).sink)")
        val worldSink = if (worlds) worldEval(view, PROBE_ID, TT_SINK_PROBE) else null
        val extensionSink = extEval(tab, PROBE_ID, TT_SINK_PROBE)
        val pageSinkAfter = tabEval(view, TT_SINK_PROBE)
        val world = if (worlds) worldEval(view, PROBE_ID, WORLD_REPORT)?.let(::json) else null
        val shield = if (worlds) world?.optJSONObject("stats")?.optJSONObject("trustedTypes")
        else tabEval(view, "JSON.stringify((window.__zenExtStats || {}).trustedTypes || null)").let { if (it == "null") null else json(it) }
        results.put(
            "trustedTypesPage",
            JSONObject().put("pageSink", pageSink).put("worldSink", worldSink ?: JSONObject.NULL).put("extensionSink", extensionSink)
                .put("pageSinkAfter", pageSinkAfter).put("shield", shield ?: JSONObject.NULL)
                .put("probeIdleRan", world?.opt("idle") != null || tabEval(view, PROBE_DONE) == "true")
        )
        stage(
            PROBE_ID, "trustedTypes",
            when {
                pageSink.startsWith("refused") && extensionSink == "ok" && pageSinkAfter.startsWith("refused") && shield?.optBoolean("policy") == true -> "PASS"
                extensionSink == "ok" -> "PARTIAL"
                else -> "FAIL"
            },
            "page sink=$pageSink extension sink=$extensionSink page sink after=$pageSinkAfter shield=$shield" +
                (if (worlds) " world sink=$worldSink" else " (one realm: the page's sinks retry a refused string for the extension's frames only)")
        )
        chromeInvoke("tab.close", """{"tabId":${JSONObject.quote(tab)},"force":true}""")
    }

    /**
     * `scripting.executeScript` / `insertCSS` into a document that predates the extension's
     * units: the probe is disabled, a tab opens without it, the probe comes back and its
     * background injects into that tab. The frame has no world of the probe's, so the runtime
     * boots the probe's scope late into the main world (`Extensions.lateBoots`) and runs the
     * function there; the CSS lands on the page either way.
     */
    private fun lateInjection() {
        val report = JSONObject()
        chromeInvoke("extension.setEnabled", """{"id":${JSONObject.quote(PROBE_ID)},"enabled":false}""")
        waitFor(20_000, 300) { if (backgroundView(PROBE_ID) == null) true else null }
        val lateTab = createTab("$BASE/probe.html")
        val lateView = waitForView(lateTab)
        waitFor(30_000) { if (tabEval(lateView, "document.readyState") == "complete") true else null }
        SystemClock.sleep(1_000)
        report.put("probeRanInTab", tabEval(lateView, "String(typeof document.__zenProbeStart)"))
        chromeInvoke("extension.setEnabled", """{"id":${JSONObject.quote(PROBE_ID)},"enabled":true}""")
        val bg = waitFor(30_000, 500) {
            val v = backgroundView(PROBE_ID) ?: return@waitFor null
            if (tabEval(v, "String(typeof chrome === 'object' && !!chrome.scripting)") == "true") v else null
        }
        var verdict = "FAIL"
        if (bg == null) {
            report.put("error", "no probe background after re-enabling")
        } else {
            chromeInvoke("tab.activate", """{"tabId":${JSONObject.quote(lateTab)}}""")
            SystemClock.sleep(800)
            tabEval(bg, LATE_INJECT)
            val raw = waitFor(20_000, 300) { val v = tabEval(bg, "window.__late || null"); if (v == "null") null else v }
            val result = raw?.let(::json) ?: JSONObject().put("error", "never settled")
            report.put("result", result)
            report.put("outlineColor", tabEval(lateView, "getComputedStyle(document.body).outlineColor"))
            // The style, not the colour: Dark Reader's theme recolours the inserted rule on a
            // WebView where it runs (rgb(179, 0, 90) for the pink on 156).
            report.put("outlineStyle", tabEval(lateView, "getComputedStyle(document.body).outlineStyle"))
            val cssLanded = report.optString("outlineStyle") == "dashed"
            val exec = result.optJSONArray("exec")?.optJSONObject(0)?.optJSONObject("result")
            verdict = when {
                exec != null && exec.optString("title").isNotEmpty() && cssLanded -> "PASS"
                exec != null || cssLanded -> "PARTIAL"
                else -> "FAIL"
            }
        }
        instrumentation.runOnMainSync { report.put("lateBoots", host.extensions.lateBoots) }
        results.put("lateInjection", report)
        stage(PROBE_ID, "lateInjection", verdict, report.toString().take(500))
        chromeInvoke("tab.close", """{"tabId":${JSONObject.quote(lateTab)},"force":true}""")
        SystemClock.sleep(800)
    }

    /**
     * Private tabs: Chrome keeps an extension the user did not allow in incognito out of
     * incognito tabs, and those tabs out of its `tabs` API. A private tab opens on the probe
     * page: no unit of the probe runs there (its CSS variable is absent from the document, in
     * whichever world the scripts would run) and the probe's background does not find the tab
     * with `tabs.query`. Allowed in private tabs (`extension.setAllowPrivate`, the record change
     * the runtime's `reconfigure` hook reads), a reload brings the probe's units and the query
     * lists the tab; the toggle goes back afterwards.
     *
     * W2-3 adds the network side: the probe's declarativeNetRequest rules (static `ads=1`, dynamic
     * `dyn=1`, session `sess=1`) reach the engine scoped to the partitions the extension is loaded
     * into, so the private tab's pixels all load while the probe is disallowed there, and the
     * three go the way they do in a normal tab once it is allowed. The engine's compiled snapshot
     * is read for the scope (`RuleSetInfo.partitions`) before each load rather than sleeping for
     * the translator round trip.
     */
    private fun privateTabs() {
        val report = JSONObject()
        val url = "$BASE/probe.html?private=1"
        report.put("rulesReachPrivateBefore", probeRulesReachPrivate())
        val tab = chromeInvoke("tab.create", """{"url":${JSONObject.quote(url)},"active":true,"containerId":"private"}""").trim('"')
        val view = waitForView(tab)
        waitFor(30_000) { if (tabEval(view, "document.readyState") == "complete") true else null }
        SystemClock.sleep(1_500)
        report.put("containerId", state().optJSONObject("tabs")?.optJSONObject(tab)?.optString("containerId"))
        report.put("cssWhileDisallowed", tabEval(view, PROBE_CSS))
        report.put("pixelsWhileDisallowed", pixels(view))
        var verdict = "FAIL"
        val bg = probeBackground()
        if (bg == null) {
            report.put("error", "no probe background")
        } else {
            report.put("listedWhileDisallowed", queryTabs(bg, url))
            chromeInvoke("extension.setAllowPrivate", """{"id":${JSONObject.quote(PROBE_ID)},"allowed":true}""")
            report.put("rescopedToPrivateMs", timeUntil(15_000) { probeRulesReachPrivate() == true })
            SystemClock.sleep(1_000)
            chromeInvoke("tab.reload", """{"tabId":${JSONObject.quote(tab)}}""")
            SystemClock.sleep(400)
            val reloaded = waitForView(tab)
            waitFor(30_000) { if (tabEval(reloaded, "document.readyState") == "complete") true else null }
            SystemClock.sleep(1_500)
            report.put("cssWhenAllowed", tabEval(reloaded, PROBE_CSS))
            report.put("pixelsWhenAllowed", pixels(reloaded))
            report.put("listedWhenAllowed", queryTabs(bg, url))
            chromeInvoke("extension.setAllowPrivate", """{"id":${JSONObject.quote(PROBE_ID)},"allowed":false}""")
            report.put("rescopedBackMs", timeUntil(15_000) { probeRulesReachPrivate() == false })
            SystemClock.sleep(600)
            val kept = report.optString("cssWhileDisallowed") == "" && report.optInt("listedWhileDisallowed", -1) == 0
            val admitted = report.optString("cssWhenAllowed") == "injected" && report.optInt("listedWhenAllowed", -1) == 1
            val before = report.optJSONObject("pixelsWhileDisallowed") ?: JSONObject()
            val after = report.optJSONObject("pixelsWhenAllowed") ?: JSONObject()
            val untouched = listOf("ads", "dyn", "sess", "ok").all { before.optString(it) == "loaded" }
            val ruled = listOf("ads", "dyn", "sess").all { after.optString(it) == "error" } && after.optString("ok") == "loaded"
            report.put("rulesUntouchedWhileDisallowed", untouched).put("rulesAppliedWhenAllowed", ruled)
            verdict = when {
                kept && admitted && untouched && ruled -> "PASS"
                kept || admitted || untouched || ruled -> "PARTIAL"
                else -> "FAIL"
            }
        }
        results.put("privateTabs", report)
        stage(PROBE_ID, "privateTabs", verdict, report.toString().take(700))
        chromeInvoke("tab.close", """{"tabId":${JSONObject.quote(tab)},"force":true}""")
        SystemClock.sleep(800)
    }

    /**
     * W2-3: the engine's decisions on the probe page's pixels come back to the extension the way
     * Chrome reports them. `onRuleMatchedDebug` (unpacked extensions) named the rule and ruleset
     * of each match as it happened – the probe's background keeps them in `report.ruleMatches` –
     * and `getMatchedRules` (`declarativeNetRequestFeedback`) lists the matches of the last
     * minutes per tab from the same record. The three rulesets that decided the probe page's
     * pixels – the manifest's `probe`, `_dynamic` and `_session` – must show up in both.
     */
    private fun matchedRules() {
        val report = JSONObject()
        var verdict = "FAIL"
        val bg = probeBackground()
        if (bg == null) {
            report.put("error", "no probe background")
        } else {
            val readDebug = { runCatching { JSONArray(tabEval(bg, "JSON.stringify(report.ruleMatches || [])")) }.getOrDefault(JSONArray()) }
            val debug = waitFor(10_000, 250) { readDebug().takeIf { it.length() >= 3 } } ?: readDebug()
            report.put("onRuleMatchedDebug", debug)
            tabEval(bg, "__askMatchedRules()")
            val raw = waitFor(10_000, 250) { tabEval(bg, "JSON.stringify(self.__matchedRules)").takeIf { it != "null" } }
            val matched = raw?.let { runCatching { JSONArray(it) }.getOrNull() }
            report.put("getMatchedRules", matched ?: raw ?: "no answer")
            val want = setOf("probe", "_dynamic", "_session")
            val debugSets = (0 until debug.length()).map { debug.getJSONObject(it).optString("rulesetId") }.toSet()
            val matchedSets = matched?.let { m -> (0 until m.length()).map { m.getJSONObject(it).optString("rulesetId") }.toSet() } ?: emptySet()
            report.put("debugRulesets", JSONArray(debugSets.sorted())).put("matchedRulesets", JSONArray(matchedSets.sorted()))
            verdict = when {
                want.all { it in debugSets } && want.all { it in matchedSets } -> "PASS"
                (debugSets intersect want).isNotEmpty() || (matchedSets intersect want).isNotEmpty() -> "PARTIAL"
                else -> "FAIL"
            }
        }
        results.put("matchedRules", report)
        stage(
            PROBE_ID, "matchedRules", verdict,
            "onRuleMatchedDebug rulesets=${report.opt("debugRulesets")} (${report.optJSONArray("onRuleMatchedDebug")?.length() ?: 0} events) " +
                "getMatchedRules rulesets=${report.opt("matchedRulesets")}"
        )
    }

    /** The probe page's pixel outcomes (`__page.images`: `loaded` | `error` per name), once all four settled. */
    private fun pixels(view: TabWebView): JSONObject {
        waitFor(15_000, 250) {
            if (tabEval(view, "String(Object.keys((window.__page || {}).images || {}).length >= 4)") == "true") true else null
        }
        return json(tabEval(view, "JSON.stringify((window.__page || {}).images || {})"))
    }

    /**
     * Whether the engine's compiled snapshot lets the probe's rule sets take part in private tabs
     * (`RuleSetInfo.appliesTo("private")`, every set of the extension agreeing); null while the
     * snapshot holds none of them.
     */
    private fun probeRulesReachPrivate(): Boolean? {
        var sets: List<RuleSetInfo> = emptyList()
        instrumentation.runOnMainSync { sets = host.blocking.snapshot.ruleSets.filter { it.id.startsWith("ext:$PROBE_ID:") } }
        if (sets.isEmpty()) return null
        return sets.all { it.appliesTo("private") }
    }

    /** Milliseconds until `ready` holds, polled every 200 ms; -1 when it did not within `timeoutMs`. */
    private fun timeUntil(timeoutMs: Long, ready: () -> Boolean): Long {
        val started = SystemClock.uptimeMillis()
        val done = waitFor(timeoutMs, 200) { if (ready()) true else null }
        return if (done == true) SystemClock.uptimeMillis() - started else -1
    }

    /**
     * Frame targets: `scripting.executeScript({ target: { frameIds } })` reaches the named subframe
     * alone and `allFrames` every frame the extension has a script in. A page with one same-origin
     * iframe opens; the probe's frame script runs in the iframe and nowhere else (its manifest
     * entry matches the inner document with `all_frames`). The background lists the frames with
     * `webNavigation.getAllFrames`, marks the subframe by its id, then every frame at once, and
     * the top document reads both documents' markers. A subframe is reached through its own
     * bridge endpoint (`JavaScriptReplyProxy.executeJavaScript`, Chromium 146+): without that, the
     * named target is refused with the host's message and `allFrames` still marks the main frame.
     */
    private fun frames() {
        val report = JSONObject()
        val tab = createTab("$BASE/frames.html")
        val view = waitForView(tab)
        waitFor(30_000) { if (tabEval(view, "document.readyState") == "complete") true else null }
        waitFor(15_000, 300) {
            val inner = tabEval(view, "(function(){try{return String(frames[0].document.readyState==='complete')}catch(e){return 'false'}})()")
            if (inner == "true") true else null
        }
        SystemClock.sleep(1_000)
        var verdict = "FAIL"
        val bg = probeBackground()
        if (bg == null) {
            report.put("error", "no probe background")
        } else {
            chromeInvoke("tab.activate", """{"tabId":${JSONObject.quote(tab)}}""")
            SystemClock.sleep(800)
            tabEval(bg, FRAMES_INJECT)
            val raw = waitFor(20_000, 300) { val v = tabEval(bg, "window.__frames || null"); if (v == "null") null else v }
            val result = raw?.let(::json) ?: JSONObject().put("error", "never settled")
            report.put("result", result)
            report.put("markers", json(tabEval(view, FRAME_MARKERS)))
            val markers = report.getJSONObject("markers")
            val inner = markers.optJSONObject("inner") ?: JSONObject()
            val listed = result.optJSONArray("frames")?.length() ?: 0
            val frameScriptWhereDue = inner.optString("script") == "/frame-inner.html" && markers.isNull("topScript")
            val namedReachedFrame = inner.optString("exec").startsWith("sub") && markers.optString("topExec") == "all"
            val allReachedBoth = inner.optString("exec") == "sub,all" && markers.optString("topExec") == "all"
            val unreachable = result.optString("subError").contains("subframe")
            verdict = when {
                listed >= 2 && frameScriptWhereDue && allReachedBoth -> "PASS"
                !worlds && unreachable && frameScriptWhereDue && markers.optString("topExec") == "all" && inner.isNull("exec") -> "N/A"
                frameScriptWhereDue && namedReachedFrame -> "PARTIAL"
                else -> "FAIL"
            }
        }
        results.put("frames", report)
        stage(PROBE_ID, "frames", verdict, report.toString().take(600) + if (verdict == "N/A") " (no frame injection below Chromium 146: the main frame alone is reachable)" else "")
        chromeInvoke("tab.close", """{"tabId":${JSONObject.quote(tab)},"force":true}""")
        SystemClock.sleep(800)
    }

    // --- W2-2: sheets, menus, notifications, identity, proxy, cookies, capture, navigation ---------

    /**
     * The popup sheet gives the extension's document its own size: the probe popup's body is 320
     * CSS px wide plus 20 px of padding a side (360), so on a 411 dp phone the surface is narrower
     * than the sheet and centred in it, and its height follows the document rather than the
     * sheet's maximum (the v2 sheet rules: grip, 48 dp header, the body the content's).
     */
    private fun popupSheetSize(view: WebView) {
        val report = JSONObject()
        instrumentation.runOnMainSync {
            val density = view.resources.displayMetrics.density
            val parent = view.parent as? View
            report.put("widthDp", (view.width / density).toInt())
            report.put("heightDp", (view.height / density).toInt())
            report.put("frameWidthDp", ((parent?.width ?: 0) / density).toInt())
            report.put("screenWidthDp", (view.resources.displayMetrics.widthPixels / density).toInt())
            report.put("screenHeightDp", (view.resources.displayMetrics.heightPixels / density).toInt())
        }
        report.put(
            "document",
            json(tabEval(view, "JSON.stringify({scrollWidth: document.documentElement.scrollWidth, scrollHeight: document.documentElement.scrollHeight, bodyWidth: document.body.getBoundingClientRect().width, bodyHeight: document.body.getBoundingClientRect().height, innerWidth: innerWidth, innerHeight: innerHeight})"))
        )
        results.put("popupSheet", report)
        val widthDp = report.optInt("widthDp")
        val heightDp = report.optInt("heightDp")
        val ownWidth = widthDp in 330..390 && widthDp < report.optInt("frameWidthDp") - 2
        val ownHeight = heightDp in 80..600 && heightDp < report.optInt("screenHeightDp") * 0.85
        stage(
            PROBE_ID, "popupSheet",
            when {
                ownWidth && ownHeight -> "PASS"
                ownWidth || ownHeight -> "PARTIAL"
                else -> "FAIL"
            },
            "surface ${widthDp}x${heightDp} dp in a ${report.optInt("frameWidthDp")} dp sheet on a ${report.optInt("screenWidthDp")}x${report.optInt("screenHeightDp")} dp screen; document ${report.optJSONObject("document")}"
        )
    }

    /**
     * The options page (`options_ui` without `open_in_tab`) in the same sheet chassis at the
     * sheet's full width: it loads, binds its form to `storage.local`, and a change it saves is
     * what the background reads back.
     */
    private fun optionsSheet() {
        val report = JSONObject()
        chromeInvoke("extension.openOptions", """{"id":${JSONObject.quote(PROBE_ID)}}""")
        val view = waitFor(20_000, 400) {
            val v = popupView()
            if (v != null && tabEval(v, "document.title") == "probe-options-ready") v else null
        }
        SystemClock.sleep(1_000)
        var saved = false
        if (view != null) {
            tabEval(view, "(function(){var g=document.getElementById('greeting');g.value='hello from the demo';g.dispatchEvent(new Event('input'));return 'ok'})()")
            saved = waitFor(8_000, 200) { if (tabEval(view, "document.body.getAttribute('data-saved')") == "1") true else null } == true
            SystemClock.sleep(600)
        }
        shot("07-probe-options-sheet")
        if (view != null) {
            report.put("options", json(tabEval(view, "JSON.stringify(window.__optionsReport || null)")))
            report.put("url", tabEval(view, "location.href"))
            instrumentation.runOnMainSync {
                val density = view.resources.displayMetrics.density
                report.put("widthDp", (view.width / density).toInt()).put("heightDp", (view.height / density).toInt())
            }
        }
        chromeInvoke("extension.closePopup", null)
        SystemClock.sleep(900)
        val bg = probeBackground()
        if (bg != null) {
            tabEval(bg, "(function(){window.__opt=null;chrome.storage.local.get(['greeting'],function(i){window.__opt=JSON.stringify(i||{})})})()")
            val raw = waitFor(8_000, 200) { val v = tabEval(bg, "window.__opt"); if (v == "null") null else v }
            report.put("storageFromBackground", raw?.let(::json) ?: JSONObject.NULL)
        }
        val stored = report.optJSONObject("storageFromBackground")?.optString("greeting") == "hello from the demo"
        results.put("optionsSheet", report)
        stage(
            PROBE_ID, "options",
            when {
                view != null && saved && stored -> "PASS"
                view != null -> "PARTIAL"
                else -> "FAIL"
            },
            if (view == null) "options page never reported ready" else report.toString().take(500)
        )
    }

    /**
     * `chrome.contextMenus` in the long-press menu: a long press on a link of the probe page opens
     * Zenium's link menu (the chrome's sheet) with the probe's items after the browser's own, and
     * tapping one raises `onClicked` in the background with the link and the tab. Should the press
     * not open the menu (it became a text selection), the view's own `contextMenu` event is sent
     * for the same link, which is noted in the verdict.
     */
    private fun contextMenu(probeView: TabWebView) {
        val report = JSONObject()
        val bg = probeBackground()
        report.put("registered", bg?.let { json(tabEval(it, "JSON.stringify({items: report.menuItems, clicks: report.menuClicks})")) } ?: JSONObject.NULL)
        val clicksBefore = report.optJSONObject("registered")?.optJSONArray("clicks")?.length() ?: 0
        val link = json(
            tabEval(
                probeView,
                "JSON.stringify((function(a){if(!a)return null;var r=a.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2,w:r.width,h:r.height}})(document.querySelector('a[href=\"https://example.com/\"]')))"
            )
        )
        val point = screenPoint(probeView, link)
        report.put("linkPoint", point?.let { JSONObject().put("x", it.first).put("y", it.second) } ?: JSONObject.NULL)
        var via = "none"
        if (point != null) {
            longPress(point.first, point.second)
            via = "long-press"
        }
        var item = waitFor(8_000, 300) { menuItemPoint(MENU_LINK_LABEL) }
        if (item == null) {
            instrumentation.runOnMainSync {
                host.viewEvent(
                    probeTab, "contextMenu",
                    JSONObject().put("linkURL", "https://example.com/").put("srcURL", "").put("mediaType", "none").put("x", 100).put("y", 300)
                )
            }
            via = if (point != null) "synthetic event after a long-press without a menu" else "synthetic event"
            item = waitFor(8_000, 300) { menuItemPoint(MENU_LINK_LABEL) }
        }
        report.put("menuVia", via)
        report.put("itemShown", item != null)
        report.put("menuLabels", menuLabels())
        // The row is in the document from the moment the sheet mounts, at its closed position,
        // and the sheet then springs up: a point taken at first sight is where the row was, not
        // where it comes to rest (measured: on WebView 156 the first point lay at y=3476 on a
        // 1600 px screen and the dispatcher dropped the tap as outside every window; on 113 a
        // point taken mid-flight landed a row lower, in the Boosts submenu). Aim once it stands
        // still, at the row the accessibility tree reports, else at the document's rectangle.
        val target = if (item != null) settledMenuItemPoint(MENU_LINK_LABEL) else null
        report.put("itemPoint", target?.let { JSONObject().put("x", it.first).put("y", it.second) } ?: JSONObject.NULL)
        report.put("geometry", menuGeometry(MENU_LINK_LABEL))
        shot("08-context-menu")
        var clicked: JSONObject? = null
        var picked = "none"
        if (item != null && bg != null) {
            var tappedAt = 0L
            if (target != null) {
                tap(target.first, target.second)
                tappedAt = SystemClock.uptimeMillis()
                picked = "tap"
                clicked = waitFor(20_000, 250) { menuClick(bg, clicksBefore) }
            }
            if (clicked == null) {
                val row = pickMenuItem(MENU_LINK_LABEL)
                when {
                    row -> {
                        picked = "$picked, then a click in the document"
                        clicked = waitFor(20_000, 250) { menuClick(bg, clicksBefore) }
                    }
                    target != null -> {
                        // No row left: the tap took the menu down, and its click is still on its
                        // way through a stalled main thread (measured on WebView 156 under the
                        // emulator's swangle renderer: the sheet closed 6.3 s after the tap, one
                        // app frame every 1.3–3.5 s, and a click of the document's row reached
                        // the background 8 s later). Only the tap's click can arrive now.
                        picked = "tap (late)"
                        clicked = waitFor(20_000, 250) { menuClick(bg, clicksBefore) }
                    }
                    else -> picked = "$picked, then no row left to click"
                }
            }
            if (clicked != null && tappedAt != 0L) report.put("clickAfterTapMs", SystemClock.uptimeMillis() - tappedAt)
        }
        report.put("picked", picked)
        if (menuLabels().length() > 0) {
            ui.performGlobalAction(AccessibilityService.GLOBAL_ACTION_BACK)
            SystemClock.sleep(800)
        }
        report.put("click", clicked ?: JSONObject.NULL)
        results.put("contextMenu", report)
        val right = clicked != null && clicked.optString("menuItemId") == "probe-link" && clicked.optString("linkUrl") == "https://example.com/"
        stage(
            PROBE_ID, "contextMenus",
            when {
                item != null && right && via == "long-press" && (picked == "tap" || picked == "tap (late)") -> "PASS"
                item != null && right -> "PARTIAL"
                item != null -> "PARTIAL"
                else -> "FAIL"
            },
            report.toString().take(900)
        )
        SystemClock.sleep(600)
    }

    /**
     * `chrome.notifications`: the probe posts a card on the system shade (its own channel under
     * the Extensions group); the shade opens for the picture, the card is tapped and the
     * background's `onClicked` (and the `onClosed` that follows) arrives through MainActivity. If
     * the driver cannot find the card in the shade, the card is cleared instead, which raises
     * `onClosed`, and the stage says so.
     */
    private fun notification() {
        val report = JSONObject()
        val created = w22("notify", """{"id":"probe-note","title":"Zenium probe","message":"Tap me: the probe extension is listening."}""")
        report.put("created", created)
        SystemClock.sleep(1_500)
        val dump = shell("dumpsys notification --noredact")
        report.put("posted", dump.contains("pkg=${app.packageName}"))
        report.put("channel", dump.contains(ExtensionNotifications.channelId(PROBE_ID)))
        ui.performGlobalAction(AccessibilityService.GLOBAL_ACTION_NOTIFICATIONS)
        val card = waitFor(6_000, 400) { findInWindows("Zenium probe") }
        SystemClock.sleep(1_200)
        shot("09-notification-shade")
        report.put("cardFound", card != null)
        var via = "none"
        if (card != null) {
            tap(card.exactCenterX(), card.exactCenterY())
            via = "tap on the shade"
        } else {
            ui.performGlobalAction(AccessibilityService.GLOBAL_ACTION_DISMISS_NOTIFICATION_SHADE)
            SystemClock.sleep(800)
        }
        val bg = probeBackground()
        var events = waitFor(8_000, 300) {
            val list = bg?.let { json(tabEval(it, "JSON.stringify({list: report.notificationEvents})")) }?.optJSONArray("list")
            if (list != null && list.length() > 0) list else null
        }
        if (events == null) {
            val cleared = w22("notifyClear", """{"id":"probe-note"}""")
            report.put("cleared", cleared)
            via = if (card != null) "tap without an event, then clear" else "clear"
            events = cleared.optJSONArray("events")
        }
        val seen = events ?: JSONArray()
        report.put("via", via)
        report.put("events", seen)
        // The shade must be gone for the rest of the recording, whatever happened above.
        if (ui.rootInActiveWindow?.packageName?.toString()?.contains("systemui") == true) {
            ui.performGlobalAction(AccessibilityService.GLOBAL_ACTION_DISMISS_NOTIFICATION_SHADE)
            SystemClock.sleep(800)
        }
        results.put("notification", report)
        val okCreate = created.optString("id") == "probe-note" && created.isNull("error")
        val kinds = (0 until seen.length()).map { seen.getJSONObject(it).optString("event") }
        stage(
            PROBE_ID, "notifications",
            when {
                okCreate && "clicked" in kinds -> "PASS"
                okCreate -> "PARTIAL"
                else -> "FAIL"
            },
            report.toString().take(700)
        )
        SystemClock.sleep(600)
    }

    /**
     * `identity.launchWebAuthFlow` in the auth sheet: the runner's stand-in provider loads in the
     * sheet (a WebView on the regular profile), the driver taps its sign-in button, the page goes
     * to `https://<id>.chromiumapp.org/cb?code=…`, which the sheet cancels and hands to the flow;
     * the promise resolves with that URL and the sheet closes. Then a silent flow whose page
     * redirects by itself: it resolves without the sheet ever showing.
     */
    private fun authSheet() {
        val report = JSONObject()
        val bg = probeBackground()
        if (bg == null) {
            stage(PROBE_ID, "identity", "FAIL", "no probe background")
            return
        }
        tabEval(bg, "window.__w22('auth', {url: ${JSONObject.quote("$BASE/auth.html")}})")
        val view = waitFor(15_000, 300) { authView() }
        val shown = view != null && waitFor(15_000, 300) {
            var attached = false
            instrumentation.runOnMainSync { attached = view.isAttachedToWindow && view.isShown }
            if (attached && tabEval(view, "String(document.readyState === 'complete' && !!document.getElementById('signin'))") == "true") true else null
        } == true
        report.put("sheetShown", shown)
        SystemClock.sleep(1_500)
        shot("10-auth-sheet")
        var via = "none"
        if (view != null && shown) {
            report.put("sheetUrl", tabEval(view, "location.href"))
            val button = json(tabEval(view, "JSON.stringify((function(b){var r=b.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})(document.getElementById('signin')))"))
            val point = screenPoint(view, button)
            if (point != null) {
                tap(point.first, point.second)
                via = "tap"
            }
        }
        var result = waitFor(10_000, 250) { w22Result(bg) }
        if (result == null && view != null) {
            tabEval(view, "document.getElementById('signin').click()")
            via = "$via, then a click in the document"
            result = waitFor(10_000, 250) { w22Result(bg) }
        }
        report.put("via", via)
        report.put("interactive", result ?: JSONObject().put("error", "never settled"))
        SystemClock.sleep(800)
        report.put("sheetClosed", authView() == null)
        val silent = w22("auth", """{"url":${JSONObject.quote("$BASE/auth.html")},"auto":1,"interactive":false}""", 25_000)
        report.put("silent", silent)
        report.put("sheetAfterSilent", authView() != null)
        results.put("identity", report)
        val interactiveUrl = result?.optString("responseUrl") ?: ""
        val redirect = result?.optString("redirect") ?: ""
        val interactiveOk = redirect.isNotEmpty() && interactiveUrl.startsWith(redirect) && interactiveUrl.contains("code=probe-ok")
        val silentOk = silent.optString("responseUrl").contains("code=probe-ok")
        stage(
            PROBE_ID, "identity",
            when {
                shown && interactiveOk && silentOk && via == "tap" && report.optBoolean("sheetClosed") -> "PASS"
                interactiveOk -> "PARTIAL"
                else -> "FAIL"
            },
            report.toString().take(800)
        )
    }

    /**
     * The CORS proxy: a `fetch` and an XHR from the probe's background (origin
     * `https://<id>.ext.zenium.invalid`) to the runner's page server, which sends no CORS headers,
     * so the responses are readable only because Kotlin re-served them; a POST with a body goes
     * the same way (the server answers it 501, which is readable for the same reason). The
     * acceptance case is Dark Reader's: its content script on the probe page asks its background
     * to fetch the page's cross-origin Google logo for analysis, and the proxy's log has it.
     */
    private fun corsProxy() {
        val url = "$BASE/data.json?cors=1"
        val probe = w22("cors", """{"url":${JSONObject.quote(url)}}""")
        var log: List<String> = emptyList()
        instrumentation.runOnMainSync { log = synchronized(host.extensions.proxied) { host.extensions.proxied.toList() } }
        val report = JSONObject().put("probe", probe).put("proxied", JSONArray(log.takeLast(40)))
            .put("cookieIntercept", host.extensions.cookieIntercept)
        val probeOk = probe.optInt("status") == 200 && probe.optString("body").contains("{") && probe.optInt("xhrStatus") == 200
        val postSeen = probe.has("postStatus")
        stage(
            PROBE_ID, "corsProxy",
            when {
                probeOk && postSeen -> "PASS"
                probeOk || probe.optInt("status") == 200 -> "PARTIAL"
                else -> "FAIL"
            },
            "fetch=${probe.optInt("status")} acao=${probe.optString("allowOrigin")} xhr=${probe.optInt("xhrStatus")} post=${probe.opt("postStatus") ?: probe.optString("postError")} body=${probe.optString("body").take(60)}"
        )
        val google = log.filter { it.contains("googlelogo") }
        report.put("darkReaderGoogleFetch", JSONArray(google))
        // The page's side: Dark Reader swaps an analysed background image for its own rendering.
        showTab(probeTab)
        val probeView = waitForView(probeTab)
        report.put("logoBackgroundImage", tabEval(probeView, "(function(e){return e ? getComputedStyle(e).backgroundImage.slice(0, 80) : 'no element'})(document.querySelector('.logo'))"))
        results.put("corsProxy", report)
        val darkStatus = google.mapNotNull { it.split(' ').getOrNull(2)?.toIntOrNull() }
        stage(
            DARK_READER, "corsProxy",
            when {
                darkStatus.any { it == 200 } -> "PASS"
                google.isNotEmpty() -> "PARTIAL"
                else -> "FAIL"
            },
            if (google.isEmpty()) "no proxied request for the probe page's Google logo (Dark Reader did not ask its background to fetch it, or the request never reached the proxy); log tail=${log.takeLast(5)}"
            else "proxied: ${google.joinToString()}; page shows ${report.optString("logoBackgroundImage").take(50)}"
        )
    }

    /**
     * `chrome.cookies` against the probe page's origin: `set` lands in the WebView's jar (the page
     * reads it from `document.cookie`), `get` / `getAll` read it back, `remove` takes it out again
     * (the page no longer sees it), `onChanged` reports the write and the removal.
     */
    private fun cookies() {
        val url = "$BASE/probe.html"
        showTab(probeTab)
        val probeView = waitForView(probeTab)
        val report = JSONObject()
        report.put("detailed", androidx.webkit.WebViewFeature.isFeatureSupported(androidx.webkit.WebViewFeature.GET_COOKIE_INFO))
        report.put("pageBefore", tabEval(probeView, "document.cookie"))
        val set = w22("cookies", """{"url":${JSONObject.quote(url)}}""")
        report.put("set", set)
        SystemClock.sleep(500)
        report.put("pageAfterSet", tabEval(probeView, "document.cookie"))
        val removed = w22("cookieRemove", """{"url":${JSONObject.quote(url)}}""")
        report.put("remove", removed)
        SystemClock.sleep(500)
        report.put("pageAfterRemove", tabEval(probeView, "document.cookie"))
        results.put("cookies", report)
        val value = set.optJSONObject("set")?.optString("value") ?: ""
        val apiSet = value.startsWith("w22-") && set.optJSONObject("get")?.optString("value") == value && set.optJSONArray("getAll")?.toString()?.contains("zenProbe=$value") == true
        val pageSaw = report.optString("pageAfterSet").contains("zenProbe=$value")
        val apiRemoved = removed.isNull("after") && removed.optJSONObject("removed")?.optString("name") == "zenProbe"
        val pageForgot = !report.optString("pageAfterRemove").contains("zenProbe=")
        val changes = (set.optJSONArray("changes")?.length() ?: 0) + (removed.optJSONArray("changes")?.length() ?: 0)
        stage(
            PROBE_ID, "cookies",
            when {
                apiSet && pageSaw && apiRemoved && pageForgot && changes >= 2 -> "PASS"
                apiSet && apiRemoved -> "PARTIAL"
                else -> "FAIL"
            },
            "set/get/getAll=$apiSet page saw=$pageSaw removed=$apiRemoved page forgot=$pageForgot onChanged=$changes stores=${set.optJSONArray("stores")} detailed(GET_COOKIE_INFO)=${report.optBoolean("detailed")}" +
                (set.optString("error").takeIf { it.isNotEmpty() }?.let { " error=$it" } ?: "")
        )
    }

    /**
     * `tabs.captureVisibleTab` from the probe's background: a PNG data URL of the active (probe)
     * tab's on-screen pixels that decodes to a real image, saved next to the screenshots; then a
     * JPEG at a chosen quality.
     */
    private fun captureVisibleTab() {
        showTab(probeTab)
        val png = w22("capture", """{"format":"png"}""", 25_000)
        val dataUrl = png.optString("dataUrl")
        if (dataUrl.startsWith("data:image/png;base64,")) {
            runCatching {
                val bytes = android.util.Base64.decode(dataUrl.substringAfter("base64,"), android.util.Base64.DEFAULT)
                File(out, "ext-android-runtime-12-capture-visible-tab.png").writeBytes(bytes)
            }
        }
        png.remove("dataUrl")
        val jpeg = w22("capture", """{"format":"jpeg","quality":50}""", 25_000)
        jpeg.remove("dataUrl")
        val report = JSONObject().put("png", png).put("jpeg", jpeg)
        results.put("captureVisibleTab", report)
        val pngOk = png.optString("prefix").startsWith("data:image/png") && png.optInt("width") > 0 && png.optInt("height") > 0
        val jpegOk = jpeg.optString("prefix").startsWith("data:image/jpeg") && jpeg.optInt("width") > 0
        stage(
            PROBE_ID, "captureVisibleTab",
            when {
                pngOk && jpegOk -> "PASS"
                pngOk || jpegOk -> "PARTIAL"
                else -> "FAIL"
            },
            "png ${png.optInt("width")}x${png.optInt("height")} (${png.optInt("length")} chars) jpeg q50 ${jpeg.optInt("width")}x${jpeg.optInt("height")} (${jpeg.optInt("length")} chars)" +
                (png.optString("error").takeIf { it.isNotEmpty() }?.let { " error=$it" } ?: "")
        )
    }

    /**
     * `chrome.webNavigation` as the probe's background saw the run, derived from the WebView's
     * navigation listener where the WebView has one (`NAVIGATION_LISTENER`, Chromium 137+) and
     * inferred from the client callbacks otherwise: the four phases of a probe page load in order,
     * a fragment change and a `pushState` as same-document events, and the filtered `onCommitted`
     * listener (`hostEquals`, `pathSuffix`) hearing about probe pages only.
     */
    private fun webNavigation() {
        showTab(probeTab)
        val report = JSONObject()
        report.put("navigationListener", NavigationReports.supported)
        val phases = listOf("onBeforeNavigate", "onCommitted", "onDOMContentLoaded", "onCompleted")
        fun probeMainFrame(list: List<JSONObject>) = list.filter {
            it.optString("url").startsWith("$BASE/probe.html") && it.optInt("frameId", -1) == 0 && !it.optString("event").endsWith(":filtered")
        }
        fun recorded(): List<JSONObject> {
            val all = w22("navigation").optJSONArray("list") ?: JSONArray()
            return (0 until all.length()).map { all.getJSONObject(it) }
        }
        // One full load of the probe page, made here: the stage used to read whatever load an
        // earlier stage had left in the worker's array, and the worker restarts at the
        // `lateInjection` stage (its `report` fresh) and idles out between slow stages, so on
        // one run the array held no probe load at all. The reload's `tabs.onUpdated` and the
        // content script's ping wake an idled worker; the derived events are held until it is
        // ready and arrive in order.
        val loadFrom = recorded().size
        chromeInvoke("tab.reload", """{"tabId":${JSONObject.quote(probeTab)}}""")
        SystemClock.sleep(400)
        val probeView = waitForView(probeTab)
        waitFor(30_000) { if (tabEval(probeView, "document.readyState") == "complete") true else null }
        val loaded = waitFor(20_000, 500) {
            val events = probeMainFrame(recorded().drop(loadFrom)).map { it.optString("event") }
            if (events.windowed(4).any { it == phases }) true else null
        } == true
        report.put("loadRecorded", loaded)
        val before = recorded().size
        tabEval(probeView, "location.hash = '#w22'")
        waitFor(10_000, 300) { if (recorded().drop(before).any { it.optString("event") == "onReferenceFragmentUpdated" }) true else null }
        tabEval(probeView, "history.pushState({}, '', location.pathname + '?w22=1')")
        waitFor(10_000, 300) { if (recorded().drop(before).any { it.optString("event") == "onHistoryStateUpdated" }) true else null }
        // WebView finishes a hash change too (`onPageFinished`), and Chrome reports no load for
        // it: anything the inferred path might still add comes within a settle.
        SystemClock.sleep(1_500)
        val entries = recorded()
        report.put("count", entries.size)
        report.put("tail", JSONArray(entries.drop(loadFrom).takeLast(24)))
        // What the two same-document moves produced on the probe page: the fragment event, the
        // history event, and nothing else.
        val sameDocument = entries.drop(before).filter { it.optString("url").startsWith("$BASE/probe.html") }
        val fragment = sameDocument.any { it.optString("event") == "onReferenceFragmentUpdated" && it.optString("url").endsWith("#w22") }
        val pushed = sameDocument.any { it.optString("event") == "onHistoryStateUpdated" && it.optString("url").contains("w22=1") }
        val sameDocumentOnly = sameDocument.all { it.optString("event") in listOf("onReferenceFragmentUpdated", "onHistoryStateUpdated") }
        report.put("sameDocumentOnly", sameDocumentOnly)
        // The phases of the stage's load, in order, for the same tab. The filtered listener's
        // copy of `onCommitted` is recorded alongside and graded on its own below.
        val probeLoads = probeMainFrame(entries.drop(loadFrom))
        val orderedLoad = probeLoads.map { it.optString("event") }.windowed(4).any { it == phases }
        val filtered = entries.drop(loadFrom).filter { it.optString("event") == "onCommitted:filtered" }
        val filterRight = filtered.isNotEmpty() && filtered.all { it.optString("url").startsWith("$BASE/probe.html") }
        val transitions = probeLoads.filter { it.optString("event") == "onCommitted" }.map { it.optString("transitionType") }.distinct()
        report.put("orderedLoad", orderedLoad).put("fragment", fragment).put("pushState", pushed).put("filteredCount", filtered.size).put("filterRight", filterRight).put("transitions", JSONArray(transitions))
        results.put("webNavigation", report)
        stage(
            PROBE_ID, "webNavigation",
            when {
                orderedLoad && fragment && pushed && sameDocumentOnly && filterRight -> "PASS"
                orderedLoad -> "PARTIAL"
                else -> "FAIL"
            },
            "listener=${report.optBoolean("navigationListener")} events=${entries.size} ordered load=$orderedLoad fragment=$fragment pushState=$pushed " +
                "sameDocumentOnly=$sameDocumentOnly filtered=${filtered.size}/$filterRight transitions=$transitions"
        )
    }

    /** Run a W2-2 stage in the probe's background (`window.__w22`) and wait for its JSON result. */
    private fun w22(name: String, args: String = "{}", timeoutMs: Long = 20_000): JSONObject {
        val bg = probeBackground() ?: return JSONObject().put("error", "no probe background")
        tabEval(bg, "window.__w22(${JSONObject.quote(name)}, $args)")
        return waitFor(timeoutMs, 250) { w22Result(bg) } ?: JSONObject().put("error", "never settled")
    }

    private fun w22Result(bg: WebView): JSONObject? {
        val raw = tabEval(bg, "window.__w22Result")
        return if (raw == "null") null else json(raw)
    }

    private fun authView(): WebView? {
        var v: WebView? = null
        instrumentation.runOnMainSync { v = host.extensions.authSheetView(PROBE_ID) }
        return v
    }

    /** A CSS-px point in a WebView's document (`{x, y}`) as screen coordinates, or null without one. */
    private fun screenPoint(view: WebView, css: JSONObject): Pair<Float, Float>? {
        if (!css.has("x") || !css.has("y")) return null
        var result: Pair<Float, Float>? = null
        instrumentation.runOnMainSync {
            val location = IntArray(2)
            view.getLocationOnScreen(location)
            @Suppress("DEPRECATION")
            val scale = view.scale.takeIf { it > 0f } ?: view.resources.displayMetrics.density
            result = (location[0] + css.getDouble("x").toFloat() * scale) to (location[1] + css.getDouble("y").toFloat() * scale)
        }
        return result
    }

    /** The centre of the chrome's menu row labelled `label`, scrolled into view, on screen; null without such a row. */
    private fun menuItemPoint(label: String): Pair<Float, Float>? {
        var chrome: WebView? = null
        instrumentation.runOnMainSync { chrome = host.chrome }
        val view = chrome ?: return null
        val raw = tabEval(
            view,
            "JSON.stringify((function(){var b=Array.prototype.find.call(document.querySelectorAll('button.zen-sheet-item'),function(el){return el.textContent.trim()===${JSONObject.quote(label)}});" +
                "if(!b)return null;b.scrollIntoView({block:'center'});var r=b.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})())"
        )
        if (raw == "null") return null
        return screenPoint(view, json(raw))
    }

    /**
     * The centre of the menu row labelled `label` once the sheet has come to rest: the row the
     * accessibility tree reports (screen bounds from the WebView itself), else the document's
     * rectangle, unchanged over three readings 300 ms apart and on the screen. Null when the row
     * never stood still on screen within the wait, or is gone: three readings in a row without it
     * (one missed reading is a stalled main thread, not a closed menu; measured on WebView 156
     * under the emulator's swangle renderer, where an `evaluateJavascript` waited past its 10 s).
     */
    private fun settledMenuItemPoint(label: String): Pair<Float, Float>? {
        var last: Pair<Float, Float>? = null
        var still = 0
        var missed = 0
        val deadline = SystemClock.uptimeMillis() + 20_000
        while (SystemClock.uptimeMillis() < deadline) {
            val point = findByLabel(label)?.let { it.exactCenterX() to it.exactCenterY() } ?: menuItemPoint(label)
            if (point == null) {
                if (++missed >= 3) return null
                SystemClock.sleep(300)
                continue
            }
            missed = 0
            val onScreen = point.first in 0f..(width - 1).toFloat() && point.second in 0f..(height - 1).toFloat()
            still = if (last != null && abs(point.first - last.first) < 0.5f && abs(point.second - last.second) < 0.5f) still + 1 else 0
            if (onScreen && still >= 2) return point
            last = point
            SystemClock.sleep(300)
        }
        return null
    }

    /** What the driver aims with: the chrome view's placement and scale, the row's rectangle in the document and on the accessibility tree. */
    private fun menuGeometry(label: String): JSONObject {
        val geometry = JSONObject()
        var chrome: WebView? = null
        instrumentation.runOnMainSync { chrome = host.chrome }
        val view = chrome ?: return geometry
        instrumentation.runOnMainSync {
            val location = IntArray(2)
            view.getLocationOnScreen(location)
            @Suppress("DEPRECATION")
            geometry.put("scale", view.scale).put("density", view.resources.displayMetrics.density)
                .put("view", JSONObject().put("x", location[0]).put("y", location[1]).put("width", view.width).put("height", view.height))
        }
        geometry.put(
            "document",
            json(
                tabEval(
                    view,
                    "JSON.stringify((function(){var s=document.querySelector('.zen-sheet');var b=Array.prototype.find.call(document.querySelectorAll('button.zen-sheet-item'),function(el){return el.textContent.trim()===${JSONObject.quote(label)}});" +
                        "var r=b?b.getBoundingClientRect():null;var sr=s?s.getBoundingClientRect():null;return {innerWidth:innerWidth,innerHeight:innerHeight,devicePixelRatio:devicePixelRatio," +
                        "row:r?{left:r.left,top:r.top,width:r.width,height:r.height}:null,sheet:sr?{top:sr.top,height:sr.height,transform:s.style.transform,locked:s.getAttribute('data-locked')}:null}})())"
                )
            )
        )
        geometry.put("a11y", findByLabel(label)?.let { JSONObject().put("left", it.left).put("top", it.top).put("right", it.right).put("bottom", it.bottom) } ?: JSONObject.NULL)
        return geometry
    }

    private fun menuLabels(): JSONArray {
        var chrome: WebView? = null
        instrumentation.runOnMainSync { chrome = host.chrome }
        val view = chrome ?: return JSONArray()
        val raw = tabEval(view, "JSON.stringify(Array.prototype.map.call(document.querySelectorAll('button.zen-sheet-item'),function(el){return el.textContent.trim()}))")
        return runCatching { JSONArray(raw) }.getOrDefault(JSONArray())
    }

    /** Clicks the menu row labelled `label` in the chrome's document; false when there is no such row (the menu is gone, or in a submenu). */
    private fun pickMenuItem(label: String): Boolean {
        var chrome: WebView? = null
        instrumentation.runOnMainSync { chrome = host.chrome }
        val view = chrome ?: return false
        return tabEval(view, "(function(){var b=Array.prototype.find.call(document.querySelectorAll('button.zen-sheet-item'),function(el){return el.textContent.trim()===${JSONObject.quote(label)}});if(b)b.click();return String(!!b)})()") == "true"
    }

    /** The next `contextMenus.onClicked` the background recorded after `before`, or null. */
    private fun menuClick(bg: WebView, before: Int): JSONObject? {
        val raw = tabEval(bg, "JSON.stringify(report.menuClicks[$before] || null)")
        return if (raw == "null") null else json(raw)
    }

    /** How many tabs with exactly `url` the extension's background sees through `tabs.query({})`; -1 when the call failed. */
    private fun queryTabs(bg: WebView, url: String): Int {
        tabEval(
            bg,
            "(function(){window.__query=null;chrome.tabs.query({},function(tabs){window.__query=JSON.stringify(" +
                "{count:(tabs||[]).filter(function(t){return t.url===${JSONObject.quote(url)}}).length,error:chrome.runtime.lastError?chrome.runtime.lastError.message:null})})})()"
        )
        val raw = waitFor(10_000, 200) { val v = tabEval(bg, "window.__query"); if (v == "null") null else v } ?: return -1
        val result = json(raw)
        return if (result.isNull("error")) result.optInt("count", -1) else -1
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
            val entry = json(tabEval(view, NAV_TIMING))
            // With worlds the bootstrap's statistics live in each extension's world: the probe's
            // stand for the run (boot and match cost of one unit), and the groups of all are counted.
            if (worlds) {
                var applied = 0
                for (id in listOf(PROBE_ID, DARK_READER, VIMIUM, RYD, STYLUS, UBOL)) {
                    val report = worldEval(view, id, WORLD_REPORT)?.let(::json)?.optJSONObject("stats") ?: continue
                    applied += report.optJSONArray("groups")?.length() ?: 0
                    if (id == PROBE_ID) entry.put("bootMs", report.optDouble("bootMs", 0.0)).put("matchMs", report.optDouble("matchMs", 0.0))
                }
                entry.put("applied", applied)
            }
            list.put(entry)
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
        val sess = images.optString("sess")
        val ok = images.optString("ok")
        stage(
            PROBE_ID, "declarativeNetRequest",
            when {
                ads == "error" && dyn == "error" && sess == "error" && ok == "loaded" -> "PASS"
                ok == "loaded" && (ads == "error" || dyn == "error" || sess == "error") -> "PARTIAL"
                else -> "FAIL"
            },
            "static rule (ads=1)=$ads dynamic rule (dyn=1)=$dyn session rule (sess=1)=$sess control (ok=1)=$ok " +
                "(background: dynamicRules=${bg?.opt("dynamicRules")} sessionRules=${bg?.opt("sessionRules")})"
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

    /**
     * The probe's background view, woken when its MV3 worker has idled out: the lifecycle stops
     * a worker 30 s after its last bridge traffic, as Chrome does, and a stage that follows a slow
     * one finds it gone (measured on WebView 156 under the emulator's swangle renderer: the
     * private tab of the `privateTabs` stage, hidden from the probe while disallowed, took over
     * 30 s to load and the stage found no background). The wake is a `tabs.onUpdated` the probe
     * listens for, raised by a title change of the probe tab (`onReceivedTitle` → the runtime's
     * `onUpdated {title}`); a stopped worker is started for an event it has a listener for and
     * the event is held until it is ready. The title is put back once the worker is up. Null when
     * it never came up; `results.backgroundWakes` counts the wakes.
     */
    private fun probeBackground(timeoutMs: Long = 20_000): ExtensionWebView? {
        backgroundView(PROBE_ID)?.let { return it }
        val view = runCatching { waitForView(probeTab) }.getOrNull() ?: return null
        val title = tabEval(view, "(function(){var t=document.title;document.title=t+' \\u00b7 wake';return t})()")
        val woken = waitFor(timeoutMs, 300) { backgroundView(PROBE_ID) }
        tabEval(view, "document.title=${JSONObject.quote(title)}")
        if (woken == null) return null
        // The worker's `report` is fresh: its startup registers the listeners and the menu items.
        waitFor(10_000, 250) { if (tabEval(woken, "String(typeof report === 'object' && report.menuItems !== null)") == "true") true else null }
        results.put("backgroundWakes", results.optInt("backgroundWakes") + 1)
        return woken
    }

    private fun decisions(): List<String> {
        var list: List<String> = emptyList()
        instrumentation.runOnMainSync { list = synchronized(host.extensions.decisions) { host.extensions.decisions.toList() } }
        return list
    }

    /**
     * Matcher latency from the decision log ("verdict type <micros>us <cpuMicros>cpu url"):
     * count, median, p90, max of the wall-clock figure, and the same of the CPU figure under
     * `cpu` where the platform reports one.
     */
    private fun decisionMicros(all: List<String>): JSONObject {
        val micros = all.mapNotNull { line -> line.split(' ').getOrNull(2)?.removeSuffix("us")?.toLongOrNull() }.sorted()
        if (micros.isEmpty()) return JSONObject().put("count", 0)
        val out = JSONObject()
            .put("count", micros.size)
            .put("medianUs", micros[micros.size / 2])
            .put("p90Us", micros[(micros.size * 9) / 10])
            .put("maxUs", micros.last())
            .put("firstUs", all.firstOrNull()?.split(' ')?.getOrNull(2))
        val cpu = all.mapNotNull { line -> line.split(' ').getOrNull(3)?.removeSuffix("cpu")?.toLongOrNull() }.sorted()
        if (cpu.isNotEmpty()) {
            out.put(
                "cpu",
                JSONObject()
                    .put("count", cpu.size)
                    .put("medianUs", cpu[cpu.size / 2])
                    .put("p90Us", cpu[(cpu.size * 9) / 10])
                    .put("maxUs", cpu.last())
            )
        }
        return out
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
            // The tab model spells an extension page as Chrome does; a run on an older
            // runtime still shows the served origin. Either is the page.
            if (!ExtensionUrls.isExtensionUrl(url)) continue
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

    /**
     * `expression`, evaluated as `ext` itself would through `scripting.executeScript` (the host's
     * `ext.exec`): in the extension's isolated world on a WebView with worlds, else in the main
     * world as the named script the with-fallback shield knows as the extension's. The value, or
     * `rejected: <reason>`.
     */
    private fun extEval(tabId: String, ext: String, expression: String, timeoutSeconds: Long = 10): String {
        val latch = CountDownLatch(1)
        var value = "null"
        val args = JSONObject()
            .put("tabId", tabId).put("ext", ext).put("kind", "js").put("payload", JSONObject())
            .put("funcSource", "function(){return $expression}").put("args", JSONArray())
        instrumentation.runOnMainSync {
            host.extensions.handle("ext.exec", args) { result ->
                value = when (result) {
                    is Host.RawJson -> result.json.let { if (it.startsWith("\"")) runCatching { JSONObject("{\"v\":$it}").getString("v") }.getOrDefault(it) else it }
                    is Host.Rejection -> "rejected: ${result.message}"
                    else -> result.toString()
                }
                latch.countDown()
            }
        }
        latch.await(timeoutSeconds, TimeUnit.SECONDS)
        return value
    }

    private fun json(text: String): JSONObject = runCatching { JSONObject(text) }.getOrElse { JSONObject().put("raw", text) }

    /**
     * The request engine's decision for a subresource `url` of `documentUrl` whose type WebView
     * did not reveal (a `fetch`: the wildcard `Accept`, no telling extension), read from the
     * current snapshot without the side effects of an intercepted request.
     */
    private fun engineVerdict(url: String, documentUrl: String): JSONObject {
        val snapshot = host.blocking.snapshot
        val decision = snapshot.decide(
            Request(url, ResourceType.XMLHTTPREQUEST, documentUrl, "GET", typeMask = ResourceType.AMBIGUOUS_MASK)
        )
        return JSONObject()
            .put("url", url)
            .put("action", decision.action.name)
            .put("filter", decision.matchedFilter ?: JSONObject.NULL)
            .put("set", decision.matchedSet ?: JSONObject.NULL)
            .put("rule", decision.matchedRule)
            .put("filters", snapshot.filterCount)
            .put("sets", snapshot.setCount)
    }

    /**
     * A GET of `url` with `Origin: origin` from the emulator's own network stack (this thread, not
     * the WebView's): the status, the `Access-Control-Allow-Origin` it came with (null without
     * one), Cloudflare's `cf-mitigated` and the `server` header; `error` when nothing answered.
     * Tells a network that refuses the runner (a challenge page carries no CORS header) from a
     * WebView-side loss of the header.
     */
    private fun probeCors(url: String, origin: String): JSONObject {
        val out = JSONObject().put("url", url).put("origin", origin)
        return runCatching {
            val connection = URL(url).openConnection() as HttpURLConnection
            try {
                connection.connectTimeout = 10_000
                connection.readTimeout = 10_000
                connection.instanceFollowRedirects = true
                connection.setRequestProperty("Origin", origin)
                connection.setRequestProperty("Accept", "application/json, */*")
                out.put("status", connection.responseCode)
                out.put("allowOrigin", connection.getHeaderField("Access-Control-Allow-Origin") ?: JSONObject.NULL)
                out.put("cfMitigated", connection.getHeaderField("cf-mitigated") ?: JSONObject.NULL)
                out.put("server", connection.getHeaderField("Server") ?: JSONObject.NULL)
                out.put("contentType", connection.getHeaderField("Content-Type") ?: JSONObject.NULL)
            } finally {
                connection.disconnect()
            }
            out
        }.getOrElse { e -> out.put("error", e.toString()) }
    }

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
        File(out, "ext-android-runtime-$name.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
        bitmap.recycle()
    }

    private fun tap(x: Float, y: Float) {
        val down = SystemClock.uptimeMillis()
        inject(MotionEvent.ACTION_DOWN, down, down, x, y)
        SystemClock.sleep(60)
        inject(MotionEvent.ACTION_UP, down, SystemClock.uptimeMillis(), x, y)
    }

    /** A finger held still well past the long-press timeout (500 ms), then lifted. */
    private fun longPress(x: Float, y: Float) {
        val down = SystemClock.uptimeMillis()
        inject(MotionEvent.ACTION_DOWN, down, down, x, y)
        SystemClock.sleep(1_100)
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
        return findIn(root, label)
    }

    /**
     * `label` in any window on screen (the notification shade is the system UI's, not the
     * app's): the first node whose text or description equals it, as screen bounds.
     */
    private fun findInWindows(label: String): Rect? {
        val windows = runCatching { ui.windows }.getOrNull() ?: emptyList()
        for (window in windows) {
            val root = window.root ?: continue
            findIn(root, label)?.let { return it }
        }
        return findByLabel(label)
    }

    private fun findIn(root: AccessibilityNodeInfo, label: String): Rect? {
        val queue = ArrayDeque<AccessibilityNodeInfo>()
        queue.add(root)
        var visited = 0
        while (queue.isNotEmpty() && visited < 6_000) {
            val node = queue.removeFirst()
            visited++
            if (node.contentDescription?.toString() == label || node.text?.toString() == label) return Rect().also { node.getBoundsInScreen(it) }
            for (i in 0 until node.childCount) node.getChild(i)?.let(queue::add)
        }
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

        /** The probe background's `contextMenus.create` title for links (see its background.js). */
        private const val MENU_LINK_LABEL = "Probe: report this link"
        /** Polled from the first moments of a document, before it has a root element. */
        private const val PROBE_DONE = "String(!!document.documentElement && document.documentElement.getAttribute('data-zen-probe-done') === '1')"
        /** The probe's `probe.css` on the document (`injected`), whichever world its scripts run in; empty without it. */
        private const val PROBE_CSS = "getComputedStyle(document.documentElement).getPropertyValue('--zen-probe-css').trim()"
        private const val PROBE_REPORT =
            "JSON.stringify({start: document.__zenProbeStart || null, idle: document.__zenProbeIdle || null, page: window.__page || null, pageScript: window.__pageScript || null, stats: window.__zenExtStats || null, readyState: document.readyState, url: location.href})"
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
                "return JSON.stringify({hints:n,shadowRoots:roots,ui:document.querySelectorAll('.vimiumUIComponent,iframe[src*=\"vimium\"],[class*=\"vimium\"]').length,focused:document.hasFocus(),active:document.activeElement&&document.activeElement.tagName})})()"
        /** In the page's world, before the key: keep every key event the window sees (Vimium's own listener is on the window of its world). */
        private const val KEY_RECORDER =
            "(function(){window.__keys=[];['keydown','keypress','keyup'].forEach(function(t){window.addEventListener(t,function(e){window.__keys.push({type:t,key:e.key,code:e.code,keyCode:e.keyCode,trusted:e.isTrusted,target:e.target&&e.target.tagName||String(e.target)})},true)});return 'ok'})()"
        /**
         * Vimium's state in its world: its top-level `let`s are the world's script scope, which
         * a later script in the same world reads. Whether the frame is enabled and knows its id
         * (the `initializeFrame` handshake with the background), whether the key mapping arrived
         * (`chrome.storage.session`), and whether the key handler saw the press.
         */
        private const val VIMIUM_WORLD_REPORT =
            "(function(){try{return JSON.stringify({enabled:typeof isEnabledForUrl==='boolean'?isEnabledForUrl:null,frameId:typeof frameId==='undefined'?null:frameId," +
                "normalMode:typeof normalMode==='undefined'?null:(normalMode?{keyMapping:normalMode.keyMapping?Object.keys(normalMode.keyMapping).length:0,passKeys:normalMode.passKeys||null}:'null'),handlers:typeof handlerStack==='undefined'?null:handlerStack.stack.length," +
                "hud:typeof HUD,linkHints:typeof LinkHints,settingsLoaded:typeof Settings==='undefined'?null:Settings.isLoaded(),session:typeof chrome==='object'&&chrome.storage?typeof chrome.storage.session:null,runtimeId:typeof chrome==='object'&&chrome.runtime?chrome.runtime.id:null})}catch(e){return JSON.stringify({error:String(e&&e.message||e)})}})()"
        /**
         * The watch page as the main world sees it: the extension's elements (its rate bar and
         * tooltip, the marks it leaves on the buttons), the text it wrote into the dislike button
         * (YouTube's own mobile dislike button carries an icon and no text; the extension clones the
         * like count's template into it and writes the count, or "Temporarily Unavailable" when its
         * API request failed), its API requests in the resource timeline, the page's own
         * like/dislike bar (the first of the mobile layout's selectors present, '' before it
         * renders), the player's state, the open dialogs (the "Watch in YouTube app" upsell), and
         * the bootstrap statistics of the main-world groups.
         */
        private const val RYD_REPORT =
            "JSON.stringify({elements: document.querySelectorAll('[id*=\"return-youtube-dislike\"],[class*=\"ryd-\"],[id^=\"ryd-\"],[data-ryd-ratebar-wrapper],[data-ryd-video-id],[data-ryd-role]').length, " +
                "dislikeText: (function(b){return b ? b.innerText.replace(/\\s+/g,' ').trim().slice(0, 40) : ''})(document.querySelector('.slim-video-action-bar-actions [aria-label*=\"islike\"], ytm-slim-video-action-bar-renderer [aria-label*=\"islike\"]')), " +
                "apiEntries: performance.getEntriesByType('resource').filter(function(e){return e.name.indexOf('returnyoutubedislike')>=0}).map(function(e){return {name:e.name,size:e.transferSize,duration:Math.round(e.duration)}}), " +
                "actionBar: ['ytm-slim-video-action-bar-renderer','.slim-video-action-bar-actions','segmented-like-dislike-button-view-model','like-button-view-model','ytm-like-button-renderer'].find(function(s){return document.querySelector(s)}) || '', " +
                "video: (function(v){return v ? (v.paused ? 'paused' : (v.currentTime > 0 ? 'playing' : 'idle')) : 'none'})(document.querySelector('video')), " +
                "dialogs: document.querySelectorAll('dialog[open], [role=\"dialog\"]').length, " +
                "groups: (window.__zenExtStats && window.__zenExtStats.groups ? window.__zenExtStats.groups.length : 0), stats: window.__zenExtStats || null, readyState: document.readyState, title: document.title, url: location.href})"
        /** The centre of the first element matching `%SELECTOR%`, in CSS pixels of the viewport; null without one. */
        private const val ELEMENT_CENTRE =
            "JSON.stringify((function(el){if(!el)return null;var r=el.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2,w:r.width,h:r.height}})(document.querySelector('%SELECTOR%')))"

        /**
         * Close m.youtube.com's "Get the best experience / Watch in YouTube app" upsell dialog when
         * it is over the watch page (its close control is the dialog's only button with a Close
         * label); 'closed' when one was clicked, 'none' when no such dialog is up.
         */
        private const val YT_CLOSE_UPSELL =
            "(function(){var d=Array.prototype.find.call(document.querySelectorAll('dialog[open], [role=\"dialog\"]'),function(el){return /YouTube app|best experience/i.test(el.textContent||'')});" +
                "if(!d)return 'none';var c=d.querySelector('button[aria-label*=\"lose\"], [role=\"button\"][aria-label*=\"lose\"], button[aria-label*=\"ismiss\"]');if(!c)return 'no close button';c.click();return 'closed'})()"

        /** Whether Return YouTube Dislike reached the page's DOM: an element of its own, or text in the dislike button. */
        private fun rydDecorated(report: JSONObject): Boolean {
            val text = report.optString("dislikeText")
            return report.optInt("elements") > 0 || (text.isNotEmpty() && !text.equals("dislike", ignoreCase = true))
        }
        /** In the probe's background: inject a function and a stylesheet into the active tab, report to `window.__late`. */
        private const val LATE_INJECT =
            "(function(){window.__late=null;chrome.tabs.query({active:true,currentWindow:true},function(tabs){var t=tabs&&tabs[0];" +
                "if(!t){window.__late=JSON.stringify({error:'no active tab'});return}" +
                "chrome.scripting.executeScript({target:{tabId:t.id},func:function(){return {title:document.title,readyState:document.readyState,chrome:typeof chrome,probeStart:typeof document.__zenProbeStart}}})" +
                ".then(function(r){return chrome.scripting.insertCSS({target:{tabId:t.id},css:'body{outline:3px dashed rgb(255, 0, 128) !important}'}).then(function(){window.__late=JSON.stringify({exec:r})})})" +
                ".catch(function(e){window.__late=JSON.stringify({error:String(e&&e.message||e)})})})})()"
        /**
         * In the probe's background: list the active tab's frames, mark the first subframe by its
         * frame id, then every frame with `allFrames`; each marker appends its label to
         * `data-zen-frame-exec` on the document it ran in and returns the document's path.
         */
        private const val FRAMES_INJECT =
            "(function(){window.__frames=null;chrome.tabs.query({active:true,currentWindow:true},function(tabs){var t=tabs&&tabs[0];" +
                "if(!t){window.__frames=JSON.stringify({error:'no active tab'});return}var out={tab:t.url};" +
                "var mark=function(label){var d=document.documentElement;var v=d.getAttribute('data-zen-frame-exec');d.setAttribute('data-zen-frame-exec',v?v+','+label:label);return location.pathname};" +
                "chrome.webNavigation.getAllFrames({tabId:t.id}).then(function(frames){out.frames=(frames||[]).map(function(f){return {frameId:f.frameId,url:f.url}});" +
                "var sub=(frames||[]).filter(function(f){return f.frameId!==0});" +
                "var first=sub.length?chrome.scripting.executeScript({target:{tabId:t.id,frameIds:[sub[0].frameId]},func:mark,args:['sub']}).then(function(r){out.sub=r},function(e){out.subError=String(e&&e.message||e)}):Promise.resolve(out.subError='no subframe listed');" +
                "return first.then(function(){return chrome.scripting.executeScript({target:{tabId:t.id,allFrames:true},func:mark,args:['all']}).then(function(r){out.all=r},function(e){out.allError=String(e&&e.message||e)})})" +
                "}).catch(function(e){out.error=String(e&&e.message||e)}).then(function(){window.__frames=JSON.stringify(out)})})})()"
        /** From the top document of frames.html: the markers on it and on its same-origin inner frame. */
        private const val FRAME_MARKERS =
            "(function(){var top=document.documentElement;var inner;try{var d=frames[0].document.documentElement;inner={exec:d.getAttribute('data-zen-frame-exec'),script:d.getAttribute('data-zen-frame-script')}}catch(e){inner={error:String(e)}}" +
                "return JSON.stringify({topExec:top.getAttribute('data-zen-frame-exec'),topScript:top.getAttribute('data-zen-frame-script'),inner:inner})})()"
        /** A plain string into a script sink: "ok", or the TypeError a Trusted Types CSP raises. */
        private const val TT_SINK_PROBE =
            "(function(){try{var s=document.createElement('script');s.textContent='void 0';return 'ok'}catch(e){return 'refused: '+String(e&&e.message||e).slice(0,120)}})()"
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
