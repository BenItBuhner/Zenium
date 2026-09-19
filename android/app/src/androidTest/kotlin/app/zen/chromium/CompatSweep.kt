package app.zen.chromium

import android.content.Intent
import android.graphics.Rect
import android.os.Debug
import android.os.SystemClock
import android.util.Log
import android.view.KeyEvent
import android.view.View
import android.view.accessibility.AccessibilityNodeInfo
import android.view.accessibility.AccessibilityWindowInfo
import android.webkit.WebView
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.runner.lifecycle.ActivityLifecycleMonitorRegistry
import androidx.test.runner.lifecycle.Stage
import androidx.webkit.WebViewCompat
import app.zen.chromium.blocking.Blocking
import app.zen.chromium.ext.ExtensionWebView
import org.json.JSONArray
import org.json.JSONObject
import org.json.JSONTokener
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlin.math.roundToInt

/**
 * The top-30 compatibility sweep on the phone (Wave 3, mirroring the desktop sweep's method in
 * `internal/extensions/desktop-compat-sweep.md`): every extension of the list is installed from
 * its store through the merged store host (`extension.installFromStore` by id, the install prompt
 * answered with a touch), then graded on the five stages the desktop table has – install,
 * background clean, popup, options, core function – each with the concrete outcome, and disabled
 * again before the next one so the sweep fits the debug heap. The extensions' own console lines,
 * the bridge's failed replies and the error console go into the row as evidence.
 *
 * Grades match the desktop's: `P` (works), `PARTIAL` (came up but threw, or half of it), `F`
 * (absent or failed), `-` (the extension has no such surface), `n/m` (not measurable here: an
 * account, a merchant checkout) and `n/a` (a surface the phone has no equivalent of, such as a
 * DevTools panel). A flow that needs a keyboard or a mouse is graded on the emulator's key events
 * or a synthesised pointer event and says so in its note.
 *
 * Everything lands in `files/ext-compat-sweep/results.json` (rewritten after every extension, so
 * a run that dies keeps what it had) and `ext-android-compat-*.png`. The instrumentation argument
 * `only` (comma-separated ids) restricts the run to a subset; `skipInstall` keeps what an earlier
 * run left under `files/zen/extensions` instead of installing again.
 */
@RunWith(AndroidJUnit4::class)
class CompatSweep : DemoHarness("ext-store-demo-state.json", "ext-android-compat", "ext-compat-sweep") {
    override val tag = TAG
    private val results = JSONObject()
    private val rows = JSONArray()
    private val memory = MemorySampler()
    private var shots = 0
    private var fixtureTab = ""
    private var worlds = false
    private val host: Host get() = (activity as MainActivity).host
    private val arguments = InstrumentationRegistry.getArguments()
    private val only: Set<String>? = arguments.getString("only")?.split(',')?.map { it.trim() }?.filter { it.isNotEmpty() }?.toSet()
    /**
     * Ids that run after every other row (`last`, comma-separated; by default uBlock Origin MV2,
     * whose first start compiles 45 MB of filter lists into `chrome.storage.local`): a row that
     * takes the process down loses nothing but the rows behind it, and results.json keeps the rest.
     */
    private val last: Set<String> = arguments.getString("last")?.split(',')?.map { it.trim() }?.filter { it.isNotEmpty() }?.toSet()
        ?: setOf(UBO_MV2)
    private val skipInstall = arguments.getString("skipInstall") == "1"
    /** Prompts no reachable button answered on screen, answered through the chrome's command instead. */
    private var promptsAnsweredByCommand = 0
    /** Why the last prompt went through the command (the button's measurements), for the row's evidence. */
    private var lastPromptFallback: JSONObject? = null
    /** `zen()` calls so far: each gets its own answer slot in the chrome. */
    private var zenCalls = 0
    /** The text of every native dialog pressed away to get the chrome answering again. */
    private val dialogsDismissed = JSONArray()
    /** Each time something else had the screen when a finger was due (the launcher, Overview) and the browser was brought back. */
    private val screenRestored = JSONArray()

    private class Grade(val verdict: String, val note: String, val extra: JSONObject? = null)

    /** One row of the table: the store id, the name, a slug for the screenshots, the store when not the Chrome Web Store, and the core check. */
    private inner class Row(
        val id: String,
        val name: String,
        val slug: String,
        val store: String? = null,
        val feasible: Boolean = true,
        val core: (Row, JSONObject) -> Grade
    )

    /** The registry document of the earlier run, kept across the profile seed when `skipInstall` is set. */
    private var keptRegistry: String? = null

    @Test
    fun record() {
        if (!skipInstall) File(app.filesDir, "zen/extensions").deleteRecursively()
        else keptRegistry = File(app.filesDir, "zen/extensions.json").takeIf { it.isFile }?.readText()
        memory.start()
        try {
            runDemo()
        } finally {
            memory.stop()
            results.put("appProcessMemory", memory.report())
            results.put("promptsAnsweredByCommand", promptsAnsweredByCommand)
            results.put("screenRestored", screenRestored)
            write()
        }
    }

    /** The seeded tab opens the local fixture, not the network. */
    override fun patchState(json: String): String =
        json.replace("https://example.com/", "$BASE/page-a.html").replace("Example Domain", "Probe Page A")

    override fun seedMore(zen: File) {
        keptRegistry?.let { File(zen, "extensions.json").writeText(it) }
    }

    override fun warmUp() {
        val state = coreState()
        assertTrue("the Android host must turn the extension capability on", state.getJSONObject("capabilities").getBoolean("extensions"))
        instrumentation.runOnMainSync { worlds = host.extensions.isolatedWorlds }
        results.put("isolatedWorlds", worlds)
        results.put("webView", WebViewCompat.getCurrentWebViewPackage(app)?.let { "${it.packageName} ${it.versionName}" } ?: JSONObject.NULL)
        results.put("only", only?.let { JSONArray(it.toList()) } ?: JSONObject.NULL)
        results.put("startedAt", System.currentTimeMillis())
        // The core's toasts carry what an install refused to do (the store host toasts instead of rejecting).
        chromeJs("window.__toasts=[];window.zen.on('toast',function(p){window.__toasts.push(String(p&&p.message||p))});'ok'")
        // The prompts the chrome raises (install, permissions), by request id, so one its sheet
        // did not put a reachable button on screen can still be answered through the command.
        // The renderer answers a prompt through the same `window.zen.invoke` (a tap on its
        // button, a dismissed sheet): that answer takes the prompt off the list, so a tap that
        // did answer is never taken for one that did not and answered again through the command.
        chromeJs(
            "window.__prompts=[];window.__promptAnswers=[];" +
                "window.zen.on('extensionInstallRequest',function(p){window.__prompts.push({kind:'install',id:p.requestId,ok:p.okLabel||''})});" +
                "window.zen.on('extensionPermissionRequest',function(p){window.__prompts.push({kind:'permission',id:p.requestId,ok:p.okLabel||''})});" +
                "(function(){var z=window.zen,invoke=z.invoke;z.invoke=function(name,args){" +
                "if((name==='extension.confirmInstall'||name==='extension.respondPermissionRequest')&&args&&args.requestId){" +
                "window.__prompts=window.__prompts.filter(function(p){return p.id!==args.requestId});" +
                "window.__promptAnswers.push({id:args.requestId,accept:!!args.accept})}" +
                "return invoke.apply(z,arguments)}})();'ok'"
        )
        fixtureTab = tabIdByUrl("$BASE/page-a.html") ?: createTab("$BASE/page-a.html")
        showTab(fixtureTab)
        SystemClock.sleep(1_500)
    }

    override fun demo() {
        snap("browser-idle")
        // The table's order, the `last` ids moved to the end (a stable sort keeps the rest in place).
        val list = table.filter { only == null || it.id in only }.sortedBy { if (it.id in last) 1 else 0 }
        results.put("order", JSONArray(list.map { it.id }))
        results.put("heapAtStartKb", heapKb())
        for ((index, row) in list.withIndex()) {
            if (!chromeAnswers()) {
                // The chrome's JS is gone for good (a renderer wedged behind a dialog nothing
                // could press, a heap with no room left): every row behind this one would spend
                // its timeouts on nothing. Say so in each and stop.
                val reason = "the chrome stopped answering before this row" +
                    (dialogsDismissed.takeIf { it.length() > 0 }?.let { "; dialogs pressed away: $it" } ?: "")
                Log.e(TAG, "$reason (${row.name})")
                results.put("stoppedBefore", row.id)
                for (rest in list.drop(index)) {
                    rows.put(JSONObject().put("id", rest.id).put("name", rest.name).put("feasible", rest.feasible).put("crash", reason))
                }
                write()
                break
            }
            val entry = JSONObject().put("id", row.id).put("name", row.name).put("feasible", row.feasible)
            rows.put(entry)
            val started = SystemClock.uptimeMillis()
            try {
                // A row's core check is read off a page on screen: the browser back in front first.
                onScreen("before ${row.name}")
                sweep(index + 1, row, entry)
            } catch (e: Throwable) {
                Log.e(TAG, "${row.name}: the sweep threw", e)
                entry.put("crash", e.toString())
            } finally {
                runCatching { cleanup(row, entry) }.onFailure { entry.put("cleanupError", it.toString()) }
                entry.put("ms", SystemClock.uptimeMillis() - started)
                entry.put("pssKbAfter", Debug.getPss())
                entry.put("heapAfterKb", heapKb())
                entry.put("grade", listOf("background", "popup", "options", "core").joinToString("/") { entry.optJSONObject(it)?.optString("verdict") ?: "?" })
                Log.i(
                    TAG,
                    "ROW ${row.name}: install=${entry.optJSONObject("install")?.optString("verdict")} ${entry.optString("grade")}; " +
                        "heap enabled ${entry.optLong("heapEnabledKb", -1) / 1024} MB, after ${entry.optLong("heapAfterKb") / 1024} MB"
                )
                write()
            }
        }
        results.put("dialogsDismissed", dialogsDismissed)
        // Every row installed (and disabled) on the management page.
        runCatching {
            coreInvoke("urlbar.runCommand", """{"action":"addons.open"}""")
            waitFor("Add-ons and Themes", 10_000)
            beat()
            snap("addons-all")
        }
        results.put("finishedAt", System.currentTimeMillis())
    }

    // --- one extension ---------------------------------------------------------------------------

    private fun sweep(n: Int, row: Row, entry: JSONObject) {
        val slug = "${n.toString().padStart(2, '0')}-${row.slug}"
        entry.put("slug", slug)
        val ext = install(row, entry, slug) ?: return
        val dir = File(ext.optString("path"))
        val manifest = runCatching { JSONObject(File(dir, "manifest.json").readText().removePrefix("\uFEFF")) }.getOrNull()
        if (manifest == null) {
            stage(entry, "background", "F", "no readable manifest under ${dir.path}")
            return
        }
        entry.put("version", ext.optString("version")).put("manifestVersion", manifest.optInt("manifest_version"))
        background(row, entry, manifest)
        showTab(fixtureTab)
        popup(row, entry, manifest, slug)
        showTab(fixtureTab)
        options(row, entry, manifest, slug)
        showTab(fixtureTab)
        core(row, entry, slug)
        evidence(row, entry)
        // What the extension costs the Java heap while it runs (its units, its rules in the
        // Kotlin engine), against `heapAfterKb` once it is disabled, and the engine's snapshot.
        entry.put("heapEnabledKb", heapKb())
        entry.put("blockingEnabled", runCatching { Blocking.shared(app).stats() }.getOrNull() ?: JSONObject.NULL)
    }

