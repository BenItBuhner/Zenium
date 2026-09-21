package app.zen.chromium

import android.content.Intent
import android.graphics.Rect
import android.os.Debug
import android.os.SystemClock
import android.util.Log
import android.view.Choreographer
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
import app.zen.chromium.ext.ExtensionUrls
import app.zen.chromium.ext.ExtensionWebView
import org.json.JSONArray
import org.json.JSONObject
import org.json.JSONTokener
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.util.concurrent.CopyOnWriteArrayList
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
        /** Account-backed (core graded by [popupLogin]): the page the action click opens is read in the popup stage. */
        val account: Boolean = false,
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
        // Last, as it starts the browser over: the restored extension-page tab.
        if (chromeAnswers()) {
            runCatching { restoredOptionsTab() }.onFailure {
                Log.e(TAG, "the restored options tab check threw", it)
                results.optJSONObject("restoredOptionsTab")?.put("crash", it.toString()) ?: results.put("restoredOptionsTab", JSONObject().put("crash", it.toString()))
            }
        }
        results.put("finishedAt", System.currentTimeMillis())
    }

    /**
     * The restored extension-page tab: an options page open as a tab when the session ends must
     * come back rendered, with the runtime attached, when the browser starts again. The core
     * restores its windows (the active tab's view loads at once) before `extensions.start()`
     * configures the runtime, so the restored tab asks for its document before its extension is
     * served; the runtime holds the document and loads it again once the extension's configure
     * completes (`Extensions.kt`, `HeldPages`). The start-over is forced with a second
     * [launch]: a new activity, so a new host, a new chrome and a new core that reads the session
     * back from disk (the process stays: the instrumentation shares it). The row is the first
     * whose options page graded `P`, enabled again for this.
     */
    private fun restoredOptionsTab() {
        val report = JSONObject()
        results.put("restoredOptionsTab", report)
        val entry = (0 until rows.length()).map { rows.getJSONObject(it) }.firstOrNull { row ->
            row.optJSONObject("options")?.optString("verdict") == "P" && row.optJSONObject("options")?.optJSONObject("detail")?.optString("page", "")?.isNotEmpty() == true
        }
        if (entry == null) {
            report.put("verdict", "n/m").put("note", "no row's options page graded P in this run")
            return
        }
        val id = entry.getString("id")
        val page = entry.getJSONObject("options").getJSONObject("detail").getString("page").trimStart('/')
        val url = "chrome-extension://$id/$page"
        report.put("id", id).put("name", entry.optString("name")).put("url", url)
        val factor = speedFactor(entry)
        report.put("speedFactor", factor)
        coreInvoke("extension.setEnabled", JSONObject().put("id", id).put("enabled", true).toString())
        poll(scaled(20_000, factor), 400) { extensions().firstOrNull { it.getString("id") == id }?.takeIf { it.getBoolean("enabled") } }
            ?: error("$id did not come back enabled")
        closeExtraTabs()
        val tabId = createTab(url)
        showTab(tabId)
        val view = waitForView(tabId)
        val drawn = poll(scaled(OPTIONS_TIMEOUT_MS, factor), 500) { if (rendered(view)) true else null }
        SystemClock.sleep(1_200)
        snap("restored-options-before")
        report.put("before", json(tabEval(view, RESTORED_PAGE_REPORT)).put("rendered", drawn == true))
        if (drawn != true) {
            report.put("verdict", "n/m").put("note", "the options page did not render as a tab before the restart")
            return
        }
        // The session file must name the tab before the start-over, or nothing is restored. The
        // core writes it on a cadence; the wait scales with the job like the step's other waits
        // (a 156 job at x3.1 rendered the page and missed a fixed 10 s here).
        val state = File(app.filesDir, "zen/state.json")
        val persistDeadline = scaled(10_000, factor)
        val persisted = poll(persistDeadline, 300) { if (state.isFile && state.readText().contains(url)) true else null }
        report.put("persisted", persisted == true)
        if (persisted != true) {
            report.put("verdict", "n/m").put("note", "the session file did not name the tab within ${persistDeadline / 1000} s")
            return
        }
        Log.i(TAG, "RESTORE: starting the browser over with $url active")
        val since = SystemClock.uptimeMillis()
        launch()
        report.put("relaunchMs", SystemClock.uptimeMillis() - since)
        // The restored session's active tab is the options page, in whichever of the two
        // spellings the core carries for it (the session file names Chrome's; the tab model
        // takes the WebView's served origin back at the commit: `TabWebView.doUpdateVisitedHistory`
        // reports the raw URL over `navState()`'s presented one), as the core's own
        // `extensionPageOf` treats them.
        val restoredTab = poll(30_000, 500) {
            runCatching { activeCoreTab() }.getOrNull()?.takeIf { ExtensionUrls.present(it.optString("url")).startsWith(url) }
        }
        if (restoredTab == null) {
            report.put("verdict", "F").put("note", "no active tab on $url within 30 s of the restart; tabs: ${runCatching { tabUrls() }.getOrNull()}")
            snap("restored-options-tab")
            return
        }
        val restoredId = restoredTab.optString("id")
        report.put("restoredTabId", restoredId).put("restoredUrl", restoredTab.optString("url"))
        val restored = waitForView(restoredId)
        val rendered = poll(scaled(OPTIONS_TIMEOUT_MS, factor), 500) { if (rendered(restored)) true else null }
        report.put("renderedMs", SystemClock.uptimeMillis() - since)
        // A page may keep itself out of sight until its background answers (uBO Lite's dashboard
        // stays `body.loading`, visibility hidden and so without innerText, until its worker's
        // `getOptionsPageData` resolves, and on a restart the worker loads its rulesets first):
        // the screenshot waits for visible text, the page as the user sees it, and the report
        // says when it came.
        val visible = poll(scaled(OPTIONS_TIMEOUT_MS, factor), 500) { if (visibleText(restored)) true else null }
        report.put("visible", visible == true).put("visibleMs", SystemClock.uptimeMillis() - since)
        SystemClock.sleep(1_500)
        snap("restored-options-tab")
        val after = json(tabEval(restored, RESTORED_PAGE_REPORT))
        val console = consoleOf(restored)
        report.put("after", after).put("console", JSONArray(console.takeLast(20)))
        val attached = after.optString("runtimeId") == id
        val verdict = if (rendered == true && attached && visible == true) "P" else if (rendered == true) "PARTIAL" else "F"
        report.put("verdict", verdict).put(
            "note",
            if (rendered == true) "the restored tab rendered ${after.optInt("els")} elements ${report.optLong("renderedMs") / 1000} s after the restart" +
                (if (visible == true) ", visible text ${report.optLong("visibleMs") / 1000} s after it" else ", no visible text within ${scaled(OPTIONS_TIMEOUT_MS, factor) / 1000} s of the render") +
                (if (attached) ", chrome.runtime.id is the extension's" else ", but chrome.runtime.id reads ${after.optString("runtimeId")}")
            else "the restored tab did not render within ${scaled(OPTIONS_TIMEOUT_MS, factor) / 1000} s of the restart: ${after.toString().take(300)}"
        )
        Log.i(TAG, "RESTORE ${entry.optString("name")}: $verdict – ${report.optString("note")}")
        write()
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
     * it opens, or an open page of its own it brings to the front, counts as the extension's
     * answer (the desktop grades it the same way).
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
        val activeBefore = activeCoreTab()?.optString("id")
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
                // A page of the extension's own that was open already and that the click brought
                // to the front (1Password activates its welcome tab while it onboards, as Chrome
                // shows it) is the extension's answer as much as a new tab is.
                val activeNow = activeCoreTab()
                val raised = activeNow?.optString("url")?.takeIf {
                    activeNow.optString("id") != activeBefore && extensionPage(it, row.id)
                }
                raised?.let { detail.put("raisedTab", it) }
                val answered = if (opened.isNotEmpty()) opened else listOfNotNull(raised)
                if (runtimePopup == null && answered.isNotEmpty()) {
                    entry.put("popupOpened", JSONArray(answered))
                    // The page the click showed, read while its tab is still there (the stage's
                    // closeExtraTabs takes it): an account row's core grade (popupLogin) is its
                    // text, and an extension page that shows no sign-in (1Password's
                    // app.html#/page/error) carries the blank-page evidence of the row so far.
                    if (row.account) openedPage(row, answered[0])?.let { entry.put("popupOpenedPage", it) }
                    val what = if (opened.isNotEmpty()) "opened ${opened.joinToString().take(160)}" else "brought its open page ${answered[0].take(160)} to the front"
                    stage(entry, "popup", "P", "no popup (the extension emptied it with action.setPopup); the click fired action.onClicked, which $what", detail)
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
     * The document of the tab the action click opened (`url`), as [DOM_REPORT] reads it, and for
     * an extension page whose text shows no sign-in word the blank-page evidence of the row so far
     * ([blankPageEvidence]); null when the tab has no WebView.
     */
    private fun openedPage(row: Row, url: String): JSONObject? {
        val tabId = tabUrls().entries.firstOrNull { it.value == url }?.key ?: return null
        val view = runCatching { waitForView(tabId) }.getOrNull() ?: return null
        val dom = runCatching { json(tabEval(view, DOM_REPORT)) }.getOrNull() ?: return null
        val page = JSONObject().put("url", url).put("dom", dom)
        if (extensionPage(url) && (ERROR_ROUTE.containsMatchIn(url) || !LOGIN_WORDS.containsMatchIn(dom.optString("text")))) {
            page.put("blankTab", blankPageEvidence(view, row, 0L))
        }
        return page
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
        val since = SystemClock.uptimeMillis()
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
            val opened = urls.filterKeys { it !in tabsBefore }.entries.firstOrNull { extensionPage(it.value) }
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
                "in a $where: ${dom.optInt("els")} elements, ${dom.optInt("w")}x${dom.optInt("h")} css px, text \"${dom.optString("text").take(80)}\" (${extensionPath(dom.optString("url")).take(60)})" +
                    (if (uncaught.isNotEmpty()) "; uncaught: ${uncaught.take(2).joinToString(" | ") { it.take(160) }}" else ""),
                detail
            )
        } else {
            val sheet = popupView()
            val openedTabs = tabUrls().filterKeys { it !in tabsBefore }
            val opened = openedTabs.values.toList()
            detail.put("openedTabs", JSONArray(opened))
            if (sheet != null) detail.put("sheetDom", json(tabEval(sheet, DOM_REPORT))).put("sheetConsole", JSONArray(consoleOf(sheet).takeLast(20)))
            // A tab that opened and drew nothing: its document's report (scripts, readyState), console,
            // the host's endpoints for it, the bridge trace of the stage and a message probe are the
            // evidence of why (Adblock Plus's and Ghostery's options pages stayed blank on both jobs,
            // their documents complete and their consoles empty; Adblock Plus's options.js awaits one
            // runtime.sendMessage before it shows its body).
            openedTabs.entries.firstOrNull { extensionPage(it.value) }?.let { blank ->
                var v: TabWebView? = null
                instrumentation.runOnMainSync { v = host.tabs.get(blank.key) }
                v?.let { detail.put("blankTab", blankPageEvidence(it, row, since)) }
            }
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

    /**
     * Tabs the extension opened go, the extension is disabled: the next row starts from the same
     * place. Each step stands on its own, the disable first among what the chrome has to answer:
     * a row whose command timed out (Tampermonkey's popup close on the 156 job) left its
     * extension enabled when the tab close before the disable threw, and its install page and
     * tampermonkey.net tabs stood in Violentmonkey's row.
     */
    private fun cleanup(row: Row, entry: JSONObject) {
        if (!chromeAnswers()) Log.w(TAG, "${row.name} cleanup: the chrome is not answering")
        runCatching { coreInvoke("extension.closePopup", "null") }
        val installed = runCatching { extensions().firstOrNull { it.getString("id") == row.id } }
        val enabled = installed.getOrNull()?.getBoolean("enabled") ?: installed.isFailure
        if (enabled) {
            runCatching {
                coreInvoke("extension.setEnabled", JSONObject().put("id", row.id).put("enabled", false).toString())
            }.onFailure { entry.put("disableError", it.toString()) }
            val off = runCatching {
                poll(20_000, 400) { extensions().firstOrNull { it.getString("id") == row.id }?.takeIf { !it.getBoolean("enabled") } }
            }.getOrNull()
            entry.put("disabled", off != null)
            // The runtime detaches: its background view goes with it.
            val gone = poll(10_000, 300) { if (backgroundView(row.id) == null) true else null }
            entry.put("backgroundGoneAfterDisable", gone == true)
        }
        runCatching { closeExtraTabs() }.onFailure { entry.put("closeTabsError", it.toString()) }
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
    private fun popupLogin(label: String): (Row, JSONObject) -> Grade = { row, entry ->
        val popup = entry.optJSONObject("popup")
        val opened = entry.optJSONArray("popupOpened")
        val text = entry.optString("popupText")
        val login = LOGIN_WORDS
        when {
            opened != null && opened.length() > 0 -> {
                val url = opened.optString(0)
                // The page as the popup stage read it before closing its tab (popupOpenedPage);
                // read again here when the tab is still open.
                val stored = entry.optJSONObject("popupOpenedPage")?.takeIf { it.optString("url") == url }
                val tabId = tabUrls().entries.firstOrNull { it.value == url }?.key
                val view = tabId?.let { id -> runCatching { waitForView(id) }.getOrNull() }
                val dom = view?.let { v -> runCatching { json(tabEval(v, DOM_REPORT)) }.getOrNull() } ?: stored?.optJSONObject("dom")
                val txt = dom?.optString("text") ?: ""
                val pass = login.containsMatchIn(txt) && !ERROR_ROUTE.containsMatchIn(url)
                // An extension page that opened in a tab and shows no sign-in (1Password's
                // `app.html#/page/error`): the same evidence as a blank options tab, the whole
                // row's trace since the page was opened in the popup stage.
                val evidence = when {
                    pass || !extensionPage(url) -> null
                    view != null -> blankPageEvidence(view, row, 0L)
                    else -> stored?.optJSONObject("blankTab")
                }
                val extra = evidence?.let { JSONObject().put("blankTab", it) }
                Grade(if (pass) "n/m" else "F", "$label: the action click showed ${url.take(90)} (\"${txt.take(80)}\"); the vault itself needs an account (not measurable here)", extra)
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
     *
     * The install is asynchronous in the manager (it stores the script, then closes its install
     * tab), so the target is opened once the install tab has gone, or after [USERSCRIPT_INSTALL_MS]
     * if the manager keeps it. A target page whose first document loaded before the script was
     * in place is reloaded once inside the same deadline: the grade is about whether the runtime
     * runs the script, not about which of the two documents came first. Both readings are kept
     * (`target`, then `targetReload` when there was one).
     */
    private fun userscripts(row: Row, entry: JSONObject, installPage: Regex): Grade {
        coreInvoke("extension.setAllowUserScripts", JSONObject().put("id", row.id).put("allowed", true).toString())
        SystemClock.sleep(2_500)
        val extra = JSONObject()
        val factor = speedFactor(entry)
        extra.put("speedFactor", factor)
        val since = StepEvidence(row)
        val before = tabUrls().keys
        createTab("$BASE/hello.user.js")
        val installTab = poll(scaled(30_000, factor), 500) {
            tabUrls().entries.firstOrNull { it.key !in before && extensionPage(it.value) && installPage.containsMatchIn(it.value) }
        }
        extra.put("tabsAfterOpen", JSONArray(tabUrls().values.toList()))
        if (installTab == null) {
            since.record(extra, "afterOpen")
            return Grade("F", "install page never appeared within ${scaled(30_000, factor) / 1000} s: tabs=${tabUrls().values.joinToString().take(200)}", extra)
        }
        extra.put("installUrl", installTab.value)
        val installView = waitForView(installTab.key)
        // The manager's page asks its background for the script's data and sits on a spinner
        // until the answer comes: the Install button showing, not a fixed wait, is the cue.
        val readyAt = SystemClock.elapsedRealtime()
        val ready = pollExpr(installView, USERSCRIPT_INSTALL_PAGE_STATE, scaled(20_000, factor))
        extra.put("installPage", ready.put("readyMs", SystemClock.elapsedRealtime() - readyAt).put("console", JSONArray(consoleOf(installView).takeLast(8))))
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
        val clicked = SystemClock.elapsedRealtime()
        SystemClock.sleep(1_000)
        if (installTab.key in tabUrls()) {
            // What the page shows a second after the click: its spinner back up, the button's
            // state, its console; the manager's answer to the click comes from its background.
            snap("${entry.optString("slug")}-userscript-after-click")
            extra.put("installPageAfterClick", json(tabEval(installView, USERSCRIPT_INSTALL_PAGE_STATE)).put("console", JSONArray(consoleOf(installView).takeLast(8))))
        }
        // The manager closes its install tab once the script is stored; that is the install landing.
        val installWaitMs = scaled(USERSCRIPT_INSTALL_MS, factor)
        val installTabGone = poll(installWaitMs, 250) { if (installTab.key !in tabUrls()) true else null } == true
        extra.put("installTabClosedMs", if (installTabGone) SystemClock.elapsedRealtime() - clicked else JSONObject.NULL)
        if (!installTabGone) {
            SystemClock.sleep(1_000)
            extra.put("installPageAtDeadline", json(tabEval(installView, USERSCRIPT_INSTALL_PAGE_STATE)).put("console", JSONArray(consoleOf(installView).takeLast(8))))
        }
        since.record(extra, "afterInstall")
        val bg = backgroundView(row.id)
        if (bg != null) {
            tabEval(bg, "(function(){window.__us=null;Promise.resolve().then(function(){return chrome.userScripts.getScripts()}).then(function(s){window.__us=JSON.stringify({registered:s.length})},function(e){window.__us=JSON.stringify({error:String(e&&e.message||e)})})})()")
            poll(8_000, 250) { val v = tabEval(bg, "window.__us"); if (v == "null") null else v }?.let { extra.put("userScripts", json(it)) }
        } else extra.put("userScripts", "no background view")
        val marker = "JSON.stringify({pass: !!(document.documentElement && document.documentElement.dataset.userscript), title: document.title, " +
            "dataset: (document.documentElement && document.documentElement.dataset.userscript) || null})"
        val target = createTab("$BASE/us-target.html")
        val targetView = waitForView(target)
        val deadline = SystemClock.elapsedRealtime() + scaled(USERSCRIPT_EFFECT_MS, factor)
        var page = pollExpr(targetView, marker, scaled(USERSCRIPT_FIRST_LOAD_MS, factor))
        extra.put("target", page)
        if (!page.optBoolean("pass")) {
            // The script may have landed after the first document loaded: one reload, same deadline.
            extra.put("targetErrorsFirstLoad", targetErrors(targetView))
            tabEval(targetView, "location.reload()")
            SystemClock.sleep(1_000)
            page = pollExpr(targetView, marker, (deadline - SystemClock.elapsedRealtime()).coerceAtLeast(3_000))
            extra.put("targetReload", page)
        }
        extra.put("targetConsole", JSONArray(consoleOf(targetView).takeLast(10)))
        // The fixture keeps its uncaught errors with their stacks (`window.__errors`): a console
        // line names a file and a line, the frames say whose code threw.
        extra.put("targetErrors", targetErrors(targetView))
        since.record(extra, "atEnd")
        val readings = "first load ${extra.optJSONObject("target")?.toString()?.take(120)}" +
            (extra.optJSONObject("targetReload")?.let { ", after reload ${it.toString().take(120)}" } ?: "")
        return Grade(
            if (page.optBoolean("pass")) "P" else "F",
            "install page opened (${extensionPath(installTab.value).take(50)}), ready after ${ready.optLong("readyMs")} ms ${if (ready.optBoolean("pass")) "" else "(still waiting: ${ready.optString("text").take(60)}) "}" +
                "install click ${click.toString().take(120)}, " +
                "install tab ${if (installTabGone) "closed after ${extra.opt("installTabClosedMs")} ms" else "still open after ${installWaitMs / 1000} s (${extra.optJSONObject("installPageAtDeadline")?.optString("text")?.take(60)})"}, " +
                "userScripts: ${extra.opt("userScripts")}, target page: $readings" +
                (extra.optJSONArray("targetErrors")?.takeIf { it.length() > 0 }?.let { "; first error: ${it.optJSONObject(0)?.optString("message")?.take(80)}" } ?: "") +
                if (factor > 1.0) " (waits x${"%.1f".format(factor)}: ${speedNote(entry)})" else "",
            extra
        )
    }

    /**
     * The page's uncaught errors and their stacks: the fixture's own (`window.__errors`, from its
     * first inline script on), the runtime's debug capture (`__zenExtStats.errors`, from
     * document start on, with the throwing inline script's source for an error a console line
     * gives as `<document URL>:1`) and the errors of the sub-frames the runtime left alone
     * (`__zenExtStats.frameErrors`: an error inside such a frame never reaches the page's own
     * `error` listeners), each marked with where it was kept. One `stats` entry carries the
     * frames the runtime left alone and the shield's state; without the runtime's capture on the
     * page (no `__zenExtStats`), one `none` entry says so.
     */
    private fun targetErrors(view: WebView): JSONArray {
        // tabEval hands a string result back unquoted: the array's text itself.
        val text = tabEval(
            view,
            "JSON.stringify([].concat((window.__errors||[]).slice(0,6).map(function(e){e=Object.assign({},e);e.kept='page';return e})," +
                "((window.__zenExtStats&&window.__zenExtStats.errors)||[]).slice(0,6).map(function(e){e=Object.assign({},e);e.kept='runtime';return e})," +
                "((window.__zenExtStats&&window.__zenExtStats.frameErrors)||[]).slice(0,6).map(function(e){e=Object.assign({},e);e.kept='frame';return e})," +
                "window.__zenExtStats?[{kept:'stats',untouchedFrames:window.__zenExtStats.untouchedFrames||[],trustedTypes:window.__zenExtStats.trustedTypes,applied:window.__zenExtStats.applied,groups:(window.__zenExtStats.groups||[]).length}]" +
                ":[{kept:'none',message:'no __zenExtStats on the page'}]))"
        )
        return runCatching { JSONArray(text) }.getOrElse { JSONArray().put(JSONObject().put("kept", "unread").put("message", text.take(300))) }
    }

    /**
     * How much slower this job runs than the 113 job at normal speed, the larger of two readings,
     * bounded so a wait never grows past four times its size (a core check's fixed waits scale
     * by it, so a slow job does not fail a working runtime):
     *  - the row's own store install against about 8 s on the 113 job (6.8-11 s in round 3's
     *    runs; 12-18 s on a 156 job at its normal speed, 25-29 s on round 2's slow final run);
     *  - the app's UI frame interval against about 100 ms on the 113 job. Every bridge hop between
     *    an extension's page, the core and its worker takes a turn of the UI thread
     *    (`evaluateJavascript`, the reply proxy's `postMessage`), so a handshake of many hops runs
     *    at one hop per frame: on the 156 job's snapshot WebView a frame took about 830 ms in
     *    round 3's mid run (`Choreographer: Skipped 49 frames` all run long) and Stylus's install
     *    page needed 21 s for the 25 hops of its build before its Install button was armed, where
     *    the 113 job needs under a second. The install time alone (x1.7 there) does not see this.
     * Measured once per row and kept on its entry (`speed`).
     */
    private fun speedFactor(entry: JSONObject): Double {
        entry.optJSONObject("speed")?.let { return it.optDouble("factor", 1.0) }
        val installMs = entry.optJSONObject("install")?.optJSONObject("detail")?.optLong("ms", 0L) ?: 0L
        val installRatio = if (installMs <= 0L) 1.0 else installMs.toDouble() / NOMINAL_INSTALL_MS
        val frameMs = frameIntervalMs()
        val frameRatio = if (frameMs <= 0L) 1.0 else frameMs.toDouble() / NOMINAL_FRAME_MS
        val factor = maxOf(installRatio, frameRatio).coerceIn(1.0, 4.0)
        entry.put("speed", JSONObject().put("installMs", installMs).put("frameMs", frameMs).put("installRatio", installRatio).put("frameRatio", frameRatio).put("factor", factor))
        Log.i(TAG, "SPEED ${entry.optString("name")}: install ${installMs} ms (x${"%.2f".format(installRatio)}), frame ${frameMs} ms (x${"%.2f".format(frameRatio)}) -> waits x${"%.2f".format(factor)}")
        return factor
    }

    /**
     * The UI thread's frame interval right now: the mean gap between [FRAME_PROBE_FRAMES]
     * consecutive Choreographer frames (a redraw is requested so frames come even when nothing
     * animates), or the time the probe waited when fewer frames came; 0 when none did.
     */
    private fun frameIntervalMs(): Long {
        val stamps = CopyOnWriteArrayList<Long>()
        val done = CountDownLatch(1)
        val started = SystemClock.uptimeMillis()
        instrumentation.runOnMainSync {
            val choreographer = Choreographer.getInstance()
            val callback = object : Choreographer.FrameCallback {
                override fun doFrame(frameTimeNanos: Long) {
                    stamps.add(frameTimeNanos / 1_000_000)
                    if (stamps.size > FRAME_PROBE_FRAMES) done.countDown()
                    else {
                        activity.window.decorView.invalidate()
                        choreographer.postFrameCallback(this)
                    }
                }
            }
            activity.window.decorView.invalidate()
            choreographer.postFrameCallback(callback)
        }
        done.await(FRAME_PROBE_TIMEOUT_MS, TimeUnit.MILLISECONDS)
        val list = stamps.toList()
        return when {
            list.size >= 2 -> (list.last() - list.first()) / (list.size - 1)
            list.isEmpty() -> 0L
            else -> SystemClock.uptimeMillis() - started
        }
    }

    private fun scaled(ms: Long, factor: Double): Long = (ms * factor).toLong()

    /** The two readings behind the row's speed factor, for a grade's note. */
    private fun speedNote(entry: JSONObject): String {
        val speed = entry.optJSONObject("speed") ?: return "install took ${entry.optJSONObject("install")?.optJSONObject("detail")?.optLong("ms")} ms"
        return "install took ${speed.optLong("installMs")} ms, a UI frame ${speed.optLong("frameMs")} ms"
    }

    /**
     * What the extension's background and the bridge said during one core step: the console lines
     * the background view added and the bridge trace lines of the extension since the step began
     * (a `runtime.sendMessage` shows as `msg type=<its discriminator>`, its answer as `msgReply`,
     * a relayed service-worker port as `sw`), so a handshake that stopped can be placed.
     */
    private inner class StepEvidence(private val row: Row) {
        private val consoleFrom = backgroundView(row.id)?.let { consoleOf(it).size } ?: 0
        /** Trace lines start with `uptimeMillis`; the ring drops old lines, so the time, not the index, marks the step's start. */
        private val startedAt = SystemClock.uptimeMillis()

        private fun traceLines(): List<String> {
            var list: List<String> = emptyList()
            instrumentation.runOnMainSync { list = host.extensions.traceSnapshot(row.id) }
            return list.filter { (it.substringBefore(' ').toLongOrNull() ?: Long.MAX_VALUE) >= startedAt }
        }

        fun record(extra: JSONObject, at: String) {
            val bg = backgroundView(row.id)
            val console = bg?.let { consoleOf(it).drop(consoleFrom) } ?: emptyList()
            val trace = traceLines()
            extra.put(
                "bg" + at.replaceFirstChar { it.uppercase() },
                JSONObject()
                    .put("console", JSONArray(console.takeLast(15)))
                    .put("bridge", JSONArray(trace.takeLast(40)))
                    .put("bridgeLines", trace.size)
            )
        }
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
     * which tells the runtime path from the pointer model. The touch selection is cleared from the
     * page (Chromium takes its handles and toolbar down with it): a Back on a tab without history
     * leaves the browser (`PredictiveBack.nothingLeft`, `moveTaskToBack`), and every evaluation
     * of the synthetic path answered null against the paused page (both jobs, every run).
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
            tabEval(view, "(function(){getSelection().removeAllRanges();return 'ok'})()")
            SystemClock.sleep(600)
        }
        if (how == "none" && onScreen("Google Translate: the synthetic selection")) {
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
            tabUrls().entries.firstOrNull { it.key !in before && extensionPage(it.value, row.id) }
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
        val factor = speedFactor(entry)
        extra.put("speedFactor", factor)
        val since = StepEvidence(row)
        val before = tabUrls().keys
        createTab("$BASE/hello.user.css")
        val installTab = poll(scaled(25_000, factor), 500) {
            tabUrls().entries.firstOrNull { it.key !in before && extensionPage(it.value) && it.value.contains("install-usercss") }
        }
        extra.put("tabsAfterOpen", JSONArray(tabUrls().values.toList()))
        var click = JSONObject().put("clicked", false)
        var ready = JSONObject()
        if (installTab != null) {
            val installView = waitForView(installTab.key)
            // The page parses the usercss in a worker of its own origin reached through the
            // service worker (round 2, 8.6): `getInstallCode`, `build`, then the button's `onclick`
            // is assigned. The button is in the HTML from the start, enabled and visible, so the
            // handler being armed is the cue (round 3's mid run on the 156 job clicked a button
            // without one, 21 s of hops before the build came back), not the button, not a wait.
            val readyAt = SystemClock.elapsedRealtime()
            ready = pollExpr(installView, STYLUS_INSTALL_PAGE_STATE, scaled(20_000, factor))
            extra.put("installPage", ready.put("readyMs", SystemClock.elapsedRealtime() - readyAt).put("console", JSONArray(consoleOf(installView).takeLast(8))))
            snap("${entry.optString("slug")}-usercss-install")
            for (i in 0 until 10) {
                click = json(tabEval(installView, "(function(){var b=document.querySelector('button.install');if(!b||b.offsetParent===null||b.disabled||typeof b.onclick!=='function')return JSON.stringify({clicked:false,present:!!b,disabled:b?b.disabled:null,hidden:b?b.offsetParent===null:null,armed:!!b&&typeof b.onclick==='function'});b.click();return JSON.stringify({clicked:true})})()"))
                if (click.optBoolean("clicked")) break
                SystemClock.sleep(1_000)
            }
            SystemClock.sleep(1_000)
            // A second after the click: the button (Stylus disables it and relabels it once the
            // style is saved), the page's message box, its console; the save itself is the
            // page-to-service-worker `usercss.install` round trip.
            snap("${entry.optString("slug")}-usercss-after-click")
            extra.put("installPageAfterClick", json(tabEval(installView, STYLUS_INSTALL_PAGE_STATE)).put("console", JSONArray(consoleOf(installView).takeLast(8))))
            // The style's save (the `usercss.install` round trip, several hops) and the broadcast
            // to the open tabs, scaled with the job.
            val landed = pollExpr(installView, STYLUS_INSTALL_PAGE_STATE.replace("pass:!!b&&b.offsetParent!==null&&!b.disabled&&armed", "pass:!!b&&(b.disabled||/installed/i.test(b.textContent||''))"), scaled(8_000, factor))
            extra.put("installPageLanded", landed)
            since.record(extra, "afterInstall")
        }
        extra.put("installClick", click)
        val tab = createTab("$BASE/page-a.html?stylus")
        val view = waitForView(tab)
        val found = pollExpr(view, "JSON.stringify({pass: getComputedStyle(document.body).backgroundColor === 'rgb(255, 0, 0)', bg: getComputedStyle(document.body).backgroundColor, styles: document.querySelectorAll('style.stylus, style[id^=\"stylus\"]').length})", scaled(12_000, factor))
        extra.put("page", found)
        if (worlds) worldEval(view, row.id, WORLD_REPORT)?.let { extra.put("world", json(it)) }
        since.record(extra, "atEnd")
        return Grade(
            if (found.optBoolean("pass")) "P" else "F",
            "usercss install page ${if (installTab != null) "opened, ready after ${ready.optLong("readyMs")} ms${if (ready.optBoolean("pass")) "" else " (button not up: ${ready.toString().take(100)})"}" else "did not open within ${scaled(25_000, factor) / 1000} s (tabs: ${tabUrls().values.joinToString().take(120)})"}, " +
                "install ${click.toString().take(100)}, after the click: ${extra.optJSONObject("installPageLanded")?.let { "button ${if (it.optBoolean("disabled")) "disabled" else "enabled"} \"${it.optString("label").take(30)}\"${it.optString("message").takeIf { m -> m.isNotEmpty() && m != "null" }?.let { m -> ", message \"${m.take(60)}\"" } ?: ""}" } ?: "n/a"}, " +
                "page: ${found.toString().take(120)}" +
                if (factor > 1.0) " (waits x${"%.1f".format(factor)}: ${speedNote(entry)})" else "",
            extra
        )
    }

    /** Grammarly and LanguageTool attach their custom elements to a focused textarea. */
    private fun editorAttach(tagPrefix: String, label: String, pattern: String? = null): (Row, JSONObject) -> Grade = { row, _ ->
        val tab = createTab("$BASE/editor.html?$tagPrefix")
        val view = waitForView(tab)
        poll(20_000, 400) { if (tabEval(view, "String(document.readyState === 'complete')") == "true") true else null }
        SystemClock.sleep(2_500)
        val centre = json(tabEval(view, ELEMENT_CENTRE.replace("%SELECTOR%", "#editor")))
        screenPoint(view, centre)?.let { tap(it.first, it.second) }
        SystemClock.sleep(600)
        tabEval(view, "(function(){var e=document.getElementById('editor');e.focus();e.dispatchEvent(new Event('input',{bubbles:true}));return 'ok'})()")
        awaitIme(true, 4_000)
        // The extension's elements: custom elements under its tag prefix (Grammarly's, LanguageTool's), or
        // anything whose tag, id or class carries `pattern` (QuillBot mounts <quillbot-extension-root>).
        val test = pattern?.let { "/$it/i.test(e.tagName+' '+(e.id||'')+' '+String(e.className||''))" } ?: "/^$tagPrefix-/i.test(e.tagName)"
        val expr = "(function(){var els=Array.prototype.filter.call(document.querySelectorAll('*'),function(e){return $test});" +
            "return JSON.stringify({pass:els.length>0,tags:Array.from(new Set(els.map(function(e){return e.tagName.toLowerCase()+(e.id?'#'+e.id:'')}))).slice(0,6),focused:document.activeElement&&document.activeElement.id})})()"
        val found = pollExpr(view, expr, 25_000)
        val extra = JSONObject().put("page", found).put("console", JSONArray(consoleOf(view).takeLast(10)))
        if (worlds) worldEval(view, row.id, WORLD_REPORT)?.let { extra.put("world", json(it)) }
        // The keyboard goes with a Back only while it is up: without one the Back leaves the browser.
        if (imeShown()) back() else tabEval(view, "(function(){document.activeElement&&document.activeElement.blur();return 'ok'})()")
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
        val since = SystemClock.uptimeMillis()
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
        val listTab = poll(15_000, 500) { tabUrls().entries.firstOrNull { extensionPage(it.value, row.id) && extensionPath(it.value).startsWith("/onetab.html") } }
        var list = JSONObject()
        if (listTab != null) {
            val view = waitForView(listTab.key)
            list = pollExpr(view, "JSON.stringify({pass: document.querySelectorAll('a[href*=\"page-\"]').length >= 3, links: document.querySelectorAll('a[href*=\"page-\"]').length, text: document.body.innerText.replace(/\\s+/g,' ').trim().slice(0,200)})", 10_000)
            // The list page drew nothing but its spinner (the 156 job, its console empty): the blank-page
            // evidence – the host's endpoints for it, the stage's bridge trace, a message probe.
            if (!list.optBoolean("pass")) extra.put("blankList", blankPageEvidence(view, row, since))
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

    // --- the core checks of compat round 4 (the next 30 by installs) -----------------------------

    /**
     * A row whose whole reachable surface on the phone is its background: a signed-in Google
     * account (Docs Offline), a desktop companion over native messaging (Remote Desktop, Webex,
     * Power Automate, the Windows Accounts broker behind Microsoft Single Sign On, McAfee's
     * dispatcher). The core is `n/m` with the reason, as the desktop table has it; what is
     * measured is the runtime's shape for the row: the worker up (the background stage) and, for
     * a native-messaging row, `runtime.connectNative` / `sendNativeMessage` answering as Chrome
     * does without the host installed ("Specified native messaging host not found."), not a
     * missing function or a "not implemented" rejection – that would be `F`, ours.
     */
    private fun serviceBacked(label: String, reason: String, native: Boolean = false): (Row, JSONObject) -> Grade = { row, entry ->
        val background = entry.optJSONObject("background")?.optString("verdict")
        val extra = JSONObject()
        val bg = backgroundView(row.id)
        val probe = if (native && bg != null) nativeMessagingProbe(bg).also { extra.put("nativeMessaging", it) } else null
        if (native && bg == null) extra.put("nativeMessaging", "no background view to probe from")
        val shapeOk = probe == null || probe.optBoolean("pass")
        when {
            background != "P" && background != "PARTIAL" ->
                Grade("F", "$label: background ${background ?: "?"} (${entry.optJSONObject("background")?.optString("note")?.take(160)})", extra)
            !shapeOk -> Grade("F", "$label: the native messaging API does not answer as Chrome's does: ${probe.toString().take(240)}", extra)
            else -> Grade(
                "n/m",
                "$label: $reason (not measurable here); background $background" +
                    (probe?.let { "; native messaging: ${it.optString("error").take(80)} (connectNative ${it.optString("connectNative")}, port ${it.optString("disconnect").take(60)})" } ?: ""),
                extra
            )
        }
    }

    /** `runtime.sendNativeMessage` / `connectNative` to a host that does not exist, from the background: Chrome's error is the pass. */
    private fun nativeMessagingProbe(bg: WebView): JSONObject {
        tabEval(bg, NATIVE_MESSAGING_PROBE)
        val text = poll(10_000, 250) {
            tabEval(bg, "window.__zenNativeProbe && window.__zenNativeProbe.done ? JSON.stringify(window.__zenNativeProbe) : null").takeIf { it != "null" }
        }
        return text?.let(::json) ?: JSONObject().put("pass", false).put("note", "no answer within 10 s")
    }

    /**
     * An account-gated row without a popup (Claude, Capital One Shopping, Online Security, Avira
     * Password Manager, Read&Write, NordPass): the action click, on a settled fixture tab, opens
     * or navigates to the vendor's sign-in / setup page (`opens`), switches to one it opened at
     * install (Online Security's `tabs.update(id, {active: true})` on its setup tab), opens the
     * row's own page as a tab (NordPass's app page, signed out), injects its UI into the page
     * (`injects`, Read&Write's `gw-toolbar`, which its content script shows on the worker's
     * `tabs.sendMessage`), or the row's own page (`page`, Claude's side panel document, which the
     * phone has no panel to host: opened as a tab) shows its sign-in. Each is the row's sign-in
     * surface: `n/m`, the account being the gate (`gate` names another gate: Avast's cloud
     * verdict, IE Tab's Windows companion). A row whose click runs into the gate in its worker
     * instead (`gateLog`: Save to Google Drive's `identity.getAuthToken`, refused as Zenium
     * refuses it without a signed-in browser account) is `n/m` on that line. A row whose click
     * does nothing and whose page shows nothing is `F`, with the bridge trace.
     */
    private fun accountGate(label: String, opens: Regex, page: String? = null, injects: String? = null, gate: String = "an account", gateLog: Regex? = null): (Row, JSONObject) -> Grade = { row, entry ->
        val popup = entry.optJSONObject("popup")?.optString("verdict")
        val opened = entry.optJSONArray("popupOpened")
        val extra = JSONObject()
        val factor = speedFactor(entry)
        when {
            popup == "P" || popup == "PARTIAL" ->
                Grade("n/m", "$label: popup renders (\"${entry.optString("popupText").take(80)}\"); the core needs $gate (not measurable here)")
            opened != null && opened.length() > 0 && opens.containsMatchIn(opened.optString(0)) ->
                Grade("n/m", "$label: the action click opened ${opened.optString(0).take(100)} (its sign-in / setup page); the core needs $gate (not measurable here)")
            else -> {
                val tab = createTab("$BASE/page-b.html?gate")
                val view = waitForView(tab)
                poll(scaled(15_000, factor), 400) { if (tabEval(view, "String(document.readyState === 'complete')") == "true") true else null }
                SystemClock.sleep(scaled(2_000, factor))
                val before = tabUrls()
                val activeBefore = activeCoreTab()?.optString("id")
                val since = StepEvidence(row)
                coreInvoke("extension.openPopup", """{"id":${JSONObject.quote(row.id)},"anchor":{"x":0,"y":0,"width":0,"height":0}}""")
                val hit: Any? = poll(scaled(20_000, factor), 500) {
                    val now = tabUrls()
                    now.entries.firstOrNull { (it.key !in before || before[it.key] != it.value) && opens.containsMatchIn(it.value) }
                        ?: now.entries.firstOrNull { it.key !in before && extensionPage(it.value, row.id) }
                        ?: activeCoreTab()?.optString("id")?.takeIf { it != activeBefore && it != tab }
                            ?.let { id -> now.entries.firstOrNull { it.key == id && opens.containsMatchIn(it.value) } }
                        ?: injects?.let { selector -> json(tabEval(view, INJECTED_UI.replace("__SELECTOR__", JSONObject.quote(selector)))).takeIf { it.optBoolean("pass") } }
                }
                @Suppress("UNCHECKED_CAST")
                val landed = hit as? Map.Entry<String, String>
                val injected = hit as? JSONObject
                if (injected != null) {
                    SystemClock.sleep(scaled(2_000, factor))
                    snap("${entry.optString("slug")}-injected")
                    extra.put("injected", injected)
                }
                runCatching { coreInvoke("extension.closePopup", "null") }
                extra.put("tabsAfterClick", JSONArray(tabUrls().values.toList()))
                var text = ""
                if (landed != null) {
                    val landedView = runCatching { waitForView(landed.key) }.getOrNull()
                    text = landedView?.let { v -> pollExpr(v, DOM_REPORT.replace("return JSON.stringify({text:", "return JSON.stringify({pass:document.body&&document.body.innerText.trim().length>0,text:"), scaled(15_000, factor)).optString("text") } ?: ""
                    extra.put("landed", JSONObject().put("url", landed.value).put("text", text.take(200)))
                }
                var ownPage: JSONObject? = null
                if (landed == null && page != null) {
                    val pageTab = createTab("chrome-extension://${row.id}/$page")
                    val pageView = waitForView(pageTab)
                    ownPage = pollExpr(pageView, DOM_REPORT.replace("return JSON.stringify({text:", "return JSON.stringify({pass:document.body&&document.body.innerText.trim().length>20,text:"), scaled(20_000, factor))
                    ownPage.put("console", JSONArray(consoleOf(pageView).takeLast(10)))
                    if (!ownPage.optBoolean("pass")) ownPage.put("blankTab", blankPageEvidence(pageView, row, 0L))
                    extra.put("ownPage", ownPage)
                    snap("${entry.optString("slug")}-own-page")
                }
                since.record(extra, "atEnd")
                // The gate met in the worker (its console line), when the click showed nothing.
                val logged = if (landed == null && injected == null && gateLog != null) backgroundView(row.id)?.let { bg -> consoleOf(bg).lastOrNull { gateLog.containsMatchIn(it) } } else null
                logged?.let { extra.put("gateLog", it.take(300)) }
                val how = when {
                    landed == null || landed.key !in before -> "opened"
                    before[landed.key] != landed.value -> "navigated the tab to"
                    else -> "switched to its tab"
                }
                when {
                    injected != null ->
                        Grade("n/m", "$label: the action click injected its <${injected.optString("tag")}> (${injected.optInt("w")}x${injected.optInt("h")} css px, \"${injected.optString("text").take(80)}\") into the page; the tools need $gate (not measurable here)", extra)
                    landed != null && opens.containsMatchIn(landed.value) ->
                        Grade("n/m", "$label: the action click $how ${landed.value.take(100)} (\"${text.take(80)}\"); the core needs $gate (not measurable here)", extra)
                    landed != null ->
                        Grade(if (LOGIN_WORDS.containsMatchIn(text) || text.isNotEmpty()) "n/m" else "F", "$label: the action click showed ${landed.value.take(100)} (\"${text.take(80)}\")${if (text.isEmpty()) ", which stayed blank" else "; the core needs $gate (not measurable here)"}", extra)
                    ownPage?.optBoolean("pass") == true ->
                        Grade("n/m", "$label: the action click showed nothing on the phone; its $page renders as a tab (\"${ownPage.optString("text").take(80)}\"); the core needs $gate (not measurable here)", extra)
                    ownPage != null ->
                        Grade("F", "$label: the action click showed nothing within ${scaled(20_000, factor) / 1000} s and its $page stayed blank (${ownPage.toString().take(200)})", extra)
                    logged != null ->
                        Grade("n/m", "$label: the action click ran into $gate in its worker: \"${logged.take(160)}\" (not measurable here)", extra)
                    else -> Grade("F", "$label: the action click opened nothing within ${scaled(20_000, factor) / 1000} s (tabs: ${tabUrls().values.joinToString().take(160)})", extra)
                }
            }
        }
    }

    /**
     * A VPN extension: its core (an egress change) needs the vendor's live service and, for the
     * free tiers, an account (`n/m`, as on the desktop), but the engine part is measured: the
     * worker sees `chrome.proxy` and `proxy.settings.get` answers (Chrome's `ChromeSetting`
     * shape), the popup renders its connect control, and the egress address the fixture reads
     * before and after a tap on that control (through open shadow roots) is kept – a changed
     * address is `P`. A missing `chrome.proxy` (the worker's `TypeError`) or a "not implemented"
     * rejection is `F`, ours. A popup that opens on a consent screen (`consent`: Urban VPN's
     * "Accept", 1clickVPN's) has it answered first, up to three rounds, and is opened again when
     * the consent click handed the popup off to the vendor's website and closed it (1clickVPN);
     * the connect control is the labelled one, a `connectSelector` (Urban VPN's unlabelled
     * `.play-button`) or a `connectWords` label regex (1clickVPN's location rows) when given.
     */
    private fun vpn(label: String, pac: Boolean = false, consent: Boolean = false, connectSelector: String? = null, connectWords: String? = null): (Row, JSONObject) -> Grade = { row, entry ->
        val extra = JSONObject()
        val factor = speedFactor(entry)
        val bg = backgroundView(row.id)
        val proxy = if (bg != null) {
            tabEval(bg, PROXY_PROBE)
            poll(10_000, 250) { tabEval(bg, "window.__zenProxyProbe && window.__zenProxyProbe.done ? JSON.stringify(window.__zenProxyProbe) : null").takeIf { it != "null" } }?.let(::json)
                ?: JSONObject().put("pass", false).put("note", "no answer within 10 s")
        } else JSONObject().put("pass", false).put("note", "no background view")
        extra.put("proxy", proxy)
        val egressTab = createTab("$BASE/proxy-check.html")
        val egressView = waitForView(egressTab)
        val before = pollExpr(egressView, EGRESS_REPORT, scaled(20_000, factor))
        extra.put("egressBefore", before)
        showTab(fixtureTab)
        val openPopup = {
            coreInvoke("extension.openPopup", """{"id":${JSONObject.quote(row.id)},"anchor":{"x":0,"y":0,"width":0,"height":0}}""")
            poll(scaled(POPUP_TIMEOUT_MS, factor), 400) { popupView()?.takeIf { it.context == "popup" && rendered(it) } }
        }
        var popup = openPopup()
        if (popup != null && consent) {
            val consents = JSONArray()
            SystemClock.sleep(scaled(3_000, factor))
            for (round in 0 until 3) {
                val live = popupView()?.takeIf { it.context == "popup" } ?: break
                val answer = json(tabEval(live, CLICK_LABEL.replace("__RE__", CONSENT_WORDS)))
                consents.put(answer.toString().take(120))
                if (!answer.optBoolean("clicked")) break
                SystemClock.sleep(scaled(2_500, factor))
            }
            extra.put("consent", consents)
            // The consent click handed off to the vendor's website and closed the popup: opened again.
            if (popupView()?.takeIf { it.context == "popup" && rendered(it) } == null) {
                extra.put("tabsAfterConsent", JSONArray(tabUrls().values.toList()))
                closeExtraTabs()
                showTab(fixtureTab)
                popup = openPopup()
                extra.put("reopened", popup != null)
                if (popup != null) SystemClock.sleep(scaled(3_000, factor))
            }
        }
        val connectJs = VPN_CONNECT_CLICK.replace("__WANT__", connectWords ?: VPN_CONNECT_WORDS).replace("__SELECTOR__", connectSelector?.let { JSONObject.quote(it) } ?: "null")
        var click = JSONObject().put("clicked", false)
        if (popup != null) {
            SystemClock.sleep(scaled(3_000, factor))
            click = json(tabEval(popup, connectJs))
            extra.put("popupText", json(tabEval(popup, DEEP_TEXT)).optString("text").take(300))
            if (click.optBoolean("clicked")) {
                SystemClock.sleep(scaled(6_000, factor))
                snap("${entry.optString("slug")}-vpn-after-connect")
                extra.put("popupTextAfterClick", json(tabEval(popup, DEEP_TEXT)).optString("text").take(300))
            }
        }
        extra.put("connectClick", click)
        runCatching { coreInvoke("extension.closePopup", "null") }
        var after = JSONObject()
        if (click.optBoolean("clicked")) {
            showTab(egressTab)
            coreInvoke("tab.reload", """{"tabId":${JSONObject.quote(egressTab)}}""")
            SystemClock.sleep(1_500)
            after = pollExpr(egressView, EGRESS_REPORT, scaled(20_000, factor))
            extra.put("egressAfter", after)
        }
        val changed = before.optBoolean("pass") && after.optBoolean("pass") &&
            before.optString("ipify") != after.optString("ipify") && after.optString("ipify").isNotEmpty()
        val note = "chrome.proxy: ${proxy.toString().take(200)}; popup ${if (popup != null) "rendered" else "absent"}, connect control ${click.toString().take(120)}; egress ${before.optString("ipify").ifEmpty { "unread" }}" +
            (if (click.optBoolean("clicked")) " -> ${after.optString("ipify").ifEmpty { "unread" }}" else "")
        when {
            changed -> Grade("P", "$label: the egress address changed after the connect tap: $note", extra)
            !proxy.optBoolean("pass") -> Grade("F", "$label: the proxy API is not Chrome's shape in the worker: $note", extra)
            popup == null -> Grade("F", "$label: popup did not render in the core check: $note", extra)
            // The WebView takes one fixed-rule proxy override per app (ProxyController) and no PAC
            // script; an extension that connects by `pac_script` cannot route the phone's traffic.
            pac -> Grade("n/a", "$label: the proxy API answers and the popup renders its controls; it connects with a pac_script proxy config, which the WebView cannot apply (ProxyController takes fixed rules and a bypass list only: WebView limit): $note", extra)
            else -> Grade("n/m", "$label: the proxy API answers and the popup renders its controls; a routed egress needs the vendor's live VPN service and its account (not measurable here): $note", extra)
        }
    }

    /**
     * A PDF tool: opening `sample.pdf` is either taken over (the tab lands on the extension's own
     * viewer, `chrome-extension://<id>/...`) or annotated (a button of the extension's injected
     * into the document, `pattern` on ids, classes and text). Kami passes on the desktop this
     * way ("Open with Kami" in the PDF viewer); Acrobat's takeover is opt-in and its viewer
     * needs an Adobe account, so its miss is `n/m` (`missing`), as on the desktop.
     */
    private fun pdfTool(label: String, pattern: Regex, missing: String): (Row, JSONObject) -> Grade = { row, entry ->
        val extra = JSONObject()
        val factor = speedFactor(entry)
        val before = tabUrls().keys
        val tab = createTab("$BASE/sample.pdf")
        val expr = "(function(){var pat=/${pattern.pattern}/i;var hits=[];var walk=function(root){var all=root.querySelectorAll('*');for(var i=0;i<all.length;i++){var e=all[i];var s=(e.id||'')+' '+String(e.className||'')+' '+(e.getAttribute('src')||'')+' '+(e.getAttribute('title')||'')+' '+(e.getAttribute('aria-label')||'');if(pat.test(s)||(e.children.length===0&&pat.test(e.textContent||'')&&(e.textContent||'').length<80))hits.push((e.tagName+'#'+(e.id||'')+'.'+String(e.className||'').slice(0,40)+' '+(e.textContent||'').trim().slice(0,40)).trim());if(e.shadowRoot)walk(e.shadowRoot)}};if(document.body)walk(document.body);" +
            "return JSON.stringify({pass:hits.length>0,hits:hits.slice(0,6),url:location.href,title:document.title,contentType:document.contentType,els:document.body?document.body.querySelectorAll('*').length:0})})()"
        var landed: Map.Entry<String, String>? = null
        var page = JSONObject()
        poll(scaled(30_000, factor), 700) {
            val urls = tabUrls()
            landed = urls.entries.firstOrNull { it.key !in before && extensionPage(it.value, row.id) }
            if (landed != null) return@poll true
            val view = runCatching { waitForView(tab) }.getOrNull()
            if (view != null) {
                page = json(tabEval(view, expr))
                if (page.optBoolean("pass")) return@poll true
            }
            null
        }
        extra.put("tabs", JSONArray(tabUrls().values.toList())).put("page", page)
        val view = runCatching { waitForView(tab) }.getOrNull()
        view?.let { extra.put("console", JSONArray(consoleOf(it).takeLast(10))) }
        val taken = landed
        if (taken != null) {
            val ownView = runCatching { waitForView(taken.key) }.getOrNull()
            val own = ownView?.let { pollExpr(it, DOM_REPORT.replace("return JSON.stringify({text:", "return JSON.stringify({pass:document.body&&document.body.querySelectorAll('*').length>3,text:"), scaled(20_000, factor)) } ?: JSONObject()
            extra.put("ownViewer", own)
            Grade(if (own.optBoolean("pass")) "P" else "PARTIAL", "$label took the PDF over: ${taken.value.take(100)} (${own.optInt("els")} elements, \"${own.optString("text").take(80)}\")", extra)
        } else if (page.optBoolean("pass")) {
            Grade("P", "$label injected into the PDF page: ${page.optJSONArray("hits")?.toString()?.take(200)}", extra)
        } else {
            Grade(
                missing,
                "$label: no takeover and nothing injected on sample.pdf within ${scaled(30_000, factor) / 1000} s (page: ${page.toString().take(200)})" +
                    if (missing == "n/m") "; its viewer is opt-in per PDF and needs an Adobe account (the desktop table has the same reading)" else "",
                extra
            )
        }
    }

    /** MetaMask: the fixture asks for an EIP-1193 provider on `window.ethereum`; the wallet's page-world script answers before the page runs. */
    private fun walletProvider(row: Row, entry: JSONObject): Grade {
        val factor = speedFactor(entry)
        val tab = createTab("$BASE/wallet.html")
        val view = waitForView(tab)
        val found = pollExpr(view, "JSON.stringify({pass: !!(window.__wallet && window.__wallet.isMetaMask), wallet: window.__wallet || null, ethereum: typeof window.ethereum, providers: window.ethereum && window.ethereum.providers ? window.ethereum.providers.length : null})", scaled(25_000, factor))
        val extra = JSONObject().put("page", found).put("console", JSONArray(consoleOf(view).takeLast(10)))
        if (worlds) worldEval(view, row.id, WORLD_REPORT)?.let { extra.put("world", json(it)) }
        if (!found.optBoolean("pass")) extra.put("errors", targetErrors(view))
        return Grade(
            if (found.optBoolean("pass")) "P" else "F",
            "window.ethereum with isMetaMask on the dapp page: ${found.toString().take(240)}" +
                (extra.optJSONArray("errors")?.takeIf { it.length() > 0 }?.let { "; first error: ${it.optJSONObject(0)?.optString("message")?.take(100)}" } ?: ""),
            extra
        )
    }

    /**
     * GoFullPage: the action's popup runs the capture (`tabs.captureVisibleTab` while its script
     * scrolls the page) and opens `capture.html` with the stitched image; that page rendering an
     * image of the fixture is the pass.
     */
    private fun fullPageCapture(row: Row, entry: JSONObject): Grade {
        val factor = speedFactor(entry)
        val extra = JSONObject()
        val tab = createTab("$BASE/page-b.html?capture")
        val view = waitForView(tab)
        poll(scaled(15_000, factor), 400) { if (tabEval(view, "String(document.readyState === 'complete')") == "true") true else null }
        SystemClock.sleep(scaled(1_500, factor))
        val before = tabUrls().keys
        val since = StepEvidence(row)
        coreInvoke("extension.openPopup", """{"id":${JSONObject.quote(row.id)},"anchor":{"x":0,"y":0,"width":0,"height":0}}""")
        val popup = poll(scaled(POPUP_TIMEOUT_MS, factor), 400) { popupView()?.takeIf { it.context == "popup" && rendered(it) } }
        val result = poll(scaled(45_000, factor), 700) {
            tabUrls().entries.firstOrNull { it.key !in before && (it.value.contains("capture.html") || it.value.contains("editor.html")) }
        }
        popup?.let { extra.put("popup", json(tabEval(it, DOM_REPORT))).put("popupConsole", JSONArray(consoleOf(it).takeLast(12))) }
        // The popup keeps its captures in the FileSystem API (`window.requestFileSystem ||
        // window.webkitRequestFileSystem`, bound at load; `filesystem:` URLs for the stitched
        // image) and reports "Something went wrong" when the call is not there. The WebView has
        // no FileSystem API: the row is a WebView limit, not the runtime's, once that is what the
        // popup ran into.
        val fileSystem = popup?.let { json(tabEval(it, FILESYSTEM_PROBE)) }
        fileSystem?.let { extra.put("fileSystem", it) }
        snap("${entry.optString("slug")}-capture-popup")
        runCatching { coreInvoke("extension.closePopup", "null") }
        if (result == null && fileSystem != null && !fileSystem.optBoolean("available") && fileSystem.optBoolean("failed")) {
            since.record(extra, "atEnd")
            return Grade(
                "n/a",
                "the popup's capture stores through the FileSystem API (webkitRequestFileSystem), which the WebView has not: it reports \"${fileSystem.optString("text").take(80)}\" (WebView limit)",
                extra
            )
        }
        var image = JSONObject()
        if (result != null) {
            val resultView = waitForView(result.key)
            image = pollExpr(resultView, "(function(){var imgs=Array.prototype.slice.call(document.querySelectorAll('img, canvas')).map(function(e){var r=e.getBoundingClientRect();return {tag:e.tagName,w:Math.round(e.naturalWidth||e.width||r.width),h:Math.round(e.naturalHeight||e.height||r.height),shown:r.width>0&&r.height>0}});var big=imgs.filter(function(i){return i.w>=200&&i.h>=200});return JSON.stringify({pass:big.length>0,images:imgs.slice(0,6),url:location.href,text:document.body?document.body.innerText.replace(/\\s+/g,' ').trim().slice(0,120):''})})()", scaled(30_000, factor))
            extra.put("result", image).put("resultConsole", JSONArray(consoleOf(resultView).takeLast(10)))
            showTab(result.key)
            SystemClock.sleep(800)
        }
        since.record(extra, "atEnd")
        return Grade(
            if (image.optBoolean("pass")) "P" else "F",
            "capture page ${if (result == null) "never opened within ${scaled(45_000, factor) / 1000} s" else "opened (${result.value.substringAfter("/", "").take(60)})"}; " +
                "image: ${image.toString().take(200)}; popup: \"${extra.optJSONObject("popup")?.optString("text")?.take(100)}\"" +
                if (factor > 1.0) " (waits x${"%.1f".format(factor)})" else "",
            extra
        )
    }

    /**
     * Authenticator: a TOTP account saved the way its own manual entry saves one (an `OTPStorage`
     * item in `chrome.storage.sync`, the default location), then the popup lists it with a
     * six-digit code computed from the secret: the storage round trip and the code generation
     * are the observable.
     */
    private fun authenticator(row: Row, entry: JSONObject): Grade {
        val factor = speedFactor(entry)
        val extra = JSONObject()
        val openPopup = {
            showTab(fixtureTab)
            coreInvoke("extension.openPopup", """{"id":${JSONObject.quote(row.id)},"anchor":{"x":0,"y":0,"width":0,"height":0}}""")
            poll(scaled(POPUP_TIMEOUT_MS, factor), 400) { popupView()?.takeIf { it.context == "popup" && rendered(it) } }
        }
        // The worker seeds when it is up; on a slow job the stages before the core outlast its
        // 30 s idle and it is gone, and the popup's own chrome.storage.sync is the same store.
        val bg = backgroundView(row.id)
        val seededThroughPopup = bg == null
        val seeder: WebView = bg ?: openPopup() ?: return Grade("F", "no background view nor a rendered popup to save the account through")
        tabEval(seeder, AUTHENTICATOR_SEED)
        val seeded = poll(scaled(10_000, factor), 250) { tabEval(seeder, "window.__zenSeed").takeIf { it != "null" } } ?: "no answer within ${scaled(10_000, factor) / 1000} s"
        extra.put("seed", seeded).put("seededThrough", if (seededThroughPopup) "popup" else "worker")
        if (seededThroughPopup) {
            // The popup lists the accounts it read at load: reopened, it reads the saved one.
            runCatching { coreInvoke("extension.closePopup", "null") }
            poll(scaled(5_000, factor), 200) { if (popupView() == null) true else null }
        }
        val popup = openPopup()
        var found = JSONObject()
        if (popup != null) {
            found = pollExpr(
                popup,
                "(function(){var entries=Array.prototype.slice.call(document.querySelectorAll('.entry'));var rows=entries.map(function(e){return (e.textContent||'').replace(/\\s+/g,' ').trim().slice(0,80)});" +
                    "var zen=entries.find(function(e){return /Zenium/.test(e.textContent||'')});var code=zen?((zen.querySelector('.code')||zen).textContent||'').replace(/\\s+/g,''):'';" +
                    "return JSON.stringify({pass:!!zen&&/\\d{6}/.test(code),entries:entries.length,rows:rows.slice(0,5),code:code.slice(0,12),text:document.body?document.body.innerText.replace(/\\s+/g,' ').trim().slice(0,160):''})})()",
                scaled(20_000, factor)
            )
            extra.put("popup", found).put("console", JSONArray(consoleOf(popup).takeLast(12)))
        }
        SystemClock.sleep(600)
        snap("${entry.optString("slug")}-authenticator-code")
        runCatching { coreInvoke("extension.closePopup", "null") }
        return Grade(
            if (found.optBoolean("pass")) "P" else "F",
            "account saved through the ${if (seededThroughPopup) "popup (the worker had idled out)" else "worker"} (${seeded.take(60)}); popup ${if (popup == null) "did not render" else "lists ${found.optInt("entries")} entries: ${found.optJSONArray("rows")?.toString()?.take(160)}, code ${found.optString("code")}"}",
            extra
        )
    }

    /**
     * Zotero Connector: on a page carrying Highwire / Dublin Core citation metadata its content
     * script hands the document to the connector's offscreen sandbox, the Embedded Metadata
     * translator is detected there and reported to the worker (`Connector_Browser.onTranslators`,
     * the tab's info), and the connector renames its toolbar button "Save to Zotero (Embedded
     * Metadata)" for that tab (`action.setTitle`, per tab). Chrome shows the rename only once the
     * first-run notice is dismissed: a fresh install's button reads "Zotero Connector" until its
     * first click opens the notice in the page (an extension frame) and the user closes it
     * (`firstUse`); the desktop check read the same way. So: the detection is read from the
     * worker's tab info, the button is clicked, the notice closed with Escape (its own key) and
     * the title read; a notice the key did not reach is closed as its button closes it (the
     * `firstUse` pref, then the connector's own `_updateExtensionUI`) and the title read again.
     */
    private fun zotero(row: Row, entry: JSONObject): Grade {
        val factor = speedFactor(entry)
        val bg = backgroundView(row.id)
        val tab = createTab("$BASE/zotero.html")
        val view = waitForView(tab)
        val extra = JSONObject()
        var info = JSONObject()
        if (bg != null) {
            poll(scaled(45_000, factor), 1_500) {
                tabEval(bg, ZOTERO_TAB_INFO)
                info = poll(5_000, 200) {
                    tabEval(bg, "window.__zenZotero && window.__zenZotero.done ? JSON.stringify(window.__zenZotero) : null").takeIf { it != "null" }
                }?.let(::json) ?: info
                if ((info.optJSONArray("translators")?.length() ?: 0) > 0) true else null
            }
        } else extra.put("background", "no background view")
        extra.put("tabInfo", info)
        val translators = info.optJSONArray("translators")?.let { arr -> List(arr.length()) { arr.optString(it) } } ?: emptyList()
        val detected = translators.any { it.contains("Embedded Metadata", ignoreCase = true) }
        val renamed = { (extensionAction(row.id)?.optString("title") ?: "").contains("Embedded Metadata", ignoreCase = true) }
        val notice = JSONObject()
        if (translators.isNotEmpty()) {
            // The first click: Zotero has no popup, so the click is its `action.onClicked`, and
            // the connector's handler opens the first-run notice in the page.
            showTab(tab)
            coreInvoke("extension.openPopup", """{"id":${JSONObject.quote(row.id)},"anchor":{"x":0,"y":0,"width":0,"height":0}}""")
            SystemClock.sleep(scaled(4_000, factor))
            snap("${entry.optString("slug")}-first-run-notice")
            notice.put("frameHosts", json(tabEval(view, ZOTERO_NOTICE_HOSTS)))
            key(KeyEvent.KEYCODE_ESCAPE)
            val byKey = poll(scaled(10_000, factor), 500) { if (renamed()) true else null }
            notice.put("closedBy", if (byKey != null) "escape" else "pref")
            if (byKey == null && bg != null) {
                tabEval(bg, ZOTERO_CLOSE_NOTICE)
                poll(scaled(10_000, factor), 500) { if (renamed()) true else null }
                notice.put("update", json(tabEval(bg, "JSON.stringify(window.__zenZoteroUpdate || null)")))
            }
        }
        val title = extensionAction(row.id)?.optString("title") ?: ""
        extra.put("notice", notice).put("title", title).put("action", extensionAction(row.id) ?: JSONObject.NULL)
        extra.put("console", JSONArray(consoleOf(view).takeLast(10)))
        if (worlds) worldEval(view, row.id, WORLD_REPORT)?.let { extra.put("world", json(it)) }
        if (!detected) extra.put("errors", targetErrors(view))
        val labels = translators.joinToString()
        return when {
            detected && renamed() -> Grade("P", "Embedded Metadata detected for the citation tab (the worker's tab info: $labels); after the first-run notice (closed by ${notice.optString("closedBy")}) the toolbar button reads \"$title\"", extra)
            detected -> Grade("PARTIAL", "Embedded Metadata detected for the citation tab ($labels), but the toolbar button still reads \"$title\" after the first-run notice", extra)
            translators.isNotEmpty() -> Grade("PARTIAL", "the connector ran but detected only $labels on the citation page; the button reads \"$title\"", extra)
            else -> Grade("F", "no translator detected for the citation tab within ${scaled(45_000, factor) / 1000} s: ${info.toString().take(200)}; the button reads \"$title\"", extra)
        }
    }

    /**
     * Avira Browser Safety: its tracker blocking on the ad fixture first (the desktop's ad-blocker
     * bar), else the popup's fetched verdict for the fixture site ("safe", "secure", "no threats",
     * "protected", the blocked count) – what the desktop graded.
     */
    private fun siteVerdict(label: String): (Row, JSONObject) -> Grade = { row, entry ->
        val blocked = adBlocker(row, entry)
        if (blocked.verdict == "P") blocked
        else {
            closeExtraTabs()
            val factor = speedFactor(entry)
            showTab(fixtureTab)
            coreInvoke("extension.openPopup", """{"id":${JSONObject.quote(row.id)},"anchor":{"x":0,"y":0,"width":0,"height":0}}""")
            val popup = poll(scaled(POPUP_TIMEOUT_MS, factor), 400) { popupView()?.takeIf { it.context == "popup" && rendered(it) } }
            var found = JSONObject()
            if (popup != null) {
                found = pollExpr(popup, DEEP_TEXT.replace("return JSON.stringify({text:", "return JSON.stringify({pass:/\\b(safe|secure|no threats?|protected|trusted|blocked|trackers?)\\b/i.test(text),text:"), scaled(20_000, factor))
                found.put("console", JSONArray(consoleOf(popup).takeLast(10)))
            }
            SystemClock.sleep(600)
            snap("${entry.optString("slug")}-verdict-popup")
            runCatching { coreInvoke("extension.closePopup", "null") }
            val extra = JSONObject().put("adBlock", blocked.extra ?: JSONObject()).put("popup", found)
            Grade(
                if (found.optBoolean("pass")) "P" else if (blocked.verdict == "PARTIAL") "PARTIAL" else "F",
                "$label: ad fixture ${blocked.verdict} (${blocked.note.take(120)}); popup verdict ${if (popup == null) "no popup" else "\"${found.optString("text").take(120)}\""}",
                extra
            )
        }
    }

    // --- the core checks of compat round 5 (ranks 61-90 by installs) ----------------------------

    /**
     * An effect read off a fixture page (the desktop's `domMarker`): the fixture opens, `prepare`
     * runs once its document is complete, then `expr` (a `JSON.stringify` of `{pass, ...}`) is
     * polled for `pass`. Phantom's `window.phantom.solana` on the wallet page is one.
     */
    private fun domMarker(label: String, fixture: String, expr: String, settleMs: Long = 25_000, prepare: ((WebView) -> Unit)? = null): (Row, JSONObject) -> Grade = { row, entry ->
        val factor = speedFactor(entry)
        val tab = createTab("$BASE/$fixture")
        val view = waitForView(tab)
        poll(scaled(15_000, factor), 400) { if (tabEval(view, "String(document.readyState === 'complete')") == "true") true else null }
        SystemClock.sleep(scaled(1_500, factor))
        prepare?.invoke(view)
        val found = pollExpr(view, expr, scaled(settleMs, factor))
        val extra = JSONObject().put("page", found).put("console", JSONArray(consoleOf(view).takeLast(10)))
        if (worlds) worldEval(view, row.id, WORLD_REPORT)?.let { extra.put("world", json(it)) }
        if (!found.optBoolean("pass")) extra.put("errors", targetErrors(view))
        Grade(if (found.optBoolean("pass")) "P" else "F", "$label: ${found.toString().take(240)}", extra)
    }

    /** A fixture tab, its document complete; the view to read it through. */
    private fun fixture(page: String, factor: Double, settleMs: Long = 1_500): Pair<String, TabWebView> {
        val tab = createTab("$BASE/$page")
        val view = waitForView(tab)
        poll(scaled(15_000, factor), 400) { if (tabEval(view, "String(document.readyState === 'complete')") == "true") true else null }
        SystemClock.sleep(scaled(settleMs, factor))
        return tab to view
    }

    /** The row's popup opened over the tab on screen, rendered, or null. */
    private fun openPopup(row: Row, factor: Double): ExtensionWebView? {
        coreInvoke("extension.openPopup", """{"id":${JSONObject.quote(row.id)},"anchor":{"x":0,"y":0,"width":0,"height":0}}""")
        return poll(scaled(POPUP_TIMEOUT_MS, factor), 400) { popupView()?.takeIf { it.context == "popup" && rendered(it) } }
    }

    /** A probe that lands its answer on `window.<slot>` with `done: true`, from an extension page, read within `timeoutMs`. */
    private fun probe(view: WebView, script: String, slot: String, timeoutMs: Long): JSONObject {
        tabEval(view, script)
        return poll(timeoutMs, 250) { tabEval(view, "window.$slot && window.$slot.done ? JSON.stringify(window.$slot) : null").takeIf { it != "null" } }?.let(::json)
            ?: JSONObject().put("error", "no answer within ${timeoutMs / 1000} s")
    }

    /**
     * The `tabCapture` / `desktopCapture` namespaces as an extension page sees them, and
     * `tabCapture.getMediaStreamId` asked for the active tab: Chrome's shape answers a stream id
     * or an error; a missing function is ours.
     */
    private fun captureShape(view: WebView, factor: Double): JSONObject = probe(view, CAPTURE_PROBE, "__zenCapture", scaled(10_000, factor))

    /**
     * A `tabCapture` row (Volume Master's gain graph over the tab's audio, Shazam's
     * fingerprinting of it): the WebView has no tab or display capture to source a stream from
     * (`getDisplayMedia` is not there; `getUserMedia` reaches the microphone and camera only), so
     * once the popup renders its control and the worker sees `chrome.tabCapture` in Chrome's
     * shape with `getMediaStreamId` answering (an id or an error, not a missing function) the
     * core is the WebView's limit, `n/a`, with that shape, the popup and the page's
     * `navigator.mediaDevices` recorded as what the phone gives. A stream id answered is `P`; a
     * missing namespace is `F`, ours.
     */
    private fun captureLimit(label: String, control: String): (Row, JSONObject) -> Grade = { row, entry ->
        val factor = speedFactor(entry)
        val extra = JSONObject()
        val (_, view) = fixture("audio.html?capture", factor, 2_000)
        val media = json(tabEval(view, "JSON.stringify({mediaDevices:typeof navigator.mediaDevices,getUserMedia:typeof (navigator.mediaDevices&&navigator.mediaDevices.getUserMedia),getDisplayMedia:typeof (navigator.mediaDevices&&navigator.mediaDevices.getDisplayMedia),tone:!!window.__tone})"))
        extra.put("page", media)
        val capture = backgroundView(row.id)?.let { captureShape(it, factor) } ?: JSONObject().put("error", "no background view")
        extra.put("capture", capture)
        val popup = openPopup(row, factor)
        var found = JSONObject()
        if (popup != null) {
            SystemClock.sleep(scaled(3_000, factor))
            found = json(tabEval(popup, DEEP_TEXT.replace("return JSON.stringify({text:", "return JSON.stringify({pass:$control.test(text)||document.querySelectorAll('input[type=range], [role=slider], button').length>0,controls:document.querySelectorAll('input[type=range], [role=slider], button').length,text:")))
            extra.put("popupCapture", captureShape(popup, factor))
            found.put("console", JSONArray(consoleOf(popup).takeLast(10)))
        }
        extra.put("popup", found)
        SystemClock.sleep(600)
        snap("${entry.optString("slug")}-capture-popup")
        runCatching { coreInvoke("extension.closePopup", "null") }
        val shape = capture.optString("tabCapture") == "object" && capture.optString("getMediaStreamId") == "function"
        val note = "worker: ${capture.toString().take(200)}; popup ${if (popup == null) "absent" else "\"${found.optString("text").take(100)}\" (${found.optInt("controls")} controls)"}; page mediaDevices: ${media.toString().take(120)}"
        when {
            capture.optString("streamId").isNotEmpty() && capture.isNull("error") -> Grade("P", "$label: tabCapture.getMediaStreamId answered a stream id for the tab: $note", extra)
            !shape -> Grade("F", "$label: chrome.tabCapture is not Chrome's shape in the worker: $note", extra)
            popup == null -> Grade("F", "$label: popup did not render in the core check: $note", extra)
            else -> Grade("n/a", "$label: the API is Chrome's shape and the popup renders its controls, but the WebView has no tab or display capture to source the stream from (getDisplayMedia ${media.optString("getDisplayMedia")}; getUserMedia reaches the microphone and camera only): WebView limit. $note", extra)
        }
    }

    /**
     * Custom Cursor: a pack card picked in the popup (`.collection-cursors .cursor` with an
     * image) writes `storage.local.selected`, and its content script on the fixture page
     * injects `<style id="custom-cursor">` with `cursor: url(...)` on html / body: that computed
     * style is the pass (the phone has no pointer to draw it with; the style is the effect).
     */
    private fun customCursor(row: Row, entry: JSONObject): Grade {
        val factor = speedFactor(entry)
        val extra = JSONObject()
        val (_, view) = fixture("page-a.html?cursor", factor)
        val popup = openPopup(row, factor)
        var pick = JSONObject().put("clicked", false)
        if (popup != null) {
            SystemClock.sleep(scaled(4_000, factor))
            pick = poll(scaled(8_000, factor), 1_000) { json(tabEval(popup, CURSOR_PICK)).takeIf { it.optBoolean("clicked") } } ?: json(tabEval(popup, CURSOR_PICK))
            // The click as a finger too: a React card may listen for pointer events, not click.
            if (pick.optBoolean("clicked")) screenPoint(popup, pick)?.let { tap(it.first, it.second) }
            extra.put("popupText", json(tabEval(popup, DEEP_TEXT)).optString("text").take(200)).put("popupConsole", JSONArray(consoleOf(popup).takeLast(8)))
        }
        extra.put("pick", pick)
        val found = pollExpr(view, CURSOR_STYLE, scaled(14_000, factor))
        extra.put("page", found).put("console", JSONArray(consoleOf(view).takeLast(10)))
        // The pick resolves on the cursor image's `onload` (an `Image` with crossOrigin from the
        // vendor's CDN, drawn to a canvas, stored as a data URL) and has no `onerror`: a CDN that
        // refuses the job's emulator (Cloudflare's bot check, which the vendor's welcome tab met
        // too) hangs the pick before `selected` is written. Asked from the popup, as its own load goes.
        var cdn = JSONObject()
        if (popup != null && !found.optBoolean("pass")) {
            cdn = probe(popup, CURSOR_CDN_PROBE, "__zenCdn", scaled(12_000, factor))
            extra.put("cdn", cdn)
        }
        SystemClock.sleep(600)
        snap("${entry.optString("slug")}-cursor-popup")
        runCatching { coreInvoke("extension.closePopup", "null") }
        val cdnRefused = cdn.optBoolean("done") && (cdn.optInt("status", 0) !in 200..299 || !cdn.optString("type").startsWith("image/"))
        val verdict = if (found.optBoolean("pass")) "P" else if (cdnRefused) "n/m" else "F"
        val cdnNote = if (cdn.optBoolean("done")) "; the vendor's CDN answered the popup ${cdn.optString("status", "?")} ${cdn.optString("type").ifEmpty { cdn.optString("error") }} (${cdn.optInt("thumbsBroken")}/${cdn.optInt("thumbs")} pack thumbnails broken)" else ""
        return Grade(verdict, "Custom Cursor: popup ${if (popup == null) "did not render" else "picked ${pick.toString().take(110)}"}; fixture page cursor ${found.toString().take(200)}$cdnNote", extra)
    }

    /**
     * Video DownloadHelper: `webRequest` sees the fixture's mp4 response (audio.html's clip), the
     * action's badge counts it for the tab, and the action click (a popup set at run time, or its
     * side panel document, which the phone opens as a tab) lists the media. Badge digits or a
     * listed clip pass.
     */
    private fun videoDownloadHelper(row: Row, entry: JSONObject): Grade {
        val factor = speedFactor(entry)
        val extra = JSONObject()
        fixture("audio.html?vdh", factor)
        val bg = backgroundView(row.id)
        var badge = JSONObject()
        if (bg != null) {
            poll(scaled(18_000, factor), 1_500) {
                badge = probe(bg, BADGE_PROBE.replace("__MATCH__", "/audio\\.html/"), "__zenBadge", 5_000)
                if (Regex("\\d").containsMatchIn(badge.optString("badge"))) true else null
            }
        } else extra.put("background", "no background view")
        extra.put("badge", badge)
        val before = tabUrls().keys
        val popup = openPopup(row, factor)
        val listing = DEEP_TEXT.replace("return JSON.stringify({text:", "return JSON.stringify({pass:/clip|mp4|video/i.test(text),text:")
        var surface = JSONObject()
        if (popup != null) {
            surface = pollExpr(popup, listing, scaled(12_000, factor)).put("where", "popup")
        } else {
            val opened = poll(scaled(10_000, factor), 500) { tabUrls().entries.firstOrNull { it.key !in before && extensionPage(it.value, row.id) } }
            if (opened != null) {
                runCatching { waitForView(opened.key) }.getOrNull()?.let { surface = pollExpr(it, listing, scaled(15_000, factor)) }
                surface.put("where", opened.value.take(100))
            }
        }
        extra.put("surface", surface)
        SystemClock.sleep(600)
        snap("${entry.optString("slug")}-media-list")
        runCatching { coreInvoke("extension.closePopup", "null") }
        val counted = Regex("\\d").containsMatchIn(badge.optString("badge"))
        return Grade(
            if (counted || surface.optBoolean("pass")) "P" else "F",
            "Video DownloadHelper: badge on the fixture tab ${badge.toString().take(120)}; the action showed ${surface.optString("where").ifEmpty { "nothing" }} (\"${surface.optString("text").take(100)}\")",
            extra
        )
    }

    /**
     * Read Aloud: the popup opened over the fixture page reads it through `chrome.tts` and shows
     * the sentence it is on (`#highlight`) with its pause / stop controls up; the worker's
     * `tts.getVoices` and `tts.isSpeaking` are read beside it. The desktop's `F` is Electron's
     * `activeTab` limit; the phone grants `activeTab` on the action click and speaks through
     * TextToSpeech.
     */
    private fun readAloud(row: Row, entry: JSONObject): Grade {
        val factor = speedFactor(entry)
        val extra = JSONObject()
        fixture("page-a.html?readaloud", factor)
        val bg = backgroundView(row.id)
        extra.put("voices", bg?.let { probe(it, TTS_VOICES_PROBE, "__zenTts", scaled(10_000, factor)) } ?: "no background view")
        val popup = openPopup(row, factor)
        var state = JSONObject()
        if (popup != null) {
            state = pollExpr(popup, READ_ALOUD_STATE, scaled(24_000, factor))
            if (!state.optBoolean("pass") && state.optBoolean("play")) {
                tabEval(popup, "(function(){var b=document.getElementById('btnPlay');if(b)b.click();return 'ok'})()")
                state = pollExpr(popup, READ_ALOUD_STATE, scaled(15_000, factor)).put("clickedPlay", true)
            }
            extra.put("popupConsole", JSONArray(consoleOf(popup).takeLast(12)))
        }
        extra.put("popup", state)
        val speaking = bg?.let { worker ->
            tabEval(worker, "(function(){window.__zenSpeaking=null;try{chrome.tts.isSpeaking(function(s){window.__zenSpeaking=String(s)})}catch(e){window.__zenSpeaking='threw: '+String(e&&e.message||e)}return 'asked'})()")
            poll(3_000, 200) { tabEval(worker, "window.__zenSpeaking||null").takeIf { r -> r != "null" } }
        }
        extra.put("speaking", speaking ?: JSONObject.NULL)
        SystemClock.sleep(600)
        snap("${entry.optString("slug")}-read-aloud")
        runCatching { coreInvoke("extension.closePopup", "null") }
        val pass = state.optBoolean("pass") && (state.optBoolean("pause") || state.optBoolean("stop") || speaking == "true")
        return Grade(
            if (pass) "P" else "F",
            "Read Aloud: tts voices ${extra.opt("voices")?.toString()?.take(100)}; popup ${if (popup == null) "did not render" else "over the fixture page: ${state.toString().take(220)}"}; tts.isSpeaking $speaking",
            extra
        )
    }

    /**
     * AnyDoc Translator: the popup's translate control sends the page through WPS's cloud and
     * its content script rewrites the text with its markers; a popup that shows its sign-in
     * instead is the account gate (`n/m`, as on the desktop).
     */
    private fun anyDoc(row: Row, entry: JSONObject): Grade {
        val factor = speedFactor(entry)
        val extra = JSONObject()
        val (_, view) = fixture("editor.html?anydoc", factor, 2_000)
        val popup = openPopup(row, factor)
        var click = JSONObject().put("clicked", false)
        var popupText = ""
        if (popup != null) {
            SystemClock.sleep(scaled(5_000, factor))
            popupText = json(tabEval(popup, DEEP_TEXT)).optString("text")
            val clicker = CLICK_LABEL.replace("__RE__", "/translate (this )?(page|web ?page)|translate now|^translate$|start translat/i")
            click = poll(scaled(6_000, factor), 1_000) { json(tabEval(popup, clicker)).takeIf { it.optBoolean("clicked") } } ?: json(tabEval(popup, clicker))
            if (click.optBoolean("clicked")) screenPoint(popup, click)?.let { tap(it.first, it.second) }
            extra.put("popupConsole", JSONArray(consoleOf(popup).takeLast(8)))
        }
        extra.put("popupText", popupText.take(200)).put("click", click)
        val found = pollExpr(view, ANYDOC_MARKS, scaled(24_000, factor))
        extra.put("page", found).put("console", JSONArray(consoleOf(view).takeLast(10)))
        SystemClock.sleep(600)
        snap("${entry.optString("slug")}-translate")
        runCatching { coreInvoke("extension.closePopup", "null") }
        return when {
            found.optBoolean("pass") -> Grade("P", "AnyDoc Translator: the page carries its translation markers after the popup's translate control (${click.optString("label")}): ${found.toString().take(200)}", extra)
            popup != null && LOGIN_WORDS.containsMatchIn(popupText) && !click.optBoolean("clicked") -> Grade("n/m", "AnyDoc Translator: popup shows its sign-in (\"${popupText.take(80)}\"); translation runs on WPS cloud with a WPS account (not measurable here)", extra)
            popup == null -> Grade("F", "AnyDoc Translator: popup did not render within ${scaled(POPUP_TIMEOUT_MS, factor) / 1000} s", extra)
            else -> Grade("F", "AnyDoc Translator: popup \"${popupText.take(80)}\"; translate control ${click.toString().take(100)}; page after: ${found.toString().take(200)}", extra)
        }
    }

    /**
     * Video Downloader Professional: `webRequest.onHeadersReceived` sees the fixture's mp4
     * (audio.html's clip), the worker keeps it in `storage.local` and the popup over that tab
     * lists it with a download button.
     */
    private fun videoDownloaderPro(row: Row, entry: JSONObject): Grade {
        val factor = speedFactor(entry)
        val extra = JSONObject()
        val (tab, _) = fixture("audio.html?vdp", factor)
        val bg = backgroundView(row.id)
        var stored = JSONObject()
        if (bg != null) {
            poll(scaled(15_000, factor), 1_500) {
                stored = probe(bg, STORAGE_HAS_CLIP, "__zenStored", 5_000)
                if (stored.optBoolean("hasClip")) true else null
            }
        }
        extra.put("storage", stored)
        showTab(tab)
        val popup = openPopup(row, factor)
        var dom = JSONObject()
        if (popup != null) {
            dom = pollExpr(popup, "(function(){var text=document.body?document.body.innerText.replace(/\\s+/g,' ').trim():'';return JSON.stringify({pass:/clip\\.mp4|clip|mp4/i.test(text)&&!/no video/i.test(text.slice(0,40)),text:text.slice(0,200),rows:document.querySelectorAll('.vdlButton, tr, li').length})})()", scaled(18_000, factor))
            dom.put("console", JSONArray(consoleOf(popup).takeLast(10)))
        }
        extra.put("popup", dom)
        SystemClock.sleep(600)
        snap("${entry.optString("slug")}-media-popup")
        runCatching { coreInvoke("extension.closePopup", "null") }
        return Grade(if (dom.optBoolean("pass")) "P" else "F", "Video Downloader Professional: popup over the fixture tab ${if (popup == null) "did not render" else dom.toString().take(220)}; storage ${stored.toString().take(100)}", extra)
    }

    /**
     * `chrome_settings_overrides.search_provider` (Norton Safe Search, Bing Homepage & Search):
     * while the extension is enabled the core's default engine is the extension's (the
     * `searchEngineControl` naming it, the engine listed with `source: extension`) and a URL-bar
     * search (`tab.navigate` with plain words) lands on the engine's host.
     */
    private fun searchOverride(label: String, host: Regex, name: Regex): (Row, JSONObject) -> Grade = { row, entry ->
        val factor = speedFactor(entry)
        val extra = JSONObject()
        val state = coreState()
        val control = state.optJSONObject("searchEngineControl")
        val engines = state.optJSONArray("searchEngines") ?: JSONArray()
        val list = List(engines.length()) { engines.optJSONObject(it) ?: JSONObject() }
        val own = list.firstOrNull { e -> e.optString("source") == "extension" && (name.containsMatchIn(e.optString("name")) || e.optString("id").contains(row.id)) }
        extra.put("control", control ?: JSONObject.NULL).put("engines", JSONArray(list.map { "${it.optString("id")}:${it.optString("name")}${if (it.has("source")) " (${it.optString("source")})" else ""}" }))
        val (tab, _) = fixture("page-b.html?search", factor, 500)
        coreInvoke("tab.navigate", JSONObject().put("tabId", tab).put("input", "zenium sweep query").toString())
        val landed = poll(scaled(20_000, factor), 500) { tabUrls()[tab]?.takeIf { host.containsMatchIn(it) } }
        val urlNow = tabUrls()[tab] ?: ""
        extra.put("landed", urlNow)
        SystemClock.sleep(scaled(2_500, factor))
        snap("${entry.optString("slug")}-search")
        val holds = control != null && own != null && (control.optString("extensionId") == row.id || control.optString("engineId") == own.optString("id"))
        when {
            landed != null -> Grade("P", "$label: the URL-bar search landed on ${landed.take(120)}; default engine control ${control?.toString()?.take(120) ?: "none"}", extra)
            own == null -> Grade("F", "$label: no engine of the extension's in the core's list (${list.size} engines: ${extra.optJSONArray("engines")?.toString()?.take(200)}); the search went to ${urlNow.take(100)}", extra)
            !holds -> Grade("F", "$label: the engine is listed (${own.optString("name")}) but does not hold the default (control ${control?.toString()?.take(120) ?: "none"}); the search went to ${urlNow.take(100)}", extra)
            else -> Grade("F", "$label: the engine holds the default (${control.toString().take(120)}) but the search went to ${urlNow.take(100)}", extra)
        }
    }

    /**
     * Awesome Screen Recorder & Screenshot: "Capture visible part" runs `tabs.captureVisibleTab`
     * and opens `edit-react.html` with the image (a canvas or image over 200 px): the screenshot
     * half of the row, the desktop's pass. The recorder half asks `tabCapture` / `desktopCapture`
     * for a stream the WebView has no source for; the worker's shape of both is recorded beside.
     */
    private fun awesomeScreenshot(row: Row, entry: JSONObject): Grade {
        val factor = speedFactor(entry)
        val extra = JSONObject()
        fixture("page-a.html?awesome", factor)
        backgroundView(row.id)?.let { extra.put("capture", captureShape(it, factor)) }
        val before = tabUrls().keys
        val popup = openPopup(row, factor)
        var click = JSONObject().put("clicked", false)
        if (popup != null) {
            SystemClock.sleep(scaled(4_000, factor))
            // The popup opens on its Record tab; the screenshot actions live under the Screenshot tab,
            // whose header is an icon named by `data-tab="screenshot"` (4.4.x), a text "Screenshot" before.
            extra.put("screenshotTab", tabEval(popup, "(function(){var el=document.querySelector('.tab-header-item[data-tab=\"screenshot\"]')||Array.prototype.slice.call(document.querySelectorAll('.tab-header-item')).find(function(n){return /^screenshot$/i.test(n.textContent.trim())});if(el)el.click();return String(!!el)})()"))
            SystemClock.sleep(scaled(1_500, factor))
            click = poll(scaled(6_000, factor), 1_000) { json(tabEval(popup, AWESOME_VISIBLE_CLICK)).takeIf { it.optBoolean("clicked") } } ?: json(tabEval(popup, AWESOME_VISIBLE_CLICK))
            if (click.optBoolean("clicked")) screenPoint(popup, click)?.let { tap(it.first, it.second) }
            extra.put("popupText", json(tabEval(popup, DEEP_TEXT)).optString("text").take(200)).put("popupConsole", JSONArray(consoleOf(popup).takeLast(8)))
        }
        extra.put("click", click)
        val result = poll(scaled(40_000, factor), 700) { tabUrls().entries.firstOrNull { it.key !in before && it.value.contains("edit-react.html") } }
        var image = JSONObject()
        if (result != null) {
            val resultView = waitForView(result.key)
            image = pollExpr(resultView, ANNOTATOR_IMAGE, scaled(30_000, factor))
            extra.put("editor", image).put("editorConsole", JSONArray(consoleOf(resultView).takeLast(10)))
            showTab(result.key)
            SystemClock.sleep(800)
        }
        snap("${entry.optString("slug")}-annotator")
        runCatching { coreInvoke("extension.closePopup", "null") }
        return Grade(
            if (image.optBoolean("pass")) "P" else "F",
            "Awesome Screenshot: popup ${if (popup == null) "did not render" else "\"Capture visible part\" ${click.toString().take(90)}"}; edit page ${if (result == null) "never opened within ${scaled(40_000, factor) / 1000} s" else "opened: ${image.toString().take(200)}"}; worker capture APIs ${extra.opt("capture")?.toString()?.take(160) ?: "unread"}",
            extra
        )
    }

    /**
     * Google Dictionary: a double-click on a word of the fixture page opens its definition
     * bubble (`#gdx-bubble-host`, an open shadow root; the meaning fetched from Google). Two taps
     * of the emulator's finger on the word first (the WebView reports a double tap as
     * `dblclick`), then, when no bubble came, a synthesised `dblclick` over the selected word,
     * which its content script reads the selection on.
     */
    private fun dictionary(row: Row, entry: JSONObject): Grade {
        val factor = speedFactor(entry)
        val extra = JSONObject()
        val (_, view) = fixture("page-a.html?dictionary", factor, 3_000)
        val word = json(tabEval(view, DICTIONARY_WORD))
        extra.put("word", word)
        screenPoint(view, word)?.let { tap(it.first, it.second); SystemClock.sleep(90); tap(it.first, it.second) }
        var found = pollExpr(view, DICTIONARY_BUBBLE, scaled(8_000, factor))
        if (!found.optBoolean("pass")) {
            extra.put("synthesised", tabEval(view, DICTIONARY_DBLCLICK))
            found = pollExpr(view, DICTIONARY_BUBBLE, scaled(14_000, factor))
        }
        extra.put("bubble", found).put("console", JSONArray(consoleOf(view).takeLast(10)))
        if (worlds) worldEval(view, row.id, WORLD_REPORT)?.let { extra.put("world", json(it)) }
        if (!found.optBoolean("pass")) extra.put("errors", targetErrors(view))
        SystemClock.sleep(600)
        snap("${entry.optString("slug")}-bubble")
        return Grade(if (found.optBoolean("pass")) "P" else "F", "Google Dictionary: double-click on \"${word.optString("word")}\" -> bubble ${found.toString().take(240)}", extra)
    }

    // --- the core checks of compat round 6 (ranks 91-120 by installs) ----------------------------

    /** `CLICK_TARGET` for a label regex literal (`/.../i`): the smallest visible element whose text matches, its centre. */
    private fun clickTarget(words: String): String = CLICK_TARGET.replace("__RE__", words)

    /** `INJECTED_ANY` for a tag / id / class pattern: the extension's elements on the page, the visible ones counted. */
    private fun injectedAny(pattern: String): String = INJECTED_ANY.replace("__PATTERN__", JSONObject.quote(pattern))

    /**
     * An effect read off a live page (BTRoblox on roblox.com, BetterTTV on twitch.tv: rows whose
     * content scripts match one site and nothing else, which the phone has no host mapping to
     * bring a fixture under): the page opens, its document completes, and `expr` (a
     * `JSON.stringify` of `{pass, ...}`) is polled. The site's own state is recorded with the
     * outcome: a page that reads as a challenge or a refusal, or drew nothing, is `n/m` – the
     * site not serving the runner – with what it showed.
     */
    private fun liveMarker(label: String, url: String, expr: String, settleMs: Long = 45_000): (Row, JSONObject) -> Grade = { row, entry ->
        val factor = speedFactor(entry)
        val tab = createTab(url)
        val view = waitForView(tab)
        val complete = poll(scaled(45_000, factor), 500) { if (tabEval(view, "String(document.readyState === 'complete')") == "true") true else null } == true
        SystemClock.sleep(scaled(2_000, factor))
        val found = pollExpr(view, expr, scaled(settleMs, factor))
        val page = json(tabEval(view, DOM_REPORT))
        val extra = JSONObject().put("page", found).put("document", page).put("complete", complete).put("console", JSONArray(consoleOf(view).takeLast(10)))
        if (worlds) worldEval(view, row.id, WORLD_REPORT)?.let { extra.put("world", json(it)) }
        SystemClock.sleep(600)
        snap("${entry.optString("slug")}-live")
        val text = page.optString("text")
        when {
            found.optBoolean("pass") -> Grade("P", "$label: on ${url.take(60)}: ${found.toString().take(220)}", extra)
            CHALLENGE_WORDS.containsMatchIn(text) || text.isEmpty() ->
                Grade("n/m", "$label: ${url.take(60)} did not serve its page to the runner (\"${text.take(80)}\", complete $complete, ${page.optInt("els")} elements); nothing for the extension to act on (not measurable here)", extra)
            else -> Grade("F", "$label: on ${url.take(60)} (\"${text.take(60)}\"): ${found.toString().take(200)}", extra)
        }
    }

    /**
     * DeepL: a selection on the Spanish fixture brings up its inline trigger
     * (`deepl-inline-trigger`, a shadow host whose own box is 0x0 while its shadow content shows;
     * the desktop's round-4 grader measures the shadow content), and a tap on it translates the
     * selection in its popover. The selection is made by script with the events a mouse's
     * selection yields (`mouseup`, `selectionchange`); the phone's own selection handles are the
     * chrome's, not the extension's. Trigger without a translation is `PARTIAL`.
     */
    private fun deepL(row: Row, entry: JSONObject): Grade {
        val factor = speedFactor(entry)
        val extra = JSONObject()
        val (_, view) = fixture("translate.html?deepl", factor, 3_000)
        extra.put("selected", tabEval(view, DEEPL_SELECT))
        var trigger = pollExpr(view, DEEPL_TRIGGER, scaled(15_000, factor))
        if (!trigger.optBoolean("pass")) {
            SystemClock.sleep(scaled(3_000, factor))
            extra.put("selectedAgain", tabEval(view, DEEPL_SELECT))
            trigger = pollExpr(view, DEEPL_TRIGGER, scaled(15_000, factor))
        }
        extra.put("trigger", trigger)
        var translation = JSONObject()
        if (trigger.optBoolean("pass")) {
            screenPoint(view, trigger)?.let { tap(it.first, it.second) }
            translation = pollExpr(view, DEEPL_TRANSLATION, scaled(25_000, factor))
            if (!translation.optBoolean("pass")) {
                extra.put("clickedByScript", tabEval(view, DEEPL_CLICK))
                translation = pollExpr(view, DEEPL_TRANSLATION, scaled(25_000, factor))
            }
        }
        extra.put("translation", translation).put("console", JSONArray(consoleOf(view).takeLast(10)))
        if (worlds) worldEval(view, row.id, WORLD_REPORT)?.let { extra.put("world", json(it)) }
        if (!trigger.optBoolean("pass")) extra.put("errors", targetErrors(view))
        backgroundView(row.id)?.let { extra.put("workerConsole", JSONArray(consoleOf(it).takeLast(8))) }
        SystemClock.sleep(600)
        snap("${entry.optString("slug")}-translation")
        return Grade(
            when {
                translation.optBoolean("pass") -> "P"
                trigger.optBoolean("pass") -> "PARTIAL"
                else -> "F"
            },
            "DeepL: inline trigger ${trigger.toString().take(160)}; translation ${translation.toString().take(200)}",
            extra
        )
    }

    /**
     * Google Input Tools: Hindi transliteration added on its options page (a Closure tree, no
     * `<select>`: the filter narrows it, a double-click on the row moves it to `#selected`),
     * turned on from the popup, and `namaste` typed into the fixture's textarea with the
     * emulator's keys gives a candidate window or Devanagari in the field (the desktop's method).
     * Added and turned on with nothing transliterated is `PARTIAL`.
     */
    private fun inputTools(row: Row, entry: JSONObject): Grade {
        val factor = speedFactor(entry)
        val extra = JSONObject()
        // The options stage records the manifest's page as written (`options.html`, relative to the
        // extension's root); the tab wants the absolute URL.
        val optionsPage = entry.optJSONObject("options")?.optJSONObject("detail")?.optString("page", "")?.ifEmpty { null } ?: "options.html"
        val optionsUrl = if (optionsPage.contains("://")) optionsPage else "chrome-extension://${row.id}/${optionsPage.trimStart('/')}"
        val optionsTab = createTab(optionsUrl)
        val optionsView = waitForView(optionsTab)
        poll(scaled(20_000, factor), 500) { if (tabEval(optionsView, "String(document.readyState === 'complete')") == "true") true else null }
        SystemClock.sleep(scaled(3_000, factor))
        val added = pollExpr(optionsView, INPUT_TOOLS_ADD, scaled(25_000, factor))
        extra.put("options", added).put("optionsConsole", JSONArray(consoleOf(optionsView).takeLast(8)))
        snap("${entry.optString("slug")}-options")
        val (tab, view) = fixture("editor.html?inputtools", factor, 2_500)
        val popup = openPopup(row, factor)
        var enabled = JSONObject().put("clicked", false)
        if (popup != null) {
            SystemClock.sleep(scaled(2_500, factor))
            extra.put("popupText", json(tabEval(popup, DEEP_TEXT)).optString("text").take(200))
            enabled = poll(scaled(8_000, factor), 1_000) { json(tabEval(popup, clickTarget("/hindi|हिन्दी|हिंदी/i"))).takeIf { it.optBoolean("clicked") } }
                ?: json(tabEval(popup, clickTarget("/hindi|हिन्दी|हिंदी/i")))
            if (enabled.optBoolean("clicked")) {
                screenPoint(popup, enabled)?.let { tap(it.first, it.second) }
                SystemClock.sleep(800)
                if (popupView() != null) enabled.put("byScript", tabEval(popup, CLICK_TARGET_SYNTH))
            }
            extra.put("popupConsole", JSONArray(consoleOf(popup).takeLast(8)))
        }
        extra.put("popup", enabled)
        runCatching { coreInvoke("extension.closePopup", "null") }
        SystemClock.sleep(1_000)
        showTab(tab)
        val centre = json(tabEval(view, ELEMENT_CENTRE.replace("%SELECTOR%", "#editor")))
        screenPoint(view, centre)?.let { tap(it.first, it.second) }
        SystemClock.sleep(600)
        tabEval(view, "(function(){var e=document.getElementById('editor');e.focus();e.value='';return 'ok'})()")
        awaitIme(true, 4_000)
        for (c in "namaste") key(KeyEvent.KEYCODE_A + (c - 'a'))
        SystemClock.sleep(scaled(2_500, factor))
        val candidates = pollExpr(view, INPUT_TOOLS_RESULT, scaled(8_000, factor))
        key(KeyEvent.KEYCODE_SPACE)
        val result = pollExpr(view, INPUT_TOOLS_RESULT, scaled(8_000, factor))
        extra.put("candidates", candidates).put("result", result).put("console", JSONArray(consoleOf(view).takeLast(8)))
        if (worlds) worldEval(view, row.id, WORLD_REPORT)?.let { extra.put("world", json(it)) }
        snap("${entry.optString("slug")}-typed")
        if (imeShown()) back() else tabEval(view, "(function(){document.activeElement&&document.activeElement.blur();return 'ok'})()")
        SystemClock.sleep(600)
        val pass = result.optBoolean("pass") || candidates.optBoolean("pass")
        return Grade(
            if (pass) "P" else if (added.optBoolean("pass") || enabled.optBoolean("clicked")) "PARTIAL" else "F",
            "Google Input Tools: options ${added.toString().take(140)}; popup ${enabled.toString().take(80)}; typed namaste -> ${result.toString().take(160)}",
            extra
        )
    }

    /**
     * ColorZilla: "Pick Color From Page" in its popup injects the eyedropper into the page (its
     * content script's overlay and toolbar); that UI on the fixture is the pass. The colour under
     * a pointer needs a mouse; the injected picker is the effect the phone can show.
     */
    private fun colorZilla(row: Row, entry: JSONObject): Grade {
        val factor = speedFactor(entry)
        val extra = JSONObject()
        val (_, view) = fixture("page-a.html?colorzilla", factor, 2_000)
        val popup = openPopup(row, factor)
        var click = JSONObject().put("clicked", false)
        if (popup != null) {
            SystemClock.sleep(scaled(2_500, factor))
            extra.put("popupText", json(tabEval(popup, DEEP_TEXT)).optString("text").take(200))
            click = poll(scaled(6_000, factor), 1_000) { json(tabEval(popup, clickTarget("/pick color from page|page color picker|color picker/i"))).takeIf { it.optBoolean("clicked") } }
                ?: json(tabEval(popup, clickTarget("/pick color from page|page color picker|color picker/i")))
            if (click.optBoolean("clicked")) screenPoint(popup, click)?.let { tap(it.first, it.second) }
            extra.put("popupConsole", JSONArray(consoleOf(popup).takeLast(8)))
        }
        extra.put("click", click)
        var injected = pollExpr(view, injectedAny("colorzilla|cz-|czp-|cz_"), scaled(15_000, factor))
        if (!injected.optBoolean("pass") && click.optBoolean("clicked") && popupView() != null) {
            extra.put("clickedByScript", tabEval(popup!!, CLICK_TARGET_SYNTH))
            injected = pollExpr(view, injectedAny("colorzilla|cz-|czp-|cz_"), scaled(15_000, factor))
        }
        extra.put("injected", injected).put("console", JSONArray(consoleOf(view).takeLast(8)))
        SystemClock.sleep(600)
        snap("${entry.optString("slug")}-picker")
        runCatching { coreInvoke("extension.closePopup", "null") }
        return Grade(
            if (injected.optBoolean("pass")) "P" else "F",
            "ColorZilla: popup ${if (popup == null) "did not render" else "\"Pick Color From Page\" ${click.toString().take(80)}"}; picker on the page ${injected.toString().take(180)}",
            extra
        )
    }

    /**
     * Picture-in-Picture (by Google): the action click has its content script call
     * `requestPictureInPicture()` on the page's playing video. The WebView has no
     * picture-in-picture window for a page's element (`document.pictureInPictureEnabled` is
     * false; the app's own PiP is the window's, `MediaControls`), so the row is a WebView limit,
     * `n/a`, once the click ran and that is what the page reports; a video that did enter is `P`.
     */
    private fun pictureInPicture(row: Row, entry: JSONObject): Grade {
        val factor = speedFactor(entry)
        val extra = JSONObject()
        val (_, view) = fixture("video.html?pip", factor, 3_000)
        val before = json(tabEval(view, PIP_STATE))
        extra.put("before", before)
        val since = StepEvidence(row)
        coreInvoke("extension.openPopup", """{"id":${JSONObject.quote(row.id)},"anchor":{"x":0,"y":0,"width":0,"height":0}}""")
        val after = pollExpr(view, PIP_STATE, scaled(15_000, factor))
        extra.put("after", after).put("console", JSONArray(consoleOf(view).takeLast(8)))
        backgroundView(row.id)?.let { extra.put("workerConsole", JSONArray(consoleOf(it).takeLast(8))) }
        if (worlds) worldEval(view, row.id, WORLD_REPORT)?.let { extra.put("world", json(it)) }
        since.record(extra, "atEnd")
        SystemClock.sleep(600)
        snap("${entry.optString("slug")}-pip")
        runCatching { coreInvoke("extension.closePopup", "null") }
        return when {
            after.optBoolean("pass") -> Grade("P", "Picture-in-Picture: the action click put the video into picture-in-picture: ${after.toString().take(160)}", extra)
            !before.optBoolean("enabled") -> Grade("n/a", "Picture-in-Picture: document.pictureInPictureEnabled is false in the WebView, so the extension's requestPictureInPicture() has no window to enter (WebView limit); after the click: ${after.toString().take(140)}", extra)
            else -> Grade("F", "Picture-in-Picture: the WebView reports picture-in-picture enabled but the click entered nothing within ${scaled(15_000, factor) / 1000} s: ${after.toString().take(160)}", extra)
        }
    }

    /**
     * DuckDuckGo: its tracker protections on the ad fixture (the row's blocking half; the
     * fixture's host `10.0.2.2` is one DuckDuckGo may treat as local and leave unprotected, as in
     * Chrome, which the desktop's round 4 met on `127.0.0.1`), else its `search_provider`
     * override taking the URL bar's search (the row's search half): either is `P`.
     */
    private fun duckDuckGo(row: Row, entry: JSONObject): Grade {
        val blocked = adBlocker(row, entry)
        if (blocked.verdict == "P") return blocked
        closeExtraTabs()
        val search = searchOverride("DuckDuckGo", Regex("duckduckgo\\.com", RegexOption.IGNORE_CASE), Regex("duckduckgo", RegexOption.IGNORE_CASE))(row, entry)
        val extra = JSONObject().put("adBlock", blocked.extra ?: JSONObject()).put("search", search.extra ?: JSONObject())
        return Grade(
            search.verdict,
            "DuckDuckGo: ad fixture ${blocked.verdict} (${blocked.note.take(140)}; the fixture host may read as local to it, protections off there as in Chrome); search ${search.note.take(200)}",
            extra
        )
    }

    /**
     * A screenshot row whose popup item runs `tabs.captureVisibleTab` and opens the extension's
     * own editor page with the image (FireShot's "Capture visible part"): the popup rendered, the
     * item tapped (by script when the tap did not open anything), a new own-page tab with a
     * canvas or an image over 200 px is the pass.
     */
    private fun popupCapture(label: String, clickWords: String): (Row, JSONObject) -> Grade = { row, entry ->
        val factor = speedFactor(entry)
        val extra = JSONObject()
        fixture("page-a.html?capture", factor, 2_000)
        val before = tabUrls().keys
        val popup = openPopup(row, factor)
        var click = JSONObject().put("clicked", false)
        if (popup != null) {
            SystemClock.sleep(scaled(3_000, factor))
            extra.put("popupText", json(tabEval(popup, DEEP_TEXT)).optString("text").take(200))
            click = poll(scaled(6_000, factor), 1_000) { json(tabEval(popup, clickTarget(clickWords))).takeIf { it.optBoolean("clicked") } } ?: json(tabEval(popup, clickTarget(clickWords)))
            if (click.optBoolean("clicked")) screenPoint(popup, click)?.let { tap(it.first, it.second) }
            extra.put("popupConsole", JSONArray(consoleOf(popup).takeLast(8)))
        }
        extra.put("click", click)
        var result = poll(scaled(20_000, factor), 700) { tabUrls().entries.firstOrNull { it.key !in before && extensionPage(it.value, row.id) } }
        if (result == null && click.optBoolean("clicked") && popup != null && popupView() != null) {
            extra.put("clickedByScript", tabEval(popup, CLICK_TARGET_SYNTH))
            result = poll(scaled(25_000, factor), 700) { tabUrls().entries.firstOrNull { it.key !in before && extensionPage(it.value, row.id) } }
        }
        var image = JSONObject()
        if (result != null) {
            val resultView = waitForView(result.key)
            image = pollExpr(resultView, ANNOTATOR_IMAGE, scaled(30_000, factor))
            extra.put("editor", image).put("editorUrl", result.value).put("editorConsole", JSONArray(consoleOf(resultView).takeLast(10)))
            showTab(result.key)
            SystemClock.sleep(800)
        }
        backgroundView(row.id)?.let { extra.put("workerConsole", JSONArray(consoleOf(it).takeLast(8))) }
        snap("${entry.optString("slug")}-capture")
        runCatching { coreInvoke("extension.closePopup", "null") }
        Grade(
            if (image.optBoolean("pass")) "P" else "F",
            "$label: popup ${if (popup == null) "did not render" else "item ${click.toString().take(90)}"}; result page ${if (result == null) "never opened within ${scaled(45_000, factor) / 1000} s" else "opened (${result.value.substringAfterLast('/').take(50)}): ${image.toString().take(160)}"}",
            extra
        )
    }

    /**
     * Immersive Translate: the popup's translate control has its content script rewrite the
     * Spanish fixture with its target wrappers (`immersive-translate-target-wrapper`) carrying
     * the English; wrappers without English (the service unreachable) are `PARTIAL`. Its floating
     * ball on every page says the content script runs and is recorded beside.
     */
    private fun immersiveTranslate(row: Row, entry: JSONObject): Grade {
        val factor = speedFactor(entry)
        val extra = JSONObject()
        val (_, view) = fixture("translate.html?immersive", factor, 3_000)
        extra.put("ball", json(tabEval(view, injectedAny("immersive-translate"))))
        val popup = openPopup(row, factor)
        var click = JSONObject().put("clicked", false)
        if (popup != null) {
            SystemClock.sleep(scaled(3_000, factor))
            extra.put("popupText", json(tabEval(popup, DEEP_TEXT)).optString("text").take(200))
            click = poll(scaled(6_000, factor), 1_000) { json(tabEval(popup, clickTarget("/^translate( this)?( page| website)?$|^translate$|translate page|translate the page/i"))).takeIf { it.optBoolean("clicked") } }
                ?: json(tabEval(popup, clickTarget("/translate/i")))
            if (click.optBoolean("clicked")) screenPoint(popup, click)?.let { tap(it.first, it.second) }
            extra.put("popupConsole", JSONArray(consoleOf(popup).takeLast(8)))
        }
        extra.put("click", click)
        var found = pollExpr(view, IMMERSIVE_TRANSLATED, scaled(25_000, factor))
        if (!found.optBoolean("pass") && found.optInt("wrappers") == 0 && click.optBoolean("clicked") && popup != null && popupView() != null) {
            extra.put("clickedByScript", tabEval(popup, CLICK_TARGET_SYNTH))
            found = pollExpr(view, IMMERSIVE_TRANSLATED, scaled(25_000, factor))
        }
        extra.put("page", found).put("console", JSONArray(consoleOf(view).takeLast(8)))
        if (worlds) worldEval(view, row.id, WORLD_REPORT)?.let { extra.put("world", json(it)) }
        backgroundView(row.id)?.let { extra.put("workerConsole", JSONArray(consoleOf(it).takeLast(8))) }
        SystemClock.sleep(600)
        snap("${entry.optString("slug")}-translated")
        runCatching { coreInvoke("extension.closePopup", "null") }
        return Grade(
            when {
                found.optBoolean("pass") -> "P"
                found.optInt("wrappers") > 0 -> "PARTIAL"
                else -> "F"
            },
            "Immersive Translate: popup ${if (popup == null) "did not render" else "translate ${click.toString().take(80)}"}; page ${found.toString().take(200)}",
            extra
        )
    }

    /**
     * WhatFont: the action click has its worker inject the tool into the page
     * (`scripting.executeScript` under `activeTab`, which the phone grants on the click; the
     * desktop's Electron does not, its settled F); the tool up on the fixture and a font read
     * off a paragraph (a pointer's hover, synthesised) is the pass; the tool up alone is
     * `PARTIAL`.
     */
    private fun whatFont(row: Row, entry: JSONObject): Grade {
        val factor = speedFactor(entry)
        val extra = JSONObject()
        val (_, view) = fixture("page-a.html?whatfont", factor, 2_000)
        val since = StepEvidence(row)
        coreInvoke("extension.openPopup", """{"id":${JSONObject.quote(row.id)},"anchor":{"x":0,"y":0,"width":0,"height":0}}""")
        val injected = pollExpr(view, injectedAny("what-?font|wf_|wfont|__wf"), scaled(20_000, factor))
        extra.put("injected", injected)
        var font = JSONObject()
        if (injected.optBoolean("pass")) {
            extra.put("hovered", tabEval(view, WHATFONT_HOVER))
            font = pollExpr(view, WHATFONT_READ, scaled(10_000, factor))
        }
        extra.put("font", font).put("console", JSONArray(consoleOf(view).takeLast(8)))
        backgroundView(row.id)?.let { extra.put("workerConsole", JSONArray(consoleOf(it).takeLast(8))) }
        since.record(extra, "atEnd")
        SystemClock.sleep(600)
        snap("${entry.optString("slug")}-tool")
        runCatching { coreInvoke("extension.closePopup", "null") }
        return Grade(
            when {
                font.optBoolean("pass") -> "P"
                injected.optBoolean("pass") -> "PARTIAL"
                else -> "F"
            },
            "WhatFont: the action click ${if (injected.optBoolean("pass")) "injected the tool (${injected.optJSONArray("tags")?.toString()?.take(100)})" else "injected nothing within ${scaled(20_000, factor) / 1000} s (${injected.toString().take(100)})"}; font read ${font.toString().take(160)}",
            extra
        )
    }

    /**
     * Wappalyzer: the popup lists the technologies its content script found on the fixture (a
     * WordPress generator meta, jQuery, Bootstrap, React's hook, a Google tag); any of them named
     * is the pass.
     */
    private fun wappalyzer(row: Row, entry: JSONObject): Grade {
        val factor = speedFactor(entry)
        val extra = JSONObject()
        val (_, view) = fixture("tech.html?wappalyzer", factor, 4_000)
        SystemClock.sleep(scaled(3_000, factor))
        val popup = openPopup(row, factor)
        var found = JSONObject()
        if (popup != null) {
            found = pollExpr(popup, TECH_LIST, scaled(30_000, factor))
            found.put("console", JSONArray(consoleOf(popup).takeLast(10)))
        }
        extra.put("popup", found).put("console", JSONArray(consoleOf(view).takeLast(8)))
        if (worlds) worldEval(view, row.id, WORLD_REPORT)?.let { extra.put("world", json(it)) }
        SystemClock.sleep(600)
        snap("${entry.optString("slug")}-technologies")
        runCatching { coreInvoke("extension.closePopup", "null") }
        return Grade(
            if (found.optBoolean("pass")) "P" else "F",
            "Wappalyzer: popup ${if (popup == null) "did not render" else "lists ${found.optJSONArray("found")?.toString()?.take(120) ?: "nothing"} (\"${found.optString("text").take(120)}\")"}",
            extra
        )
    }

    /**
     * Google Scholar Button: the popup searches Scholar for the page's title and lists results
     * ("Cited by", "[PDF]"); a popup reporting that it could not reach the server is the service
     * refusing the runner (`scholar.google.com` answered 403 to the desktop's VM in round 4),
     * `n/m`.
     */
    private fun scholarButton(row: Row, entry: JSONObject): Grade {
        val factor = speedFactor(entry)
        val extra = JSONObject()
        fixture("page-a.html?scholar", factor, 2_000)
        val popup = openPopup(row, factor)
        var found = JSONObject()
        if (popup != null) {
            found = pollExpr(popup, SCHOLAR_RESULTS, scaled(30_000, factor))
            found.put("console", JSONArray(consoleOf(popup).takeLast(10)))
        }
        extra.put("popup", found)
        SystemClock.sleep(600)
        snap("${entry.optString("slug")}-results")
        runCatching { coreInvoke("extension.closePopup", "null") }
        val text = found.optString("text")
        return when {
            found.optBoolean("pass") -> Grade("P", "Google Scholar Button: the popup lists results for the page (\"${text.take(120)}\")", extra)
            popup == null -> Grade("F", "Google Scholar Button: popup did not render in the core check", extra)
            Regex("unable to access|server|try again|error|unusual traffic|not a robot", RegexOption.IGNORE_CASE).containsMatchIn(text) ->
                Grade("n/m", "Google Scholar Button: the popup reports \"${text.take(100)}\": scholar.google.com refuses the runner (service, as on the desktop; not measurable here)", extra)
            else -> Grade("F", "Google Scholar Button: the popup shows no results within ${scaled(30_000, factor) / 1000} s (\"${text.take(120)}\")", extra)
        }
    }

    /**
     * Tag Assistant: the action opens its side panel (the phone has no panel to host it: opened
     * as a tab), which embeds `tagassistant.google.com` in a cross-origin frame and lists the
     * fixture's Google tag there. The panel and its frame rendered is what the phone can read
     * (the frame's own text is not readable from the harness, the desktop read it through
     * DevTools): `n/m` with the frame's size, the screenshot the evidence; no panel is `F`.
     */
    private fun tagAssistant(row: Row, entry: JSONObject): Grade {
        val factor = speedFactor(entry)
        val extra = JSONObject()
        val (_, view) = fixture("gtag.html?ta", factor, 2_000)
        extra.put("dataLayer", poll(scaled(15_000, factor), 500) { tabEval(view, "String(!!(window.dataLayer && window.dataLayer.length > 0))").takeIf { it == "true" } } ?: "empty")
        val before = tabUrls().keys
        val since = StepEvidence(row)
        coreInvoke("extension.openPopup", """{"id":${JSONObject.quote(row.id)},"anchor":{"x":0,"y":0,"width":0,"height":0}}""")
        // The panel as the runtime hosts it: a side panel sheet (`sidePanel.open`, round 7), else
        // the tab the extension opened for it when the phone had no panel (round 6).
        var how = ""
        val panelView: WebView? = poll(scaled(30_000, factor), 700) {
            sheetView("sidePanel")?.also { how = "as a side panel sheet" }
                ?: tabUrls().entries.firstOrNull { it.key !in before && extensionPage(it.value, row.id) }?.let { page ->
                    how = "as a tab (${extensionPath(page.value).take(40)})"
                    extra.put("panelUrl", page.value)
                    showTab(page.key)
                    waitForView(page.key)
                }
        }
        var frame = JSONObject()
        if (panelView != null) {
            frame = pollExpr(panelView, TA_PANEL, scaled(30_000, factor))
            extra.put("panel", frame).put("panelHow", how).put("panelConsole", JSONArray(consoleOf(panelView).takeLast(10)))
            if (panelView is ExtensionWebView) extra.put("sheet", sheetSize(panelView))
            SystemClock.sleep(scaled(4_000, factor))
        } else {
            popupView()?.let { extra.put("popupInstead", json(tabEval(it, DEEP_TEXT)).optString("text").take(160)) }
        }
        backgroundView(row.id)?.let { extra.put("workerConsole", JSONArray(consoleOf(it).takeLast(8))) }
        since.record(extra, "atEnd")
        snap("${entry.optString("slug")}-panel")
        runCatching { coreInvoke("extension.closePopup", "null") }
        return when {
            panelView != null && frame.optBoolean("pass") ->
                Grade("n/m", "Tag Assistant: its side panel opened $how and embeds tagassistant.google.com (${frame.optInt("w")}x${frame.optInt("h")} css px); the tag list inside the cross-origin frame is not readable from the phone's harness, the screenshot shows it (not measurable here)", extra)
            panelView != null -> Grade("PARTIAL", "Tag Assistant: its side panel opened $how but its frame did not render: ${frame.toString().take(200)}", extra)
            else -> Grade("F", "Tag Assistant: the action click opened no panel within ${scaled(30_000, factor) / 1000} s (tabs: ${tabUrls().values.joinToString().take(160)})", extra)
        }
    }

    // --- the core checks of compat round 7 (the desktop's round-5 list, ranks 121-150) -----------

    /** The row's sheet (popup, options or side panel) when one is up and rendered, or null. */
    private fun sheetView(context: String? = null): ExtensionWebView? =
        popupView()?.takeIf { (context == null || it.context == context) && rendered(it) }

    /** A tab the step opened (not in `before`) on one of the row's own pages, `pattern` on its path when given. */
    private fun openedPage(before: Set<String>, row: Row, pattern: Regex? = null): Map.Entry<String, String>? =
        tabUrls().entries.firstOrNull { it.key !in before && extensionPage(it.value, row.id) && (pattern == null || pattern.containsMatchIn(extensionPath(it.value))) }

    /**
     * Enable local file links: a trusted tap on the fixture's `file://` link has its content
     * script send the address to the worker, which calls `tabs.create` on it. Chrome refuses the
     * navigation while the extension's file-access switch is off ("Cannot navigate to a file URL
     * without local file access.") and the extension then opens its options page at
     * `#need-file-scheme-access`: that page opening is the pass (the desktop's fix A). A tab
     * opened straight on the `file://` address is the gap (F): the phone's tab WebView has no
     * file access, so the tab lands on an error page where Chrome would have refused the call.
     * The switch-on path (the file itself opening) is the WebView's, not measured: the fixture's
     * address is the runner's, not the phone's.
     */
    private fun localFileLinks(row: Row, entry: JSONObject): Grade {
        val factor = speedFactor(entry)
        val extra = JSONObject()
        val (_, view) = fixture("file-links.html?local", factor, 2_000)
        val before = tabUrls().keys
        val since = StepEvidence(row)
        val centre = json(tabEval(view, ELEMENT_CENTRE.replace("%SELECTOR%", "#local")))
        extra.put("link", centre)
        screenPoint(view, centre)?.let { tap(it.first, it.second) } ?: run { extra.put("tapByScript", tabEval(view, "(function(){var a=document.getElementById('local');a&&a.click();return 'clicked'})()")) }
        val hit = poll(scaled(20_000, factor), 500) {
            openedPage(before, row, Regex("need-file-scheme-access|options", RegexOption.IGNORE_CASE))
                ?: tabUrls().entries.firstOrNull { it.key !in before && it.value.startsWith("file:", ignoreCase = true) }
        }
        var landed = JSONObject()
        if (hit != null) {
            val landedView = runCatching { waitForView(hit.key) }.getOrNull()
            landed = landedView?.let { pollExpr(it, DOM_REPORT.replace("return JSON.stringify({text:", "return JSON.stringify({pass:document.body&&document.body.innerText.trim().length>0,text:"), scaled(15_000, factor)) } ?: JSONObject()
            landed.put("url", hit.value)
            showTab(hit.key)
            SystemClock.sleep(800)
        }
        extra.put("landed", landed).put("tabsAfterTap", JSONArray(tabUrls().values.toList()))
        since.record(extra, "atEnd")
        val worker = backgroundView(row.id)?.let { consoleOf(it) } ?: emptyList()
        val refused = worker.lastOrNull { it.contains("file URL", ignoreCase = true) || it.contains("file access", ignoreCase = true) }
        refused?.let { extra.put("refusal", it.take(300)) }
        snap("${entry.optString("slug")}-file-link")
        return when {
            hit != null && extensionPage(hit.value, row.id) ->
                Grade("P", "Enable local file links: with file access off the tap opened ${extensionPath(hit.value).take(60)} (\"${landed.optString("text").take(60)}\")${refused?.let { "; the worker logged \"${it.take(80)}\"" } ?: ""}; the switch-on path (the file itself) is the runner's file, not the phone's (not measured)", extra)
            hit != null ->
                Grade("F", "Enable local file links: the tap opened a tab straight on ${hit.value.take(60)} (\"${landed.optString("text").take(60)}\"); Chrome refuses the navigation without file access and the extension opens its options page instead", extra)
            else -> Grade("F", "Enable local file links: the tap opened nothing within ${scaled(20_000, factor) / 1000} s (tabs: ${tabUrls().values.joinToString().take(160)})", extra)
        }
    }

    /**
     * Poper Blocker: a trusted tap on the click-hijacking fixture (`window.open` on a
     * third-party address from a document-level click handler). Its page-world script replaces
     * `window.open` with one that answers a stub window (the fixture logs `fake`) and its content
     * script shows its toast (`#pb-toast-main`) for the refused pop-up: either is the pass. The
     * fixture's `null` alone is the WebView's own refusal, not the extension's (PARTIAL when the
     * extension's script is in the page but showed nothing); a window opened is F.
     */
    private fun popupBlocker(row: Row, entry: JSONObject): Grade {
        val factor = speedFactor(entry)
        val extra = JSONObject()
        val (tab, view) = fixture("popups.html?blocker", factor, 3_000)
        val before = tabUrls().keys
        val centre = json(tabEval(view, ELEMENT_CENTRE.replace("%SELECTOR%", "#log")))
        screenPoint(view, centre)?.let { tap(it.first, it.second) }
        SystemClock.sleep(scaled(2_500, factor))
        val result = pollExpr(view, POPUP_BLOCK_REPORT, scaled(12_000, factor))
        extra.put("page", result).put("console", JSONArray(consoleOf(view).takeLast(10)))
        val opened = tabUrls().entries.filter { it.key !in before }
        extra.put("opened", JSONArray(opened.map { it.value }))
        if (worlds) worldEval(view, row.id, WORLD_REPORT)?.let { extra.put("world", json(it)) }
        showTab(tab)
        SystemClock.sleep(600)
        snap("${entry.optString("slug")}-blocked")
        val fake = result.optString("result") == "fake"
        val toast = result.optBoolean("toast")
        return when {
            opened.isNotEmpty() && !fake && !toast -> Grade("F", "Poper Blocker: the tap opened ${opened.first().value.take(60)} in a new tab; nothing of the extension's refused it: ${result.toString().take(160)}", extra)
            fake || toast -> Grade("P", "Poper Blocker: the pop-up was refused by the extension (window.open answered ${result.optString("result")}, toast ${toast}): ${result.toString().take(160)}", extra)
            result.optBoolean("scriptInPage") -> Grade("PARTIAL", "Poper Blocker: its page script is in the page but the refusal was the WebView's own (window.open answered ${result.optString("result")}, no toast): ${result.toString().take(160)}", extra)
            else -> Grade("F", "Poper Blocker: nothing of the extension's reached the page (window.open answered ${result.optString("result")}): ${result.toString().take(160)}", extra)
        }
    }

    /**
     * An image downloader (Imageye, Image Downloader): the action click opens its list over the
     * gallery fixture (four 320x240 pictures) as a side panel (Chrome 114+; Imageye's
     * `setPanelBehavior`, Image Downloader's popup handing off to `sidePanel.open`), a popup or
     * a tab; the list built by `scripting.executeScript` on the active tab under `activeTab`
     * shows the fixture's pictures. Four or more pictures listed is the pass; a surface that
     * renders without them ("cannot access the contents of this page") is PARTIAL with its
     * text; no surface is F.
     */
    private fun imageList(label: String): (Row, JSONObject) -> Grade = { row, entry ->
        val factor = speedFactor(entry)
        val extra = JSONObject()
        fixture("gallery.html?images", factor, 2_500)
        val before = tabUrls().keys
        val since = StepEvidence(row)
        coreInvoke("extension.openPopup", """{"id":${JSONObject.quote(row.id)},"anchor":{"x":0,"y":0,"width":0,"height":0}}""")
        var surface = ""
        var list = JSONObject()
        val found = poll(scaled(30_000, factor), 700) {
            val sheet = sheetView()
            val page = openedPage(before, row)
            val view: WebView? = sheet ?: page?.let { runCatching { waitForView(it.key) }.getOrNull() }
            if (view != null) {
                surface = sheet?.let { "sheet (${it.context})" } ?: "tab ${extensionPath(page!!.value).take(40)}"
                list = json(tabEval(view, IMAGE_LIST_REPORT))
                if (list.optBoolean("pass")) view else null
            } else null
        }
        if (found == null) {
            // The surface is up without the pictures: read it once more, settled.
            (sheetView() ?: openedPage(before, row)?.let { runCatching { waitForView(it.key) }.getOrNull() })?.let { view ->
                SystemClock.sleep(scaled(3_000, factor))
                list = json(tabEval(view, IMAGE_LIST_REPORT))
                list.put("console", JSONArray(consoleOf(view).takeLast(10)))
            }
        }
        extra.put("surface", surface).put("list", list).put("tabsAfterClick", JSONArray(tabUrls().values.toList()))
        since.record(extra, "atEnd")
        SystemClock.sleep(800)
        snap("${entry.optString("slug")}-images")
        runCatching { coreInvoke("extension.closePopup", "null") }
        when {
            list.optBoolean("pass") -> Grade("P", "$label: its $surface lists ${list.optInt("photos")} of the fixture's pictures (${list.optInt("images")} images shown): \"${list.optString("text").take(80)}\"", extra)
            surface.isNotEmpty() -> Grade("PARTIAL", "$label: its $surface rendered without the fixture's pictures (${list.optInt("images")} images): \"${list.optString("text").take(120)}\"", extra)
            else -> Grade("F", "$label: the action click opened no panel, popup or page within ${scaled(30_000, factor) / 1000} s (tabs: ${tabUrls().values.joinToString().take(160)})", extra)
        }
    }

    /**
     * Sound Booster: its popup reads `usePopup: false` and opens `window.html?tabId=<active>` with
     * `windows.create` (a tab on the phone), whose script captures the target tab's audio with
     * `tabCapture.getMediaStreamId({consumerTabId, targetTabId})` into a gain graph (the desktop's
     * fix B). The WebView has no tab capture to source the stream from: with the window up, its
     * slider drawn and `chrome.tabCapture` in Chrome's shape in the worker, the core is the
     * WebView's limit (`n/a`), as Volume Master's and Volume Booster's are; a stream id answered
     * is P; no window or a missing namespace is F.
     */
    private fun soundBooster(row: Row, entry: JSONObject): Grade {
        val factor = speedFactor(entry)
        val extra = JSONObject()
        fixture("audio.html?booster", factor, 2_000)
        val before = tabUrls().keys
        val capture = backgroundView(row.id)?.let { captureShape(it, factor) } ?: JSONObject().put("error", "no background view")
        extra.put("capture", capture)
        coreInvoke("extension.openPopup", """{"id":${JSONObject.quote(row.id)},"anchor":{"x":0,"y":0,"width":0,"height":0}}""")
        val window = poll(scaled(30_000, factor), 700) { openedPage(before, row, Regex("window\\.html", RegexOption.IGNORE_CASE)) }
        var page = JSONObject()
        if (window != null) {
            val view = waitForView(window.key)
            page = pollExpr(view, DEEP_TEXT.replace("return JSON.stringify({text:", "return JSON.stringify({pass:document.querySelectorAll('input[type=range], [role=slider]').length>0,controls:document.querySelectorAll('input[type=range], [role=slider], button').length,text:"), scaled(20_000, factor))
            page.put("console", JSONArray(consoleOf(view).takeLast(10))).put("url", window.value)
            extra.put("windowCapture", captureShape(view, factor))
            showTab(window.key)
            SystemClock.sleep(scaled(2_000, factor))
        } else {
            popupView()?.let { extra.put("popupInstead", json(tabEval(it, DEEP_TEXT)).optString("text").take(160)) }
        }
        extra.put("window", page)
        backgroundView(row.id)?.let { extra.put("workerConsole", JSONArray(consoleOf(it).takeLast(8))) }
        snap("${entry.optString("slug")}-window")
        runCatching { coreInvoke("extension.closePopup", "null") }
        val shape = capture.optString("tabCapture") == "object" && capture.optString("getMediaStreamId") == "function"
        val streamed = extra.optJSONObject("windowCapture")?.let { it.optString("streamId").isNotEmpty() && it.isNull("error") } == true
        val note = "worker tabCapture: ${capture.toString().take(160)}; window ${if (window == null) "never opened" else "${extensionPath(window.value).take(40)}: \"${page.optString("text").take(80)}\" (${page.optInt("controls")} controls)"}"
        return when {
            streamed -> Grade("P", "Sound Booster: its window holds a tab-audio stream id: $note", extra)
            !shape -> Grade("F", "Sound Booster: chrome.tabCapture is not Chrome's shape in the worker: $note", extra)
            window == null -> Grade("F", "Sound Booster: the popup's windows.create opened no window.html within ${scaled(30_000, factor) / 1000} s: $note", extra)
            else -> Grade("n/a", "Sound Booster: the API is Chrome's shape and its window renders its slider, but the WebView has no tab or display capture to source the stream from (WebView limit): $note", extra)
        }
    }

    /**
     * Lightshot: the action click has the worker `captureVisibleTab` the page and open
     * `screenshot.html?id=<n>` with the capture (its editor); the capture drawn there (a canvas or
     * an image over 200 px on a side) is the pass.
     */
    private fun clickCapture(label: String, page: Regex): (Row, JSONObject) -> Grade = { row, entry ->
        val factor = speedFactor(entry)
        val extra = JSONObject()
        fixture("page-a.html?capture", factor, 2_000)
        val before = tabUrls().keys
        val since = StepEvidence(row)
        coreInvoke("extension.openPopup", """{"id":${JSONObject.quote(row.id)},"anchor":{"x":0,"y":0,"width":0,"height":0}}""")
        val result = poll(scaled(30_000, factor), 700) { openedPage(before, row, page) }
        var image = JSONObject()
        if (result != null) {
            val view = waitForView(result.key)
            image = pollExpr(view, ANNOTATOR_IMAGE, scaled(30_000, factor))
            extra.put("editorUrl", result.value).put("editorConsole", JSONArray(consoleOf(view).takeLast(10)))
            showTab(result.key)
            SystemClock.sleep(800)
        } else {
            popupView()?.let { extra.put("popupInstead", json(tabEval(it, DEEP_TEXT)).optString("text").take(160)) }
        }
        extra.put("editor", image)
        since.record(extra, "atEnd")
        snap("${entry.optString("slug")}-capture")
        runCatching { coreInvoke("extension.closePopup", "null") }
        Grade(
            if (image.optBoolean("pass")) "P" else "F",
            "$label: ${if (result == null) "the action click opened no ${page.pattern} within ${scaled(30_000, factor) / 1000} s (tabs: ${tabUrls().values.joinToString().take(120)})" else "${extensionPath(result.value).take(50)} opened: ${image.toString().take(200)}"}",
            extra
        )
    }

    /**
     * Dark Mode: on the stylesheet-lit fixture the action click (its `action.onClicked` toggles
     * the mode in storage; its content script restyles the page) turns the page's white
     * background dark: the computed body background's relative luminance falling under 0.5 is
     * the pass (the desktop's round-5 grader, which reads the colour and not a marker).
     */
    private fun darkMode(row: Row, entry: JSONObject): Grade {
        val factor = speedFactor(entry)
        val extra = JSONObject()
        val (_, view) = fixture("styled-light.html?dark", factor, 2_500)
        val before = json(tabEval(view, LUMINANCE_REPORT))
        extra.put("before", before)
        coreInvoke("extension.openPopup", """{"id":${JSONObject.quote(row.id)},"anchor":{"x":0,"y":0,"width":0,"height":0}}""")
        SystemClock.sleep(scaled(1_500, factor))
        runCatching { coreInvoke("extension.closePopup", "null") }
        val after = pollExpr(view, LUMINANCE_REPORT, scaled(25_000, factor))
        extra.put("after", after).put("console", JSONArray(consoleOf(view).takeLast(10)))
        if (worlds) worldEval(view, row.id, WORLD_REPORT)?.let { extra.put("world", json(it)) }
        backgroundView(row.id)?.let { extra.put("workerConsole", JSONArray(consoleOf(it).takeLast(8))) }
        SystemClock.sleep(800)
        snap("${entry.optString("slug")}-dark")
        return Grade(
            if (after.optBoolean("pass")) "P" else "F",
            "Dark Mode: body background ${before.optString("background")} (luminance ${before.optDouble("luminance")}) -> ${after.optString("background")} (luminance ${after.optDouble("luminance")}) after the action click${if (after.optBoolean("pass")) "" else "; injected ${after.optInt("injected")} elements of its own"}",
            extra
        )
    }

    /**
     * Screen Recorder: the action click opens its page (`index.html`), whose "Start Recording"
     * asks `desktopCapture.chooseDesktopMedia` for a screen. The WebView has no screen, window
     * or tab capture to offer (`getDisplayMedia` is not there): with the page up and
     * `chrome.desktopCapture` in Chrome's shape (the picker function present) the core is the
     * WebView's limit, `n/a`; a missing namespace or no page is F.
     */
    private fun desktopCaptureLimit(row: Row, entry: JSONObject): Grade {
        val factor = speedFactor(entry)
        val extra = JSONObject()
        val (_, fixtureView) = fixture("audio.html?recorder", factor, 2_000)
        extra.put("page", json(tabEval(fixtureView, "JSON.stringify({getDisplayMedia:typeof (navigator.mediaDevices&&navigator.mediaDevices.getDisplayMedia),getUserMedia:typeof (navigator.mediaDevices&&navigator.mediaDevices.getUserMedia)})")))
        val before = tabUrls().keys
        coreInvoke("extension.openPopup", """{"id":${JSONObject.quote(row.id)},"anchor":{"x":0,"y":0,"width":0,"height":0}}""")
        val opened = poll(scaled(30_000, factor), 700) { openedPage(before, row) }
        var page = JSONObject()
        var capture = JSONObject()
        if (opened != null) {
            val view = waitForView(opened.key)
            page = pollExpr(view, DEEP_TEXT.replace("return JSON.stringify({text:", "return JSON.stringify({pass:text.length>20,buttons:document.querySelectorAll('button, [role=button]').length,text:"), scaled(25_000, factor))
            page.put("url", opened.value).put("console", JSONArray(consoleOf(view).takeLast(10)))
            capture = captureShape(view, factor)
            showTab(opened.key)
            SystemClock.sleep(scaled(2_000, factor))
        }
        extra.put("recorderPage", page).put("capture", capture)
        snap("${entry.optString("slug")}-recorder")
        runCatching { coreInvoke("extension.closePopup", "null") }
        val shape = capture.optString("desktopCapture") == "object" && capture.optString("chooseDesktopMedia") == "function"
        val note = "page ${if (opened == null) "never opened" else "${extensionPath(opened.value).take(40)}: \"${page.optString("text").take(80)}\" (${page.optInt("buttons")} buttons)"}; desktopCapture: ${capture.toString().take(160)}"
        return when {
            opened == null -> Grade("F", "Screen Recorder: the action click opened no page within ${scaled(30_000, factor) / 1000} s: $note", extra)
            !page.optBoolean("pass") -> Grade("F", "Screen Recorder: its page stayed blank: $note", extra)
            !shape -> Grade("F", "Screen Recorder: chrome.desktopCapture is not Chrome's shape in its page: $note", extra)
            else -> Grade("n/a", "Screen Recorder: its page renders and the API is Chrome's shape, but the WebView has no screen, window or tab capture to offer its picker (getDisplayMedia ${extra.optJSONObject("page")?.optString("getDisplayMedia")}): WebView limit. $note", extra)
        }
    }

    /**
     * Microsoft Defender Browser Protection: a navigation to Microsoft's SmartScreen phishing
     * demo page has the worker (`webNavigation.onBeforeNavigate`, its cloud verdict) send the
     * tab to its warning page (`BrowserProtectionWarning.htm`): the tab landing there and
     * rendering is the pass. The demo page not serving the runner is `n/m`; the demo page
     * shown with no redirect is F.
     */
    private fun warningPage(label: String, url: String, warning: Regex): (Row, JSONObject) -> Grade = { row, entry ->
        val factor = speedFactor(entry)
        val extra = JSONObject()
        val since = StepEvidence(row)
        val tab = createTab(url)
        val redirected = poll(scaled(40_000, factor), 700) { tabUrls()[tab]?.takeIf { extensionPage(it, row.id) && warning.containsMatchIn(extensionPath(it)) } }
        val view = waitForView(tab)
        val page = pollExpr(view, DOM_REPORT.replace("return JSON.stringify({text:", "return JSON.stringify({pass:document.body&&document.body.innerText.trim().length>20,text:"), scaled(20_000, factor))
        extra.put("landed", tabUrls()[tab] ?: "").put("page", page).put("console", JSONArray(consoleOf(view).takeLast(10)))
        since.record(extra, "atEnd")
        SystemClock.sleep(800)
        snap("${entry.optString("slug")}-warning")
        val text = page.optString("text")
        when {
            redirected != null && page.optBoolean("pass") -> Grade("P", "$label: the demo page was sent to ${extensionPath(redirected).take(60)} (\"${text.take(80)}\")", extra)
            redirected != null -> Grade("PARTIAL", "$label: the tab was sent to ${extensionPath(redirected).take(60)} but the warning page stayed blank", extra)
            CHALLENGE_WORDS.containsMatchIn(text) || text.isEmpty() -> Grade("n/m", "$label: ${url.take(60)} did not serve the demo page to the runner (\"${text.take(80)}\"); nothing for the worker's verdict to act on (not measurable here)", extra)
            else -> Grade("F", "$label: the demo page rendered (\"${text.take(80)}\") and the worker sent the tab nowhere within ${scaled(40_000, factor) / 1000} s", extra)
        }
    }

    // --- the table -------------------------------------------------------------------------------

    /** The desktop sweep's thirty, the twenty-seven the feasibility table calls feasible first, the three it does not last. */
    private val table: List<Row> = listOf(
        Row("ddkjiahejlhfcafbddmgiahcphecmpfh", "uBlock Origin Lite", "ubo-lite", core = ::adBlocker),
        Row("odfafepnkmbhccpbejgmiehpchacaeak", "uBlock Origin (MV2, Edge Add-ons)", "ubo-mv2", store = "edge-add-ons", core = ::adBlocker),
        Row("cfhdojbkjhnklbpkdaibdccddilifddb", "Adblock Plus", "adblock-plus", core = ::adBlocker),
        Row("pkehgijcmpdhfbdbbnkijodmdjhbjlgp", "Privacy Badger", "privacy-badger", core = ::adBlocker),
        Row("mlomiejdfkolichcflejclcbmpeaniij", "Ghostery", "ghostery", core = ::adBlocker),
        Row("eimadpbcbfnmbkopoojfekhnkhdbieeh", "Dark Reader", "dark-reader", core = ::darkReader),
        Row("nngceckbapebfimnlniiiahkandclblb", "Bitwarden Password Manager", "bitwarden", account = true, core = popupLogin("Bitwarden")),
        Row("aeblfdkhhhdcdjpifhhbdiojplfjncoa", "1Password", "1password", account = true, core = popupLogin("1Password")),
        Row("hdokiejnpimakedhajhdlcegeplioahd", "LastPass", "lastpass", account = true, core = popupLogin("LastPass")),
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
        Row("ldgfbffkinooeloadekpmfoklnobpien", "Raindrop.io", "raindrop", account = true, core = popupLogin("Raindrop.io")),
        Row("knheggckgoiihginacbkhaalnibhilkk", "Notion Web Clipper", "notion-web-clipper", account = true, core = popupLogin("Notion Web Clipper")),
        Row("jldhpllghnbhlbpcmnajkpdmadaolakh", "Todoist", "todoist", account = true, core = popupLogin("Todoist")),
        Row("chphlpgkkbolifaimnlloiipkdnihall", "OneTab", "onetab", core = ::oneTab),
        Row("bcjindcccaagfpapjjmafapmmgkkhgoa", "JSON Formatter", "json-formatter", core = ::jsonFormatter),
        Row("nffaoalbilbmmfgbnbgppjihopabppdk", "Video Speed Controller", "video-speed-controller", core = ::videoSpeed),
        // Not feasible on the phone (feasibility table): a DevTools panel and screen capture have no WebView equivalent.
        Row("fmkadmapgofadopljbjfkapdkoienihi", "React Developer Tools", "react-devtools", feasible = false, core = notOnThePhone("devtools_page: the phone has no DevTools panel to host it (WebView limit)")),
        Row("nhdogjmejiglipccpnnnanhbledajbpd", "Vue.js devtools", "vue-devtools", feasible = false, core = notOnThePhone("devtools_page: the phone has no DevTools panel to host it (WebView limit)")),
        Row("liecbddmkiiihnedobmlmillhodjkdmb", "Loom", "loom", feasible = false, core = notOnThePhone("desktopCapture / tabCapture: no screen or tab capture on the phone (WebView limit); the recorder itself needs an account")),
        // Compat round 4: the next 30 by installs (`.github/scripts/ext-compat/next30.json`, the
        // desktop round-2 list), so the phone's table grows on the desktop's axis. Feasibility as
        // the top-30 sweep set it: a row needing a native host, a desktop app or an account is
        // n/m at core with the reason, graded on its other surfaces anyway.
        Row("ghbmnnjooekpmoecnnnilnnbdlolhkhi", "Google Docs Offline", "google-docs-offline", core = serviceBacked("Google Docs Offline", "offline editing needs a signed-in Google account on docs.google.com")),
        Row("efaidnbmnnnibpcajpcglclefindmkaj", "Adobe Acrobat", "adobe-acrobat", core = pdfTool("Acrobat", Regex("acrobat|adobe"), missing = "n/m")),
        Row("fheoggkfdfchfphceeifdbepaooicaho", "McAfee WebAdvisor", "mcafee-webadvisor", core = serviceBacked("McAfee WebAdvisor", "site ratings come from McAfee's cloud through its native dispatcher (a desktop companion)", native = true)),
        Row("lmjegmlicamnimmfhcmpkclmigmmcbeh", "Application Launcher For Drive", "drive-app-launcher", core = serviceBacked("Application Launcher For Drive", "launching needs Drive for desktop over native messaging and a Google account", native = true)),
        Row("gighmmpiobklfepjocnamgkkbiglidom", "AdBlock", "adblock", core = ::adBlocker),
        Row("inomeogfingihgjfjlpeplalcfajhgai", "Chrome Remote Desktop", "chrome-remote-desktop", core = serviceBacked("Chrome Remote Desktop", "remote access needs its native host (a desktop companion) and a Google account", native = true)),
        Row("ppnbnpeolgkicgegkbkbjmhlideopiji", "Microsoft Single Sign On", "microsoft-sso", core = serviceBacked("Microsoft Single Sign On", "sign-on needs the Windows Accounts broker over native messaging and a work account", native = true)),
        Row("jlhmfgmfgeifomenelglieieghnjghma", "Cisco Webex Extension", "cisco-webex", core = serviceBacked("Cisco Webex Extension", "joining needs the Webex desktop app over native messaging", native = true)),
        Row("ecnphlgnajanjnkcmbpancdjoidceilk", "Kami", "kami", core = pdfTool("Kami", Regex("kami"), missing = "F")),
        Row("bgnkhhnnamicmpeenaelnjfhikgbkllg", "AdGuard AdBlocker", "adguard", core = ::adBlocker),
        Row("inoeonmfapjbbkmdafoankkfajkcphgd", "Read&Write for Google Chrome", "read-and-write", core = accountGate("Read&Write", Regex("texthelp|readwrite|read&write", RegexOption.IGNORE_CASE), injects = "gw-toolbar")),
        Row("fcoeoabgfenejglbffodgkkbkcdhcgfn", "Claude", "claude", core = accountGate("Claude", Regex("claude\\.ai|anthropic", RegexOption.IGNORE_CASE), page = "sidepanel.html")),
        Row("majdfhpaihoncoakbjgbdhglocklcgno", "VeePN", "veepn", core = vpn("VeePN", pac = true)),
        Row("fjoaledfpmneenckfbpdfhkmimnjocfa", "NordVPN", "nordvpn", core = vpn("NordVPN", pac = true)),
        Row("ljglajjnnkapghbckkcmodicjhacbfhk", "Microsoft Power Automate", "power-automate", core = serviceBacked("Microsoft Power Automate", "flows run through Power Automate for desktop over native messaging and a work account", native = true)),
        Row("nkbihfbeogaeaoehlefnkodbefgpgknn", "MetaMask", "metamask", core = ::walletProvider),
        Row("nenlahapcbofgnanklpelkaejcehkggg", "Capital One Shopping", "capital-one-shopping", core = accountGate("Capital One Shopping", Regex("capitalone|wikibuy", RegexOption.IGNORE_CASE))),
        Row("cmedhionkhpnakcndndgjdbohmhepckk", "Adblock for Youtube", "adblock-for-youtube", core = ::adBlocker),
        Row("ihcjicgdanjaechkgeegckofjjedodee", "Malwarebytes Browser Guard", "malwarebytes-browser-guard", core = ::adBlocker),
        Row("llbcnfanfmjhpedaedhbcnpgeepdnnok", "Online Security", "online-security", core = accountGate("Online Security", Regex("getmozo|reasonlabs|reasonsecurity|onlinesecurity|online-security", RegexOption.IGNORE_CASE))),
        Row("fdpohaocaechififmbbbbbknoalclacl", "GoFullPage", "gofullpage", core = ::fullPageCapture),
        Row("oocalimimngaihdkbihfgmpkcpnmlaoa", "Teleparty", "teleparty", account = true, core = popupLogin("Teleparty")),
        Row("mmeijimgabbpbgpdklnllpncmdofkcpn", "Screencastify", "screencastify", feasible = false, core = notOnThePhone("tabCapture / desktopCapture: no screen or tab capture on the phone (WebView limit); recording itself needs an account")),
        Row("bhghoamapcdpbohphigoooaddinpkbai", "Authenticator", "authenticator", core = ::authenticator),
        Row("kgjfgplpablkjnlkjmjdecgdpfankdle", "Zoom Chrome Extension", "zoom", account = true, core = popupLogin("Zoom")),
        Row("eiaeiblijfjekdanodkjadfinkhbfgcd", "NordPass", "nordpass", account = true, core = accountGate("NordPass", Regex("nordpass", RegexOption.IGNORE_CASE))),
        Row("ekhagklcjbdpajgpjgmbionohlpdbjgc", "Zotero Connector", "zotero", core = ::zotero),
        Row("flliilndjeohchalpbbcdekjklbdgfkk", "Avira Browser Safety", "avira-browser-safety", core = siteVerdict("Avira Browser Safety")),
        Row("omghfjlpggmjjaagoclmmobgdodcjboh", "Browsec VPN", "browsec", core = vpn("Browsec", pac = true)),
        Row("caljgklbbfbcjjanaijlacgncafpegll", "Avira Password Manager", "avira-password-manager", core = accountGate("Avira Password Manager", Regex("avira", RegexOption.IGNORE_CASE))),
        // Compat round 5: the desktop's round-3 list (ranks 61-90 by installs).
        Row("glcimepnljoholdmjchkloafkggfoijh", "360 Internet Protection", "360-internet-protection", core = serviceBacked("360 Internet Protection", "its site verdicts and action come from 360 Total Security's Windows host (com.google.chrome.wdwedpro) over native messaging; the action is disabled and titled for Windows only elsewhere, as Chrome on Linux shows it", native = true)),
        Row("fcfhplploccackoneaefokcmbjfbkenj", "1clickVPN", "1clickvpn", core = vpn("1clickVPN", consent = true, connectWords = "/^(connect|start|turn on|enable|quick connect|united states|france|canada|germany|netherlands|united kingdom|singapore)/i")),
        Row("eppiocemhmnlbhjplcgkofciiegomcon", "Urban VPN Proxy", "urban-vpn", core = vpn("Urban VPN", consent = true, connectSelector = ".play-button")),
        Row("jghecgabfgfdldnmbfkhmffcabddioke", "Volume Master", "volume-master", core = captureLimit("Volume Master", "/\\\\d+ ?%|volume|boost/i")),
        Row("lpcaedmchfhocbbapmcbpinfpgnhiddi", "Google Keep Chrome Extension", "google-keep", core = accountGate("Google Keep", Regex("keep\\.google|accounts\\.google", RegexOption.IGNORE_CASE), page = "index.html")),
        Row("gmbmikajjgmnabiglmofipeabaddhgne", "Save to Google Drive", "save-to-google-drive", core = accountGate("Save to Google Drive", Regex("accounts\\.google|drive\\.google", RegexOption.IGNORE_CASE), gate = "a Google account signed into the browser (identity.getAuthToken)", gateLog = Regex("getAuthToken|signed-in browser account|launchWebAuthFlow", RegexOption.IGNORE_CASE))),
        Row("fkepacicchenbjecpbpbclokcabebhah", "iCloud Bookmarks", "icloud-bookmarks", feasible = false, core = notOnThePhone("nativeMessaging to iCloud for Windows: a Windows-only host (n/a on the phone, as on every other platform); the popup shows Apple's Windows notice")),
        Row("pejdijmoenmkgeppbflobdenhhabjlaj", "iCloud Passwords", "icloud-passwords", feasible = false, core = notOnThePhone("nativeMessaging to iCloud for Windows: a Windows-only host (n/a on the phone, as on every other platform); the popup shows Apple's Windows notice")),
        Row("kdpelmjpfafjppnhbloffcjpeomlnpah", "WPS PDF", "wps-pdf", core = pdfTool("WPS PDF", Regex("wps"), missing = "F")),
        Row("ogdlpmhglpejoiomcodnpjnfgcpmgale", "Custom Cursor for Chrome", "custom-cursor", core = ::customCursor),
        Row("lmjnegcaeklhafolokijcfjliaokphfk", "Video DownloadHelper", "video-downloadhelper", core = ::videoDownloadHelper),
        Row("gpdjojdkbbmdfjfahjcgigfpmkopogic", "Save to Pinterest", "save-to-pinterest", core = accountGate("Save to Pinterest", Regex("pinterest", RegexOption.IGNORE_CASE), injects = "iframe[src*='gpdjojdkbbmdfjfahjcgigfpmkopogic']", gate = "a Pinterest account")),
        Row("iidnbdjijdkbmajdffnidomddglmieko", "QuillBot", "quillbot", core = editorAttach("quillbot", "QuillBot mounts its root beside the textarea", pattern = "quillbot|qb-")),
        Row("hdhinadidafjejdhmfkjgnolgimiaplp", "Read Aloud", "read-aloud", core = ::readAloud),
        Row("aopddeflghjljihihabdclejbojaomaf", "AnyDoc Translator", "anydoc-translator", core = ::anyDoc),
        Row("fjgncogppolhfdpijihbpfmeohpaadpc", "EndNote Click", "endnote-click", account = true, core = popupLogin("EndNote Click")),
        Row("feepmdlmhplaojabeoecaobfmibooaid", "OrbitNote", "orbitnote", core = accountGate("OrbitNote", Regex("texthelp|orbitnote", RegexOption.IGNORE_CASE), gate = "a Google or Microsoft sign-in at texthelp")),
        Row("elicpjhcidhpjomhibiffojpinpmmpil", "Video Downloader Professional", "video-downloader-professional", core = ::videoDownloaderPro),
        Row("difoiogjjojoaoomphldepapgpbgkhkb", "Sider", "sider", core = accountGate("Sider", Regex("sider\\.ai|sidepanel", RegexOption.IGNORE_CASE), page = "sidepanel.html", gate = "a Sider account")),
        Row("mmioliijnhnoblpgimnlajmefafdfilb", "Shazam", "shazam", core = captureLimit("Shazam", "/shazam|tap|listen|identify/i")),
        Row("gomekmidlodglbbmalcneegieacbdmki", "Avast Online Security & Privacy", "avast-online-security", core = accountGate("Avast Online Security", Regex("avast", RegexOption.IGNORE_CASE), injects = "[class*='aosp'], [id*='aosp'], [class*='avast'], [id*='avast']", gate = "Avast's cloud verdict for the site")),
        Row("admmjipmmciaobhojoghlmleefbicajg", "Norton Password Manager", "norton-password-manager", core = accountGate("Norton Password Manager", Regex("norton|onboard", RegexOption.IGNORE_CASE), gate = "a Norton account")),
        Row("bfnaelmomeimhlpmgjnjophhpkkoljpa", "Phantom", "phantom", core = domMarker("Phantom providers injected into the page world", "wallet.html?phantom", "JSON.stringify({pass:!!((window.phantom&&window.phantom.solana&&window.phantom.solana.isPhantom)||(window.solana&&window.solana.isPhantom)),solana:!!window.solana,phantomSolana:!!(window.phantom&&window.phantom.solana),phantomEthereum:!!(window.phantom&&window.phantom.ethereum),announced:window.__wallet?window.__wallet.announced:null})", settleMs = 20_000)),
        Row("hehggadaopoacecdllhhajmbjkdcmajg", "ChatGPT", "chatgpt", core = accountGate("ChatGPT", Regex("chatgpt|openai|codex-sidepanel", RegexOption.IGNORE_CASE), page = "codex-sidepanel/index.html", gate = "an OpenAI account")),
        Row("mpnlkmlkncncpgnnkmkgoobfpnjmblnk", "Norton Safe Search", "norton-safe-search", core = searchOverride("Norton Safe Search", Regex("nortonsafesearch\\.com|searchsafe\\.norton\\.com|nortonsafe\\.search\\.ask\\.com", RegexOption.IGNORE_CASE), Regex("norton", RegexOption.IGNORE_CASE))),
        Row("ddojnmkongaimkdddgmcccldlfhokcfb", "Microsoft Bing Homepage & Search", "bing-homepage-search", core = searchOverride("Bing Homepage & Search", Regex("\\bbing\\.com", RegexOption.IGNORE_CASE), Regex("bing", RegexOption.IGNORE_CASE))),
        Row("gkojfkhlekighikafcpjkiklfbnlmeio", "Hola VPN", "hola-vpn", core = vpn("Hola VPN", pac = true, consent = true, connectWords = "/^(connect|start|turn on|enable|quick connect|protect me|unblock|get started|connect now)/i")),
        Row("nlipoenfbbikpbjkfpfillcgkoblgpmj", "Awesome Screen Recorder & Screenshot", "awesome-screenshot", core = ::awesomeScreenshot),
        Row("hehijbfgiekmjfkfjpbkbammjbdenadd", "IE Tab", "ie-tab", core = accountGate("IE Tab", Regex("ietab|nhc\\.htm", RegexOption.IGNORE_CASE), gate = "its Windows-only native host (ietabhelper)")),
        Row("mgijmajocgfcbeboacabfgobmjgjcoja", "Google Dictionary (by Google)", "google-dictionary", core = ::dictionary),
        // Round 5's rows 31 and 32, Read&Write and Kami, are round 4's rows above (one row per id:
        // `only` selects by id), graded again on the runtime fixes.
        // Compat round 6: the desktop's round-4 list (ranks 91-120 by installs,
        // `.github/scripts/ext-compat/next30-round4.json`). Feasibility on the phone as before:
        // a row whose effect lives on one live site the phone has no host mapping to bring a
        // fixture under (BTRoblox, BetterTTV, Keepa) is read on that site and is `n/m` when the
        // site does not serve the runner; an account, a native companion or a vendor's cloud is
        // `n/m` with its gate surface rendered; a WebView limit is `n/a` with the limit named.
        Row("cofdbpoegempjloogbagkncekinflcnj", "DeepL Translate", "deepl", core = ::deepL),
        Row("eofcbnmajmjmplflapaojjnihcjkigck", "Avast SafePrice", "avast-safeprice", core = serviceBacked("Avast SafePrice", "its offers bar needs Avast's offers cloud to return offers for a product page on a shop it supports (the desktop's round 4 got none for the runner), and the phone has no host mapping to bring a fixture under a shop's host")),
        Row("ophjlpahpchlmihnnnihgmmeilfjmjjc", "LINE", "line", core = accountGate("LINE", Regex("line\\.me|index\\.html", RegexOption.IGNORE_CASE), page = "index.html", gate = "a LINE account (its QR or email sign-in)")),
        Row("hbkpclpemjeibhioopcebchdmohaieln", "BTRoblox", "btroblox", core = liveMarker("BTRoblox", "https://www.roblox.com/games/920587237", injectedAny("btroblox|btr-|btr_"))),
        Row("mclkkofklkfljcocdinagocijmpgbhab", "Google Input Tools", "google-input-tools", core = ::inputTools),
        Row("neebplgakaahbhdphmkckjjcegoiijjo", "Keepa - Amazon Price Tracker", "keepa", core = liveMarker("Keepa", "https://www.amazon.com/dp/B0CHX3QBCH", injectedAny("keepa"))),
        Row("bhlhnicpbhignbdhedgjhgdocnmhomnp", "ColorZilla", "colorzilla", core = ::colorZilla),
        Row("hkgfoiooedgoejojocmhlaklaeopbecg", "Picture-in-Picture Extension (by Google)", "picture-in-picture", core = ::pictureInPicture),
        Row("bkdgflcldnnnapblkhphbgpggdiikppg", "DuckDuckGo Privacy Essentials", "duckduckgo", core = ::duckDuckGo),
        Row("ejcfepkfckglbgocfkanmcdngdijcgld", "ChatGPT search", "chatgpt-search", core = searchOverride("ChatGPT search", Regex("chatgpt\\.com", RegexOption.IGNORE_CASE), Regex("chatgpt", RegexOption.IGNORE_CASE))),
        Row("hjngolefdpdnooamgdldlkjgmdcmcjnc", "Equatio - Math made digital", "equatio", core = accountGate("Equatio", Regex("texthelp|everway|equatio|loginWindow", RegexOption.IGNORE_CASE), page = "loginWindow/index.html", gate = "a Texthelp (Everway) account")),
        Row("fnpbeacklnhmkkilekogeiekaglbmmka", "Norton Safe Web", "norton-safe-web", core = siteVerdict("Norton Safe Web")),
        Row("lgblnfidahcdcjddiepkckcfdhpknnjh", "Stands AdBlocker", "stands-adblocker", core = ::adBlocker),
        Row("bihmplhobchoageeokmgbdihknkjbknd", "Touch VPN", "touch-vpn", core = vpn("Touch VPN", consent = true)),
        Row("mcbpblocgmgfnpjjppndjkmgjaogfceg", "FireShot", "fireshot", core = popupCapture("FireShot", "/capture visible part|visible part|capture visible/i")),
        Row("chhjbpecpncaggjpdakmflnfcopglcmi", "Rakuten: Get Cash Back For Shopping", "rakuten", core = accountGate("Rakuten", Regex("rakuten\\.com", RegexOption.IGNORE_CASE), gate = "a Rakuten account")),
        Row("ofpnmcalabcbjgholdjcjblkibolbppb", "Monica: All-In-One AI Assist", "monica", core = domMarker("Monica's in-page widget mounted by its content script", "page-a.html?monica", injectedAny("monica"), settleMs = 30_000)),
        Row("ndnaehgpjlnokgebbaldlmgkapkpjkkb", "Mailtrack - Email Tracker for Gmail", "mailtrack", core = accountGate("Mailtrack", Regex("mailtrack|mailsuite", RegexOption.IGNORE_CASE), gate = "a Mailtrack sign-in, and Gmail for the tracking")),
        Row("mfidniedemcgceagapgdekdbmanojomk", "Coupert - Automatic Coupon Finder & Cash Back", "coupert", core = accountGate("Coupert", Regex("coupert", RegexOption.IGNORE_CASE), gate = "a Coupert account and a merchant's checkout")),
        Row("ajopnjidmegmdimjlfnijceegpefgped", "BetterTTV", "betterttv", core = liveMarker("BetterTTV", "https://www.twitch.tv/twitch", injectedAny("bttv|betterttv"))),
        Row("ahmpjcflkgiildlgicmcieglgoilbfdp", "Free Download Manager", "free-download-manager", core = serviceBacked("Free Download Manager", "downloads hand off to the Free Download Manager desktop app over native messaging (the `fdm` host)", native = true)),
        Row("ejkiikneibegknkgimmihdpcbcedgmpo", "Volume Booster", "volume-booster", core = captureLimit("Volume Booster", "/\\\\d+ ?%|volume|boost/i")),
        Row("fbgcedjacmlbgleddnoacbnijgmiolem", "Microsoft Bing Search with Rewards", "bing-search-rewards", core = searchOverride("Bing Search with Rewards", Regex("\\bbing\\.com", RegexOption.IGNORE_CASE), Regex("bing", RegexOption.IGNORE_CASE))),
        Row("dagcmkpagjlhakfdhnbomgmjdpkdklff", "Mendeley Web Importer", "mendeley-web-importer", core = accountGate("Mendeley Web Importer", Regex("mendeley|elsevier", RegexOption.IGNORE_CASE), page = "index.html", injects = "iframe[src*='dagcmkpagjlhakfdhnbomgmjdpkdklff']", gate = "a Mendeley (Elsevier) account")),
        Row("bpoadfkcbjbfhfodiogcnhhhpibjhbnh", "Immersive Translate", "immersive-translate", core = ::immersiveTranslate),
        Row("jabopobgcpjmedljpbcaablpmlmfcogm", "WhatFont", "whatfont", core = ::whatFont),
        Row("gppongmhjkpfnbhagpmjfkannfbllamg", "Wappalyzer", "wappalyzer", core = ::wappalyzer),
        Row("ldipcbpaocekfooobnbcddclnhejkcpn", "Google Scholar Button", "google-scholar-button", core = ::scholarButton),
        Row("fdgfkebogiimcoedlicjlajpkdmockpc", "Meta Ads Data Advisor", "meta-ads-data-advisor", core = accountGate("Meta Ads Data Advisor", Regex("side-panel|facebook\\.com", RegexOption.IGNORE_CASE), page = "side-panel/index.html", gate = "a Meta business account (its panel reads \"No Pixels found\" on the fixture)")),
        Row("kejbdjndbnbjgmefkgdddjlbokphdefk", "Tag Assistant Companion", "tag-assistant", core = ::tagAssistant),
        // Compat round 7: the desktop's round-5 list (ranks 121-150 by installs,
        // `.github/scripts/ext-compat/next30-round5.json`), graded as the desktop graded them
        // (desktop-compat-sweep-5.md) with the phone's feasibility classes: a native companion
        // (Web PKI, Web Threat Shield, Signer.Digital) is `n/m` once `connectNative` answers as
        // Chrome does without the host; an account or a vendor's service is `n/m` with its gate
        // surface rendered; a capture the WebView has no source for (Sound Booster's tab audio,
        // Screen Recorder's screen) is `n/a` with the API's shape measured; a live site the phone
        // has no fixture for (YouTube, Twitch, Roblox, Microsoft's SmartScreen demo) is read on
        // the site. Round 6's five open rows (Read&Write, DeepL, Google Input Tools, Tag
        // Assistant, Touch VPN) are the rows above, graded again on this round's fixes.
        Row("pachckjkecffpdphbpmfolblodfkgbhl", "vidIQ Vision for YouTube", "vidiq", core = { row, entry -> youtube(row, entry, injectedAny("vidiq"), "vidIQ's panel on a watch page", desktopSite = true) }),
        Row("dcngeagmmhegagicpcmpinaoklddcgon", "Web PKI", "web-pki", core = serviceBacked("Web PKI", "certificates and signatures come from the Web PKI native component (a desktop companion) over native messaging; its page API answers isReady: false without it", native = true)),
        Row("kjeghcllfecehndceplomkocgfbklffd", "Web Threat Shield", "web-threat-shield", core = serviceBacked("Web Threat Shield", "site verdicts come from the Webroot agent (com.webroot.wtsmsg, a desktop companion) over native messaging and need a keycode", native = true)),
        Row("nikfmfgobenbhmocjaaboihbeocackld", "Enable local file links", "local-file-links", core = ::localFileLinks),
        Row("glghokcicpikglmflbbelbgeafpijkkf", "Signer.Digital Digital Signature, PKI", "signer-digital", core = serviceBacked("Signer.Digital", "signing needs its Signer.Digital host (a desktop companion) over native messaging; its installer dialog opens on Chrome's missing-host disconnect", native = true)),
        Row("pioclpoplcdbaefihamjohnefbikjilc", "Evernote Web Clipper", "evernote-web-clipper", core = accountGate("Evernote Web Clipper", Regex("evernote", RegexOption.IGNORE_CASE), gate = "an Evernote account (its sign-in at accounts.evernote.com)")),
        Row("bkkbcggnhapdmkeljlodobbkopceiche", "Pop up blocker for Chrome - Poper Blocker", "poper-blocker", core = ::popupBlocker),
        Row("ohahllgiabjaoigichmmfljhkcfikeof", "AdBlocker Ultimate", "adblocker-ultimate", core = ::adBlocker),
        Row("akcocjjpkmlniicdeemdceeajlmoabhg", "Free VPN Proxy - 1VPN", "1vpn", core = vpn("1VPN", pac = true, connectSelector = "#proxyToggle")),
        Row("adbacgifemdbhdkfppmeilbgppmhaobf", "RoPro - Enhance Your Roblox Experience", "ropro", core = liveMarker("RoPro", "https://www.roblox.com/games/920587237", injectedAny("ropro"))),
        Row("jpkfgepcmmchgfbjblnodjhldacghenp", "Pie Adblock - A Powerful Free Ad Blocker", "pie-adblock", core = ::adBlocker),
        Row("mihcahmgecmbnbcchbopgniflfhgnkff", "Google Mail Checker", "google-mail-checker", core = accountGate("Google Mail Checker", Regex("accounts\\.google|mail\\.google|gmail", RegexOption.IGNORE_CASE), gate = "a Google account (the unread count is Gmail's feed)")),
        Row("fjnbnpbmkenffdnngjfgmeleoegfcffe", "Stylish - Custom themes for any website", "stylish", core = accountGate("Stylish", Regex("userstyles|stylish", RegexOption.IGNORE_CASE), injects = "iframe[src*='fjnbnpbmkenffdnngjfgmeleoegfcffe']", gate = "its styles gateway listing styles for the site (none for the runner on the desktop) and a Stylish account")),
        Row("hnmpcagpplmpfojmgmnngilcnanddlhb", "Free VPN For Chrome - VPN Extension - Windscribe", "windscribe", core = vpn("Windscribe")),
        Row("agionbommeaifngbhincahgmoflcikhm", "Image downloader - Imageye", "imageye", core = imageList("Imageye")),
        Row("nmigaijibiabddkkmjhlehchpmgbokfj", "Sound Booster - increase volume up", "sound-booster", core = ::soundBooster),
        Row("bfogiafebfohielmmehodmfbbebbbpei", "Keeper Password Manager & Digital Vault", "keeper", account = true, core = popupLogin("Keeper")),
        Row("ammjkodgmmoknidbanneddgankgfejfh", "7TV", "7tv", core = liveMarker("7TV", "https://www.twitch.tv/directory", injectedAny("seventv|7tv"))),
        Row("mbniclmhobmnbdlbpiphghaielnnpgdp", "Lightshot (screenshot tool)", "lightshot", core = clickCapture("Lightshot", Regex("screenshot\\.html", RegexOption.IGNORE_CASE))),
        Row("cndibmoanboadcifjkjbdpjgfedanolh", "BetterCampus (prev. BetterCanvas)", "bettercampus", core = accountGate("BetterCampus", Regex("bettercampus|bettercanvas", RegexOption.IGNORE_CASE), gate = "a Canvas LMS session (its welcome page asks for the school's LMS address)")),
        Row("hoombieeljmmljlkjmnheibnpciblicm", "Language Reactor", "language-reactor", core = { row, entry -> youtube(row, entry, injectedAny("lln|language-reactor|languagereactor|lr-"), "Language Reactor's controls on a watch page", desktopSite = true) }),
        Row("jplgfhpmjnbigmhklmmbgecoobifkmpa", "Proton VPN: Fast & Secure", "proton-vpn", core = vpn("Proton VPN")),
        Row("nmmicjeknamkfloonkhhcjmomieiodli", "YouTube Summary with ChatGPT & Claude", "youtube-summary", core = { row, entry -> youtube(row, entry, injectedAny("yt_ai_summary|ytsummary"), "the summary box on a watch page", desktopSite = true) }),
        Row("cnpniohnfphhjihaiiggeabnkjhpaldj", "Image Downloader", "image-downloader", core = imageList("Image Downloader")),
        Row("pocpnlppkickgojjlmhdmidojbmbodfm", "Chromebook Recovery Utility", "chromebook-recovery", core = accountGate("Chromebook Recovery Utility", Regex("window\\.html|recovery", RegexOption.IGNORE_CASE), page = "window.html", gate = "Chrome's private imageWriterPrivate API (allowlisted to this Google extension) and a USB drive; its window says the platform is unsupported, as on Linux")),
        Row("dmghijelimhndkbmpgbldicpogfkceaj", "Dark Mode", "dark-mode", core = ::darkMode),
        Row("bfgdeiadkckfbkeigkoncpdieiiefpig", "Bitmoji", "bitmoji", account = true, core = popupLogin("Bitmoji")),
        Row("hniebljpgcogalllopnjokppmgbhaden", "Screen Recorder", "screen-recorder", core = ::desktopCaptureLimit),
        Row("dahenjhkoodjbpjheillcadbppiidmhp", "Google Scholar PDF Reader", "scholar-pdf-reader", core = pdfTool("Google Scholar PDF Reader", Regex("scholar|gs_|gsr", RegexOption.IGNORE_CASE), missing = "F")),
        Row("bkbeeeffjjeopflfhgeknacdieedcoml", "Microsoft Defender Browser Protection", "defender-browser-protection", core = warningPage("Microsoft Defender Browser Protection", "https://demo.smartscreen.msft.net/phishingdemo.html", Regex("BrowserProtectionWarning", RegexOption.IGNORE_CASE)))
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

    /** The document shows text (innerText leaves out what visibility hides): the page as seen. */
    private fun visibleText(view: WebView): Boolean =
        tabEval(view, "String(!!document.body && document.body.innerText.trim().length > 20)", 5) == "true"

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

    /**
     * An extension page's URL in either spelling – Chrome's `chrome-extension://<id>/…`, the
     * tab model's canonical form, or the served `https://<id>.ext.zenium.invalid/…` the WebView
     * loads – of any extension, or of `id`'s. The driver reads both so a run before and after the
     * model's spelling changed grades the same.
     */
    private fun extensionPage(url: String, id: String? = null): Boolean {
        val presented = ExtensionUrls.present(url)
        return presented.startsWith("chrome-extension://") && (id == null || presented.startsWith("chrome-extension://$id/", ignoreCase = true))
    }

    /** The path (query and fragment kept) of an extension page's URL in either spelling, for a note; the URL itself for any other. */
    private fun extensionPath(url: String): String {
        val presented = ExtensionUrls.present(url)
        if (!presented.startsWith("chrome-extension://")) return url
        val rest = presented.removePrefix("chrome-extension://").substringAfter("/", "")
        return "/$rest"
    }

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

    /**
     * An extension page that opened and drew nothing: its document's report, the endpoints the host
     * still holds for the view (a page the host dropped gets no reply, and no error), what crossed
     * the bridge for the extension since the stage began (the background's own calls and their
     * replies left out: its storage traffic would fill the window), and whether a message and a
     * storage read sent from the page now come back ([MESSAGE_PROBE]).
     */
    private fun blankPageEvidence(view: WebView, row: Row, since: Long): JSONObject {
        var endpoints: List<String> = emptyList()
        var trace: List<String> = emptyList()
        instrumentation.runOnMainSync {
            endpoints = host.extensions.endpointSnapshot(view)
            trace = host.extensions.traceSnapshot(row.id)
        }
        val stage = trace.filter {
            (it.substringBefore(' ').toLongOrNull() ?: 0L) >= since && !it.contains("/background call ") && !it.contains("/background reply ")
        }
        tabEval(view, MESSAGE_PROBE)
        SystemClock.sleep(2_500)
        return JSONObject()
            .put("report", json(tabEval(view, BLANK_PAGE_REPORT)))
            .put("console", JSONArray(consoleOf(view).takeLast(20)))
            .put("endpoints", JSONArray(endpoints))
            .put("trace", JSONArray(stage.takeLast(80)))
            .put("probe", json(tabEval(view, "JSON.stringify(window.__zenMessageProbe||null)")))
    }

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
        /** A userscript manager's install landing: its install tab closing after the Install click. */
        private const val USERSCRIPT_INSTALL_MS = 15_000L
        /** The marker on the target's first document; the rest of [USERSCRIPT_EFFECT_MS] goes to the reload. */
        private const val USERSCRIPT_FIRST_LOAD_MS = 20_000L
        private const val USERSCRIPT_EFFECT_MS = 45_000L
        /** A store install of these rows on the 113 job at normal speed; a row's own install against it is the job's speed factor ([speedFactor]). */
        private const val NOMINAL_INSTALL_MS = 8_000L
        /** The 113 job's UI frame interval (`app_time_stats avg=99-134ms` in round 3's runs). */
        private const val NOMINAL_FRAME_MS = 100L
        private const val FRAME_PROBE_FRAMES = 4
        private const val FRAME_PROBE_TIMEOUT_MS = 8_000L
        /**
         * A userscript manager's install page: whether its Install button is up and its spinner
         * down (Tampermonkey's `ask.html` shows "Please wait..." while its background answers),
         * the button's state, the page's text.
         */
        private const val USERSCRIPT_INSTALL_PAGE_STATE =
            "(function(){var label=function(n){return (n.value||n.textContent||'').trim()};var visible=function(n){return n.offsetParent!==null};" +
                "var isInstall=function(n){return /^(install|confirm installation)$/i.test(label(n))&&visible(n)};" +
                "var buttons=Array.prototype.slice.call(document.querySelectorAll('button, input[type=button], input[type=submit]'));var nodes=Array.prototype.slice.call(document.querySelectorAll('a, [role=button], div, span'));" +
                "var hit=buttons.find(isInstall)||nodes.find(isInstall);var text=(document.body?document.body.innerText:'').replace(/\\s+/g,' ').trim();var waiting=/please wait/i.test(text);" +
                "return JSON.stringify({pass:!!hit&&!waiting,waiting:waiting,button:hit?{label:label(hit),disabled:!!hit.disabled}:null,buttons:buttons.map(label).filter(Boolean).slice(0,8),text:text.slice(0,200),readyState:document.readyState})})()"
        /** Stylus's install page: its `button.install` (present, shown, enabled, label, classes), its message box, the page's text. */
        /**
         * Stylus's install page: the Install button (in the HTML from the start; `armed` once the
         * page assigned its `onclick`, after its `build` came back from the worker), the page's
         * message box, its text.
         */
        private const val STYLUS_INSTALL_PAGE_STATE =
            "(function(){var b=document.querySelector('button.install');var armed=!!b&&typeof b.onclick==='function';var m=document.querySelector('#message-box, .message-box, #message-box-contents');var text=(document.body?document.body.innerText:'').replace(/\\s+/g,' ').trim();" +
                "return JSON.stringify({pass:!!b&&b.offsetParent!==null&&!b.disabled&&armed,armed:armed,present:!!b,disabled:b?b.disabled:null,hidden:b?b.offsetParent===null:null,label:b?(b.textContent||'').trim():null,classes:b?String(b.className):null,title:document.title," +
                "message:m?(m.textContent||'').replace(/\\s+/g,' ').trim().slice(0,160):null,text:text.slice(0,160),readyState:document.readyState})})()"
        /**
         * What an account-backed extension's sign-in surface says (the account rows' core grade,
         * [popupLogin]); whole words, so a product name is not one ("Contact 1Password Support").
         */
        private val LOGIN_WORDS = Regex("\\b(?:log ?in|sign ?in|create account|get started|continue|welcome|e-?mail|unlock|passwords?)\\b", RegexOption.IGNORE_CASE)
        /** An extension page routed to an error view (1Password's `app.html#/page/error`) is no sign-in, whatever it says. */
        private val ERROR_ROUTE = Regex("/error(?:[/?#]|$)", RegexOption.IGNORE_CASE)
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
        /**
         * A page that drew nothing: what it loaded (its scripts by URL and type, the stylesheets), its
         * `readyState`, whether its `chrome` is there, the body's markup size, and the first of the body.
         */
        private const val BLANK_PAGE_REPORT =
            "(function(){var s=Array.prototype.slice.call(document.scripts).map(function(x){return (x.type||'classic')+':'+(x.src?x.src.replace(location.origin,''):'inline:'+x.textContent.length)});" +
                "var css=Array.prototype.slice.call(document.styleSheets).map(function(x){return x.href?x.href.replace(location.origin,''):'inline'});" +
                "var c=typeof chrome==='object'&&chrome?Object.keys(chrome).sort():null;var rt=c&&chrome.runtime?{id:chrome.runtime.id,hasSendMessage:typeof chrome.runtime.sendMessage}:null;" +
                "return JSON.stringify({readyState:document.readyState,url:location.href,title:document.title,scripts:s.slice(0,30),styleSheets:css.slice(0,15),chrome:c,runtime:rt,bodyHtml:document.body?document.body.innerHTML.length:-1,bodyStart:document.body?document.body.innerHTML.replace(/\\s+/g,' ').slice(0,300):'',hidden:document.body?document.body.hidden:null,bodyDisplay:document.body?getComputedStyle(document.body).display:null,visibility:document.visibilityState})})()"
        /** An extension page's document after a restart: its size, its `readyState`, and the runtime's word on whose page it is. */
        private const val RESTORED_PAGE_REPORT =
            "(function(){var c=typeof chrome==='object'&&chrome&&chrome.runtime?chrome.runtime:null;" +
                "return JSON.stringify({url:location.href,readyState:document.readyState,title:document.title,els:document.body?document.body.querySelectorAll('*').length:0," +
                "text:document.body?document.body.innerText.replace(/\\s+/g,' ').trim().slice(0,120):'',runtimeId:c?String(c.id):null,getURL:c&&typeof c.getURL==='function'?c.getURL('x.html'):null})})()"
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
        /**
         * From a blank extension page: does a `runtime.sendMessage` to the extension's other pages come
         * back at all (a response, `undefined`, or Chrome's "Receiving end" error all count), and does a
         * `storage.local.get` – the two hops a page's first paint usually waits on. What each answered,
         * or that it had not after 2.5 s, lands on `window.__zenMessageProbe`.
         */
        private const val MESSAGE_PROBE =
            "(function(){var p=window.__zenMessageProbe={askedAt:Date.now(),message:null,messageError:null,messageMs:null,storage:null,storageError:null,storageMs:null};" +
                "try{chrome.runtime.sendMessage({type:'zenium-probe',what:'os'}).then(function(v){p.messageMs=Date.now()-p.askedAt;p.message=v===undefined?'undefined':JSON.stringify(v).slice(0,200)},function(e){p.messageMs=Date.now()-p.askedAt;p.messageError=String(e&&e.message||e)})}catch(e){p.messageError='threw: '+String(e&&e.message||e)}" +
                "try{chrome.storage.local.get(null).then(function(v){p.storageMs=Date.now()-p.askedAt;p.storage=Object.keys(v).length+' keys'},function(e){p.storageMs=Date.now()-p.askedAt;p.storageError=String(e&&e.message||e)})}catch(e){p.storageError='threw: '+String(e&&e.message||e)}return 'asked'})()"
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
        /**
         * From the background of a row with the `nativeMessaging` permission: `sendNativeMessage`
         * and `connectNative` to a host that does not exist. Chrome answers both with "Specified
         * native messaging host not found." (the callback's `lastError`, the port's disconnect);
         * a missing function, a synchronous throw or another wording is not Chrome's shape. The
         * answers, or their absence after 8 s, land on `window.__zenNativeProbe`.
         */
        private const val NATIVE_MESSAGING_PROBE =
            "(function(){var rt=typeof chrome==='object'&&chrome?chrome.runtime:null;var p=window.__zenNativeProbe={done:false,pass:false,sendNativeMessage:typeof (rt&&rt.sendNativeMessage),connectNative:typeof (rt&&rt.connectNative),error:null,disconnect:null,askedAt:Date.now()};" +
                "var chromes=/native messaging host not found/i;var finish=function(){if(p.error!==null&&p.disconnect!==null&&!p.done){p.pass=p.sendNativeMessage==='function'&&p.connectNative==='function'&&chromes.test(p.error)&&chromes.test(p.disconnect);p.ms=Date.now()-p.askedAt;p.done=true}};" +
                "setTimeout(function(){if(!p.done){if(p.error===null)p.error='no answer within 8 s';if(p.disconnect===null)p.disconnect='no disconnect within 8 s';p.done=true}},8000);" +
                "try{rt.sendNativeMessage('com.zenium.sweep.missing_host',{ping:1},function(v){p.error=rt.lastError?String(rt.lastError.message):'answered: '+JSON.stringify(v).slice(0,80);finish()})}catch(e){p.error='threw: '+String(e&&e.message||e);finish()}" +
                "try{var port=rt.connectNative('com.zenium.sweep.missing_host');port.onDisconnect.addListener(function(){p.disconnect=rt.lastError?String(rt.lastError.message):'disconnected without lastError';finish()});port.onMessage.addListener(function(m){p.disconnect='message: '+JSON.stringify(m).slice(0,80);finish()})}catch(e){p.disconnect='threw: '+String(e&&e.message||e);finish()}" +
                "return 'asked'})()"
        /**
         * From a VPN row's background: `chrome.proxy` as Chrome defines it with the `proxy`
         * permission – `proxy.settings.get({})` answering a `ChromeSetting` reading (`value.mode`,
         * `levelOfControl`), `set` / `clear` / `onChange` and `onProxyError` present, the `Mode`
         * constants. What answered, or a `TypeError` for a missing namespace, lands on
         * `window.__zenProxyProbe`.
         */
        private const val PROXY_PROBE =
            "(function(){var px=typeof chrome==='object'&&chrome?chrome.proxy:undefined;var p=window.__zenProxyProbe={done:false,pass:false,proxy:typeof px,settings:typeof (px&&px.settings),get:typeof (px&&px.settings&&px.settings.get),set:typeof (px&&px.settings&&px.settings.set),clear:typeof (px&&px.settings&&px.settings.clear)," +
                "onChange:typeof (px&&px.settings&&px.settings.onChange&&px.settings.onChange.addListener),onProxyError:typeof (px&&px.onProxyError&&px.onProxyError.addListener),modes:px&&px.Mode?Object.keys(px.Mode).length:0,reading:null,error:null};" +
                "var finish=function(){p.pass=p.get==='function'&&p.set==='function'&&p.clear==='function'&&p.onChange==='function'&&p.onProxyError==='function'&&!!p.reading&&typeof p.reading.levelOfControl==='string'&&!!p.reading.value&&typeof p.reading.value.mode==='string';p.done=true};" +
                "if(p.get!=='function'){p.error='chrome.proxy.settings.get is '+p.get;finish();return 'asked'}" +
                "setTimeout(function(){if(!p.done){p.error='no answer within 8 s';finish()}},8000);" +
                "try{var r=px.settings.get({},function(v){if(chrome.runtime.lastError)p.error=String(chrome.runtime.lastError.message);p.reading=v||null;finish()});if(r&&typeof r.then==='function')r.then(function(v){p.reading=v||null;finish()},function(e){p.error=String(e&&e.message||e);finish()})}catch(e){p.error='threw: '+String(e&&e.message||e);finish()}" +
                "return 'asked'})()"
        /** proxy-check.html's reading: the public address its two echo services saw (`window.__egress`). */
        private const val EGRESS_REPORT =
            "JSON.stringify({pass:!!(window.__egress&&window.__egress.ipify&&!/error/i.test(window.__egress.ipify)),ipify:window.__egress?window.__egress.ipify:null,ifconfig:window.__egress?window.__egress.ifconfig:null,errors:window.__egress?window.__egress.errors:['no __egress on the page'],readyState:document.readyState})"
        /**
         * A VPN popup's connect control: the first shown button, link, switch or checkbox labelled
         * connect / turn on / enable / start / protect / activate (through open shadow roots) that
         * is not a disconnect, a sign-in or an upgrade; a tap on it, and what the popup offered.
         */
        private const val VPN_CONNECT_WORDS = "/\\b(connect|turn on|enable|start|protect|activate|power|switch on|quick connect)\\b/i"
        private const val VPN_CONNECT_CLICK =
            "(function(){var want=__WANT__;var sel=__SELECTOR__;var avoid=/\\b(disconnect|turn off|disable|log ?in|sign ?in|sign up|register|upgrade|premium|buy|trial)\\b/i;var cands=[];" +
                "var label=function(e){return ((e.getAttribute&&(e.getAttribute('aria-label')||e.getAttribute('title')))||e.value||e.textContent||'').replace(/\\s+/g,' ').trim()};var shown=function(e){var r=e.getBoundingClientRect();return r.width>0&&r.height>0};" +
                "var walk=function(root){var all=root.querySelectorAll('button, a, [role=button], [role=switch], input[type=checkbox], input[type=button], input[type=submit], label, div, span, li');for(var i=0;i<all.length;i++){var e=all[i];var l=label(e);if(l.length<40&&l.length>0&&want.test(l)&&!avoid.test(l)&&shown(e))cands.push(e);if(e.shadowRoot)walk(e.shadowRoot)}};" +
                "if(document.body)walk(document.body);var switches=Array.prototype.slice.call(document.querySelectorAll('[role=switch], input[type=checkbox]')).filter(shown);var bySel=sel?document.querySelector(sel):null;if(bySel&&!shown(bySel))bySel=null;" +
                "var hit=bySel||cands.find(function(e){return /^(BUTTON|A|INPUT)$/.test(e.tagName)||e.getAttribute('role')==='button'})||cands[0]||switches[0]||null;" +
                "if(hit){try{hit.click()}catch(e){return JSON.stringify({clicked:false,error:String(e&&e.message||e)})}}" +
                "return JSON.stringify({clicked:!!hit,bySelector:!!bySel,label:hit?label(hit).slice(0,60):null,tag:hit?hit.tagName+(hit.getAttribute('role')?'[role='+hit.getAttribute('role')+']':''):null,candidates:cands.slice(0,6).map(function(e){return e.tagName+':'+label(e).slice(0,30)}),switches:switches.length})})()"
        /** A consent screen's accepting control, for [CLICK_LABEL]: the whole label is one of these. */
        private const val CONSENT_WORDS = "/^(agree|accept|i agree|agree (and|&) continue|accept (and|&) continue|continue|get started|got it|start|skip|next|ok|okay|allow)[.!]?$/i"
        /**
         * A tap on the first drawn control whose whole label matches `__RE__` (buttons, links,
         * role=button, labelled inputs, then the innermost text container; through open shadow
         * roots): its label and centre, or the document's text when nothing matched.
         */
        private const val CLICK_LABEL =
            "(function(){var re=__RE__;var visible=function(n){var r=n.getBoundingClientRect();return r.width>10&&r.height>10};" +
                "var label=function(e){return ((e.getAttribute&&(e.getAttribute('aria-label')||e.getAttribute('title')))||e.value||e.textContent||'').replace(/\\s+/g,' ').trim()};var cands=[];" +
                "var walk=function(root){var all=root.querySelectorAll('button, a, [role=button], input[type=button], input[type=submit], label, div, span, li, p');for(var i=0;i<all.length;i++){var e=all[i];var l=label(e);if(l.length>0&&l.length<60&&re.test(l)&&visible(e))cands.push(e);if(e.shadowRoot)walk(e.shadowRoot)}};" +
                "if(document.body)walk(document.body);var leaves=cands.filter(function(e){return !cands.some(function(o){return o!==e&&e.contains(o)})});" +
                "var hit=cands.find(function(e){return /^(BUTTON|A|INPUT)$/.test(e.tagName)||e.getAttribute('role')==='button'})||leaves[0]||null;" +
                "if(!hit)return JSON.stringify({clicked:false,text:document.body?document.body.innerText.replace(/\\s+/g,' ').trim().slice(0,100):''});var r=hit.getBoundingClientRect();try{hit.click()}catch(e){}" +
                "return JSON.stringify({clicked:true,label:label(hit).slice(0,40),tag:hit.tagName,x:r.left+r.width/2,y:r.top+r.height/2})})()"
        /** A document's text through open shadow roots (`innerText` stops at a shadow host), scripts and styles left out. */
        private const val DEEP_TEXT =
            "(function(){var parts=[];var walk=function(root){var it=document.createNodeIterator(root,NodeFilter.SHOW_TEXT);var n;while((n=it.nextNode())){var par=n.parentNode;if(par&&/^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(par.nodeName))continue;var t=n.textContent.replace(/\\s+/g,' ').trim();if(t)parts.push(t)}" +
                "var all=root.querySelectorAll('*');for(var i=0;i<all.length;i++)if(all[i].shadowRoot)walk(all[i].shadowRoot)};if(document.body)walk(document.body);var text=parts.join(' ').replace(/\\s+/g,' ').trim();" +
                "return JSON.stringify({text:text.slice(0,400),len:text.length,els:document.body?document.body.querySelectorAll('*').length:0,readyState:document.readyState})})()"
        /**
         * From Authenticator's background: one TOTP account saved as its own manual entry saves
         * one – an `OTPStorage` item keyed by its hash in `chrome.storage.sync`, the default
         * location (a sync area with entries and an empty local one is read as sync). The set,
         * read back, or the error lands on `window.__zenSeed`.
         */
        private const val AUTHENTICATOR_SEED =
            "(function(){window.__zenSeed=null;var hash='zenium-sweep-totp-0001';var item={};item[hash]={account:'sweep@zenium.invalid',issuer:'Zenium',secret:'JBSWY3DPEHPK3PXP',type:'totp',index:0,hash:hash,encrypted:false,counter:0,period:30,digits:6,algorithm:'SHA1',pinned:false};" +
                "try{chrome.storage.sync.set(item).then(function(){return chrome.storage.sync.get(hash)}).then(function(v){window.__zenSeed='saved, read back '+Object.keys(v||{}).length+' key'},function(e){window.__zenSeed='error: '+String(e&&e.message||e)})}catch(e){window.__zenSeed='threw: '+String(e&&e.message||e)}return 'asked'})()"
        /**
         * From Zotero Connector's worker: the connector's own record of the citation tab
         * (`Connector_Browser.getTabInfo`), the translators its content script and offscreen
         * sandbox detected for it (their labels) and whether the first-run notice is still owed
         * (`firstUse`). Lands on `window.__zenZotero`.
         */
        private const val ZOTERO_TAB_INFO =
            "(function(){var p=window.__zenZotero={done:false,translators:[],firstUse:null,tab:null,error:null};var citation=function(t){return /\\/zotero\\.html/.test(t.url||t.pendingUrl||'')};" +
                "try{chrome.tabs.query({},function(tabs){try{var tab=(tabs||[]).filter(citation)[0];if(!tab){p.error='no citation tab among '+(tabs||[]).length;p.done=true;return}p.tab={id:tab.id,active:!!tab.active,url:tab.url||null};" +
                "var info=Zotero.Connector_Browser.getTabInfo(tab.id);p.translators=((info&&info.translators)||[]).map(function(t){return t.label});p.firstUse=!!Zotero.Prefs.get('firstUse');p.done=true}catch(e){p.error=String(e&&e.message||e);p.done=true}})}" +
                "catch(e){p.error=String(e&&e.message||e);p.done=true}return 'asked'})()"
        /**
         * Closing Zotero's first-run notice as its button does, for a notice the emulator's
         * Escape did not reach: the pref the button sets, then the connector's own
         * `_updateExtensionUI` for the citation tab (what the button's handler runs next). The
         * outcome lands on `window.__zenZoteroUpdate`.
         */
        private const val ZOTERO_CLOSE_NOTICE =
            "(function(){var p=window.__zenZoteroUpdate={done:false,error:null};var citation=function(t){return /\\/zotero\\.html/.test(t.url||t.pendingUrl||'')};" +
                "try{Zotero.Prefs.set('firstUse',false);chrome.tabs.query({},function(tabs){try{var tab=(tabs||[]).filter(citation)[0];if(!tab){p.error='no citation tab';p.done=true;return}" +
                "Promise.resolve(Zotero.Connector_Browser._updateExtensionUI(tab)).then(function(){p.done=true},function(e){p.error=String(e&&e.message||e);p.done=true})}catch(e){p.error=String(e&&e.message||e);p.done=true}})}" +
                "catch(e){p.error=String(e&&e.message||e);p.done=true}return 'asked'})()"
        /**
         * The page's view of Zotero's frames: the connector mounts each (the notice among them)
         * as an iframe in a closed shadow root on a bare body-level div, so the page sees only
         * the hosts; their count, and whether the last one is drawn full-screen.
         */
        private const val ZOTERO_NOTICE_HOSTS =
            "(function(){var hosts=Array.prototype.slice.call(document.body?document.body.children:[]).filter(function(e){return e.tagName==='DIV'&&e.attributes.length===0&&e.childNodes.length===0});" +
                "var last=hosts[hosts.length-1];var r=last?last.getBoundingClientRect():null;return JSON.stringify({hosts:hosts.length,last:r?{w:r.width,h:r.height}:null,innerW:innerWidth,innerH:innerHeight})})()"

        /**
         * The first element `__SELECTOR__` matches in the page, when it is drawn: its tag, size
         * and text (its shadow root's when it has one). An extension's UI the click injected.
         */
        /**
         * The element `__SELECTOR__` names, measured; a shadow host that sizes nothing itself (Avast's
         * `div.aosp-class` under `<html>` holds a fixed-position frame in its shadow tree, so the host
         * is 0x0 while the panel shows, as DeepL's trigger was on the desktop) is measured by the
         * largest visible node of its shadow tree, and a frame's text is read from its document when
         * it is ours to read (an `about:blank` frame the script filled).
         */
        private const val INJECTED_UI =
            "(function(){var el=document.querySelector(__SELECTOR__);if(!el)return JSON.stringify({pass:false});" +
                "var visible=function(e){var r=e.getBoundingClientRect();var cs=getComputedStyle(e);return r.width>0&&r.height>0&&cs.visibility!=='hidden'&&cs.display!=='none'?r:null};" +
                "var best=el,rect=visible(el);if(el.shadowRoot){var nodes=el.shadowRoot.querySelectorAll('*');for(var i=0;i<nodes.length;i++){var r=visible(nodes[i]);if(r&&(!rect||r.width*r.height>rect.width*rect.height)){best=nodes[i];rect=r}}}" +
                "var text='';if(best.tagName==='IFRAME'){try{var d=best.contentDocument;text=d&&d.body?String(d.body.innerText||''):''}catch(e){}}" +
                "if(!text)text=String((el.shadowRoot&&el.shadowRoot.textContent)||el.textContent||'');text=text.replace(/\\s+/g,' ').trim();" +
                "return JSON.stringify({pass:!!rect,tag:best.tagName.toLowerCase(),w:rect?Math.round(rect.width):0,h:rect?Math.round(rect.height):0,text:text.slice(0,120),host:el.tagName.toLowerCase(),shadow:!!el.shadowRoot,hostBox:Math.round(el.getBoundingClientRect().width)+'x'+Math.round(el.getBoundingClientRect().height)})})()"

        /**
         * In GoFullPage's popup: whether the FileSystem API it stores captures through is there
         * (`webkitRequestFileSystem`, or the `requestFileSystem` it binds from it), and whether
         * its "Something went wrong" error (`#uh-oh`) is what the popup shows.
         */
        private const val FILESYSTEM_PROBE =
            "(function(){var err=document.getElementById('uh-oh');var shown=!!err&&err.getBoundingClientRect().height>0;" +
                "return JSON.stringify({available:typeof window.webkitRequestFileSystem==='function'||typeof window.requestFileSystem==='function',failed:shown,text:shown?(err.innerText||'').replace(/\\s+/g,' ').trim().slice(0,120):''})})()"

        // --- compat round 5 ---

        /**
         * From an extension page: the shape of `chrome.tabCapture` and `chrome.desktopCapture`,
         * and `tabCapture.getMediaStreamId` asked for the active tab (a stream id, or Chrome's
         * error; a missing function is ours). Lands on `window.__zenCapture`.
         */
        private const val CAPTURE_PROBE =
            "(function(){var tc=chrome.tabCapture,dc=chrome.desktopCapture;var p=window.__zenCapture={done:false,tabCapture:typeof tc,desktopCapture:typeof dc,getMediaStreamId:typeof (tc&&tc.getMediaStreamId),capture:typeof (tc&&tc.capture),getCapturedTabs:typeof (tc&&tc.getCapturedTabs),chooseDesktopMedia:typeof (dc&&dc.chooseDesktopMedia),streamId:null,error:null};" +
                "var finish=function(){p.done=true};setTimeout(function(){if(!p.done){p.error=p.error||'no answer within 8 s';finish()}},8000);var took=function(id){p.streamId=id==null?null:(typeof id+' of '+String(id).length);finish()};" +
                "if(typeof (tc&&tc.getMediaStreamId)!=='function'){p.error='getMediaStreamId is '+p.getMediaStreamId;finish();return 'asked'}" +
                "try{chrome.tabs.query({active:true},function(tabs){var t=tabs&&tabs[0];if(!t){p.error='no active tab';finish();return}" +
                "try{var r=tc.getMediaStreamId({targetTabId:t.id},function(id){if(chrome.runtime.lastError)p.error=String(chrome.runtime.lastError.message);took(id)});if(r&&typeof r.then==='function')r.then(took,function(e){p.error=String(e&&e.message||e);finish()})}catch(e){p.error='threw: '+String(e&&e.message||e);finish()}})}" +
                "catch(e){p.error='threw: '+String(e&&e.message||e);finish()}return 'asked'})()"
        /** From the worker: `action.getBadgeText` for the tab whose URL matches `__MATCH__`. Lands on `window.__zenBadge`. */
        private const val BADGE_PROBE =
            "(function(){var p=window.__zenBadge={done:false,badge:null,tab:null,error:null};try{chrome.tabs.query({},function(tabs){var t=(tabs||[]).filter(function(t){return __MATCH__.test(t.url||t.pendingUrl||'')})[0];" +
                "if(!t){p.error='no fixture tab among '+(tabs||[]).length;p.done=true;return}p.tab=t.id;try{chrome.action.getBadgeText({tabId:t.id},function(b){if(chrome.runtime.lastError)p.error=String(chrome.runtime.lastError.message);p.badge=b==null?null:String(b);p.done=true})}catch(e){p.error=String(e&&e.message||e);p.done=true}})}" +
                "catch(e){p.error=String(e&&e.message||e);p.done=true}return 'asked'})()"
        /** From the worker: `chrome.storage.local` read whole, whether it names the fixture's clip. Lands on `window.__zenStored`. */
        private const val STORAGE_HAS_CLIP =
            "(function(){var p=window.__zenStored={done:false,keys:[],hasClip:false,error:null};try{chrome.storage.local.get(null,function(all){if(chrome.runtime.lastError)p.error=String(chrome.runtime.lastError.message);all=all||{};p.keys=Object.keys(all).slice(0,8);p.hasClip=/clip\\.mp4/.test(JSON.stringify(all));p.done=true})}" +
                "catch(e){p.error=String(e&&e.message||e);p.done=true}return 'asked'})()"
        /** From the worker: `chrome.tts.getVoices`, the count and the first voice's name. Lands on `window.__zenTts`. */
        private const val TTS_VOICES_PROBE =
            "(function(){var p=window.__zenTts={done:false,tts:typeof chrome.tts,voices:null,first:null,error:null};try{chrome.tts.getVoices(function(v){if(chrome.runtime.lastError)p.error=String(chrome.runtime.lastError.message);p.voices=(v||[]).length;p.first=v&&v[0]?v[0].voiceName:null;p.done=true})}" +
                "catch(e){p.error='threw: '+String(e&&e.message||e);p.done=true}setTimeout(function(){if(!p.done){p.error='no answer within 8 s';p.done=true}},8000);return 'asked'})()"
        /** Read Aloud's popup: the sentence it is on (`#highlight`), its status line and which controls are up. */
        private const val READ_ALOUD_STATE =
            "(function(){var vis=function(id){var e=document.getElementById(id);return !!e&&e.offsetParent!==null};var hl=document.getElementById('highlight');var h=((hl&&hl.innerText)||'').replace(/\\s+/g,' ').trim();" +
                "return JSON.stringify({pass:h.length>10,highlight:h.slice(0,140),status:(((document.getElementById('status')||{}).innerText)||'').trim().slice(0,80),play:vis('btnPlay'),pause:vis('btnPause'),stop:vis('btnStop'),loading:vis('imgLoading'),text:document.body?document.body.innerText.replace(/\\s+/g,' ').trim().slice(0,120):''})})()"
        /** Custom Cursor's popup: a pack card (`.collection-cursors .cursor` with an image; a fallback on any drawn card with an image), clicked. */
        private const val CURSOR_PICK =
            "(function(){var visible=function(n){var r=n.getBoundingClientRect();return r.width>20&&r.height>20};var packs=Array.prototype.slice.call(document.querySelectorAll('.collection-cursors .cursor, .collection-cursors > div')).filter(function(n){return visible(n)&&n.querySelector('img')});" +
                "var cards=packs.length?packs:Array.prototype.slice.call(document.querySelectorAll('[class*=\"cursor\"], [class*=\"Cursor\"], [class*=\"item\"], [class*=\"card\"], li')).filter(function(n){return visible(n)&&n.querySelector('img')&&!/logo|header|footer|nav|btn|setting/i.test(n.className)});" +
                "var imgs=Array.prototype.slice.call(document.querySelectorAll('img')).filter(function(i){return visible(i)&&/\\.(png|svg|cur|gif)/i.test(i.src)&&!/logo/i.test(i.src+i.alt+i.className)});var hit=cards[0]||imgs[1]||imgs[0];" +
                "if(!hit)return JSON.stringify({clicked:false,imgs:imgs.length,text:document.body?document.body.innerText.replace(/\\s+/g,' ').trim().slice(0,100):''});var r=hit.getBoundingClientRect();hit.click();" +
                "return JSON.stringify({clicked:true,tag:hit.tagName,cls:String(hit.className).slice(0,50),x:r.left+r.width/2,y:r.top+r.height/2,imgs:imgs.length})})()"
        /**
         * Custom Cursor's CDN as its popup reaches it: one cursor image fetched from the popup (a
         * CORS request of the extension origin, as the pick's `Image` with crossOrigin is), with
         * the status and type it answered, and the pack thumbnails that failed to load.
         */
        private const val CURSOR_CDN_PROBE =
            "(function(){var p=window.__zenCdn={done:false,status:0,type:'',error:null,thumbs:0,thumbsBroken:0};var imgs=Array.prototype.slice.call(document.querySelectorAll('img')).filter(function(i){return /cdn\\.custom-cursor\\.com/.test(i.src)});" +
                "p.thumbs=imgs.length;p.thumbsBroken=imgs.filter(function(i){return i.complete&&i.naturalWidth===0}).length;" +
                "fetch('https://cdn.custom-cursor.com/db/cursor/pointer_6.png',{cache:'no-store'}).then(function(r){p.status=r.status;p.type=r.headers.get('content-type')||'';p.done=true}).catch(function(e){p.error=String(e&&e.message||e);p.done=true});return 'asked'})()"
        /** The fixture page's cursor: Custom Cursor's `<style id="custom-cursor">` and the computed `cursor` of html / body. */
        private const val CURSOR_STYLE =
            "(function(){var st=document.getElementById('custom-cursor');var body=getComputedStyle(document.body).cursor;var html=getComputedStyle(document.documentElement).cursor;" +
                "return JSON.stringify({pass:!!st&&/url\\(/.test(html+body),style:!!st,css:(st?st.textContent:'').slice(0,80),body:body.slice(0,60),html:html.slice(0,60)})})()"
        /** The fixture page after AnyDoc's translate: its markers (classes, data attributes, shadow hosts) and a text sample. */
        private const val ANYDOC_MARKS =
            "(function(){var marks=document.querySelectorAll('[class*=\"anydoc\"], [id*=\"anydoc\"], [data-wps-translate-resize-ignore], [class*=\"wps-translate\"], [data-anydoc-translated], font[class*=\"translat\"], [class*=\"translated\"]');" +
                "var shadow=Array.prototype.filter.call(document.querySelectorAll('*'),function(e){return e.shadowRoot&&/anydoc|translat/i.test(e.tagName+e.id+e.className)});var text=document.body?document.body.innerText:'';" +
                "return JSON.stringify({pass:marks.length>0||shadow.length>0,marks:marks.length,shadowHosts:shadow.length,sample:text.replace(/\\s+/g,' ').trim().slice(0,100)})})()"
        /** Awesome Screenshot's popup, on its Screenshot tab: the "visible part" action, clicked. */
        private const val AWESOME_VISIBLE_CLICK =
            "(function(){var visible=function(n){var r=n.getBoundingClientRect();return r.width>10&&r.height>10};var el=Array.prototype.slice.call(document.querySelectorAll('.action-item.visible, .main-capture-action .visible, .visible')).find(visible);" +
                "if(!el)return JSON.stringify({clicked:false,text:document.body?document.body.innerText.replace(/\\s+/g,' ').trim().slice(0,120):''});var r=el.getBoundingClientRect();el.click();" +
                "return JSON.stringify({clicked:true,label:el.textContent.replace(/\\s+/g,' ').trim().slice(0,40),x:r.left+r.width/2,y:r.top+r.height/2})})()"
        /** An annotator page: a canvas or image over 200 px is the captured picture. */
        private const val ANNOTATOR_IMAGE =
            "(function(){var cs=Array.prototype.slice.call(document.querySelectorAll('canvas')).map(function(c){return {w:c.width,h:c.height}});var imgs=Array.prototype.slice.call(document.querySelectorAll('img')).filter(function(i){return i.naturalWidth>200&&i.naturalHeight>200}).map(function(i){return {w:i.naturalWidth,h:i.naturalHeight}});" +
                "return JSON.stringify({pass:cs.some(function(c){return c.w>200&&c.h>200})||imgs.length>0,canvases:cs.slice(0,3),images:imgs.slice(0,2),title:document.title.slice(0,50),text:document.body?document.body.innerText.replace(/\\s+/g,' ').trim().slice(0,80):''})})()"
        /** A word of the fixture page's text to double-click: its range kept on `window.__zenWord`, its centre in css px. */
        private const val DICTIONARY_WORD =
            "(function(){var walker=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);var node;while((node=walker.nextNode())){var m=/\\b(paragraph|example|fixture|page|content|browser|extension|simple|light|quick|brown|lazy)\\b/i.exec(node.nodeValue);" +
                "if(m&&node.parentElement.offsetParent!==null){var r=document.createRange();r.setStart(node,m.index);r.setEnd(node,m.index+m[0].length);var b=r.getBoundingClientRect();if(b.width>0){window.__zenWord={range:r,x:b.left+b.width/2,y:b.top+b.height/2,word:m[0]};return JSON.stringify({word:m[0],x:b.left+b.width/2,y:b.top+b.height/2})}}}" +
                "var h=document.querySelector('h1, p');var hb=h.getBoundingClientRect();return JSON.stringify({word:h.textContent.trim().split(/\\s+/)[0],x:hb.left+20,y:hb.top+hb.height/2})})()"
        /** The word selected and a `dblclick` (then `mouseup`) dispatched over it, as a double-click of a mouse yields. */
        private const val DICTIONARY_DBLCLICK =
            "(function(){var w=window.__zenWord;if(!w)return 'no word';var sel=getSelection();sel.removeAllRanges();sel.addRange(w.range);var el=w.range.startContainer.parentElement;" +
                "['mousedown','mouseup','click','mousedown','mouseup','click','dblclick'].forEach(function(type,i){el.dispatchEvent(new MouseEvent(type,{bubbles:true,cancelable:true,clientX:w.x,clientY:w.y,detail:i<3?1:2,view:window,button:0}))});return 'dispatched over '+w.word})()"
        /** Google Dictionary's bubble: `#gdx-bubble-host`'s open shadow root, shown, with the query or a meaning. */
        private const val DICTIONARY_BUBBLE =
            "(function(){var host=document.getElementById('gdx-bubble-host');var root=host&&host.shadowRoot;var main=root&&root.querySelector('#gdx-bubble-main');var meaning=(((root&&root.querySelector('#gdx-bubble-meaning'))||{}).textContent||'').replace(/\\s+/g,' ').trim();" +
                "var query=(((root&&root.querySelector('#gdx-bubble-query'))||{}).textContent||'').trim();var shown=!!main&&getComputedStyle(main).display!=='none'&&host.getBoundingClientRect().width>0;" +
                "return JSON.stringify({pass:shown&&(meaning.length>0||query.length>0),host:!!host,shown:shown,query:query.slice(0,30),meaning:meaning.slice(0,120),selection:String(getSelection()).trim().slice(0,30)})})()"

        // --- compat round 6 ---------------------------------------------------------------------

        /**
         * [CLICK_LABEL] that also keeps the control it hit on `window.__zenClickTarget`, so
         * [CLICK_TARGET_SYNTH] can send it a pointer's full event sequence when its `click()` and
         * the tap at its centre both left the extension unmoved (a popup drawn by a framework that
         * listens to `pointerdown` / `mousedown`, not `click`).
         */
        private const val CLICK_TARGET =
            "(function(){var re=__RE__;var visible=function(n){var r=n.getBoundingClientRect();return r.width>10&&r.height>10};" +
                "var label=function(e){return ((e.getAttribute&&(e.getAttribute('aria-label')||e.getAttribute('title')))||e.value||e.textContent||'').replace(/\\s+/g,' ').trim()};var cands=[];" +
                "var walk=function(root){var all=root.querySelectorAll('button, a, [role=button], [role=menuitem], [role=option], input[type=button], input[type=submit], label, div, span, li, p, option');for(var i=0;i<all.length;i++){var e=all[i];var l=label(e);if(l.length>0&&l.length<60&&re.test(l)&&(visible(e)||e.tagName==='OPTION'))cands.push(e);if(e.shadowRoot)walk(e.shadowRoot)}};" +
                "if(document.body)walk(document.body);var leaves=cands.filter(function(e){return !cands.some(function(o){return o!==e&&e.contains(o)})});" +
                "var hit=cands.find(function(e){return /^(BUTTON|A|INPUT)$/.test(e.tagName)||/^(button|menuitem|option)$/.test(e.getAttribute('role')||'')})||leaves[0]||null;window.__zenClickTarget=hit;" +
                "if(!hit)return JSON.stringify({clicked:false,text:document.body?document.body.innerText.replace(/\\s+/g,' ').trim().slice(0,100):''});var r=hit.getBoundingClientRect();try{hit.click()}catch(e){}" +
                "return JSON.stringify({clicked:true,label:label(hit).slice(0,40),tag:hit.tagName,x:r.left+r.width/2,y:r.top+r.height/2})})()"
        /** The pointer's sequence (`pointerdown`, `mousedown`, `pointerup`, `mouseup`, `click`) at the centre of the control [CLICK_TARGET] kept. */
        private const val CLICK_TARGET_SYNTH =
            "(function(){var el=window.__zenClickTarget;if(!el)return 'no target';var r=el.getBoundingClientRect();var o={bubbles:true,cancelable:true,composed:true,clientX:r.left+r.width/2,clientY:r.top+r.height/2,button:0,buttons:1,pointerId:1,pointerType:'mouse',isPrimary:true,view:window};" +
                "try{el.dispatchEvent(new PointerEvent('pointerdown',o));el.dispatchEvent(new MouseEvent('mousedown',o));o.buttons=0;el.dispatchEvent(new PointerEvent('pointerup',o));el.dispatchEvent(new MouseEvent('mouseup',o));el.dispatchEvent(new MouseEvent('click',o));return 'dispatched on '+el.tagName}catch(e){return 'threw: '+String(e&&e.message||e)}})()"
        /**
         * The extension's elements on the page: every element (through open shadow roots) whose
         * tag, id or class matches `__PATTERN__` (a regex source, case-insensitive), the ones drawn
         * counted apart; `pass` when there is at least one.
         */
        /** The pop-up fixture after the tap: what `window.open` answered (`window`, `fake`, `null`), Poper Blocker's toast, its page script's `window.open` replacement. */
        private const val POPUP_BLOCK_REPORT =
            "(function(){var r=window.__popupResult||'';var toast=document.getElementById('pb-toast-main')||document.querySelector('[id^=\"pb-toast\"], [class*=\"pb-toast\"], iframe[src*=\"bkkbcggnhapdmkeljlodobbkopceiche\"]');" +
                "var src=String(window.open);var native=/\\[native code\\]/.test(src);var orig=typeof window.originalOpenFunction;" +
                "return JSON.stringify({pass:r==='fake'||!!toast,result:r,toast:!!toast,toastTag:toast?(toast.tagName+' '+(toast.id||'')).trim():'',scriptInPage:!native||orig==='function',openIsNative:native,log:(window.__popupLog||[]).slice(-3)})})()"
        /** An image downloader's list: how many images it shows and how many of them are the gallery fixture's `photo-N.png` (through open shadow roots). */
        private const val IMAGE_LIST_REPORT =
            "(function(){var imgs=[];var walk=function(root){var all=root.querySelectorAll('img, [style*=\"background-image\"]');for(var i=0;i<all.length;i++){var e=all[i];var s=e.currentSrc||e.src||(e.style&&e.style.backgroundImage)||'';imgs.push(String(s));if(e.shadowRoot)walk(e.shadowRoot)}var rest=root.querySelectorAll('*');for(var j=0;j<rest.length;j++){if(rest[j].shadowRoot)walk(rest[j].shadowRoot)}};if(document.documentElement)walk(document.documentElement);" +
                "var photos=imgs.filter(function(s){return /photo-\\d\\.png/.test(s)}).length;var text=document.body?document.body.innerText.replace(/\\s+/g,' ').trim():'';" +
                "return JSON.stringify({pass:photos>=4,photos:photos,images:imgs.length,text:text.slice(0,160),title:document.title.slice(0,40)})})()"
        /** The body's computed background as a colour and its relative luminance (white 1.0), with a count of the page's foreign elements. */
        private const val LUMINANCE_REPORT =
            "(function(){var bg=getComputedStyle(document.body).backgroundColor;var html=getComputedStyle(document.documentElement).backgroundColor;var pick=function(c){var m=/rgba?\\((\\d+),\\s*(\\d+),\\s*(\\d+)(?:,\\s*([\\d.]+))?\\)/.exec(c||'');if(!m)return null;if(m[4]!==undefined&&parseFloat(m[4])===0)return null;var f=function(v){v=parseInt(v,10)/255;return v<=0.03928?v/12.92:Math.pow((v+0.055)/1.055,2.4)};return 0.2126*f(m[1])+0.7152*f(m[2])+0.0722*f(m[3])};" +
                "var l=pick(bg);var src=bg;if(l===null){l=pick(html);src=html}if(l===null){l=1;src='transparent'}var injected=document.querySelectorAll('[id*=\"dark\"], [class*=\"dark\"], style[id], html[data-theme], [data-darkmode]').length;" +
                "return JSON.stringify({pass:l<0.5,luminance:Math.round(l*100)/100,background:src,injected:injected,filter:getComputedStyle(document.documentElement).filter})})()"
        private const val INJECTED_ANY =
            "(function(){var re=new RegExp(__PATTERN__,'i');var found=[];var shown=0;var walk=function(root){var all=root.querySelectorAll('*');for(var i=0;i<all.length;i++){var e=all[i];var key=e.tagName+' '+(e.id||'')+' '+(typeof e.className==='string'?e.className:'');" +
                "if(re.test(key)){found.push(key.replace(/\\s+/g,' ').trim().slice(0,40));var r=e.getBoundingClientRect();if(r.width>0&&r.height>0)shown++}if(e.shadowRoot)walk(e.shadowRoot)}};if(document.documentElement)walk(document.documentElement);" +
                "return JSON.stringify({pass:found.length>0,n:found.length,visible:shown,tags:found.slice(0,6)})})()"
        /** A live page that is not serving the runner: a challenge, a refusal, a block page. */
        // Amazon's interstitial for an automated visitor ("Click the button below to continue
        // shopping") is a challenge page too: the product page behind it never reaches Keepa.
        private val CHALLENGE_WORDS = Regex("access denied|captcha|unusual traffic|verify (that )?you are|not a robot|attention required|just a moment|checking your browser|enable javascript|rate limit|error 403|forbidden|service unavailable|temporarily unavailable|something went wrong|blocked|continue shopping", RegexOption.IGNORE_CASE)
        /** DeepL: the Spanish phrase selected by script with the events a mouse's selection ends in (`mouseup`, `selectionchange`). */
        private const val DEEPL_SELECT =
            "(function(){var el=document.getElementById('phrase')||document.querySelector('p');if(!el)return 'no phrase';var r=document.createRange();r.selectNodeContents(el);var sel=getSelection();sel.removeAllRanges();sel.addRange(r);var b=r.getBoundingClientRect();" +
                "var o={bubbles:true,cancelable:true,clientX:b.right-2,clientY:b.top+b.height/2,button:0,view:window};el.dispatchEvent(new MouseEvent('mousedown',o));el.dispatchEvent(new MouseEvent('mouseup',o));document.dispatchEvent(new Event('selectionchange'));" +
                "return 'selected '+String(sel).trim().slice(0,40)})()"
        /**
         * DeepL's inline trigger (`deepl-inline-trigger`, a shadow host whose own box is 0x0 while
         * its shadow content shows): the shadow content's centre, as the desktop's grader measures.
         */
        private const val DEEPL_TRIGGER =
            "(function(){var host=document.querySelector('deepl-inline-trigger, [class*=\"deepl-inline-trigger\"], [id*=\"deepl\"]');if(!host)return JSON.stringify({pass:false,hosts:document.querySelectorAll('[class*=\"deepl\"], [id*=\"deepl\"]').length,selection:String(getSelection()).trim().slice(0,30)});" +
                "var box=host.getBoundingClientRect();var inner=host.shadowRoot?Array.prototype.slice.call(host.shadowRoot.querySelectorAll('*')).map(function(e){return e.getBoundingClientRect()}).filter(function(r){return r.width>4&&r.height>4})[0]:null;var r=inner||box;" +
                "return JSON.stringify({pass:r.width>4&&r.height>4,x:r.left+r.width/2,y:r.top+r.height/2,w:r.width,h:r.height,tag:host.tagName,hostBox:Math.round(box.width)+'x'+Math.round(box.height),shadow:!!host.shadowRoot})})()"
        /** A script's click on the trigger's shadow content (its host's box is 0x0). */
        private const val DEEPL_CLICK =
            "(function(){var host=document.querySelector('deepl-inline-trigger');if(!host)return 'no trigger';var target=host.shadowRoot?Array.prototype.slice.call(host.shadowRoot.querySelectorAll('button, [role=button], div, span')).find(function(e){var r=e.getBoundingClientRect();return r.width>4&&r.height>4}):null;var el=target||host;" +
                "var r=el.getBoundingClientRect();var o={bubbles:true,cancelable:true,composed:true,clientX:r.left+r.width/2,clientY:r.top+r.height/2,button:0,view:window};el.dispatchEvent(new PointerEvent('pointerdown',o));el.dispatchEvent(new MouseEvent('mousedown',o));el.dispatchEvent(new PointerEvent('pointerup',o));el.dispatchEvent(new MouseEvent('mouseup',o));el.dispatchEvent(new MouseEvent('click',o));return 'clicked '+el.tagName})()"
        /**
         * DeepL's translation popover (`deepl-inline-translate` / `deepl-inline-popover`, shadow
         * hosts): its text, `pass` on a translation – text longer than a few words that is not the
         * Spanish source and holds an English word of it ("good morning", "friend", "weather", "walk").
         */
        private const val DEEPL_TRANSLATION =
            "(function(){var hosts=Array.prototype.slice.call(document.querySelectorAll('deepl-inline-translate, deepl-inline-popover, deepl-inline-translation, [class*=\"deepl-inline-translate\"], [class*=\"deepl-popover\"], [class*=\"deepl-inline-popover\"]'));" +
                "var text=function(root){var parts=[];var it=document.createNodeIterator(root,NodeFilter.SHOW_TEXT);var n;while((n=it.nextNode())){var p=n.parentNode;if(p&&/^(SCRIPT|STYLE)$/.test(p.nodeName))continue;var t=n.textContent.replace(/\\s+/g,' ').trim();if(t)parts.push(t)}var all=root.querySelectorAll('*');for(var i=0;i<all.length;i++)if(all[i].shadowRoot)parts.push(text(all[i].shadowRoot));return parts.join(' ')};" +
                "var t=hosts.map(function(h){return text(h.shadowRoot||h)}).join(' ').replace(/\\s+/g,' ').trim();var english=/good morning|friend|weather|walk|today|nice|fine/i.test(t);var status=/translat|loading|error|sign in|log in|limit/i.test(t)?t.match(/translat[a-z]*|loading|error|sign in|log in|limit/i)[0]:null;" +
                "return JSON.stringify({pass:hosts.length>0&&english&&t.length>12,hosts:hosts.length,tags:hosts.map(function(h){return h.tagName}).slice(0,3),text:t.slice(0,160),status:status})})()"
        /**
         * Google Input Tools' options page: Hindi transliteration added to the selected input
         * tools. The page is a Closure UI: a list (select or listbox) of the available tools, an
         * arrow to add the selected one, a list of the selected. Every shape it has had is tried:
         * an `<option>` whose text says Hindi selected then the add control clicked, or a list
         * item that says Hindi clicked then the add control, or a Hindi entry that adds on click.
         * `pass` when a selected-side element says Hindi afterwards.
         */
        private const val INPUT_TOOLS_ADD =
            "(function(){var hindi=/hindi|\\u0939\\u093f(\\u0928|\\u0902)\\u0926\\u0940/i;var label=function(e){return ((e.getAttribute&&(e.getAttribute('aria-label')||e.getAttribute('title')))||e.value||e.textContent||'').replace(/\\s+/g,' ').trim()};var shown=function(e){var r=e.getBoundingClientRect();return r.width>0&&r.height>0};" +
                "var selectedSide=function(){var els=Array.prototype.slice.call(document.querySelectorAll('select, [role=listbox], ul, ol, table, div'));var right=els.filter(function(e){return shown(e)&&/selected|chosen|enabled|active|right|second/i.test(e.id+' '+e.className+' '+(e.getAttribute('aria-label')||''))});" +
                "return right.some(function(e){return hindi.test(e.textContent||Array.prototype.map.call(e.options||[],function(o){return o.text}).join(' '))})};" +
                "if(selectedSide())return JSON.stringify({pass:true,how:'already'});var picked=null;var opts=Array.prototype.slice.call(document.querySelectorAll('option'));var opt=opts.find(function(o){return hindi.test(o.text)&&!/transliteration.*keyboard|keyboard/i.test(o.text)})||opts.find(function(o){return hindi.test(o.text)});" +
                "if(opt){opt.selected=true;opt.parentNode.dispatchEvent(new Event('change',{bubbles:true}));opt.dispatchEvent(new MouseEvent('dblclick',{bubbles:true}));picked='option '+opt.text.slice(0,30)}" +
                "else{var items=Array.prototype.slice.call(document.querySelectorAll('li, [role=option], [role=listitem], tr, div, span')).filter(function(e){return shown(e)&&hindi.test(label(e))&&label(e).length<60});var leaf=items.filter(function(e){return !items.some(function(o){return o!==e&&e.contains(o)})})[0];if(leaf){leaf.click();picked='item '+label(leaf).slice(0,30)}}" +
                "var add=Array.prototype.slice.call(document.querySelectorAll('button, a, [role=button], input[type=button], div, span, img')).filter(shown).find(function(e){var l=label(e)+' '+(e.id||'')+' '+(e.className||'')+' '+(e.getAttribute('alt')||'');return /^(add|>>|>|\\u2192|\\u25b6|\\u25ba)$|add|arrow-?right|to-?right|moveRight|move-right/i.test(l)&&!/remove|left|delete/i.test(l)});" +
                "if(add)add.click();return JSON.stringify({pass:selectedSide(),picked:picked,add:add?(label(add)||add.id||add.className||add.tagName).slice(0,30):null,selects:document.querySelectorAll('select').length,options:opts.length,text:document.body?document.body.innerText.replace(/\\s+/g,' ').trim().slice(0,120):''})})()"
        /**
         * Google Input Tools on the editor: Devanagari in the textarea (a transliteration of what
         * was typed), or its candidate window (`ita-` classes / ids) drawn on the page.
         */
        private const val INPUT_TOOLS_RESULT =
            "(function(){var e=document.getElementById('editor');var v=e?e.value:'';var candidates=document.querySelectorAll('[class*=\"ita-\"], [id*=\"ita-\"], [class*=\"ita_\"], [id*=\"ita_\"], [class*=\"gwt-\"], iframe[src*=\"mclkkofklkfljcocdinagocijmpgbhab\"]');var shown=Array.prototype.filter.call(candidates,function(c){var r=c.getBoundingClientRect();return r.width>0&&r.height>0});" +
                "var deva=/[\\u0900-\\u097F]/.test(v);return JSON.stringify({pass:deva,value:v.replace(/\\s+/g,' ').trim().slice(-40),devanagari:deva,candidates:candidates.length,candidatesShown:shown.length,active:document.activeElement?document.activeElement.id||document.activeElement.tagName:null})})()"
        /** The video fixture's picture-in-picture state. */
        private const val PIP_STATE =
            "(function(){var v=document.getElementById('clip')||document.querySelector('video');return JSON.stringify({pass:!!document.pictureInPictureElement,enabled:!!document.pictureInPictureEnabled,paused:v?v.paused:null,readyState:v?v.readyState:null,disablePip:v?v.disablePictureInPicture:null,event:window.__pip||null,state:(document.getElementById('state')||{}).textContent||''})})()"
        /** Immersive Translate's translations on the page: its target wrappers, with text. */
        private const val IMMERSIVE_TRANSLATED =
            "(function(){var w=document.querySelectorAll('.immersive-translate-target-wrapper, [class*=\"immersive-translate-target\"], font.immersive-translate-target-inner, [data-immersive-translate-walked] [class*=\"target\"]');var texts=Array.prototype.map.call(w,function(e){return (e.textContent||'').replace(/\\s+/g,' ').trim()}).filter(function(t){return t.length>2});" +
                "var walked=document.querySelectorAll('[data-immersive-translate-walked], [data-immersive-translate-paragraph]').length;return JSON.stringify({pass:texts.length>0,wrappers:w.length,walked:walked,sample:texts.slice(0,2).join(' | ').slice(0,120),english:/good morning|friend|weather|walk|test page/i.test(texts.join(' '))})})()"
        /** A pointer over the first paragraph, as WhatFont's inspector follows. */
        private const val WHATFONT_HOVER =
            "(function(){var p=document.querySelector('p')||document.body;var r=p.getBoundingClientRect();var o={bubbles:true,cancelable:true,composed:true,clientX:r.left+Math.min(40,r.width/2),clientY:r.top+r.height/2,view:window};" +
                "['pointerover','pointerenter','mouseover','mouseenter','pointermove','mousemove'].forEach(function(t){p.dispatchEvent(/^pointer/.test(t)?new PointerEvent(t,o):new MouseEvent(t,o))});return 'hovered '+p.tagName})()"
        /**
         * WhatFont's tip: its elements' text (a font family name), through shadow roots. Its 3.2.0 mounts
         * `<div id="what-font-ext-container">` on the body (React in a shadow root under it), a hyphen the
         * first spelling of the pattern did not allow: the tool was up in the final run's still and read F.
         */
        private const val WHATFONT_READ =
            "(function(){var re=/what-?font|wf_|wfont|__wf|wf-/i;var texts=[];var walk=function(root){var all=root.querySelectorAll('*');for(var i=0;i<all.length;i++){var e=all[i];var key=e.tagName+' '+(e.id||'')+' '+(typeof e.className==='string'?e.className:'');if(re.test(key)){var t=(e.textContent||'').replace(/\\s+/g,' ').trim();if(t.length>1)texts.push(t.slice(0,80))}if(e.shadowRoot)walk(e.shadowRoot)}};walk(document.documentElement);" +
                "var joined=texts.join(' | ');var font=/roboto|system-ui|sans-serif|serif|arial|helvetica|noto|droid|inter|segoe|times|georgia|monospace|[a-z]+ ?(sans|serif|mono)/i.test(joined);return JSON.stringify({pass:font,n:texts.length,text:joined.slice(0,160)})})()"
        /** Wappalyzer's popup: the technologies it lists, the fixture's expected ones named. */
        private const val TECH_LIST =
            "(function(){var t=document.body?document.body.innerText.replace(/\\s+/g,' ').trim():'';var links=Array.prototype.map.call(document.querySelectorAll('a[href*=\"wappalyzer.com/technologies\"], .technology, .detection, [class*=\"technology\"]'),function(a){return (a.textContent||'').replace(/\\s+/g,' ').trim()}).filter(Boolean);" +
                "var want=['WordPress','jQuery','Bootstrap','React','Google Analytics','Google Tag Manager','Google Font API','Google Hosted Libraries','jsDelivr'];var found=want.filter(function(w){return new RegExp(w.replace(/ /g,'\\\\s*'),'i').test(t)});" +
                "return JSON.stringify({pass:found.length>=2,found:found,links:links.slice(0,8),text:t.slice(0,200)})})()"
        /** Google Scholar Button's popup: results (`.gs_r` rows, "Cited by" links) or the service's word. */
        private const val SCHOLAR_RESULTS =
            "(function(){var t=document.body?document.body.innerText.replace(/\\s+/g,' ').trim():'';var rows=document.querySelectorAll('.gs_r, .gs_ri, .gs_rt, [class*=\"gs_r\"], a[href*=\"scholar.google\"], a[href*=\"cites=\"]');" +
                "return JSON.stringify({pass:rows.length>0||/cited by|\\bcitations?\\b|\\[PDF\\]|\\[HTML\\]/i.test(t),n:rows.length,text:t.slice(0,200),iframes:document.querySelectorAll('iframe').length})})()"
        /** Tag Assistant's panel page: the tagassistant.google.com frame it embeds, with its size. */
        private const val TA_PANEL =
            "(function(){var f=Array.prototype.slice.call(document.querySelectorAll('iframe')).map(function(i){var r=i.getBoundingClientRect();return {src:(i.src||'').slice(0,80),w:Math.round(r.width),h:Math.round(r.height)}});var ta=f.find(function(x){return /tagassistant\\.google\\.com/.test(x.src)&&x.w>100&&x.h>100});" +
                "return JSON.stringify({pass:!!ta,w:ta?ta.w:0,h:ta?ta.h:0,src:ta?ta.src:null,frames:f.slice(0,3),text:document.body?document.body.innerText.replace(/\\s+/g,' ').trim().slice(0,120):''})})()"
    }
}