    /**
     * The store install by id through the chrome's command API, the prompt answered on screen.
     * `P` once the record is enabled without an error; `F` with the error, the toast the host
     * showed instead, or the command's own rejection.
     */
    private fun install(row: Row, entry: JSONObject, slug: String): JSONObject? {
        val existing = extensions().firstOrNull { it.getString("id") == row.id }
        if (skipInstall && existing != null) {
            if (!existing.getBoolean("enabled")) {
                coreInvoke("extension.setEnabled", JSONObject().put("id", row.id).put("enabled", true).toString())
                poll(20_000, 400) { extensions().firstOrNull { it.getString("id") == row.id }?.takeIf { it.getBoolean("enabled") } }
            }
            val ext = extensions().firstOrNull { it.getString("id") == row.id } ?: existing
            stage(entry, "install", if (ext.isNull("error")) "P" else "F", "kept from the earlier run: v${ext.optString("version")}${if (ext.isNull("error")) "" else " error=${ext.optString("error")}"}")
            return ext.takeIf { it.isNull("error") }
        }
        chromeJs("window.__toasts=[];'ok'")
        val started = SystemClock.uptimeMillis()
        var promptMs = 0L
        var prompted = false
        var taps = 0
        lastPromptFallback = null
        val fallbacksBefore = promptsAnsweredByCommand
        val args = JSONObject().put("ref", row.id)
        if (row.store != null) args.put("store", row.store)
        val outcome = runCatching {
            zen("extension.installFromStore", args, INSTALL_TIMEOUT_MS) { button ->
                prompted = true
                taps++
                val up = SystemClock.uptimeMillis()
                SystemClock.sleep(900)
                if (row.id == table.first().id && taps == 1) snap("$slug-prompt")
                tapRect(button)
                promptMs += SystemClock.uptimeMillis() - up
            }
        }
        val total = SystemClock.uptimeMillis() - started
        val ext = poll(20_000, 400) { extensions().firstOrNull { it.getString("id") == row.id } }
        // `evaluateJavascript` hands the stringified array back as a JSON string: unquote, then parse.
        val toasts = runCatching { JSONArray(JSONTokener(chromeJs("JSON.stringify(window.__toasts||[])")).nextValue() as String) }.getOrDefault(JSONArray())
        val byCommand = promptsAnsweredByCommand > fallbacksBefore
        // The answers the renderer itself gave (a tap on the sheet's button, a dismissed sheet).
        val rendererAnswers = runCatching {
            JSONArray(JSONTokener(chromeJs("JSON.stringify((window.__promptAnswers||[]).splice(0))")).nextValue() as String)
        }.getOrDefault(JSONArray())
        val detail = JSONObject()
            .put("ms", total - promptMs)
            .put("promptMs", promptMs)
            .put("prompted", prompted || byCommand)
            .put("promptAnsweredBy", if (byCommand) "command" else if (prompted) "tap" else JSONObject.NULL)
            .put("rendererAnswers", rendererAnswers)
            .put("promptTaps", taps)
            .put("promptFallback", lastPromptFallback ?: JSONObject.NULL)
            .put("toasts", toasts)
            .put("commandError", outcome.exceptionOrNull()?.message ?: JSONObject.NULL)
        if (ext != null) {
            val dir = File(ext.optString("path"))
            detail.put("version", ext.optString("version"))
                .put("source", ext.optString("source"))
                .put("files", dir.walkTopDown().count { it.isFile })
                .put("bytesOnDisk", dir.walkTopDown().filter { it.isFile }.sumOf { it.length() })
                .put("permissions", ext.optJSONArray("permissions"))
                .put("hostPermissions", ext.optJSONArray("hostPermissions"))
                .put("warnings", ext.optJSONArray("warnings"))
        }
        val toastText = (0 until toasts.length()).joinToString(" | ") { toasts.optString(it) }
        when {
            ext == null -> stage(
                entry, "install", "F",
                "no record after ${total / 1000} s: ${outcome.exceptionOrNull()?.message ?: "the command settled without one"}${if (toastText.isNotEmpty()) "; toast: $toastText" else ""}${if (!prompted && !byCommand) "; no install prompt was shown" else if (byCommand) "; the prompt was answered through the command (${lastPromptFallback?.optString("reason")})" else ""}",
                detail
            )
            !ext.isNull("error") -> stage(entry, "install", "F", "installed v${ext.optString("version")} but the runtime refused it: ${ext.optString("error")}", detail)
            !ext.getBoolean("enabled") -> stage(entry, "install", "F", "installed v${ext.optString("version")} but not enabled${if (toastText.isNotEmpty()) "; toast: $toastText" else ""}", detail)
            else -> stage(
                entry, "install", "P",
                "v${ext.optString("version")} from ${ext.optString("source")} in ${(total - promptMs) / 1000.0} s (+${promptMs} ms in the prompt, answered by ${if (byCommand) "the command: ${lastPromptFallback?.optString("reason")}" else if (prompted) "a tap" else "nobody – none was shown"}), ${detail.optInt("files")} files, ${detail.optLong("bytesOnDisk") / 1024} KB",
                detail
            )
        }
        if (ext == null || !ext.isNull("error") || !ext.getBoolean("enabled")) {
            snap("$slug-install-failed")
            return null
        }
        return ext
    }

    /**
     * The background per the manifest (an MV3 worker, an MV2 page) comes up in its own view and
     * throws nothing in its first seconds: `P`; up with an uncaught exception: `PARTIAL`; never
     * up: `F`. Its console lines and the runtime's configure statistics are the evidence.
     */
    private fun background(row: Row, entry: JSONObject, manifest: JSONObject) {
        val bg = manifest.optJSONObject("background")
        val kind = when {
            bg == null -> null
            bg.has("service_worker") -> "service_worker"
            bg.has("page") || bg.has("scripts") -> "background_page"
            else -> null
        }
        if (kind == null) {
            stage(entry, "background", "-", "no background in the manifest")
            return
        }
        val started = SystemClock.uptimeMillis()
        val view = poll(BACKGROUND_TIMEOUT_MS, 500) { backgroundView(row.id) }
        val upMs = SystemClock.uptimeMillis() - started
        var configure: JSONObject? = null
        instrumentation.runOnMainSync { configure = host.extensions.configureStats[row.id] }
        val detail = JSONObject().put("kind", kind).put("upMs", if (view != null) upMs else -1).put("configure", configure ?: JSONObject.NULL)
        if (view == null) {
            val ext = extensions().firstOrNull { it.getString("id") == row.id }
            stage(entry, "background", "F", "no $kind view within ${BACKGROUND_TIMEOUT_MS / 1000} s (record error: ${ext?.optString("error")?.ifEmpty { null } ?: "none"}; configured: ${configure != null})", detail)
            return
        }
        SystemClock.sleep(BACKGROUND_SETTLE_MS)
        // The view may have idled out already (an MV3 worker stops 30 s after its last traffic); its console outlived it.
        val console = consoleOf(view)
        val uncaught = console.filter(::isUncaught)
        val errors = console.filter { it.startsWith("ERROR ") && !isUncaught(it) }
        detail.put("console", JSONArray(console.takeLast(30)))
        detail.put("url", runCatching { tabEval(view, "location.href", 5) }.getOrDefault("?"))
        stage(
            entry, "background",
            if (uncaught.isEmpty()) "P" else "PARTIAL",
            "$kind up after ${upMs / 1000.0} s" +
                (if (uncaught.isNotEmpty()) "; uncaught: ${uncaught.take(3).joinToString(" | ") { it.take(200) }}" else "") +
                (if (errors.isNotEmpty()) "; console.error x${errors.size}: ${errors.first().take(160)}" else ""),
            detail
        )
    }

    /**
     * The popup in the phone's bottom sheet: `P` when its document rendered (text or more than a
     * handful of elements) without an uncaught exception, `PARTIAL` when it rendered but threw,
     * `F` when the sheet never had a document. An action without a popup fires `onClicked`; a tab
     * it opens counts as the extension's answer (the desktop grades it the same way).
     */
    private fun popup(row: Row, entry: JSONObject, manifest: JSONObject, slug: String) {
        val action = manifest.optJSONObject("action") ?: manifest.optJSONObject("browser_action")
        val declared = action?.optString("default_popup", "")?.ifEmpty { null }
        val ext = extensions().firstOrNull { it.getString("id") == row.id }
        // The runtime's word on the popup after `action.setPopup` (null: clicks fire onClicked).
        val runtimePopup = ext?.let { if (it.isNull("popup")) null else it.optString("popup") }
        if (declared == null && runtimePopup == null) {
            stage(entry, "popup", "-", "no default_popup")
            return
        }
        val tabsBefore = tabUrls().keys
        coreInvoke("extension.openPopup", """{"id":${JSONObject.quote(row.id)},"anchor":{"x":0,"y":0,"width":0,"height":0}}""")
        val view = poll(POPUP_TIMEOUT_MS, 400) {
            val v = popupView()
            if (v != null && v.context == "popup" && rendered(v)) v else null
        }
        SystemClock.sleep(1_800)
        snap("$slug-popup")
        val live = popupView()
        val detail = JSONObject().put("declared", declared ?: JSONObject.NULL).put("runtimePopup", runtimePopup ?: JSONObject.NULL)
        if (live != null) {
            detail.put("console", JSONArray(consoleOf(live).takeLast(20)))
            detail.put("dom", json(tabEval(live, DOM_REPORT)))
            detail.put("sheet", sheetSize(live))
        }
        when {
            view != null -> {
                val dom = detail.optJSONObject("dom") ?: JSONObject()
                val uncaught = (live?.let(::consoleOf) ?: emptyList()).filter(::isUncaught)
                val sheet = detail.optJSONObject("sheet") ?: JSONObject()
                val overflow = dom.optInt("scrollWidth") > dom.optInt("innerWidth") + 2
                entry.put("popupText", dom.optString("text"))
                stage(
                    entry, "popup",
                    if (uncaught.isEmpty()) "P" else "PARTIAL",
                    "${dom.optInt("w")}x${dom.optInt("h")} css px in a ${sheet.optInt("widthDp")}x${sheet.optInt("heightDp")} dp sheet, ${dom.optInt("els")} elements, text \"${dom.optString("text").take(80)}\"" +
                        (if (overflow) "; overflows the sheet horizontally (scrollWidth ${dom.optInt("scrollWidth")} > ${dom.optInt("innerWidth")})" else "") +
                        (if (uncaught.isNotEmpty()) "; uncaught: ${uncaught.take(2).joinToString(" | ") { it.take(160) }}" else ""),
                    detail
                )
            }
            else -> {
                val opened = tabUrls().filterKeys { it !in tabsBefore }.values.toList()
                detail.put("openedTabs", JSONArray(opened))
                if (runtimePopup == null && opened.isNotEmpty()) {
                    entry.put("popupOpened", JSONArray(opened))
                    stage(entry, "popup", "P", "no popup (the extension emptied it with action.setPopup); the click fired action.onClicked, which opened ${opened.joinToString().take(160)}", detail)
                } else if (live != null) {
                    val dom = detail.optJSONObject("dom") ?: JSONObject()
                    stage(entry, "popup", "PARTIAL", "the sheet came up but its document stayed empty after ${POPUP_TIMEOUT_MS / 1000} s: ${dom.toString().take(200)}; console: ${detail.optJSONArray("console")?.toString()?.take(200)}", detail)
                } else {
                    stage(entry, "popup", "F", "no popup sheet within ${POPUP_TIMEOUT_MS / 1000} s (runtime popup=${runtimePopup ?: "null"}, declared=$declared, tabs opened=${opened.size})", detail)
                }
            }
        }
        coreInvoke("extension.closePopup", "null")
        SystemClock.sleep(900)
        closeExtraTabs()
    }

    /**
     * The options page: in the sheet chassis (`options_ui`) or in a tab (`open_in_tab`, or an
     * `options_page`). `P` when the document rendered without an uncaught exception.
     */
    private fun options(row: Row, entry: JSONObject, manifest: JSONObject, slug: String) {
        val optionsUi = manifest.optJSONObject("options_ui")
        val page = optionsUi?.optString("page", "")?.ifEmpty { null } ?: manifest.optString("options_page", "").ifEmpty { null }
        if (page == null) {
            stage(entry, "options", "-", "no options page")
            return
        }
        val tabsBefore = tabUrls().keys
        coreInvoke("extension.openOptions", """{"id":${JSONObject.quote(row.id)}}""")
        var where = ""
        var tabId: String? = null
        val view: WebView? = poll(OPTIONS_TIMEOUT_MS, 500) {
            val sheet = popupView()
            if (sheet != null && sheet.context == "options" && rendered(sheet)) {
                where = "sheet"
                return@poll sheet
            }
            // The page may put up a dialog (an alert) that blocks the renderer the chrome shares: press it away and look again.
            val urls = runCatching { tabUrls() }.getOrElse {
                dismissDialog()?.let { text -> Log.w(TAG, "${row.name} options: a dialog pressed away: $text") }
                return@poll null
            }
            val opened = urls.filterKeys { it !in tabsBefore }.entries.firstOrNull { it.value.contains(".ext.zenium.invalid/") }
            if (opened != null) {
                var v: TabWebView? = null
                instrumentation.runOnMainSync { v = host.tabs.get(opened.key) }
                val tabView = v
                if (tabView != null && rendered(tabView)) {
                    where = "tab"
                    tabId = opened.key
                    return@poll tabView
                }
            }
            null
        }
        SystemClock.sleep(1_800)
        snap("$slug-options")
        val detail = JSONObject().put("page", page).put("openInTab", optionsUi?.optBoolean("open_in_tab", false) ?: (optionsUi == null)).put("where", where)
        if (view != null) {
            val dom = json(tabEval(view, DOM_REPORT))
            val console = consoleOf(view)
            val uncaught = console.filter(::isUncaught)
            detail.put("dom", dom).put("console", JSONArray(console.takeLast(20)))
            if (view is ExtensionWebView) detail.put("sheet", sheetSize(view))
            stage(
                entry, "options",
                if (uncaught.isEmpty()) "P" else "PARTIAL",
                "in a $where: ${dom.optInt("els")} elements, ${dom.optInt("w")}x${dom.optInt("h")} css px, text \"${dom.optString("text").take(80)}\" (${dom.optString("url").substringAfter(".ext.zenium.invalid").take(60)})" +
                    (if (uncaught.isNotEmpty()) "; uncaught: ${uncaught.take(2).joinToString(" | ") { it.take(160) }}" else ""),
                detail
            )
        } else {
            val sheet = popupView()
            val opened = tabUrls().filterKeys { it !in tabsBefore }.values.toList()
            detail.put("openedTabs", JSONArray(opened))
            if (sheet != null) detail.put("sheetDom", json(tabEval(sheet, DOM_REPORT))).put("sheetConsole", JSONArray(consoleOf(sheet).takeLast(20)))
            stage(
                entry, "options",
                if (sheet != null || opened.isNotEmpty()) "PARTIAL" else "F",
                if (sheet != null) "the options sheet came up but its document stayed empty after ${OPTIONS_TIMEOUT_MS / 1000} s: ${detail.optJSONObject("sheetDom")?.toString()?.take(200)}"
                else if (opened.isNotEmpty()) "a tab opened (${opened.joinToString().take(120)}) but never rendered within ${OPTIONS_TIMEOUT_MS / 1000} s"
                else "no options sheet or tab within ${OPTIONS_TIMEOUT_MS / 1000} s",
                detail
            )
        }
        coreInvoke("extension.closePopup", "null")
        tabId?.let { closeTab(it) }
        SystemClock.sleep(900)
        closeExtraTabs()
    }

    private fun core(row: Row, entry: JSONObject, slug: String) {
        val started = SystemClock.uptimeMillis()
        val grade = try {
            row.core(row, entry)
        } catch (e: Throwable) {
            Log.e(TAG, "${row.name}: core check threw", e)
            Grade("F", "core check threw: $e")
        }
        SystemClock.sleep(600)
        snap("$slug-core")
        val extra = (grade.extra ?: JSONObject()).put("ms", SystemClock.uptimeMillis() - started)
        stage(entry, "core", grade.verdict, grade.note, extra)
        closeExtraTabs()
    }

    /** What the run left as evidence besides the stages: the error console, the bridge's failed replies, the call statistics. */
    private fun evidence(row: Row, entry: JSONObject) {
        val ext = extensions().firstOrNull { it.getString("id") == row.id }
        val errors = ext?.optJSONArray("errors") ?: JSONArray()
        entry.put(
            "errorConsole",
            JSONArray((0 until errors.length()).map { i ->
                val e = errors.getJSONObject(i)
                "${e.optString("level")} ${e.optString("source")} x${e.optInt("count")} ${e.optString("message").lineSequence().first().take(200)}"
            })
        )
        var trace: List<String> = emptyList()
        var calls: Map<String, IntArray> = emptyMap()
        instrumentation.runOnMainSync {
            trace = host.extensions.traceSnapshot(row.id)
            calls = host.extensions.callStatsSnapshot().filterKeys { it.startsWith("${row.id} ") }
        }
        entry.put("bridgeErrors", JSONArray(trace.filter { it.contains(" reply error=") }.takeLast(20)))
        val table = JSONObject()
        for ((key, counts) in calls.toSortedMap()) table.put(key.substringAfter(' '), JSONArray().put(counts[0]).put(counts[1]).put(counts[2]))
        entry.put("calls", table)
        backgroundView(row.id)?.let { entry.put("backgroundConsoleAtEnd", JSONArray(consoleOf(it).takeLast(30))) }
    }

    /** Tabs the extension opened go, the extension is disabled: the next row starts from the same place. */
    private fun cleanup(row: Row, entry: JSONObject) {
        runCatching { coreInvoke("extension.closePopup", "null") }
        closeExtraTabs()
        val ext = extensions().firstOrNull { it.getString("id") == row.id }
        if (ext != null && ext.getBoolean("enabled")) {
            coreInvoke("extension.setEnabled", JSONObject().put("id", row.id).put("enabled", false).toString())
            val off = poll(20_000, 400) { extensions().firstOrNull { it.getString("id") == row.id }?.takeIf { !it.getBoolean("enabled") } }
            entry.put("disabled", off != null)
            // The runtime detaches: its background view goes with it.
            val gone = poll(10_000, 300) { if (backgroundView(row.id) == null) true else null }
            entry.put("backgroundGoneAfterDisable", gone == true)
        }
        runCatching { showTab(fixtureTab) }
        SystemClock.sleep(1_000)
    }

    // --- the core checks -------------------------------------------------------------------------

    /**
     * The tracker page requests eight third-party scripts every default list blocks and a local
     * control stylesheet; the verdict comes from the layer's own decision log (block or redirect,
     * as uBOL redirects to its neutered scripts) with the page's `onerror` beside it. The desktop's
     * bar: three or more hosts stopped, the control loaded.
     */
    private fun adBlocker(row: Row, entry: JSONObject): Grade {
        val tab = createTab("$BASE/sweep-ads.html")
        val view = waitForView(tab)
        poll(30_000, 500) { if (tabEval(view, "String(Object.keys(window.__ads || {}).length >= 9)") == "true") true else null }
        SystemClock.sleep(1_500)
        val ads = json(tabEval(view, "JSON.stringify(window.__ads || {})"))
        val all = decisions()
        val verdicts = JSONObject()
        var stopped = 0
        val stoppedNames = ArrayList<String>()
        for ((name, host) in TRACKER_HOSTS) {
            val decision = all.lastOrNull { it.substringAfterLast(' ').contains("://$host/") }?.substringBefore(' ') ?: "unseen"
            val page = ads.optString(name, "pending")
            verdicts.put(name, "$decision/$page")
            if (decision == "block" || decision == "redirect" || page == "error") {
                stopped++
                stoppedNames += host
            }
        }
        val control = ads.optString("control", "pending")
        val controlDecision = all.lastOrNull { it.contains("probe-page.css?control=1") }?.substringBefore(' ') ?: "unseen"
        val badge = extensionAction(row.id)?.optString("badgeText") ?: ""
        var ruleSets: JSONArray? = null
        var engine: JSONObject? = null
        instrumentation.runOnMainSync {
            ruleSets = host.extensions.ruleSetStats()
            engine = host.blocking.stats()
        }
        val extra = JSONObject().put("ads", ads).put("verdicts", verdicts).put("badge", badge).put("decisions", JSONArray(all.takeLast(40)))
            .put("ruleSets", ruleSets ?: JSONArray()).put("engine", engine ?: JSONObject())
        val note = "$stopped of ${TRACKER_HOSTS.size} tracker hosts stopped (${stoppedNames.joinToString()}); control=$control/$controlDecision; badge=\"$badge\"; per host decision/page: $verdicts"
        return when {
            stopped >= 3 && control == "loaded" && controlDecision != "block" -> Grade("P", note, extra)
            stopped > 0 -> Grade("PARTIAL", note, extra)
            else -> Grade("F", "nothing stopped: $note", extra)
        }
    }

    private fun darkReader(row: Row, entry: JSONObject): Grade {
        val tab = createTab("$BASE/page-a.html?dark")
        val view = waitForView(tab)
        val expr = "JSON.stringify({pass: document.documentElement.hasAttribute('data-darkreader-mode') && !!document.querySelector('style.darkreader, style[class*=\"darkreader\"]'), " +
            "mode: document.documentElement.getAttribute('data-darkreader-mode'), scheme: document.documentElement.getAttribute('data-darkreader-scheme'), " +
            "styles: document.querySelectorAll('style.darkreader, style[class*=darkreader]').length, bg: getComputedStyle(document.body).backgroundColor, " +
            "styleSheetsGetterNative: /native code/.test(String((Object.getOwnPropertyDescriptor(Document.prototype, 'styleSheets') || {}).get)), wasEnabledForHost: sessionStorage.getItem('__darkreader__wasEnabledForHost')})"
        val found = pollExpr(view, expr, 20_000)
        val extra = JSONObject().put("page", found).put("console", JSONArray(consoleOf(view).takeLast(10)))
        if (worlds) worldEval(view, row.id, WORLD_REPORT)?.let { extra.put("world", json(it)) }
        val oneRealm = !worlds && !found.optBoolean("pass") && found.optString("wasEnabledForHost") == "false"
        return Grade(
            if (found.optBoolean("pass")) "P" else "F",
            "page darkened: ${found.toString().take(260)}" +
                if (oneRealm) " (one realm below Chromium 146: its MAIN-world proxy.js hides its sheets from its own detector, which takes the theme for the page's and removes it)" else "",
            extra
        )
    }

    /** Password managers and clippers: the popup (a sign-in screen, or an account-backed frame) is the whole reachable surface. */
    private fun popupLogin(label: String): (Row, JSONObject) -> Grade = { _, entry ->
        val popup = entry.optJSONObject("popup")
        val opened = entry.optJSONArray("popupOpened")
        val text = entry.optString("popupText")
        val login = Regex("log ?in|sign ?in|create account|get started|continue|welcome|email|unlock|password", RegexOption.IGNORE_CASE)
        when {
            opened != null && opened.length() > 0 -> {
                val url = opened.optString(0)
                val tabId = tabUrls().entries.firstOrNull { it.value == url }?.key
                val dom = tabId?.let { id -> runCatching { json(tabEval(waitForView(id), DOM_REPORT)) }.getOrNull() }
                val txt = dom?.optString("text") ?: ""
                Grade(if (login.containsMatchIn(txt)) "n/m" else "F", "$label: the action click opened ${url.take(90)} (\"${txt.take(80)}\"); the vault itself needs an account (not measurable here)")
            }
            popup?.optString("verdict") in setOf("P", "PARTIAL") ->
                Grade(
                    "n/m",
                    if (login.containsMatchIn(text)) "$label: popup shows its sign-in screen (\"${text.take(80)}\"); the vault / sync itself needs an account (not measurable here)"
                    else "$label: popup renders (${if (text.isNotEmpty()) "\"${text.take(80)}\"" else "account-backed content, blank until sign-in"}); the core needs an account (not measurable here)"
                )
            else -> Grade("F", "$label: popup did not render (${popup?.optString("note")?.take(160)})")
        }
    }

    /** Vimium: `f` on a page with links opens its hint markers; a keyboard flow, graded on the emulator's key events. */
    private fun vimium(row: Row, entry: JSONObject): Grade {
        val tab = createTab("$BASE/editor.html?vimium")
        val view = waitForView(tab)
        poll(20_000, 400) { if (tabEval(view, "String(document.readyState === 'complete')") == "true") true else null }
        SystemClock.sleep(3_000)
        tabEval(view, KEY_RECORDER)
        val heading = screenPoint(view, json(tabEval(view, ELEMENT_CENTRE.replace("%SELECTOR%", "h1"))))
        tap(heading?.first ?: (width / 2f), heading?.second ?: (height * 0.3f))
        SystemClock.sleep(700)
        key(KeyEvent.KEYCODE_F)
        val expr = "(function(){var n=document.querySelectorAll('.vimiumHintMarker, div[class*=\"vimiumHintMarker\"]').length,roots=0;document.querySelectorAll('*').forEach(function(el){if(el.shadowRoot){roots++;n+=el.shadowRoot.querySelectorAll('.vimiumHintMarker').length}});" +
            "var hud=document.querySelector('iframe.vimiumHUDFrame, .vimiumHUD, iframe[class*=\"vimium\"]');return JSON.stringify({pass:n>=3,hints:n,hud:!!hud,shadowRoots:roots,keys:(window.__keys||[]).length})})()"
        val found = pollExpr(view, expr, 8_000)
        SystemClock.sleep(800)
        val extra = JSONObject().put("page", found).put("pageKeys", json(tabEval(view, "JSON.stringify({keys: window.__keys || null})")))
        if (worlds) worldEval(view, row.id, VIMIUM_WORLD_REPORT)?.let { extra.put("world", json(it)) }
        key(KeyEvent.KEYCODE_ESCAPE)
        return Grade(
            if (found.optBoolean("pass")) "P" else "F",
            "link hints on \"f\" (keyboard flow: the emulator's key events, as a hardware keyboard sends them): ${found.toString().take(200)}" +
                if (!found.optBoolean("pass")) "; world: ${extra.optJSONObject("world")?.toString()?.take(200) ?: "n/a"}" else "",
            extra
        )
    }

    /**
     * A userscript manager: opening `hello.user.js` lands on the manager's install page (a tab
     * of its own), its Install button is clicked from the page, and the target page then carries
     * the script's marker. `chrome.userScripts` on the phone is served without the desktop's
     * "Allow user scripts" reload, so the toggle is only set.
     */
    private fun userscripts(row: Row, entry: JSONObject, installPage: Regex): Grade {
        coreInvoke("extension.setAllowUserScripts", JSONObject().put("id", row.id).put("allowed", true).toString())
        SystemClock.sleep(2_500)
        val extra = JSONObject()
        val before = tabUrls().keys
        createTab("$BASE/hello.user.js")
        val installTab = poll(30_000, 500) {
            tabUrls().entries.firstOrNull { it.key !in before && it.value.contains(".ext.zenium.invalid/") && installPage.containsMatchIn(it.value) }
        }
        extra.put("tabsAfterOpen", JSONArray(tabUrls().values.toList()))
        if (installTab == null) {
            return Grade("F", "install page never appeared within 30 s: tabs=${tabUrls().values.joinToString().take(200)}", extra)
        }
        extra.put("installUrl", installTab.value)
        val installView = waitForView(installTab.key)
        SystemClock.sleep(3_500)
        snap("${entry.optString("slug")}-userscript-install")
        val click = json(
            tabEval(
                installView,
                "(function(){var label=function(n){return (n.value||n.textContent||'').trim()};var visible=function(n){return n.offsetParent!==null};" +
                    "var isInstall=function(n){return /^(install|confirm installation)$/i.test(label(n))&&visible(n)};" +
                    "var buttons=Array.prototype.slice.call(document.querySelectorAll('button, input[type=button], input[type=submit]'));var nodes=Array.prototype.slice.call(document.querySelectorAll('a, [role=button], div, span'));" +
                    "var hit=buttons.find(isInstall)||nodes.find(isInstall);if(!hit)return JSON.stringify({clicked:false,buttons:buttons.map(label).slice(0,10)});hit.click();return JSON.stringify({clicked:true,label:label(hit)})})()"
            )
        )
        extra.put("click", click)
        SystemClock.sleep(4_000)
        val bg = backgroundView(row.id)
        if (bg != null) {
            tabEval(bg, "(function(){window.__us=null;Promise.resolve().then(function(){return chrome.userScripts.getScripts()}).then(function(s){window.__us=JSON.stringify({registered:s.length})},function(e){window.__us=JSON.stringify({error:String(e&&e.message||e)})})})()")
            poll(8_000, 250) { val v = tabEval(bg, "window.__us"); if (v == "null") null else v }?.let { extra.put("userScripts", json(it)) }
        } else extra.put("userScripts", "no background view")
        val target = createTab("$BASE/us-target.html")
        val targetView = waitForView(target)
        val page = pollExpr(targetView, "JSON.stringify({pass: !!document.documentElement.dataset.userscript, title: document.title, dataset: document.documentElement.dataset.userscript || null})", 20_000)
        extra.put("target", page).put("targetConsole", JSONArray(consoleOf(targetView).takeLast(10)))
        return Grade(
            if (page.optBoolean("pass")) "P" else "F",
            "install page opened (${installTab.value.substringAfter(".ext.zenium.invalid").take(50)}), install click ${click.toString().take(120)}, userScripts: ${extra.opt("userScripts")}, target page: ${page.toString().take(160)}",
            extra
        )
    }

    /**
     * A YouTube watch page: the phone WebView lands on m.youtube.com; `desktopSite` asks for the
     * desktop site instead (extensions whose scripts match `www.youtube.com` alone). The page's
     * upsell dialog is closed when it comes up; a consent interstitial makes the check `n/m`.
     */
    private fun youtube(row: Row, entry: JSONObject, expr: String, label: String, desktopSite: Boolean = false, settleMs: Long = 45_000): Grade {
        val tab = createTab(YOUTUBE_URL)
        if (desktopSite) {
            coreInvoke("tab.setDesktopSite", JSONObject().put("tabId", tab).put("on", true).toString())
            SystemClock.sleep(1_000)
        }
        val view = waitForView(tab)
        var upsells = 0
        var found = JSONObject()
        val started = SystemClock.uptimeMillis()
        poll(settleMs, 1_500) {
            found = json(tabEval(view, expr))
            if (tabEval(view, YT_CLOSE_UPSELL) == "closed") upsells++
            if (found.optBoolean("pass")) true else null
        }
        val where = json(tabEval(view, "JSON.stringify({url: location.href, title: document.title, readyState: document.readyState, video: (function(v){return v ? (v.paused ? 'paused' : 'playing') : 'none'})(document.querySelector('video'))})"))
        val extra = JSONObject().put("page", found).put("where", where).put("upsellsClosed", upsells).put("desktopSite", desktopSite)
            .put("waitedMs", SystemClock.uptimeMillis() - started).put("console", JSONArray(consoleOf(view).takeLast(15)))
        if (worlds) worldEval(view, row.id, WORLD_REPORT)?.let { extra.put("world", json(it)) }
        val url = where.optString("url")
        val host = runCatching { android.net.Uri.parse(url).host ?: "" }.getOrDefault("")
        return when {
            host.contains("consent") || url.contains("consent.youtube") -> Grade("n/m", "$label: YouTube served its consent interstitial instead of the watch page ($url)", extra)
            !(host == "youtube.com" || host.endsWith(".youtube.com")) -> Grade("n/m", "$label: the tab landed on ${host.ifEmpty { "nowhere" }}, not a watch page (network)", extra)
            found.optBoolean("pass") -> Grade("P", "$label${if (desktopSite) " (desktop site)" else ""}: ${found.toString().take(220)} on $host", extra)
            else -> Grade("F", "$label${if (desktopSite) " (desktop site)" else ""}: ${found.toString().take(220)} on $host after ${(SystemClock.uptimeMillis() - started) / 1000} s (title ${JSONObject.quote(where.optString("title").take(40))}, video ${where.optString("video")})", extra)
        }
    }

    /** Enhancer for YouTube matches `www.youtube.com` alone: the mobile site first, then the desktop site of the same tab. */
    private fun enhancerForYouTube(row: Row, entry: JSONObject): Grade {
        val expr = "(function(){var els=document.querySelectorAll('[id^=\"efyt\"], [class*=\"efyt\"]');return JSON.stringify({pass:els.length>0,n:els.length,ids:Array.prototype.slice.call(els).map(function(e){return e.id||String(e.className).split(' ')[0]}).slice(0,6)})})()"
        val mobile = youtube(row, entry, expr, "Enhancer controls injected", desktopSite = false, settleMs = 25_000)
        if (mobile.verdict == "P" || mobile.verdict == "n/m") return mobile
        closeExtraTabs()
        val desktop = youtube(row, entry, expr, "Enhancer controls injected", desktopSite = true, settleMs = 60_000)
        val extra = JSONObject().put("mobile", mobile.extra ?: JSONObject()).put("desktop", desktop.extra ?: JSONObject())
        return Grade(
            desktop.verdict,
            "mobile site: ${mobile.note.take(200)} — its scripts match www.youtube.com only, the phone lands on m.youtube.com; ${desktop.note.take(300)}",
            extra
        )
    }

    /**
     * Google Translate: selecting text shows its translate button; its content script listens for
     * `mouseup`. A real long press selects the phrase on the phone (a touch flow, no mouseup);
     * when that shows no button, the selection is made from the page and a `mouseup` dispatched,
     * which tells the runtime path from the pointer model.
     */
    private fun googleTranslate(row: Row, entry: JSONObject): Grade {
        val tab = createTab("$BASE/editor.html?translate")
        val view = waitForView(tab)
        poll(20_000, 400) { if (tabEval(view, "String(document.readyState === 'complete')") == "true") true else null }
        SystemClock.sleep(3_000)
        val extra = JSONObject()
        val centre = json(tabEval(view, ELEMENT_CENTRE.replace("%SELECTOR%", "#phrase")))
        val point = screenPoint(view, centre)
        val button = "(function(){var b=document.getElementById('gtx-trans');return JSON.stringify({pass:!!b&&b.offsetParent!==null,selection:String(getSelection()).trim().slice(0,40),button:!!b})})()"
        var found = JSONObject()
        var how = "none"
        if (point != null && onScreen("Google Translate: the long press")) {
            val f = Finger()
            f.press(point.first, point.second)
            f.up()
            found = pollExpr(view, button, 6_000)
            extra.put("afterLongPress", found)
            if (found.optBoolean("pass")) how = "touch"
            back()
            SystemClock.sleep(600)
        }
        if (how == "none") {
            tabEval(view, "(function(){var el=document.getElementById('phrase');var r=document.createRange();r.selectNodeContents(el);var s=getSelection();s.removeAllRanges();s.addRange(r);var rect=el.getBoundingClientRect();el.dispatchEvent(new MouseEvent('mouseup',{bubbles:true,clientX:rect.right-1,clientY:rect.top+rect.height/2,button:0}));return 'ok'})()")
            found = pollExpr(view, button, 8_000)
            extra.put("afterSyntheticMouseup", found)
            if (found.optBoolean("pass")) how = "synthetic mouseup"
        }
        var bubble = JSONObject()
        if (how != "none") {
            tabEval(view, "(function(){var b=document.getElementById('gtx-trans');if(b)b.click();return 'ok'})()")
            bubble = pollExpr(view, "(function(){var host=document.querySelector('.jfk-bubble, #gtx-host, .gtx-bubble, [class*=\"gtx-\"]');var text=host?((host.shadowRoot&&host.shadowRoot.textContent)||host.textContent||''):'';return JSON.stringify({pass:!!host&&text.trim().length>0,bubble:!!host,text:text.replace(/\\s+/g,' ').trim().slice(0,160)})})()", 10_000)
            extra.put("bubble", bubble)
        }
        extra.put("console", JSONArray(consoleOf(view).takeLast(10)))
        return when (how) {
            "touch" -> Grade("P", "selection button after a long press (touch): ${found.toString().take(120)}; bubble: ${bubble.toString().take(160)}", extra)
            "synthetic mouseup" -> Grade("PARTIAL", "needs a mouse: no button after the touch selection (its script listens for mouseup, which a touch selection never fires); with a synthesised mouseup the button comes up: ${found.toString().take(120)}; bubble: ${bubble.toString().take(160)}", extra)
            else -> Grade("F", "no translate button after a long press nor after a synthesised mouseup: ${found.toString().take(160)}", extra)
        }
    }

    private fun honey(row: Row, entry: JSONObject): Grade {
        val popup = entry.optJSONObject("popup")?.optString("verdict")
        return if (popup == "P" || popup == "PARTIAL") Grade("n/m", "popup renders (\"${entry.optString("popupText").take(80)}\"); coupon finding needs a merchant checkout (not measurable here)")
        else Grade("F", "popup did not render: ${entry.optJSONObject("popup")?.optString("note")?.take(160)}")
    }

    /** Momentum: with the override opted in, the browser's new tab is the extension's page. */
    private fun momentum(row: Row, entry: JSONObject): Grade {
        coreInvoke("extension.setNewTabOverride", JSONObject().put("id", row.id).put("enabled", true).toString())
        SystemClock.sleep(1_000)
        val before = tabUrls().keys
        runCatching { coreInvoke("tab.new", "null") }.onFailure { coreInvoke("tab.create", """{"active":true}""") }
        val extra = JSONObject()
        val opened = poll(20_000, 500) {
            tabUrls().entries.firstOrNull { it.key !in before && it.value.contains("${row.id}.ext.zenium.invalid/") }
        }
        val after = tabUrls()
        extra.put("tabsAfter", JSONArray(after.values.toList()))
        val record = extensions().firstOrNull { it.getString("id") == row.id }
        extra.put("record", JSONObject().put("newTabOverride", record?.opt("newTabOverride")).put("newTabPage", record?.opt("newTabPage")))
        if (opened == null) {
            val newTabs = after.filterKeys { it !in before }.values.toList()
            return Grade("F", "new tab override: tab.new opened ${if (newTabs.isEmpty()) "no tab" else newTabs.joinToString().take(120)}, not the extension's page (record newTabOverride=${record?.opt("newTabOverride")}, newTabPage=${record?.opt("newTabPage")})", extra)
        }
        val view = waitForView(opened.key)
        val found = pollExpr(view, "JSON.stringify({pass: (document.body ? document.body.innerText.trim().length > 20 : false) || document.querySelectorAll('img, canvas, .background, [class*=\"background\"]').length > 0, text: document.body ? document.body.innerText.replace(/\\s+/g,' ').trim().slice(0,120) : '', url: location.href})", 25_000)
        extra.put("page", found).put("console", JSONArray(consoleOf(view).takeLast(10)))
        return Grade(if (found.optBoolean("pass")) "P" else "F", "new tab override: ${found.toString().take(260)}", extra)
    }

    /** Stylus: a `.user.css` opens its install page, the style installs, the page it targets turns red. */
    private fun stylus(row: Row, entry: JSONObject): Grade {
        val extra = JSONObject()
        val before = tabUrls().keys
        createTab("$BASE/hello.user.css")
        val installTab = poll(25_000, 500) {
            tabUrls().entries.firstOrNull { it.key !in before && it.value.contains(".ext.zenium.invalid/") && it.value.contains("install-usercss") }
        }
        extra.put("tabsAfterOpen", JSONArray(tabUrls().values.toList()))
        var click = JSONObject().put("clicked", false)
        if (installTab != null) {
            val installView = waitForView(installTab.key)
            SystemClock.sleep(3_500)
            snap("${entry.optString("slug")}-usercss-install")
            for (i in 0 until 10) {
                click = json(tabEval(installView, "(function(){var b=document.querySelector('button.install');if(!b||b.offsetParent===null||b.disabled)return JSON.stringify({clicked:false,present:!!b,disabled:b?b.disabled:null,hidden:b?b.offsetParent===null:null});b.click();return JSON.stringify({clicked:true})})()"))
                if (click.optBoolean("clicked")) break
                SystemClock.sleep(1_000)
            }
            SystemClock.sleep(3_000)
        }
        extra.put("installClick", click)
        val tab = createTab("$BASE/page-a.html?stylus")
        val view = waitForView(tab)
        val found = pollExpr(view, "JSON.stringify({pass: getComputedStyle(document.body).backgroundColor === 'rgb(255, 0, 0)', bg: getComputedStyle(document.body).backgroundColor, styles: document.querySelectorAll('style.stylus, style[id^=\"stylus\"]').length})", 12_000)
        extra.put("page", found)
        if (worlds) worldEval(view, row.id, WORLD_REPORT)?.let { extra.put("world", json(it)) }
        return Grade(
            if (found.optBoolean("pass")) "P" else "F",
            "usercss install page ${if (installTab != null) "opened" else "did not open within 25 s (tabs: ${tabUrls().values.joinToString().take(120)})"}, install ${click.toString().take(100)}, page: ${found.toString().take(120)}",
            extra
        )
    }

    /** Grammarly and LanguageTool attach their custom elements to a focused textarea. */
    private fun editorAttach(tagPrefix: String, label: String): (Row, JSONObject) -> Grade = { row, _ ->
        val tab = createTab("$BASE/editor.html?$tagPrefix")
        val view = waitForView(tab)
        poll(20_000, 400) { if (tabEval(view, "String(document.readyState === 'complete')") == "true") true else null }
        SystemClock.sleep(2_500)
        val centre = json(tabEval(view, ELEMENT_CENTRE.replace("%SELECTOR%", "#editor")))
        screenPoint(view, centre)?.let { tap(it.first, it.second) }
        SystemClock.sleep(600)
        tabEval(view, "(function(){var e=document.getElementById('editor');e.focus();return 'ok'})()")
        awaitIme(true, 4_000)
        val expr = "(function(){var els=Array.prototype.filter.call(document.querySelectorAll('*'),function(e){return /^$tagPrefix-/i.test(e.tagName)});" +
            "return JSON.stringify({pass:els.length>0,tags:Array.from(new Set(els.map(function(e){return e.tagName.toLowerCase()}))).slice(0,6),focused:document.activeElement&&document.activeElement.id})})()"
        val found = pollExpr(view, expr, 25_000)
        val extra = JSONObject().put("page", found).put("console", JSONArray(consoleOf(view).takeLast(10)))
        if (worlds) worldEval(view, row.id, WORLD_REPORT)?.let { extra.put("world", json(it)) }
        back()
        SystemClock.sleep(600)
        Grade(if (found.optBoolean("pass")) "P" else "F", "$label: ${found.toString().take(220)}", extra)
    }

    /**
     * OneTab: three fixture tabs, then the action (its popup is emptied: the click is "send all
     * tabs"); its list page lists them and the tabs are gone. The optional `tabGroups` permission
     * it asks for the first time is allowed on screen, as a user would.
     */
    private fun oneTab(row: Row, entry: JSONObject): Grade {
        for (p in listOf("page-a.html?onetab", "page-b.html", "page-c.html")) createTab("$BASE/$p")
        SystemClock.sleep(3_000)
        val fixture = Regex("page-[abc]\\.html")
        val openBefore = tabUrls().values.count { fixture.containsMatchIn(it) && !it.endsWith("/page-a.html") }
        val extra = JSONObject().put("openBefore", openBefore)
        coreInvoke("extension.openPopup", """{"id":${JSONObject.quote(row.id)},"anchor":{"x":0,"y":0,"width":0,"height":0}}""")
        var click = JSONObject().put("popup", false)
        val popup = poll(6_000, 400) { popupView()?.takeIf { it.context == "popup" && rendered(it) } }
        if (popup != null) {
            SystemClock.sleep(2_000)
            click = json(tabEval(popup, "(function(){var items=Array.prototype.slice.call(document.querySelectorAll('a, button, div, li'));var hit=items.find(function(n){return /send all tabs to onetab/i.test(n.textContent.trim())&&n.children.length<=2});if(!hit)return JSON.stringify({popup:true,clicked:false,labels:items.map(function(n){return n.textContent.trim()}).filter(function(t){return t&&t.length<60}).slice(0,12)});hit.click();return JSON.stringify({popup:true,clicked:true,label:hit.textContent.trim()})})()"))
        } else click.put("note", "no popup: the click fired action.onClicked (send all tabs)")
        // The permission prompt for tabGroups, when it comes.
        var allowed = 0
        poll(8_000, 300) {
            (promptButton()?.rect ?: findPositiveButton())?.let { tapRect(it); allowed++ }
            if (tabUrls().values.any { it.contains("onetab.html") }) true else null
        }
        val listTab = poll(15_000, 500) { tabUrls().entries.firstOrNull { it.value.contains("${row.id}.ext.zenium.invalid/onetab.html") } }
        var list = JSONObject()
        if (listTab != null) {
            val view = waitForView(listTab.key)
            list = pollExpr(view, "JSON.stringify({pass: document.querySelectorAll('a[href*=\"page-\"]').length >= 3, links: document.querySelectorAll('a[href*=\"page-\"]').length, text: document.body.innerText.replace(/\\s+/g,' ').trim().slice(0,200)})", 10_000)
        }
        SystemClock.sleep(1_000)
        val openAfter = tabUrls().values.count { fixture.containsMatchIn(it) && !it.endsWith("/page-a.html") }
        extra.put("click", click).put("promptsAllowed", allowed).put("list", list).put("openAfter", openAfter).put("tabsAfter", JSONArray(tabUrls().values.toList()))
        runCatching { coreInvoke("extension.closePopup", "null") }
        return Grade(
            if (list.optInt("links") >= 3 && openAfter < openBefore) "P" else "F",
            "send-all click ${click.toString().take(120)}; prompts allowed $allowed; onetab.html ${if (listTab == null) "never opened" else "lists ${list.optInt("links")} of the pages"}; fixture tabs open $openBefore -> $openAfter",
            extra
        )
    }

    private fun jsonFormatter(row: Row, entry: JSONObject): Grade {
        val tab = createTab("$BASE/data.json")
        val view = waitForView(tab)
        val found = pollExpr(view, "JSON.stringify({pass: !!document.getElementById('jsonFormatterParsed') && document.getElementById('jsonFormatterParsed').children.length > 0, parsed: !!document.getElementById('jsonFormatterParsed'), raw: !!document.getElementById('jsonFormatterRaw'), optionBar: !!document.getElementById('optionBar'), contentType: document.contentType, pre: !!document.querySelector('pre')})", 15_000)
        val extra = JSONObject().put("page", found).put("console", JSONArray(consoleOf(view).takeLast(10)))
        if (worlds) worldEval(view, row.id, WORLD_REPORT)?.let { extra.put("world", json(it)) }
        return Grade(if (found.optBoolean("pass")) "P" else "F", "JSON document reformatted: ${found.toString().take(220)}", extra)
    }

    private fun videoSpeed(row: Row, entry: JSONObject): Grade {
        val tab = createTab("$BASE/editor.html?vsc")
        val view = waitForView(tab)
        poll(20_000, 400) { if (tabEval(view, "String(document.readyState === 'complete')") == "true") true else null }
        tabEval(view, "(function(){var v=document.getElementById('clip');v.muted=true;v.play().catch(function(){});return 'ok'})()")
        SystemClock.sleep(2_500)
        val found = pollExpr(view, "(function(){var c=document.querySelector('.vsc-controller');var text=(c&&c.shadowRoot&&c.shadowRoot.textContent||'').trim();return JSON.stringify({pass:!!c&&/\\d/.test(text),controller:!!c,text:text.slice(0,20),hidden:c?c.classList.contains('vsc-hidden'):null,video:(function(v){return v?(v.paused?'paused':'playing'):'none'})(document.getElementById('clip'))})})()", 12_000)
        val extra = JSONObject().put("page", found).put("console", JSONArray(consoleOf(view).takeLast(10)))
        if (worlds) worldEval(view, row.id, WORLD_REPORT)?.let { extra.put("world", json(it)) }
        if (!found.optBoolean("pass")) {
            // Where the extension stopped: the main world's inject.js leaves window.VSC behind and
            // asks the isolated-world bridge for its settings over a CustomEvent handshake; the
            // bridge answers from chrome.storage.sync. Each half is asked again here.
            extra.put("mainWorld", json(tabEval(view, VSC_MAIN_WORLD_REPORT)))
            tabEval(view, VSC_HANDSHAKE_PROBE)
            SystemClock.sleep(2_500)
            extra.put("handshake", json(tabEval(view, "JSON.stringify(window.__vscProbe||null)")))
            if (worlds) {
                worldEval(view, row.id, STORAGE_PROBE)
                SystemClock.sleep(2_500)
                worldEval(view, row.id, "JSON.stringify(window.__zenStorageProbe||null)")?.let { extra.put("worldStorage", json(it)) }
            }
        }
        return Grade(if (found.optBoolean("pass")) "P" else "F", "speed controller attached to the video: ${found.toString().take(220)}", extra)
    }

    private fun notOnThePhone(reason: String): (Row, JSONObject) -> Grade = { _, _ -> Grade("n/a", reason) }

    // --- the table -------------------------------------------------------------------------------

    /** The desktop sweep's thirty, the twenty-seven the feasibility table calls feasible first, the three it does not last. */
    private val table: List<Row> = listOf(
        Row("ddkjiahejlhfcafbddmgiahcphecmpfh", "uBlock Origin Lite", "ubo-lite", core = ::adBlocker),
        Row("odfafepnkmbhccpbejgmiehpchacaeak", "uBlock Origin (MV2, Edge Add-ons)", "ubo-mv2", store = "edge-add-ons", core = ::adBlocker),
        Row("cfhdojbkjhnklbpkdaibdccddilifddb", "Adblock Plus", "adblock-plus", core = ::adBlocker),
        Row("pkehgijcmpdhfbdbbnkijodmdjhbjlgp", "Privacy Badger", "privacy-badger", core = ::adBlocker),
        Row("mlomiejdfkolichcflejclcbmpeaniij", "Ghostery", "ghostery", core = ::adBlocker),
        Row("eimadpbcbfnmbkopoojfekhnkhdbieeh", "Dark Reader", "dark-reader", core = ::darkReader),
        Row("nngceckbapebfimnlniiiahkandclblb", "Bitwarden Password Manager", "bitwarden", core = popupLogin("Bitwarden")),
        Row("aeblfdkhhhdcdjpifhhbdiojplfjncoa", "1Password", "1password", core = popupLogin("1Password")),
        Row("hdokiejnpimakedhajhdlcegeplioahd", "LastPass", "lastpass", core = popupLogin("LastPass")),
        Row("kbfnbcaeplbcioakkpcpgfkobkghlhen", "Grammarly", "grammarly", core = editorAttach("grammarly", "Grammarly attaches to the textarea")),
        Row("dbepggeogbaibhgnhhndojpepiihcmeb", "Vimium", "vimium", core = ::vimium),
        Row("dhdgffkkebhmkfjojejmpbldmpobfkfo", "Tampermonkey", "tampermonkey", core = { row, entry -> userscripts(row, entry, Regex("/ask\\.html")) }),
        Row("jinjaccalgkegednnccohejagnlnfdag", "Violentmonkey", "violentmonkey", core = { row, entry -> userscripts(row, entry, Regex("/confirm/index\\.html")) }),
        Row("mnjggcdmjocbbbhaepdhchncahnbgone", "SponsorBlock", "sponsorblock", core = { row, entry ->
            youtube(
                row, entry,
                "(function(){var els=document.querySelectorAll('#previewbar, .sponsorBlockPreviewBar, #sponsorBlockButton, .playerButton[id*=\"Button\"], #infoButton, #sponsorBlockDurationAfterSkips, .sbNotice, [class*=\"sponsorBlock\"], [id*=\"sponsorBlock\"], .sbButton');" +
                    "return JSON.stringify({pass:els.length>0,n:els.length,ids:Array.prototype.slice.call(els).map(function(e){return e.id||e.className}).slice(0,5)})})()",
                "SponsorBlock UI on a watch page"
            )
        }),
        Row("gebbhagfogifgggkldgodflihgfeippi", "Return YouTube Dislike", "return-youtube-dislike", core = { row, entry ->
            youtube(
                row, entry,
                "(function(){var b=document.querySelector('dislike-button-view-model, #segmented-dislike-button, #dislike-button, ytd-segmented-like-dislike-button-renderer, .slim-video-action-bar-actions [aria-label*=\"islike\"], ytm-slim-video-action-bar-renderer [aria-label*=\"islike\"]');" +
                    "var t=b?b.textContent.replace(/\\s+/g,' ').trim():'';var bar=document.querySelector('#ryd-bar, #ryd-bar-container, .ryd-tooltip, [id*=\"return-youtube-dislike\"], [class*=\"ryd-\"], [id^=\"ryd-\"]');" +
                    "return JSON.stringify({pass:/\\d/.test(t)&&!/^dislike$/i.test(t)||!!bar,text:t.slice(0,40),bar:!!bar,api:performance.getEntriesByType('resource').filter(function(e){return e.name.indexOf('returnyoutubedislike')>=0}).length})})()",
                "dislike count shown"
            )
        }),
        Row("ponfpcnoihfmfllpaingbgckeeldkhle", "Enhancer for YouTube", "enhancer-for-youtube", core = ::enhancerForYouTube),
        Row("aapbdbdomjkkjkaonfhkkikfgjllcleb", "Google Translate", "google-translate", core = ::googleTranslate),
        Row("bmnlcjabgnpnenekpadlanbbkooimhnj", "Honey", "honey", core = ::honey),
        Row("laookkfknpbbblfpciffpaejjkokdgca", "Momentum", "momentum", core = ::momentum),
        Row("clngdbkpkpeebahjckkjfobafhncgmne", "Stylus", "stylus", core = ::stylus),
        Row("oldceeleldhonbafppcapldpdifcinji", "LanguageTool", "languagetool", core = editorAttach("lt", "LanguageTool attaches to the textarea")),
        Row("ldgfbffkinooeloadekpmfoklnobpien", "Raindrop.io", "raindrop", core = popupLogin("Raindrop.io")),
        Row("knheggckgoiihginacbkhaalnibhilkk", "Notion Web Clipper", "notion-web-clipper", core = popupLogin("Notion Web Clipper")),
        Row("jldhpllghnbhlbpcmnajkpdmadaolakh", "Todoist", "todoist", core = popupLogin("Todoist")),
        Row("chphlpgkkbolifaimnlloiipkdnihall", "OneTab", "onetab", core = ::oneTab),
        Row("bcjindcccaagfpapjjmafapmmgkkhgoa", "JSON Formatter", "json-formatter", core = ::jsonFormatter),
        Row("nffaoalbilbmmfgbnbgppjihopabppdk", "Video Speed Controller", "video-speed-controller", core = ::videoSpeed),
        // Not feasible on the phone (feasibility table): a DevTools panel and screen capture have no WebView equivalent.
        Row("fmkadmapgofadopljbjfkapdkoienihi", "React Developer Tools", "react-devtools", feasible = false, core = notOnThePhone("devtools_page: the phone has no DevTools panel to host it (WebView limit)")),
        Row("nhdogjmejiglipccpnnnanhbledajbpd", "Vue.js devtools", "vue-devtools", feasible = false, core = notOnThePhone("devtools_page: the phone has no DevTools panel to host it (WebView limit)")),
        Row("liecbddmkiiihnedobmlmillhodjkdmb", "Loom", "loom", feasible = false, core = notOnThePhone("desktopCapture / tabCapture: no screen or tab capture on the phone (WebView limit); the recorder itself needs an account"))
    )

    // --- stages and evidence ---------------------------------------------------------------------

    private fun stage(entry: JSONObject, name: String, verdict: String, note: String, detail: JSONObject? = null) {
        val stage = JSONObject().put("verdict", verdict).put("note", note)
        if (detail != null) stage.put("detail", detail)
        entry.put(name, stage)
        Log.i(TAG, "${entry.optString("name")} $name $verdict – $note")
    }

    private fun write() {
        results.put("rows", rows)
        results.put("pssKb", Debug.getPss())
        File(out, "results.json").writeText(results.toString(2))
    }

    private fun isUncaught(line: String): Boolean = line.startsWith("ERROR ") && line.contains("Uncaught")

    /** The document has content: text, or more than a handful of elements (an icon-only popup). */
    private fun rendered(view: WebView): Boolean =
        tabEval(view, "String(!!document.body && (document.body.innerText.trim().length > 0 || document.body.querySelectorAll('*').length > 3))", 5) == "true"

    private fun sheetSize(view: WebView): JSONObject {
        val report = JSONObject()
        instrumentation.runOnMainSync {
            val density = view.resources.displayMetrics.density
            val parent = view.parent as? View
            report.put("widthDp", (view.width / density).toInt())
                .put("heightDp", (view.height / density).toInt())
                .put("frameWidthDp", ((parent?.width ?: 0) / density).toInt())
                .put("screenWidthDp", (view.resources.displayMetrics.widthPixels / density).toInt())
                .put("screenHeightDp", (view.resources.displayMetrics.heightPixels / density).toInt())
        }
        return report
    }

    // --- core access -----------------------------------------------------------------------------

    private fun extensions(): List<JSONObject> {
        val list = coreState().optJSONArray("extensions") ?: JSONArray()
        return (0 until list.length()).map { list.getJSONObject(it) }
    }

    private fun extensionAction(id: String): JSONObject? = extensions().firstOrNull { it.getString("id") == id }?.optJSONObject("action")

    /** Every tab of the core's snapshot: id to URL. */
    private fun tabUrls(): Map<String, String> {
        val tabs = coreState().optJSONObject("tabs") ?: return emptyMap()
        val map = LinkedHashMap<String, String>()
        for (id in tabs.keys()) map[id] = tabs.optJSONObject(id)?.optString("url") ?: ""
        return map
    }

    private fun tabIdByUrl(prefix: String): String? = tabUrls().entries.firstOrNull { it.value.startsWith(prefix) }?.key

    private fun createTab(url: String): String = coreInvoke("tab.create", """{"url":${JSONObject.quote(url)},"active":true}""").trim('"')

    private fun closeTab(tabId: String) {
        runCatching { coreInvoke("tab.close", """{"tabId":${JSONObject.quote(tabId)},"force":true}""") }
    }

    /** Every tab but the fixture goes (what an extension opened, what a check created). */
    private fun closeExtraTabs() {
        for ((id, _) in tabUrls()) if (id != fixtureTab) closeTab(id)
        SystemClock.sleep(600)
    }

    private fun showTab(tabId: String) {
        coreInvoke("tab.activate", """{"tabId":${JSONObject.quote(tabId)}}""")
        poll(8_000, 200) { if (activeCoreTab()?.optString("id") == tabId) true else null }
        SystemClock.sleep(500)
    }

    private fun waitForView(tabId: String): TabWebView =
        poll(15_000, 200) {
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

    private fun consoleOf(view: WebView): List<String> {
        var list: List<String> = emptyList()
        instrumentation.runOnMainSync {
            list = when (view) {
                is ExtensionWebView -> synchronized(view.console) { view.console.toList() }
                is TabWebView -> synchronized(view.console) { view.console.toList() }
                else -> emptyList()
            }
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

    /** Poll a JSON-returning expression until its `pass` is true, for up to `timeoutMs`; the last reading either way. */
    private fun pollExpr(view: WebView, expr: String, timeoutMs: Long): JSONObject {
        var last = JSONObject()
        poll(timeoutMs, 700) {
            last = json(tabEval(view, expr))
            if (last.optBoolean("pass")) true else null
        }
        return last
    }

    /** `script` in `ext`'s isolated world on `view`; null when the extension has no world endpoint there. */
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

    private fun <T> poll(timeoutMs: Long, pollMs: Long = 250, probe: () -> T?): T? {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            val v = probe()
            if (v != null) return v
            SystemClock.sleep(pollMs)
        }
        return null
    }

    /**
     * `window.zen.invoke(command, args)` in the chrome, awaited from here for up to `timeoutMs`.
     * Every call has its own slot (`window.__sweep[token]`), so the answer of one that timed out
     * cannot be taken for the next call's. While the call is pending, the prompt the chrome puts
     * up is answered: its accepting button, found through the chrome's own DOM (`[data-accept]`
     * of the sheet or the dialog) and on screen where a finger can reach it, is handed to
     * `onDialog` with its bounds and tapped there; a native dialog's button (the store's fallback
     * prompt) is found through the accessibility tree, only while the chrome says a prompt is
     * pending, so a matching word elsewhere on screen is never tapped. A prompt whose button is
     * up but out of reach for [PROMPT_TAP_TIMEOUT_MS] (the sheet's first detent cut it off, the
     * sheet never drew), or whose tap did not take it down, is answered through the chrome's
     * command with the picture kept as evidence and `promptsAnsweredByCommand` counting it.
     * Throws when the command rejects or never answers.
     */
    private fun zen(command: String, args: JSONObject?, timeoutMs: Long, onDialog: (Rect) -> Unit): JSONObject {
        val argsJs = args?.toString() ?: "undefined"
        val token = ++zenCalls
        chromeJs(
            "window.__sweep = window.__sweep || {}; window.__sweep[$token] = undefined; window.zen.invoke(${JSONObject.quote(command)}, $argsJs).then(" +
                "function (v) { window.__sweep[$token] = JSON.stringify({ ok: v === undefined ? null : v }); }," +
                "function (e) { window.__sweep[$token] = JSON.stringify({ err: String((e && e.message) || e) }); });'ok'"
        )
        var answered = false
        var taps = 0
        var tappedAt = 0L
        // The button's bounds at the previous poll: a sheet still sliding into place is tapped
        // only once it stands still (a finger on a moving sheet lands where it was, not where it is).
        var lastRect: Rect? = null
        // Polls the chrome did not answer within chromeJs's 10 s: a JS thread that is busy or gone.
        var silent = 0
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        var promptSeenAt = 0L
        while (SystemClock.uptimeMillis() < deadline) {
            val result = chromeJs("(window.__sweep && window.__sweep[$token] !== undefined) ? window.__sweep[$token] : null")
            if (result.isEmpty()) {
                silent++
                if (silent == 1 || silent % 10 == 0) Log.w(TAG, "$command: the chrome did not answer a poll ($silent so far)")
                // A page's dialog blocks the renderer the chrome shares: press it away and poll again.
                dismissDialog()?.let { Log.w(TAG, "$command: a dialog pressed away: $it") }
            }
            if (result.isNotEmpty() && result != "null") {
                chromeJs("delete window.__sweep[$token];'ok'")
                val envelope = JSONObject(JSONTokener(result).nextValue() as String)
                if (envelope.has("err")) error("$command rejected: ${envelope.getString("err")}")
                return when (val value = envelope.get("ok")) {
                    is JSONObject -> value
                    JSONObject.NULL -> JSONObject()
                    else -> JSONObject().put("value", value)
                }
            }
            val pending = if (answered) JSONArray() else pendingPrompts()
            if (pending.length() == 0) {
                // Nothing is asked: a sheet still on its way out (its button drawn below the
                // viewport while it slides down) is not a prompt to answer, and the next prompt
                // this command raises starts with its own taps.
                promptSeenAt = 0L
                if (taps > 0 && SystemClock.uptimeMillis() - tappedAt > PROMPT_RETAP_MS) taps = 0
            } else {
                val button = promptButton()
                when {
                    // The chrome's own sheet or dialog, its button on screen: a finger on it.
                    button != null && button.rect != null && taps < PROMPT_TAPS -> {
                        // A tap that did not take the prompt down: once more, then the command.
                        val still = button.rect == lastRect
                        lastRect = button.rect
                        if (still && (taps == 0 || SystemClock.uptimeMillis() - tappedAt > PROMPT_RETAP_MS)) {
                            if (onScreen("$command: the prompt's button")) {
                                taps++
                                tappedAt = SystemClock.uptimeMillis()
                                onDialog(button.rect)
                            } else {
                                // The browser is gone from the screen for good: no finger can reach the button.
                                Log.w(TAG, "$command: the browser is off screen, the prompt goes through the command")
                                answered = true
                                snap("prompt-browser-off-screen")
                                promptsAnsweredByCommand++
                                lastPromptFallback = JSONObject().put("reason", "browser off screen").put("button", button.detail)
                                answerPrompts(pending)
                            }
                        }
                    }
                    button != null && button.rect != null -> {
                        if (SystemClock.uptimeMillis() - tappedAt > PROMPT_RETAP_MS) {
                            Log.w(TAG, "$taps tap(s) on the prompt's button did not answer it: ${button.detail}")
                            answered = true
                            snap("prompt-tap-did-not-answer")
                            promptsAnsweredByCommand++
                            lastPromptFallback = JSONObject().put("reason", "tap did not answer").put("button", button.detail)
                            answerPrompts(pending)
                        }
                    }
                    // The prompt is up but its button is not where a finger could reach it.
                    button != null -> {
                        if (promptSeenAt == 0L) promptSeenAt = SystemClock.uptimeMillis()
                        else if (SystemClock.uptimeMillis() - promptSeenAt > PROMPT_TAP_TIMEOUT_MS) {
                            Log.w(TAG, "the prompt's button is out of reach: ${button.detail}")
                            answered = true
                            snap("prompt-without-button")
                            promptsAnsweredByCommand++
                            lastPromptFallback = JSONObject().put("reason", "button out of reach").put("button", button.detail)
                            answerPrompts(pending)
                        }
                    }
                    // No chrome sheet: a native dialog (the store's fallback prompt), by the
                    // accessibility tree, and only while the chrome says a prompt is pending.
                    else -> {
                        val native = findPositiveButton()
                        if (native != null && taps == 0) {
                            taps++
                            tappedAt = SystemClock.uptimeMillis()
                            onDialog(native)
                        } else {
                            if (promptSeenAt == 0L) promptSeenAt = SystemClock.uptimeMillis()
                            else if (SystemClock.uptimeMillis() - promptSeenAt > PROMPT_TAP_TIMEOUT_MS) {
                                Log.w(TAG, "a prompt is pending and nothing on screen answers it: $pending")
                                answered = true
                                snap("prompt-without-button")
                                promptsAnsweredByCommand++
                                lastPromptFallback = JSONObject().put("reason", "no button on screen").put("pending", pending)
                                answerPrompts(pending)
                            }
                        }
                    }
                }
            }
            SystemClock.sleep(300)
        }
        // What the chrome shows and knows at the timeout, for the row's evidence.
        val button = runCatching { promptButton()?.detail }.getOrNull()
        val pending = pendingPrompts()
        Log.w(TAG, "$command timed out: silent polls $silent, prompt taps $taps, answered $answered, button ${button ?: "none"}, pending $pending")
        error(
            "$command did not answer within ${timeoutMs / 1000} s" +
                (if (silent > 0) " ($silent poll(s) the chrome did not answer)" else "") +
                (if (button != null) "; a prompt button is on screen: $button" else "") +
                (if (pending.length() > 0) "; prompts pending: $pending" else "")
        )
    }

    /** The prompts the chrome raised since the last answer through the command: `[{kind, id, ok}]`. */
    private fun pendingPrompts(): JSONArray =
        runCatching { JSONArray(JSONTokener(chromeJs("JSON.stringify(window.__prompts||[])")).nextValue() as String) }.getOrDefault(JSONArray())

    /**
     * Accept the prompt on screen without a finger: a click on the sheet's own accepting button
     * through the chrome's DOM (the renderer's handler answers exactly as a tap would), and every
     * prompt in `pending` through the chrome's answer command (a no-op for one already answered).
     */
    private fun answerPrompts(pending: JSONArray) {
        val clicked = chromeJs("(function(){var b=document.querySelector('[data-accept]');if(!b)return 'none';b.click();return 'clicked'})()")
        Log.i(TAG, "prompt button by DOM click: $clicked; pending by id: ${pending.length()}")
        for (i in 0 until pending.length()) {
            val prompt = pending.optJSONObject(i) ?: continue
            val command = if (prompt.optString("kind") == "permission") "extension.respondPermissionRequest" else "extension.confirmInstall"
            runCatching { coreInvoke(command, JSONObject().put("requestId", prompt.optString("id")).put("accept", true).toString()) }
                .onFailure { Log.w(TAG, "$command failed: ${it.message}") }
        }
        chromeJs("window.__prompts=[];'ok'")
    }

    /**
     * The accepting button of the chrome's prompt, by the chrome's DOM: `rect` is its bounds on
     * screen when it is drawn, inside the viewport and the topmost thing at its centre (a finger
     * there presses it); `null` when a prompt is up but the button is not reachable, with the
     * measurements in `detail` (its CSS box, the viewport, what is on top of it) as evidence.
     */
    private class PromptButton(val rect: Rect?, val detail: JSONObject)

    /** The prompt's accepting button when the chrome shows one, else `null`. */
    private fun promptButton(): PromptButton? {
        val raw = chromeJs(PROMPT_BUTTON_JS)
        val json = (runCatching { JSONTokener(raw).nextValue() }.getOrNull() as? String)?.takeIf { it.isNotEmpty() } ?: return null
        val css = runCatching { JSONObject(json) }.getOrNull() ?: return null
        if (!css.optBoolean("reachable")) return PromptButton(null, css)
        val chrome = host.chrome
        val centre = screenPoint(chrome, css) ?: return PromptButton(null, css)
        var scale = 1f
        var density = 1f
        instrumentation.runOnMainSync {
            density = chrome.resources.displayMetrics.density
            @Suppress("DEPRECATION")
            scale = chrome.scale.takeIf { it > 0f } ?: density
        }
        val halfW = css.optDouble("w", 0.0).toFloat() * scale / 2
        val halfH = css.optDouble("h", 0.0).toFloat() * scale / 2
        val rect = Rect(
            (centre.first - halfW).roundToInt(), (centre.second - halfH).roundToInt(),
            (centre.first + halfW).roundToInt(), (centre.second + halfH).roundToInt()
        )
        // The chrome draws edge to edge, so its viewport runs under the system bars: a button
        // there is inside the viewport and still out of a finger's reach (a tap at the bottom edge
        // pressed the navigation bar's Overview button and the launcher took the screen; the
        // sweep then ran against a stopped activity). As DemoHarness.touchPoint, the finger aims
        // at the middle of the button's part inside the touchable band – a sheet's button may run
        // under the bar's window with most of it still reachable – and a part thinner than
        // MIN_TOUCH_OVERLAP_DP is no target (the run before this rule kept a 56 dp margin over
        // the band and put every one of thirty "Add extension" buttons, 8 dp above the bar, out
        // of reach).
        val band = touchableBand(chrome)
        val target = Rect(rect)
        if (!target.intersect(band) || target.height() < (MIN_TOUCH_OVERLAP_DP * density).roundToInt()) {
            css.put("underSystemBar", "button ${rect.top}..${rect.bottom} px, touchable ${band.top}..${band.bottom} px")
            return PromptButton(null, css)
        }
        return PromptButton(target, css)
    }

    /**
     * The screen strip a finger reaches the app in, in screen px: below the status bar and above
     * the navigation bar's window, the bottom band the larger of the bars' inset, the tappable
     * inset and [NAV_BAR_WINDOW_DP] – the band DemoHarness taps within (a gesture bar reports a
     * thinner inset than the strip the system takes touches from; the taps the system took for
     * its own, Overview opened and the launcher on screen, were within 48 dp of the bottom edge).
     */
    private fun touchableBand(view: View): Rect {
        var result = Rect(0, 0, Int.MAX_VALUE, Int.MAX_VALUE)
        instrumentation.runOnMainSync {
            val root = view.rootView
            val location = IntArray(2)
            root.getLocationOnScreen(location)
            val all = ViewCompat.getRootWindowInsets(root)
            val bars = all?.getInsets(WindowInsetsCompat.Type.systemBars())
            val tappable = all?.getInsets(WindowInsetsCompat.Type.tappableElement())
            val bottomBand = maxOf(
                bars?.bottom ?: 0, tappable?.bottom ?: 0, (NAV_BAR_WINDOW_DP * root.resources.displayMetrics.density).roundToInt()
            )
            result = Rect(
                location[0] + (bars?.left ?: 0), location[1] + (bars?.top ?: 0),
                location[0] + root.width - (bars?.right ?: 0), location[1] + root.height - bottomBand
            )
        }
        return result
    }

    // --- input and pictures ----------------------------------------------------------------------

    /** The positive button of a prompt (the chrome's sheet or a native dialog), when one is up. */
    private fun findPositiveButton(): Rect? = nodes { node ->
        node.isVisibleToUser && node.isClickable &&
            node.text?.toString()?.trim()?.let { text -> POSITIVE_BUTTONS.any { it.equals(text, ignoreCase = true) } } == true
    }
        .map { Rect().also(it::getBoundsInScreen) }
        .filter { it.width() > 0 && it.height() > 0 }
        .minByOrNull { it.width() * it.height() }

    private fun tapRect(rect: Rect) {
        if (!onScreen("tap at $rect")) return
        Finger().tap(rect.exactCenterX(), rect.exactCenterY())
        SystemClock.sleep(700)
    }

    private fun tap(x: Float, y: Float) {
        if (onScreen("tap at $x,$y")) Finger().tap(x, y)
    }

    /**
     * The browser's activity is the one on screen (resumed) before a finger goes down. A tap the
     * system's navigation took hands the screen to the launcher or to Overview; the fingers that
     * follow then start other apps or swipe the browser's task away (the run before this check
     * lost fourteen rows' taps to the launcher and then the activity itself), while the chrome's
     * JS keeps answering from the background and grades pages nobody can see. The singleTask
     * activity is brought back with its own intent; false when it has been destroyed.
     */
    private fun onScreen(context: String): Boolean {
        var stage: Stage? = null
        instrumentation.runOnMainSync { stage = ActivityLifecycleMonitorRegistry.getInstance().getLifecycleStageOf(activity) }
        if (stage == Stage.RESUMED) return true
        if (stage == Stage.DESTROYED) {
            Log.e(TAG, "$context: the browser's activity is destroyed")
            return false
        }
        Log.w(TAG, "$context: the browser is not on screen ($stage); bringing it back")
        snap("browser-off-screen")
        val intent = Intent(app, MainActivity::class.java).setAction(Intent.ACTION_MAIN)
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_REORDER_TO_FRONT)
        app.startActivity(intent)
        val deadline = SystemClock.uptimeMillis() + 10_000
        var back = false
        while (!back && SystemClock.uptimeMillis() < deadline) {
            SystemClock.sleep(250)
            instrumentation.runOnMainSync { back = ActivityLifecycleMonitorRegistry.getInstance().getLifecycleStageOf(activity) == Stage.RESUMED }
        }
        // The sheet or page that was up settles after the return.
        if (back) SystemClock.sleep(1_000)
        screenRestored.put(JSONObject().put("at", context).put("stage", stage.toString()).put("restored", back))
        Log.w(TAG, "$context: the browser is ${if (back) "back on screen" else "still not on screen"}")
        return back
    }

    private fun key(code: Int) {
        if (!onScreen("key $code")) return
        val now = SystemClock.uptimeMillis()
        ui.injectInputEvent(KeyEvent(now, now, KeyEvent.ACTION_DOWN, code, 0), true)
        ui.injectInputEvent(KeyEvent(now, SystemClock.uptimeMillis(), KeyEvent.ACTION_UP, code, 0), true)
    }

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

    /**
     * Whether the chrome's JS answers. A page's `alert()` / `confirm()` blocks the renderer's
     * main thread – WebView runs every WebView of the app, the chrome's included, in one renderer
     * – until its dialog is dismissed (the base run lost its last nineteen rows behind a dialog
     * Tampermonkey's options page put up), so a native dialog on screen is pressed away, its
     * text kept as evidence, and the chrome asked again; three silent polls and it is given up.
     */
    private fun chromeAnswers(): Boolean {
        for (attempt in 1..3) {
            if (chromeJs("'ok'").isNotEmpty()) return true
            val dialog = dismissDialog()
            Log.w(TAG, "the chrome did not answer (poll $attempt)${dialog?.let { "; a dialog pressed away: $it" } ?: ""}")
        }
        return false
    }

    /**
     * A native dialog on screen (a page's alert, confirm or prompt shown by WebView itself, a
     * system dialog) pressed away and its text returned with the button pressed; null when no
     * such window is up. A confirm is declined (Cancel, No): OK runs the page's positive path,
     * and Tampermonkey's internal-error confirm opened its forum – a github.com issue page – on
     * every OK, nine tabs in one 113 job (run 35446468306) with the eight rows after it timed
     * out behind them. An alert has OK alone. The activity's own window fills the screen and is
     * never the one; the chrome's sheets are in its DOM, not windows.
     */
    private fun dismissDialog(): String? {
        val screenHeight = app.resources.displayMetrics.heightPixels
        for (window in ui.windows) {
            val root = window.root ?: continue
            val bounds = Rect().also(window::getBoundsInScreen)
            if (window.type != AccessibilityWindowInfo.TYPE_APPLICATION || bounds.height() >= screenHeight * 9 / 10) continue
            val texts = ArrayList<String>()
            val buttons = ArrayList<AccessibilityNodeInfo>()
            val queue = ArrayDeque(listOf(root))
            var visited = 0
            while (queue.isNotEmpty() && visited++ < 2_000) {
                val node = queue.removeFirst()
                node.text?.toString()?.trim()?.takeIf { it.isNotEmpty() }?.let(texts::add)
                if (node.isClickable && node.className == "android.widget.Button") buttons.add(node)
                for (i in 0 until node.childCount) node.getChild(i)?.let(queue::add)
            }
            val button = dialogButton(buttons.map { it.text?.toString()?.trim().orEmpty() })?.let(buttons::get) ?: continue
            val text = "${texts.joinToString(" | ").take(300)} || pressed: ${button.text?.toString()?.trim().orEmpty()}"
            dialogsDismissed.put(text)
            snap("dialog-dismissed")
            tapRect(Rect().also(button::getBoundsInScreen))
            return text
        }
        return null
    }

    /** The Java heap in use after a full collection, in KB: what the process keeps at this point. */
    private fun heapKb(): Long {
        val runtime = Runtime.getRuntime()
        runtime.gc()
        SystemClock.sleep(300)
        runtime.gc()
        SystemClock.sleep(100)
        return (runtime.totalMemory() - runtime.freeMemory()) / 1024
    }

    /** Breadth-first search of every window on screen (the app and a dialog). */
    private fun nodes(predicate: (AccessibilityNodeInfo) -> Boolean): List<AccessibilityNodeInfo> {
        val roots = ArrayList<AccessibilityNodeInfo>()
        for (window in ui.windows) window.root?.let(roots::add)
        if (roots.isEmpty()) ui.rootInActiveWindow?.let(roots::add)
        val found = ArrayList<AccessibilityNodeInfo>()
        val queue = ArrayDeque(roots)
        var visited = 0
        while (queue.isNotEmpty() && visited < 12_000) {
            val node = queue.removeFirst()
            visited++
            if (predicate(node)) found += node
            for (i in 0 until node.childCount) node.getChild(i)?.let(queue::add)
        }
        return found
    }

    /** Numbered so the artifact lists the sequence in order. */
    private fun snap(name: String) {
        shots++
        shot("${shots.toString().padStart(3, '0')}-$name")
    }

    /** Peak PSS and Java heap of the app process, sampled twice a second while the sweep runs. */
    private class MemorySampler {
        private var thread: Thread? = null
        @Volatile private var running = false
        private var samples = 0
        private var peakPssKb = 0L
        private var peakHeapBytes = 0L
        private var baselinePssKb = -1L

        fun start() {
            running = true
            thread = Thread {
                val runtime = Runtime.getRuntime()
                while (running) {
                    val pss = Debug.getPss()
                    if (baselinePssKb < 0) baselinePssKb = pss
                    peakPssKb = maxOf(peakPssKb, pss)
                    peakHeapBytes = maxOf(peakHeapBytes, runtime.totalMemory() - runtime.freeMemory())
                    samples++
                    SystemClock.sleep(500)
                }
            }.apply { isDaemon = true; start() }
        }

        fun stop() {
            running = false
            thread?.join(2_000)
        }

        fun report(): JSONObject = JSONObject()
            .put("samples", samples)
            .put("baselinePssKb", baselinePssKb)
            .put("peakPssKb", peakPssKb)
            .put("peakJavaHeapBytes", peakHeapBytes)
            .put("maxHeapBytes", Runtime.getRuntime().maxMemory())
    }

    companion object {
        private const val TAG = "CompatSweep"
        /** The runner serves the fixture pages; the emulator reaches its host loopback as 10.0.2.2. */
        private const val BASE = "http://10.0.2.2:8765"
        private const val YOUTUBE_URL = "https://www.youtube.com/watch?v=jNQXAC9IVRw"
        private const val INSTALL_TIMEOUT_MS = 240_000L
        /** uBlock Origin (MV2) on Edge Add-ons: the heaviest row, run last by default. */
        private const val UBO_MV2 = "odfafepnkmbhccpbejgmiehpchacaeak"
        private const val BACKGROUND_TIMEOUT_MS = 40_000L
        private const val BACKGROUND_SETTLE_MS = 6_000L
        private const val POPUP_TIMEOUT_MS = 30_000L
        private const val OPTIONS_TIMEOUT_MS = 30_000L
        /** How long a raised prompt may go without a reachable positive button before the command answers it. */
        private const val PROMPT_TAP_TIMEOUT_MS = 8_000L
        /** Taps on the prompt's own button before the command answers it, and the wait between them. */
        private const val PROMPT_TAPS = 2
        private const val PROMPT_RETAP_MS = 3_000L
        /** The navigation bar's window is at least this tall, whatever inset it reports (see [touchableBand]). */
        private const val NAV_BAR_WINDOW_DP = 48
        /** A button's part inside the touchable band has to be this tall for a finger to aim at it. */
        private const val MIN_TOUCH_OVERLAP_DP = 12
        /** The buttons that turn a page's confirm or prompt down (WebView's JsDialogHelper labels them Cancel). */
        private val DECLINE_BUTTONS = setOf("CANCEL", "NO")
        /** The button that takes a one-button dialog (a page's alert, a system dialog) down. */
        private val DIALOG_BUTTONS = setOf("OK", "CLOSE", "DISMISS", "GOT IT")

        /**
         * Which of a dialog's buttons, by label, to press: the decline of a confirm first, then
         * the acknowledgement of an alert, else the last button (a beforeunload's "Leave this
         * Page", a dialog with labels of its own); null for a dialog without buttons.
         */
        internal fun dialogButton(labels: List<String>): Int? {
            if (labels.isEmpty()) return null
            val upper = labels.map { it.trim().uppercase() }
            return upper.indexOfFirst { it in DECLINE_BUTTONS }.takeIf { it >= 0 }
                ?: upper.indexOfFirst { it in DIALOG_BUTTONS }.takeIf { it >= 0 }
                ?: labels.lastIndex
        }
        /**
         * The chrome's prompt button as the chrome sees it: `[data-accept]` of the install /
         * permissions sheet or dialog, its CSS box, the viewport, whether its host is drawn and
         * takes the pointer (a sheet is at opacity 0 and `pointer-events: none` until presented),
         * and what `elementFromPoint` finds at its centre – `reachable` when a finger there
         * presses the button. `null` when no prompt is up.
         */
        private const val PROMPT_BUTTON_JS =
            "(function(){var b=document.querySelector('.zen-sheet-footer [data-accept], .zen-ext-dialog [data-accept], [data-accept]');if(!b)return null;" +
                "var r=b.getBoundingClientRect();var host=b.closest('.zen-sheet')||b.closest('[role=dialog]')||b;var cs=getComputedStyle(host);" +
                "var drawn=cs.opacity!=='0'&&cs.visibility!=='hidden'&&cs.pointerEvents!=='none';var cx=r.left+r.width/2,cy=r.top+r.height/2;" +
                "var top=document.elementFromPoint(cx,cy);var onTop=!!top&&(top===b||b.contains(top));" +
                "var inside=r.width>0&&r.height>0&&r.top>=0&&r.left>=0&&r.bottom<=innerHeight&&r.right<=innerWidth;" +
                "return JSON.stringify({x:cx,y:cy,w:r.width,h:r.height,top:r.top,bottom:r.bottom,innerW:innerWidth,innerH:innerHeight,drawn:drawn,onTop:onTop,inside:inside," +
                "covering:top&&!onTop?(top.tagName+'.'+String(top.className).slice(0,60)):null,label:(b.textContent||'').trim(),reachable:drawn&&onTop&&inside})})()"
        /** The prompts' positive labels (ExtensionPromptDialog, hostStore.ts installPromptText). */
        private val POSITIVE_BUTTONS = setOf("Add extension", "Update extension", "Allow")
        /** The tracker hosts of sweep-ads.html, by the page's own names. */
        private val TRACKER_HOSTS = linkedMapOf(
            "gtag" to "www.googletagmanager.com",
            "analytics" to "www.google-analytics.com",
            "adsbygoogle" to "pagead2.googlesyndication.com",
            "doubleclick" to "securepubads.g.doubleclick.net",
            "facebook" to "connect.facebook.net",
            "taboola" to "cdn.taboola.com",
            "scorecard" to "sb.scorecardresearch.com",
            "adnxs" to "acdn.adnxs.com"
        )
        /** A document's size and content, shadow roots included. */
        private const val DOM_REPORT =
            "(function(){var r=document.body?document.body.getBoundingClientRect():{width:0,height:0};var deep=function(root){var n=0;var all=root.querySelectorAll('*');for(var i=0;i<all.length;i++){n++;if(all[i].shadowRoot)n+=deep(all[i].shadowRoot)}return n};" +
                "return JSON.stringify({text:document.body?document.body.innerText.replace(/\\s+/g,' ').trim().slice(0,200):'',els:document.body?deep(document.body):0,h:Math.round(r.height),w:Math.round(r.width),title:document.title,url:location.href," +
                "scrollWidth:document.documentElement.scrollWidth,scrollHeight:document.documentElement.scrollHeight,innerWidth:innerWidth,innerHeight:innerHeight,readyState:document.readyState})})()"
        /** What one extension's world sees on a page: the bootstrap's statistics and its `chrome`. */
        private const val WORLD_REPORT =
            "JSON.stringify({stats: window.__zenExtStats || null, chrome: typeof chrome, runtimeId: (typeof chrome === 'object' && chrome && chrome.runtime) ? chrome.runtime.id : null})"
        /** Video Speed Controller's main world: what inject.js left on window.VSC and the video's state. */
        private const val VSC_MAIN_WORLD_REPORT =
            "(function(){var v=document.getElementById('clip');var r=v?v.getBoundingClientRect():null;return JSON.stringify({vsc:window.VSC?Object.keys(window.VSC):null,stats:window.__zenExtStats||null,chrome:typeof chrome," +
                "videos:document.querySelectorAll('video').length,controllers:document.querySelectorAll('vsc-controller').length,readyState:v?v.readyState:null,networkState:v?v.networkState:null,error:v&&v.error?v.error.code:null,currentSrc:v?v.currentSrc:null,rect:r?Math.round(r.width)+'x'+Math.round(r.height):null})})()"
        /** Asks the bridge as inject.js does; the answer (or its absence after 2.5 s) lands on window.__vscProbe. */
        private const val VSC_HANDSHAKE_PROBE =
            "(function(){var h=document.documentElement;var p=window.__vscProbe={askedAt:Date.now(),answer:null,ms:null};h.addEventListener('VSC_SETTINGS_READY',function(e){p.ms=Date.now()-p.askedAt;try{p.answer=JSON.stringify(e.detail)}catch(x){p.answer='unserialisable: '+x}},{once:true});" +
                "h.dispatchEvent(new CustomEvent('VSC_REQUEST_SETTINGS'));return 'asked'})()"
        /** In the extension's world: does chrome.storage.sync.get(null) answer, and how fast. */
        private const val STORAGE_PROBE =
            "(function(){var p=window.__zenStorageProbe={askedAt:Date.now(),result:null,error:null,ms:null};try{chrome.storage.sync.get(null).then(function(v){p.ms=Date.now()-p.askedAt;p.result=JSON.stringify(v).slice(0,200)},function(e){p.ms=Date.now()-p.askedAt;p.error=String(e&&e.message||e)})}catch(e){p.error='threw: '+String(e&&e.message||e)}return 'asked'})()"
        private const val ELEMENT_CENTRE =
            "JSON.stringify((function(el){if(!el)return null;var r=el.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2,w:r.width,h:r.height}})(document.querySelector('%SELECTOR%')))"
        private const val KEY_RECORDER =
            "(function(){window.__keys=[];['keydown','keypress','keyup'].forEach(function(t){window.addEventListener(t,function(e){window.__keys.push({type:t,key:e.key,code:e.code,trusted:e.isTrusted})},true)});return 'ok'})()"
        private const val VIMIUM_WORLD_REPORT =
            "(function(){try{return JSON.stringify({enabled:typeof isEnabledForUrl==='boolean'?isEnabledForUrl:null,frameId:typeof frameId==='undefined'?null:frameId," +
                "normalMode:typeof normalMode==='undefined'?null:(normalMode?{keyMapping:normalMode.keyMapping?Object.keys(normalMode.keyMapping).length:0}:'null'),handlers:typeof handlerStack==='undefined'?null:handlerStack.stack.length," +
                "settingsLoaded:typeof Settings==='undefined'?null:Settings.isLoaded(),runtimeId:typeof chrome==='object'&&chrome.runtime?chrome.runtime.id:null})}catch(e){return JSON.stringify({error:String(e&&e.message||e)})}})()"
        private const val YT_CLOSE_UPSELL =
            "(function(){var d=Array.prototype.find.call(document.querySelectorAll('dialog[open], [role=\"dialog\"]'),function(el){return /YouTube app|best experience/i.test(el.textContent||'')});" +
                "if(!d)return 'none';var c=d.querySelector('button[aria-label*=\"lose\"], [role=\"button\"][aria-label*=\"lose\"], button[aria-label*=\"ismiss\"]');if(!c)return 'no close button';c.click();return 'closed'})()"
    }
}
