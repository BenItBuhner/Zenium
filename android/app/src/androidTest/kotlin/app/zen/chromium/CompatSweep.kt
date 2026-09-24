package app.zen.chromium

import android.content.Intent
import android.graphics.Rect
import android.os.Debug
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import android.view.Choreographer
import android.view.InputDevice
import android.view.KeyEvent
import android.view.MotionEvent
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
import app.zen.chromium.blocking.ListenerOptions
import app.zen.chromium.blocking.WebRequestEvent
import app.zen.chromium.blocking.WebRequestListener
import app.zen.chromium.ext.ExtensionUrls
import app.zen.chromium.ext.ExtensionWebView
import app.zen.chromium.ext.Extensions
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
    private val mainThread = MainThreadWatch()
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
    /** Each row boundary a native sheet was still up at, with the sheet's texts and what a back left ([dismissSheets]). */
    private val sheetsDismissed = JSONArray()

    private class Grade(val verdict: String, val note: String, val extra: JSONObject? = null)

    /** An `identity.launchWebAuthFlow` sheet of the row's, up on the provider's page (`accountGate`). */
    private class AuthSheet(val url: String)

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
        mainThread.start()
        try {
            runDemo()
        } finally {
            mainThread.stop()
            memory.stop()
            results.put("mainThreadWatch", mainThread.report())
            results.put("appProcessMemory", memory.report())
            results.put("promptsAnsweredByCommand", promptsAnsweredByCommand)
            results.put("screenRestored", screenRestored)
            results.put("sheetsDismissed", sheetsDismissed)
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
        val state = coreSnapshot()
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
            mainThread.row = "${index + 1} ${row.name}"
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
            rowEntry = entry
            val started = SystemClock.uptimeMillis()
            val refusedBefore = host.chrome.bridge.refused.get()
            val guardBefore = host.extensions.floodGuardCounts()
            try {
                // A row's core check is read off a page on screen: the browser back in front first,
                // and no sheet of another extension's over it (the boundary after the last row
                // took them down; this is the check that nothing came up since).
                onScreen("before ${row.name}")
                dismissSheets(entry, "before ${row.name}")
                sweep(index + 1, row, entry)
            } catch (e: Throwable) {
                Log.e(TAG, "${row.name}: the sweep threw", e)
                entry.put("crash", e.toString())
            } finally {
                runCatching { cleanup(row, entry) }.onFailure { entry.put("cleanupError", it.toString()) }
                entry.put("ms", SystemClock.uptimeMillis() - started)
                entry.put("pssKbAfter", Debug.getPss())
                entry.put("heapAfterKb", heapKb())
                // Calls the chrome's bridge refused at its queue limit during the row (`JsBridge`): 0 unless
                // an extension's message storm outran the main thread.
                entry.put("bridgeRefused", host.chrome.bridge.refused.get() - refusedBefore)
                // The page-to-host flood guard (`ext/BridgeForward.kt`) during the row: messages it
                // forwarded to the core, action updates folded into a newer one, action updates dropped
                // and messages refused at its pending bound. All but the first are 0 unless the
                // extension's pages sent faster than the browser draws.
                val guard = host.extensions.floodGuardCounts()
                entry.put(
                    "floodGuard",
                    JSONObject()
                        .put("forwarded", guard[0] - guardBefore[0])
                        .put("superseded", guard[1] - guardBefore[1])
                        .put("dropped", guard[2] - guardBefore[2])
                        .put("refused", guard[3] - guardBefore[3])
                )
                entry.put("grade", listOf("background", "popup", "options", "core").joinToString("/") { entry.optJSONObject(it)?.optString("verdict") ?: "?" })
                Log.i(
                    TAG,
                    "ROW ${row.name}: install=${entry.optJSONObject("install")?.optString("verdict")} ${entry.optString("grade")}; " +
                        "heap enabled ${entry.optLong("heapEnabledKb", -1) / 1024} MB, after ${entry.optLong("heapAfterKb") / 1024} MB, " +
                        "bridge refused ${entry.optInt("bridgeRefused")}; flood guard ${entry.optJSONObject("floodGuard")}" +
                        (entry.optJSONObject("coreStall")?.let { "; core stall $it" } ?: "")
                )
                rowEntry = null
                write()
            }
        }
        results.put("dialogsDismissed", dialogsDismissed)
        // Every row installed (and disabled) on the management page.
        runCatching {
            coreCall("urlbar.runCommand", """{"action":"addons.open"}""")
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
        coreCall("extension.setEnabled", JSONObject().put("id", id).put("enabled", true).toString())
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
            runCatching { activeCoreTab(coreSnapshot()) }.getOrNull()?.takeIf { ExtensionUrls.present(it.optString("url")).startsWith(url) }
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
        memory.mark()
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
                coreCall("extension.setEnabled", JSONObject().put("id", row.id).put("enabled", true).toString())
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
        // An action the extension disabled for the tab (`chrome.action.disable()`: Chrome grays
        // the button and a click opens nothing) has no popup to open until the extension enables
        // it again – Redux DevTools does so on a page it finds a store in (run 35787391495 waited
        // 30 s for a sheet Chrome would not have shown either).
        val actionState = extensionAction(row.id)
        if (actionState != null && actionState.has("enabled") && !actionState.optBoolean("enabled", true)) {
            stage(
                entry, "popup", "-",
                "the extension disabled its action for this tab (chrome.action.disable(); Chrome grays the button and a click opens nothing), so there is no popup to open here (declared=$declared)",
                JSONObject().put("declared", declared ?: JSONObject.NULL).put("action", actionState)
            )
            return
        }
        val tabsBefore = tabUrls().keys
        val activeBefore = activeCoreTab(coreSnapshot())?.optString("id")
        coreCall("extension.openPopup", """{"id":${JSONObject.quote(row.id)},"anchor":{"x":0,"y":0,"width":0,"height":0}}""")
        // The sheet the click brought up: the popup, or the side panel an action without a popup
        // opens from `onClicked` (Image Downloader's `sidePanel.open`), the extension's answer as
        // Chrome shows it. A tab the click opened is watched for meanwhile, with the URL it was
        // first seen on (Boomerang's popup.html opens Gmail's compose URL and closes itself; the
        // tab lands on Google's sign-in or, on 156, on workspace.google.com – the click's answer
        // is the URL it asked for): once a tab is up and no sheet follows it within
        // [POPUP_AFTER_TAB_MS], the popup document opened it and closed itself, or the action
        // fired `onClicked`, and no sheet is coming.
        var openedFirst: Pair<String, String>? = null
        var openedAt = 0L
        var view: ExtensionWebView? = null
        val sheetDeadline = SystemClock.uptimeMillis() + POPUP_TIMEOUT_MS
        while (SystemClock.uptimeMillis() < sheetDeadline) {
            val v = popupView()
            if (v != null && (v.context == "popup" || (runtimePopup == null && v.context == "sidePanel")) && rendered(v)) {
                view = v
                break
            }
            if (openedFirst == null) {
                tabUrls().entries.firstOrNull { it.key !in tabsBefore }?.let {
                    openedFirst = it.key to it.value
                    openedAt = SystemClock.uptimeMillis()
                }
            } else if (v == null && SystemClock.uptimeMillis() - openedAt > POPUP_AFTER_TAB_MS) {
                break
            }
            SystemClock.sleep(400)
        }
        SystemClock.sleep(1_800)
        snap("$slug-popup")
        val live = popupView()
        val detail = JSONObject().put("declared", declared ?: JSONObject.NULL).put("runtimePopup", runtimePopup ?: JSONObject.NULL)
        view?.let { detail.put("surface", it.context) }
        openedFirst?.let { detail.put("openedFirstSeen", it.second) }
        if (live != null) {
            detail.put("console", JSONArray(consoleOf(live).takeLast(20)))
            detail.put("dom", json(tabEval(live, DOM_REPORT)))
            detail.put("sheet", sheetSize(live))
            // The popup's own sender-side counters (its store subscriptions' traffic to the host).
            detail.put("flow", json(tabEval(live, FLOW_REPORT)))
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
                    (if (view.context == "sidePanel") "no popup (the extension emptied it with action.setPopup); the click fired action.onClicked, which opened its side panel: " else "") +
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
                val activeNow = activeCoreTab(coreSnapshot())
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
                    // The document reads empty to a script: what the sheet shows decides (a
                    // closed shadow root on the body, Click&Clean's menu).
                    val seen = seenInView(live)
                    detail.put("seen", seen)
                    if (shownDespiteEmptyDom(seen)) {
                        val labels = seen.optJSONArray("labels")?.let { l -> (0 until l.length()).map { l.optString(it) } } ?: emptyList()
                        val uncaught = consoleOf(live).filter(::isUncaught)
                        entry.put("popupText", labels.joinToString(" "))
                        stage(
                            entry, "popup",
                            if (uncaught.isEmpty()) "P" else "PARTIAL",
                            "the document reads empty to a script (its UI is in a closed shadow root) and the sheet shows it: ${seen.optInt("nodes")} accessibility nodes, labels \"${labels.joinToString(" ").take(80)}\"" +
                                (if (uncaught.isNotEmpty()) "; uncaught: ${uncaught.take(2).joinToString(" | ") { it.take(160) }}" else ""),
                            detail
                        )
                    } else stage(entry, "popup", "PARTIAL", "the sheet came up but its document stayed empty after ${POPUP_TIMEOUT_MS / 1000} s: ${dom.toString().take(200)}; console: ${detail.optJSONArray("console")?.toString()?.take(200)}", detail)
                } else if (answered.any { extensionPage(it, row.id) }) {
                    // The popup opened, opened a page of the extension's own in a tab and closed
                    // itself (Keplr's `register.html` for an empty wallet, as a fresh Chrome
                    // profile shows it): the page is the popup's answer.
                    val page = answered.first { extensionPage(it, row.id) }
                    entry.put("popupOpened", JSONArray(answered))
                    stage(entry, "popup", "P", "the popup opened ${page.take(160)} in a tab and closed itself (no sheet left within ${POPUP_TIMEOUT_MS / 1000} s)", detail)
                } else if (opened.isNotEmpty()) {
                    // The popup opened a page elsewhere in a tab and closed itself (Boomerang's
                    // popup.html sends the click to Gmail's compose URL): the tab is the popup's
                    // answer, as Chrome shows it. The URL the tab was first seen on leads (the
                    // click's own destination, before the site's redirect), for the core stage's
                    // account gate to read.
                    val first = openedFirst?.second?.takeIf { it.isNotEmpty() }
                    val urls = (listOfNotNull(first) + opened).distinct()
                    entry.put("popupOpened", JSONArray(urls))
                    if (row.account) openedPage(row, opened[0])?.let { entry.put("popupOpenedPage", it) }
                    stage(
                        entry, "popup", "P",
                        "the popup opened ${(first ?: opened[0]).take(160)} in a tab and closed itself" +
                            (if (first != null && first != opened[0]) " (the tab then landed on ${opened[0].take(120)})" else "") +
                            " (no sheet within ${POPUP_AFTER_TAB_MS / 1000} s of the tab)",
                        detail
                    )
                } else {
                    stage(entry, "popup", "F", "no popup sheet within ${POPUP_TIMEOUT_MS / 1000} s (runtime popup=${runtimePopup ?: "null"}, declared=$declared, tabs opened=${opened.size})", detail)
                }
            }
        }
        coreCall("extension.closePopup", "null")
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
        coreCall("extension.openOptions", """{"id":${JSONObject.quote(row.id)}}""")
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
            val seen = sheet?.let(::seenInView)
            if (sheet != null && seen != null && shownDespiteEmptyDom(seen)) {
                // The document reads empty to a script but the sheet shows the page (a closed shadow root).
                detail.put("seen", seen)
                val labels = seen.optJSONArray("labels")?.let { l -> (0 until l.length()).map { l.optString(it) } } ?: emptyList()
                val uncaught = consoleOf(sheet).filter(::isUncaught)
                stage(
                    entry, "options",
                    if (uncaught.isEmpty()) "P" else "PARTIAL",
                    "in a sheet: the document reads empty to a script (its UI is in a closed shadow root) and the sheet shows it: ${seen.optInt("nodes")} accessibility nodes, labels \"${labels.joinToString(" ").take(80)}\"" +
                        (if (uncaught.isNotEmpty()) "; uncaught: ${uncaught.take(2).joinToString(" | ") { it.take(160) }}" else ""),
                    detail
                )
                coreCall("extension.closePopup", "null")
                SystemClock.sleep(900)
                closeExtraTabs()
                return
            }
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
        coreCall("extension.closePopup", "null")
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
        backgroundView(row.id)?.let { bg ->
            entry.put("backgroundConsoleAtEnd", JSONArray(consoleOf(bg).takeLast(30)))
            // The background's sender-side flow counters (Trust Wallet's store broadcasts to its
            // popup go this way): what its bursts met at the page, before the Java side.
            entry.put("backgroundFlow", json(tabEval(bg, FLOW_REPORT)))
        }
    }

    /**
     * Tabs the extension opened go, the extension is disabled: the next row starts from the same
     * place. Each step stands on its own, the disable first among what the chrome has to answer:
     * a row whose command timed out (Tampermonkey's popup close on the 156 job) left its
     * extension enabled when the tab close before the disable threw, and its install page and
     * tampermonkey.net tabs stood in Violentmonkey's row. Last, every native sheet still over
     * the browser goes ([dismissSheets]): the extension is detached by then, so nothing of its
     * can put one back, and the next row's captures start from the browser alone.
     */
    private fun cleanup(row: Row, entry: JSONObject) {
        if (!chromeAnswers()) Log.w(TAG, "${row.name} cleanup: the chrome is not answering")
        // The row's own memory peaks (install to here): the Java heap its popup stage climbed to.
        entry.put("memoryRow", memory.rowReport())
        runCatching { coreCall("extension.closePopup", "null") }
        val installed = runCatching { extensions().firstOrNull { it.getString("id") == row.id } }
        val enabled = installed.getOrNull()?.getBoolean("enabled") ?: installed.isFailure
        if (enabled) {
            runCatching {
                coreCall("extension.setEnabled", JSONObject().put("id", row.id).put("enabled", false).toString())
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
        runCatching { dismissSheets(entry, "after ${row.name}") }.onFailure { entry.put("dismissSheetsError", it.toString()) }
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
        coreCall("extension.setAllowUserScripts", JSONObject().put("id", row.id).put("allowed", true).toString())
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
                    "var isInstall=function(n){return /^(install|install script|confirm installation)$/i.test(label(n))&&visible(n)};" +
                    "var buttons=Array.prototype.slice.call(document.querySelectorAll('button, input[type=button], input[type=submit]'));var nodes=Array.prototype.slice.call(document.querySelectorAll('a, [role=button], div, span'));" +
                    USERSCRIPT_INSTALL_DEEPEST +
                    "if(!hit)return JSON.stringify({clicked:false,buttons:buttons.map(label).slice(0,10)});hit.click();return JSON.stringify({clicked:true,label:label(hit),tag:hit.tagName,cls:String(hit.className||'').slice(0,60)})})()"
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

        /** Every bridge line of the row since the step started (the ring's, so up to its size). */
        fun trace(): List<String> = traceLines()

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
            coreCall("tab.setDesktopSite", JSONObject().put("tabId", tab).put("on", true).toString())
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
        val extra = JSONObject().put("page", found).put("where", where).put("upsellsClosed", upsells).put("desktopSite", desktopSite).put("tab", tab)
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
        coreCall("extension.setNewTabOverride", JSONObject().put("id", row.id).put("enabled", true).toString())
        SystemClock.sleep(1_000)
        val before = tabUrls().keys
        runCatching { coreCall("tab.new", "null") }.onFailure { coreCall("tab.create", """{"active":true}""") }
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
        coreCall("extension.openPopup", """{"id":${JSONObject.quote(row.id)},"anchor":{"x":0,"y":0,"width":0,"height":0}}""")
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
        runCatching { coreCall("extension.closePopup", "null") }
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
     * phone has no panel to host: opened as a tab) shows its sign-in, or the click runs the
     * provider's sign-in through `identity.launchWebAuthFlow`, whose sheet is up with the
     * provider's page (Read&Write: its toolbar mounts hidden and Texthelp's IdP asks for a
     * provider, as Chrome's first click does). Each is the row's sign-in
     * surface: `n/m`, the account being the gate (`gate` names another gate: Avast's cloud
     * verdict, IE Tab's Windows companion). A row whose click runs into the gate in its worker
     * instead (`gateLog`: Save to Google Drive's `identity.getAuthToken`, refused as Zenium
     * refuses it without a signed-in browser account) is `n/m` on that line. A row whose click
     * does nothing and whose page shows nothing is `F`, with the bridge trace. The click lands
     * on the fixture tab, or on `site` (Klarna enables its action per tab on its merchant hosts
     * alone, so its click is read on one of them, as the desktop's round 6 read it).
     */
    private fun accountGate(label: String, opens: Regex, page: String? = null, injects: String? = null, gate: String = "an account", gateLog: Regex? = null, site: String? = null): (Row, JSONObject) -> Grade = gate@{ row, entry ->
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
                val tab = createTab(site ?: "$BASE/page-b.html?gate")
                val view = waitForView(tab)
                poll(scaled(if (site == null) 15_000 else 45_000, factor), 400) { if (tabEval(view, "String(document.readyState === 'complete')") == "true") true else null }
                SystemClock.sleep(scaled(if (site == null) 2_000 else 4_000, factor))
                if (site != null) {
                    val landed = json(tabEval(view, DOM_REPORT))
                    extra.put("site", landed)
                    val text = landed.optString("text")
                    if (CHALLENGE_WORDS.containsMatchIn(text) || text.isEmpty()) {
                        return@gate Grade("n/m", "$label: ${site.take(60)} did not serve its page to the runner (\"${text.take(80)}\", ${landed.optInt("els")} elements); nothing for the action to act on (not measurable here)", extra)
                    }
                }
                val before = tabUrls()
                val activeBefore = activeCoreTab(coreSnapshot())?.optString("id")
                val since = StepEvidence(row)
                coreCall("extension.openPopup", """{"id":${JSONObject.quote(row.id)},"anchor":{"x":0,"y":0,"width":0,"height":0}}""")
                val hit: Any? = poll(scaled(20_000, factor), 500) {
                    val now = tabUrls()
                    now.entries.firstOrNull { (it.key !in before || before[it.key] != it.value) && opens.containsMatchIn(it.value) }
                        ?: now.entries.firstOrNull { it.key !in before && extensionPage(it.value, row.id) }
                        ?: activeCoreTab(coreSnapshot())?.optString("id")?.takeIf { it != activeBefore && it != tab }
                            ?.let { id -> now.entries.firstOrNull { it.key == id && opens.containsMatchIn(it.value) } }
                        ?: authSheetUrl(row.id)?.let { url -> AuthSheet(url) }
                        ?: injects?.let { selector -> json(tabEval(view, INJECTED_UI.replace("__SELECTOR__", JSONObject.quote(selector)))).takeIf { it.optBoolean("pass") } }
                }
                @Suppress("UNCHECKED_CAST")
                val landed = hit as? Map.Entry<String, String>
                val injected = hit as? JSONObject
                val authSheet = hit as? AuthSheet
                if (injected != null) {
                    SystemClock.sleep(scaled(2_000, factor))
                    snap("${entry.optString("slug")}-injected")
                    extra.put("injected", injected)
                }
                if (authSheet != null) {
                    // The provider's page in the identity sheet: its host and what it says, once it shows.
                    val sheet = poll(scaled(15_000, factor), 500) { authSheetView(row.id)?.takeIf { rendered(it) } }
                    val said = sheet?.let { json(tabEval(it, DEEP_TEXT)).optString("text").replace(Regex("\\s+"), " ").trim() } ?: ""
                    extra.put("authSheet", JSONObject().put("url", (authSheetUrl(row.id) ?: authSheet.url).take(200)).put("text", said.take(200)))
                    injects?.let { selector -> extra.put("pageWithSheet", json(tabEval(view, INJECTION_MISS.replace("__SELECTOR__", JSONObject.quote(selector))))) }
                    snap("${entry.optString("slug")}-sign-in")
                }
                runCatching { coreCall("extension.closePopup", "null") }
                extra.put("tabsAfterClick", JSONArray(tabUrls().values.toList()))
                // The page's side of a missed injection: the element's state if the DOM has it
                // (Read&Write's toolbar mounts `minimised: true, visible: false` until its
                // license round trip says otherwise), the page's own console (the content
                // bundle's errors land there, not in the worker's), what the content scripts
                // left on `window` (`texthelp`, `thFrameInit`), the frames in the page, and the
                // row's whole bridge trace since the click as a file of the artifact.
                if (hit == null && injects != null) {
                    val miss = INJECTION_MISS.replace("__SELECTOR__", JSONObject.quote(injects))
                    extra.put("pageAfterClick", json(tabEval(view, miss)))
                    // On an isolated-worlds WebView the content scripts' globals live in the
                    // extension's world; the DOM is shared.
                    if (worlds) worldEval(view, row.id, miss)?.let { extra.put("worldAfterClick", json(it)) }
                    extra.put("pageConsole", JSONArray(consoleOf(view).takeLast(15)))
                    val trace = since.trace()
                    File(out, "bridge-${entry.optString("slug")}.txt").writeText(trace.joinToString("\n"))
                    extra.put("bridgeFile", "bridge-${entry.optString("slug")}.txt").put("bridgeLines", trace.size)
                }
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
                    authSheet != null -> {
                        val sheet = extra.optJSONObject("authSheet")
                        val host = sheet?.optString("url")?.let { runCatching { java.net.URI(it).host }.getOrNull() } ?: ""
                        val mounted = extra.optJSONObject("pageWithSheet")?.optJSONObject("element")?.let { el ->
                            "; its <${el.optString("tag")}> is in the page (display ${el.optString("display")}, ${el.optInt("shadowEls")} elements in its shadow root)"
                        } ?: ""
                        Grade("n/m", "$label: the action click opened the provider's sign-in in its identity.launchWebAuthFlow sheet ($host: \"${sheet?.optString("text")?.take(80) ?: ""}\")$mounted; the core needs $gate (not measurable here)", extra)
                    }
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
     * A consent control whose handler checks `isTrusted` (Planet VPN's React "Agree and
     * Continue", VPNLY's) is pressed by a finger at its centre (`tapConsent`) instead of a
     * script's `click()`, as the desktop's `consentThenTrusted` presses it. A row without a
     * popup (`hasPopup = false`: Yandex Access, whose worker sets its `pac_script` on its own from
     * `onInstalled` / `onStartup` and has no action) is graded on the API shape and the
     * settings reading alone.
     */
    private fun vpn(label: String, pac: Boolean = false, consent: Boolean = false, connectSelector: String? = null, connectWords: String? = null, tapConsent: Boolean = false, hasPopup: Boolean = true): (Row, JSONObject) -> Grade = vpn@{ row, entry ->
        val extra = JSONObject()
        val factor = speedFactor(entry)
        // Woken when it idled out during the row's earlier stages (UltraSurf's had, in round 12's
        // BEFORE run: "no background view" with the popup up and connected).
        val bg = awakeBackground(row.id, factor)
        val proxy = if (bg != null) {
            tabEval(bg, PROXY_PROBE)
            poll(10_000, 250) { tabEval(bg, "window.__zenProxyProbe && window.__zenProxyProbe.done ? JSON.stringify(window.__zenProxyProbe) : null").takeIf { it != "null" } }?.let(::json)
                ?: JSONObject().put("pass", false).put("note", "no answer within 10 s")
        } else JSONObject().put("pass", false).put("note", "no background view")
        extra.put("proxy", proxy)
        if (!hasPopup) {
            // No control to press: the worker's own proxy setting is the whole surface.
            val reading = proxy.optJSONObject("reading")
            val mode = reading?.optJSONObject("value")?.optString("mode") ?: ""
            val console = bg?.let { consoleOf(it).takeLast(10) } ?: emptyList()
            extra.put("workerConsole", JSONArray(console))
            val note = "chrome.proxy: ${proxy.toString().take(200)}; settings.get reads mode \"$mode\" (levelOfControl ${reading?.optString("levelOfControl")})"
            return@vpn when {
                !proxy.optBoolean("pass") -> Grade("F", "$label: the proxy API is not Chrome's shape in the worker: $note", extra)
                pac -> Grade("n/a", "$label: the proxy API answers in the worker (no popup; its worker sets its config itself); it connects with a pac_script proxy config, which the WebView cannot apply (ProxyController takes fixed rules and a bypass list only: WebView limit): $note", extra)
                else -> Grade("n/m", "$label: the proxy API answers in the worker (no popup; its worker sets its config itself); a routed egress needs the vendor's live service (not measurable here): $note", extra)
            }
        }
        val egressTab = createTab("$BASE/proxy-check.html")
        val egressView = waitForView(egressTab)
        val before = pollExpr(egressView, EGRESS_REPORT, scaled(20_000, factor))
        extra.put("egressBefore", before)
        showTab(fixtureTab)
        val openPopup = {
            coreCall("extension.openPopup", """{"id":${JSONObject.quote(row.id)},"anchor":{"x":0,"y":0,"width":0,"height":0}}""")
            poll(scaled(POPUP_TIMEOUT_MS, factor), 400) { popupView()?.takeIf { it.context == "popup" && rendered(it) } }
        }
        var popup = openPopup()
        if (popup != null && consent) {
            val consents = JSONArray()
            SystemClock.sleep(scaled(3_000, factor))
            for (round in 0 until 3) {
                val live = popupView()?.takeIf { it.context == "popup" } ?: break
                val consentJs = (if (tapConsent) FIND_LABEL else CLICK_LABEL).replace("__RE__", CONSENT_WORDS)
                val answer = json(tabEval(live, consentJs))
                consents.put(answer.toString().take(120))
                if (!answer.optBoolean("clicked")) break
                if (tapConsent) screenPoint(live, answer)?.let { tap(it.first, it.second) }
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
        runCatching { coreCall("extension.closePopup", "null") }
        var after = JSONObject()
        if (click.optBoolean("clicked")) {
            showTab(egressTab)
            coreCall("tab.reload", """{"tabId":${JSONObject.quote(egressTab)}}""")
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
        coreCall("extension.openPopup", """{"id":${JSONObject.quote(row.id)},"anchor":{"x":0,"y":0,"width":0,"height":0}}""")
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
        runCatching { coreCall("extension.closePopup", "null") }
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
            coreCall("extension.openPopup", """{"id":${JSONObject.quote(row.id)},"anchor":{"x":0,"y":0,"width":0,"height":0}}""")
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
            runCatching { coreCall("extension.closePopup", "null") }
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
        runCatching { coreCall("extension.closePopup", "null") }
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
            coreCall("extension.openPopup", """{"id":${JSONObject.quote(row.id)},"anchor":{"x":0,"y":0,"width":0,"height":0}}""")
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
            coreCall("extension.openPopup", """{"id":${JSONObject.quote(row.id)},"anchor":{"x":0,"y":0,"width":0,"height":0}}""")
            val popup = poll(scaled(POPUP_TIMEOUT_MS, factor), 400) { popupView()?.takeIf { it.context == "popup" && rendered(it) } }
            var found = JSONObject()
            if (popup != null) {
                found = pollExpr(popup, DEEP_TEXT.replace("return JSON.stringify({text:", "return JSON.stringify({pass:/\\b(safe|secure|no threats?|protected|trusted|blocked|trackers?)\\b/i.test(text),text:"), scaled(20_000, factor))
                found.put("console", JSONArray(consoleOf(popup).takeLast(10)))
            }
            SystemClock.sleep(600)
            snap("${entry.optString("slug")}-verdict-popup")
            runCatching { coreCall("extension.closePopup", "null") }
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
        val tab = createTab(fixtureUrl(fixture))
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

    /**
     * A fixture's URL: a page name is served off [BASE]; an absolute URL is the row's own way to
     * the same server (`http://localhost:8765/` through the port the sweep script reverses onto
     * the device, for an extension whose content-script matches name `localhost` and no plain
     * http host).
     */
    private fun fixtureUrl(page: String): String = if (page.startsWith("http://") || page.startsWith("https://")) page else "$BASE/$page"

    /** A fixture tab, its document complete; the view to read it through. */
    private fun fixture(page: String, factor: Double, settleMs: Long = 1_500): Pair<String, TabWebView> {
        val tab = createTab(fixtureUrl(page))
        val view = waitForView(tab)
        poll(scaled(15_000, factor), 400) { if (tabEval(view, "String(document.readyState === 'complete')") == "true") true else null }
        SystemClock.sleep(scaled(settleMs, factor))
        return tab to view
    }

    /** The row's popup opened over the tab on screen, rendered, or null. */
    private fun openPopup(row: Row, factor: Double): ExtensionWebView? {
        coreCall("extension.openPopup", """{"id":${JSONObject.quote(row.id)},"anchor":{"x":0,"y":0,"width":0,"height":0}}""")
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
        runCatching { coreCall("extension.closePopup", "null") }
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
        runCatching { coreCall("extension.closePopup", "null") }
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
        runCatching { coreCall("extension.closePopup", "null") }
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
        runCatching { coreCall("extension.closePopup", "null") }
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
        runCatching { coreCall("extension.closePopup", "null") }
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
        runCatching { coreCall("extension.closePopup", "null") }
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
        val state = coreSnapshot()
        val control = state.optJSONObject("searchEngineControl")
        val engines = state.optJSONArray("searchEngines") ?: JSONArray()
        val list = List(engines.length()) { engines.optJSONObject(it) ?: JSONObject() }
        val own = list.firstOrNull { e -> e.optString("source") == "extension" && (name.containsMatchIn(e.optString("name")) || e.optString("id").contains(row.id)) }
        extra.put("control", control ?: JSONObject.NULL).put("engines", JSONArray(list.map { "${it.optString("id")}:${it.optString("name")}${if (it.has("source")) " (${it.optString("source")})" else ""}" }))
        val (tab, _) = fixture("page-b.html?search", factor, 500)
        coreCall("tab.navigate", JSONObject().put("tabId", tab).put("input", "zenium sweep query").toString())
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
        runCatching { coreCall("extension.closePopup", "null") }
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
    private fun liveMarker(label: String, url: String, expr: String, settleMs: Long = 45_000, desktop: Boolean = false, mirrors: List<String> = emptyList()): (Row, JSONObject) -> Grade = { row, entry ->
        val factor = speedFactor(entry)
        val attempts = JSONArray()
        var grade: Grade? = null
        val targets = listOf(url) + mirrors
        for ((index, target) in targets.withIndex()) {
            val attempt = JSONObject().put("url", target)
            attempts.put(attempt)
            val tab = createTab(target)
            val view = waitForView(tab)
            if (desktop) {
                // The desktop site, as the tab's page-controls sheet asks for it: the core sets the
                // site's override and reloads the tab under Chrome-on-Linux's user agent, so the
                // page comes as the desktop DOM the extension's selectors are written for
                // (Buyhatke's scraper reads the product from server-sent selectors for the desktop
                // page; flipkart served the runner its mobile page and the widget stayed out, rounds 11-12).
                coreCall("tab.setDesktopSite", """{"tabId":${JSONObject.quote(tab)},"on":true}""")
                SystemClock.sleep(scaled(1_500, factor))
            }
            var complete = poll(scaled(45_000, factor), 500) { if (tabEval(view, "String(document.readyState === 'complete')") == "true") true else null } == true
            SystemClock.sleep(scaled(2_000, factor))
            var page = json(tabEval(view, DOM_REPORT))
            // A refusal or an error page (flipkart "refused to connect" once in round 12 and served
            // the page the run before): one reload before the next mirror is tried.
            val refused = json(tabEval(view, PAGE_OR_ERROR)).optBoolean("errorPage") || page.optString("text").isEmpty()
            if (refused) {
                attempt.put("firstTry", JSONObject().put("complete", complete).put("text", page.optString("text").take(120)).put("els", page.optInt("els")))
                SystemClock.sleep(scaled(3_000, factor))
                coreCall("tab.reload", """{"tabId":${JSONObject.quote(tab)}}""")
                SystemClock.sleep(scaled(1_500, factor))
                complete = poll(scaled(45_000, factor), 500) { if (tabEval(view, "String(document.readyState === 'complete')") == "true") true else null } == true
                SystemClock.sleep(scaled(2_000, factor))
                page = json(tabEval(view, DOM_REPORT))
            }
            val found = pollExpr(view, expr, scaled(settleMs, factor))
            page = json(tabEval(view, DOM_REPORT))
            attempt.put("page", found).put("document", page).put("complete", complete).put("console", JSONArray(consoleOf(view).takeLast(10)))
            if (desktop) attempt.put("userAgent", tabEval(view, "navigator.userAgent").trim('"').take(160))
            if (worlds) worldEval(view, row.id, WORLD_REPORT)?.let { attempt.put("world", json(it)) }
            SystemClock.sleep(600)
            snap("${entry.optString("slug")}-live${if (index > 0) "-$index" else ""}")
            val text = page.optString("text")
            val errorPage = json(tabEval(view, PAGE_OR_ERROR)).optBoolean("errorPage")
            attempt.put("errorPage", errorPage)
            val extra = JSONObject().put("attempts", attempts).put("page", found).put("document", page).put("complete", complete)
            val where = target.take(60) + (if (desktop) " (desktop site)" else "")
            val before = if (index > 0) "; the $index page(s) tried before it did not serve either (attempts)" else ""
            grade = when {
                found.optBoolean("pass") -> Grade("P", "$label: on $where: ${found.toString().take(220)}$before", extra)
                errorPage || CHALLENGE_WORDS.containsMatchIn(text) || NOT_FOUND_WORDS.containsMatchIn(text) || text.isEmpty() ->
                    Grade("n/m", "$label: $where did not serve its page to the runner (\"${text.take(80)}\", complete $complete, ${page.optInt("els")} elements${if (refused) ", reloaded once" else ""})$before; nothing for the extension to act on (not measurable here)", extra)
                else -> Grade("F", "$label: on $where (\"${text.take(60)}\"): ${found.toString().take(200)}$before", extra)
            }
            // A page that did not serve is no reading: the next mirror of the same shape, if one is named.
            if (grade.verdict != "n/m" || index == targets.lastIndex) break
            closeTab(tab)
        }
        grade!!
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
        runCatching { coreCall("extension.closePopup", "null") }
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
        runCatching { coreCall("extension.closePopup", "null") }
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
        coreCall("extension.openPopup", """{"id":${JSONObject.quote(row.id)},"anchor":{"x":0,"y":0,"width":0,"height":0}}""")
        val after = pollExpr(view, PIP_STATE, scaled(15_000, factor))
        extra.put("after", after).put("console", JSONArray(consoleOf(view).takeLast(8)))
        backgroundView(row.id)?.let { extra.put("workerConsole", JSONArray(consoleOf(it).takeLast(8))) }
        if (worlds) worldEval(view, row.id, WORLD_REPORT)?.let { extra.put("world", json(it)) }
        since.record(extra, "atEnd")
        SystemClock.sleep(600)
        snap("${entry.optString("slug")}-pip")
        runCatching { coreCall("extension.closePopup", "null") }
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
        runCatching { coreCall("extension.closePopup", "null") }
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
        runCatching { coreCall("extension.closePopup", "null") }
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
        coreCall("extension.openPopup", """{"id":${JSONObject.quote(row.id)},"anchor":{"x":0,"y":0,"width":0,"height":0}}""")
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
        runCatching { coreCall("extension.closePopup", "null") }
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
        runCatching { coreCall("extension.closePopup", "null") }
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
        runCatching { coreCall("extension.closePopup", "null") }
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
        coreCall("extension.openPopup", """{"id":${JSONObject.quote(row.id)},"anchor":{"x":0,"y":0,"width":0,"height":0}}""")
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
        runCatching { coreCall("extension.closePopup", "null") }
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
        coreCall("extension.openPopup", """{"id":${JSONObject.quote(row.id)},"anchor":{"x":0,"y":0,"width":0,"height":0}}""")
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
        runCatching { coreCall("extension.closePopup", "null") }
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
        coreCall("extension.openPopup", """{"id":${JSONObject.quote(row.id)},"anchor":{"x":0,"y":0,"width":0,"height":0}}""")
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
        runCatching { coreCall("extension.closePopup", "null") }
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
        coreCall("extension.openPopup", """{"id":${JSONObject.quote(row.id)},"anchor":{"x":0,"y":0,"width":0,"height":0}}""")
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
        runCatching { coreCall("extension.closePopup", "null") }
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
        coreCall("extension.openPopup", """{"id":${JSONObject.quote(row.id)},"anchor":{"x":0,"y":0,"width":0,"height":0}}""")
        SystemClock.sleep(scaled(1_500, factor))
        runCatching { coreCall("extension.closePopup", "null") }
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
        coreCall("extension.openPopup", """{"id":${JSONObject.quote(row.id)},"anchor":{"x":0,"y":0,"width":0,"height":0}}""")
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
        runCatching { coreCall("extension.closePopup", "null") }
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

    // --- the core checks of compat round 8 (ranks 151-180 by installs) ----------------------------

    /**
     * An effect drawn in the row's popup over a settled fixture tab (The QR Code Generator's SVG
     * of the tab's address, Boxel Rebound's game canvas): the popup opens, `expr` (a
     * `JSON.stringify` of `{pass, ...}`) is polled in it.
     */
    private fun popupMarker(label: String, expr: String, page: String = "page-a.html?popup", settleMs: Long = 20_000, notMeasurable: Regex? = null, gate: String = "its service", fixtureSettleMs: Long = 1_500): (Row, JSONObject) -> Grade = { row, entry ->
        val factor = speedFactor(entry)
        val extra = JSONObject()
        fixture(page, factor, fixtureSettleMs)
        val popup = openPopup(row, factor)
        var found = JSONObject()
        if (popup != null) {
            found = pollExpr(popup, expr, scaled(settleMs, factor))
            found.put("console", JSONArray(consoleOf(popup).takeLast(10)))
            extra.put("popupText", json(tabEval(popup, DEEP_TEXT)).optString("text").take(200))
        }
        extra.put("popup", found)
        SystemClock.sleep(600)
        snap("${entry.optString("slug")}-popup-core")
        runCatching { coreCall("extension.closePopup", "null") }
        // The popup up but its answer the service's refusal (`notMeasurable` on what it shows,
        // Scribbr's "something went wrong" from its citation API): the gate, not the runtime.
        val refused = popup != null && !found.optBoolean("pass") && notMeasurable != null && notMeasurable.containsMatchIn(extra.optString("popupText") + " " + found.optString("text"))
        when {
            found.optBoolean("pass") -> Grade("P", "$label: popup ${found.toString().take(240)}", extra)
            refused -> Grade("n/m", "$label: popup renders and answers with $gate's refusal (\"${extra.optString("popupText").take(100)}\"); the core needs $gate (not measurable here)", extra)
            else -> Grade("F", "$label: popup ${if (popup == null) "did not render in the core check" else found.toString().take(240)}", extra)
        }
    }

    /**
     * An effect the action click leaves on the fixture page (Turn Off the Lights' overlay over
     * `video.html`, an `action.onClicked` row without a popup): the fixture settles, the action
     * is clicked, `expr` is polled on the page.
     */
    private fun actionMarker(label: String, page: String, expr: String, settleMs: Long = 25_000): (Row, JSONObject) -> Grade = { row, entry ->
        val factor = speedFactor(entry)
        val extra = JSONObject()
        val (_, view) = fixture(page, factor, 2_500)
        val since = StepEvidence(row)
        coreCall("extension.openPopup", """{"id":${JSONObject.quote(row.id)},"anchor":{"x":0,"y":0,"width":0,"height":0}}""")
        val found = pollExpr(view, expr, scaled(settleMs, factor))
        extra.put("page", found).put("console", JSONArray(consoleOf(view).takeLast(10)))
        if (worlds) worldEval(view, row.id, WORLD_REPORT)?.let { extra.put("world", json(it)) }
        popupView()?.let { extra.put("popupInstead", json(tabEval(it, DEEP_TEXT)).optString("text").take(160)) }
        since.record(extra, "atEnd")
        SystemClock.sleep(600)
        snap("${entry.optString("slug")}-action-core")
        runCatching { coreCall("extension.closePopup", "null") }
        Grade(if (found.optBoolean("pass")) "P" else "F", "$label: after the action click ${found.toString().take(240)}", extra)
    }

    /**
     * A row whose action click opens its own page over the fixture tabs (Session Buddy's
     * `session-buddy.html` listing the open tabs, Instant Data Scraper's `popup.html?tabid=`
     * showing the table fixture's rows): the fixtures open, the action is clicked, the page
     * matching `page` is waited for and `expr` polled in it.
     */
    private fun actionPage(label: String, page: Regex, expr: String, fixtures: List<String>, settleMs: Long = 30_000): (Row, JSONObject) -> Grade = { row, entry ->
        val factor = speedFactor(entry)
        val extra = JSONObject()
        for (f in fixtures) fixture(f, factor, 1_000)
        SystemClock.sleep(scaled(1_500, factor))
        val before = tabUrls().keys
        val since = StepEvidence(row)
        coreCall("extension.openPopup", """{"id":${JSONObject.quote(row.id)},"anchor":{"x":0,"y":0,"width":0,"height":0}}""")
        val opened = poll(scaled(30_000, factor), 700) { openedPage(before, row, page) }
        var found = JSONObject()
        if (opened != null) {
            val view = waitForView(opened.key)
            showTab(opened.key)
            found = pollExpr(view, expr, scaled(settleMs, factor))
            found.put("url", opened.value.take(160)).put("console", JSONArray(consoleOf(view).takeLast(10)))
            if (!found.optBoolean("pass")) extra.put("blankTab", blankPageEvidence(view, row, 0L))
        } else {
            popupView()?.let { extra.put("popupInstead", json(tabEval(it, DEEP_TEXT)).optString("text").take(160)) }
            extra.put("tabs", JSONArray(tabUrls().values.toList()))
        }
        extra.put("page", found)
        since.record(extra, "atEnd")
        SystemClock.sleep(800)
        snap("${entry.optString("slug")}-action-page")
        runCatching { coreCall("extension.closePopup", "null") }
        Grade(
            if (found.optBoolean("pass")) "P" else "F",
            "$label: ${if (opened == null) "the action click opened no ${page.pattern} page within ${scaled(30_000, factor) / 1000} s" else "${extensionPath(opened.value).take(50)} opened: ${found.toString().take(220)}"}",
            extra
        )
    }

    /**
     * The chrome's prompt (a permissions request an extension made from a gesture) accepted:
     * its button tapped when the sheet put a reachable one on screen, else answered through the
     * chrome's command; what was found and done, for the row's evidence.
     */
    private fun acceptPrompt(factor: Double, waitMs: Long = 8_000): JSONObject {
        val report = JSONObject()
        val up = poll(scaled(waitMs, factor), 400) {
            val pending = pendingPrompts()
            val button = promptButton()
            if (pending.length() > 0 || button != null) (pending to button) else null
        }
        if (up == null) return report.put("prompt", "none within ${scaled(waitMs, factor) / 1000} s")
        val (pending, button) = up
        report.put("pending", pending.length()).put("button", button?.detail?.toString()?.take(200) ?: "none")
        val rect = button?.rect
        if (rect != null) {
            tapRect(rect)
            SystemClock.sleep(scaled(1_200, factor))
            report.put("how", "tapped ${button.detail.optString("label")}")
        }
        val left = pendingPrompts()
        if (left.length() > 0) {
            answerPrompts(left)
            promptsAnsweredByCommand += left.length()
            report.put("how", (report.optString("how").takeIf { it.isNotEmpty() }?.let { "$it, then " } ?: "") + "${left.length()} answered by command")
        }
        return report
    }

    /**
     * Cookie-Editor over `cookies.html` (two first-party cookies): its host access is optional,
     * so its popup asks for the site first ("Request permission for this site", the same in
     * Chrome); that button is tapped (a gesture) and the chrome's prompt accepted, then the
     * popup lists the two cookies, then one cookie's own delete control is pressed and the
     * fixture's `document.cookie` drops to one: the pass, as the desktop's round 6 graded it.
     * Listed but not deleted is `PARTIAL`.
     */
    private fun cookieEditor(row: Row, entry: JSONObject): Grade {
        val factor = speedFactor(entry)
        val extra = JSONObject()
        val (_, view) = fixture("cookies.html?editor", factor, 2_000)
        val cookieNames = "JSON.stringify({names:document.cookie.split(';').map(function(c){return c.trim().split('=')[0]}).filter(Boolean)})"
        val before = json(tabEval(view, cookieNames))
        extra.put("before", before)
        var popup = openPopup(row, factor)
        var listed = JSONObject()
        if (popup != null) {
            SystemClock.sleep(scaled(2_500, factor))
            extra.put("popupText", json(tabEval(popup, DEEP_TEXT)).optString("text").take(200))
            val ask = json(tabEval(popup, FIND_LABEL.replace("__RE__", "/request permission|allow|grant/i")))
            extra.put("permissionControl", ask)
            if (ask.optBoolean("clicked")) {
                screenPoint(popup, ask)?.let { tap(it.first, it.second) }
                extra.put("prompt", acceptPrompt(factor))
                SystemClock.sleep(scaled(1_500, factor))
            }
            popup = popupView()?.takeIf { it.context == "popup" } ?: run {
                extra.put("reopened", true)
                showTab(fixtureTab)
                openPopup(row, factor)
            }
            if (popup != null) {
                listed = pollExpr(popup, COOKIE_LIST, scaled(20_000, factor))
                listed.put("console", JSONArray(consoleOf(popup).takeLast(8)))
            }
        }
        extra.put("listed", listed)
        var after = JSONObject()
        val live = popup
        if (live != null && listed.optBoolean("pass")) {
            val del = json(tabEval(live, COOKIE_DELETE))
            extra.put("deleteControl", del)
            if (del.optBoolean("clicked")) screenPoint(live, del)?.let { tap(it.first, it.second) }
            after = poll(scaled(15_000, factor), 700) {
                json(tabEval(view, cookieNames)).takeIf { (it.optJSONArray("names")?.length() ?: 9) < (before.optJSONArray("names")?.length() ?: 0) }
            } ?: json(tabEval(view, cookieNames))
            extra.put("after", after)
        }
        SystemClock.sleep(600)
        snap("${entry.optString("slug")}-cookies")
        runCatching { coreCall("extension.closePopup", "null") }
        val wanted = (before.optJSONArray("names")?.length() ?: 0) - 1
        val gone = wanted >= 1 && (after.optJSONArray("names")?.length() ?: 9) == wanted
        return Grade(
            when {
                gone -> "P"
                listed.optBoolean("pass") -> "PARTIAL"
                else -> "F"
            },
            "Cookie-Editor: fixture cookies ${before.optJSONArray("names")} -> ${after.optJSONArray("names") ?: "unread"}; popup ${if (popup == null) "did not render" else "lists ${listed.optInt("fixtureCookies")} of the fixture's cookies (${listed.optString("text").take(100)})"}; permission ${extra.optJSONObject("prompt")?.optString("how")?.ifEmpty { null } ?: extra.optJSONObject("prompt")?.optString("prompt") ?: "not asked"}",
            extra
        )
    }

    /**
     * Click&Clean: its popup menu lives in a closed shadow root of `<body>` (the page's DOM
     * shows nothing; the tiles render), so its "Clear Private Data" tile is found in the
     * accessibility tree, which is built from the layout and sees through the root, and tapped
     * inside the tile; the fixture's visit leaving `chrome.history` (read from the worker) is the
     * pass, as the desktop's round 6 graded it (its default preset leaves cookies, an option).
     */
    private fun clickAndClean(row: Row, entry: JSONObject): Grade {
        val factor = speedFactor(entry)
        val extra = JSONObject()
        fixture("page-c.html?history", factor, 2_000)
        // The worker idled out while the row's earlier stages ran: woken for the probe.
        val bg = awakeBackground(row.id, factor)
        val historyProbe = HISTORY_PROBE.replace("__MATCH__", "/page-c\\.html\\?history/")
        val before = bg?.let { poll(scaled(10_000, factor), 1_500) { probe(it, historyProbe, "__zenHistory", scaled(8_000, factor)).takeIf { r -> r.optBoolean("present") } } ?: probe(it, historyProbe, "__zenHistory", scaled(8_000, factor)) }
            ?: JSONObject().put("error", "no background view")
        extra.put("historyBefore", before)
        showTab(fixtureTab)
        val popup = openPopup(row, factor)
        val tile = JSONObject()
        if (popup != null) {
            SystemClock.sleep(scaled(3_000, factor))
            extra.put("popupDom", json(tabEval(popup, DOM_REPORT)))
            val clear = Regex("clear private data", RegexOption.IGNORE_CASE)
            val node = poll(scaled(10_000, factor), 1_000) {
                nodes { n -> n.isVisibleToUser && clear.containsMatchIn((n.text ?: n.contentDescription ?: "").toString()) }.firstOrNull()
            }
            val labels = nodes { n -> n.isVisibleToUser && !n.text.isNullOrBlank() }.map { it.text.toString().trim().take(30) }.distinct().take(24)
            extra.put("a11yLabels", JSONArray(labels))
            if (node != null) {
                val target = generateSequence(node) { it.parent }.take(4).firstOrNull { it.isClickable } ?: node
                val rect = Rect().also(target::getBoundsInScreen)
                tile.put("found", true).put("rect", rect.toShortString()).put("clickable", target.isClickable).put("label", node.text?.toString()?.take(40))
                tapRect(rect)
                SystemClock.sleep(scaled(3_000, factor))
                extra.put("tabsAfterTap", JSONArray(tabUrls().values.toList()))
            } else tile.put("found", false)
        }
        extra.put("tile", tile)
        snap("${entry.optString("slug")}-clean")
        runCatching { coreCall("extension.closePopup", "null") }
        // The clean may take the worker with it (a `browsingData.remove` from the popup runs in
        // the worker, and the worker may idle again): woken once more for the reading after.
        val bgAfter = if (tile.optBoolean("found")) awakeBackground(row.id, factor) else bg
        val after = if (bgAfter != null && tile.optBoolean("found")) {
            poll(scaled(15_000, factor), 1_500) { probe(bgAfter, historyProbe, "__zenHistory", scaled(8_000, factor)).takeIf { !it.optBoolean("present") && it.isNull("error") } }
                ?: probe(bgAfter, historyProbe, "__zenHistory", scaled(8_000, factor))
        } else JSONObject()
        extra.put("historyAfter", after)
        bg?.let { extra.put("workerConsole", JSONArray(consoleOf(it).takeLast(8))) }
        val note = "history before: ${before.toString().take(120)}; tile ${tile.toString().take(120)}; history after: ${after.toString().take(120)}"
        return when {
            !before.optBoolean("present") -> Grade("F", "Click&Clean: chrome.history.search from its worker did not list the fixture's visit before the clean ($note)", extra)
            popup == null -> Grade("F", "Click&Clean: popup did not render in the core check ($note)", extra)
            !tile.optBoolean("found") -> Grade("F", "Click&Clean: no \"Clear Private Data\" tile in the accessibility tree of its popup ($note)", extra)
            !after.optBoolean("present") && after.isNull("error") -> Grade("P", "Click&Clean: the Clear Private Data tile removed the fixture's visit from history ($note)", extra)
            else -> Grade("F", "Click&Clean: the fixture's visit is still in history after the tile ($note)", extra)
        }
    }

    /**
     * BlockSite: its popup's consent ("I Accept") and its promo sheet's close control pressed by
     * finger, then "Block this site" over the fixture tab adds a `declarativeNetRequest` dynamic
     * redirect of the main frame to its hosted block page (`user.blocksite.co/app/blocked?site=`),
     * so the next load of the fixture lands there (or on a block page of the extension's own, or
     * its overlay): the pass, as the desktop's round 6 graded it. The worker's dynamic rules are
     * read beside.
     */
    private fun blockSite(row: Row, entry: JSONObject): Grade {
        val factor = speedFactor(entry)
        val extra = JSONObject()
        val (tab, view) = fixture("page-b.html?block", factor, 2_000)
        val popup = openPopup(row, factor)
        val steps = JSONArray()
        var block = JSONObject().put("clicked", false)
        if (popup != null) {
            SystemClock.sleep(scaled(3_000, factor))
            for (round in 0 until 3) {
                val live = popupView()?.takeIf { it.context == "popup" } ?: break
                val consent = json(tabEval(live, FIND_LABEL.replace("__RE__", "/^(i accept|accept|agree|agree and continue|continue|got it|skip|not now|no thanks|maybe later|close|dismiss)[.!]?$/i")))
                steps.put("consent: ${consent.toString().take(100)}")
                if (!consent.optBoolean("clicked")) break
                screenPoint(live, consent)?.let { tap(it.first, it.second) }
                SystemClock.sleep(scaled(2_000, factor))
            }
            val live = popupView()?.takeIf { it.context == "popup" }
            if (live != null) {
                extra.put("popupText", json(tabEval(live, DEEP_TEXT)).optString("text").take(240))
                // The promo sheet's own close control, when one covers the menu: pressed by finger.
                val cover = json(tabEval(live, SHEET_CLOSE))
                steps.put("sheet: ${cover.toString().take(100)}")
                if (cover.optBoolean("clicked")) {
                    screenPoint(live, cover)?.let { tap(it.first, it.second) }
                    SystemClock.sleep(scaled(1_500, factor))
                }
                block = poll(scaled(8_000, factor), 1_000) { json(tabEval(live, FIND_LABEL.replace("__RE__", "/block this site|block site|block$/i"))).takeIf { it.optBoolean("clicked") } }
                    ?: json(tabEval(live, FIND_LABEL.replace("__RE__", "/block this site|block site|block$/i")))
                steps.put("block: ${block.toString().take(100)}")
                if (block.optBoolean("clicked")) {
                    screenPoint(live, block)?.let { tap(it.first, it.second) }
                    SystemClock.sleep(scaled(3_000, factor))
                    popupView()?.takeIf { it.context == "popup" }?.let { extra.put("popupAfterBlock", json(tabEval(it, DEEP_TEXT)).optString("text").take(200)) }
                }
            }
        }
        extra.put("steps", steps)
        snap("${entry.optString("slug")}-block-popup")
        runCatching { coreCall("extension.closePopup", "null") }
        val bg = awakeBackground(row.id, factor)
        val rules = bg?.let { probe(it, DNR_DYNAMIC_RULES, "__zenDnr", scaled(8_000, factor)) } ?: JSONObject().put("error", "no background view")
        extra.put("dynamicRules", rules)
        // The next load of the fixture: sent to the block page, or shown.
        showTab(tab)
        coreCall("tab.reload", """{"tabId":${JSONObject.quote(tab)}}""")
        val blockedUrl = Regex("blocksite\\.co/app/blocked|/blocked|block", RegexOption.IGNORE_CASE)
        val landed = poll(scaled(25_000, factor), 700) { tabUrls()[tab]?.takeIf { !it.startsWith(BASE) && (blockedUrl.containsMatchIn(it) || extensionPage(it, row.id)) } }
        SystemClock.sleep(scaled(1_500, factor))
        val page = json(tabEval(view, DOM_REPORT))
        val overlay = json(tabEval(view, injectedAny("blocksite")))
        extra.put("landed", tabUrls()[tab] ?: "").put("page", page).put("overlay", overlay).put("console", JSONArray(consoleOf(view).takeLast(8)))
        bg?.let { extra.put("workerConsole", JSONArray(consoleOf(it).takeLast(8))) }
        snap("${entry.optString("slug")}-blocked")
        val text = page.optString("text")
        val blockedText = Regex("is blocked|blocked by|site blocked|stay focused", RegexOption.IGNORE_CASE).containsMatchIn(text)
        val note = "block control ${block.toString().take(80)}; dynamic rules ${rules.toString().take(120)}; fixture reload landed on ${(tabUrls()[tab] ?: "").take(90)} (\"${text.take(60)}\")"
        return when {
            landed != null -> Grade("P", "BlockSite: the next load of the fixture was sent to its block page: $note", extra)
            blockedText || overlay.optBoolean("pass") && overlay.optInt("visible") > 0 -> Grade("P", "BlockSite: the fixture shows its block ${if (blockedText) "page" else "overlay"}: $note", extra)
            popup == null -> Grade("F", "BlockSite: popup did not render in the core check: $note", extra)
            !block.optBoolean("clicked") -> Grade("F", "BlockSite: no \"Block this site\" control reached in the popup (steps ${steps.toString().take(200)}): $note", extra)
            else -> Grade("F", "BlockSite: the block was pressed but the next load of the fixture was not blocked: $note", extra)
        }
    }

    /**
     * Auto Refresh Plus over the fixture: its popup's "Dashboard access required" sheet
     * dismissed ("Not now": its `permissions.request` for the dashboard host, refused in Chrome
     * as here), the 5 s preset picked and Start pressed by finger (a `permissions.request`
     * gesture path); the fixture reloading (its `performance.timeOrigin` moving) is the pass.
     */
    private fun autoRefresh(row: Row, entry: JSONObject): Grade {
        val factor = speedFactor(entry)
        val extra = JSONObject()
        val (tab, view) = fixture("page-a.html?refresh", factor, 2_000)
        val origin = tabEval(view, "String(performance.timeOrigin)")
        val popup = openPopup(row, factor)
        val steps = JSONArray()
        var start = JSONObject().put("clicked", false)
        if (popup != null) {
            SystemClock.sleep(scaled(3_000, factor))
            for (round in 0 until 2) {
                val live = popupView()?.takeIf { it.context == "popup" } ?: break
                val sheet = json(tabEval(live, FIND_LABEL.replace("__RE__", "/^(not now|no thanks|later|maybe later|skip|close|dismiss|got it)[.!]?$/i")))
                steps.put("sheet: ${sheet.toString().take(100)}")
                if (!sheet.optBoolean("clicked")) break
                screenPoint(live, sheet)?.let { tap(it.first, it.second) }
                SystemClock.sleep(scaled(1_500, factor))
            }
            val live = popupView()?.takeIf { it.context == "popup" }
            if (live != null) {
                extra.put("popupText", json(tabEval(live, DEEP_TEXT)).optString("text").take(240))
                val preset = json(tabEval(live, FIND_LABEL.replace("__RE__", "/^0?5 ?s(ec(onds?)?)?$|^5$|^00:05$|^5 seconds$/i")))
                steps.put("preset: ${preset.toString().take(100)}")
                if (preset.optBoolean("clicked")) {
                    screenPoint(live, preset)?.let { tap(it.first, it.second) }
                    SystemClock.sleep(scaled(1_200, factor))
                }
                start = json(tabEval(live, FIND_LABEL.replace("__RE__", "/^(start|start refresh|start auto refresh|refresh|start monitoring)$/i")))
                steps.put("start: ${start.toString().take(100)}")
                if (start.optBoolean("clicked")) screenPoint(live, start)?.let { tap(it.first, it.second) }
                SystemClock.sleep(scaled(1_500, factor))
                popupView()?.takeIf { it.context == "popup" }?.let { extra.put("popupAfterStart", json(tabEval(it, DEEP_TEXT)).optString("text").take(200)) }
            }
        }
        extra.put("steps", steps)
        snap("${entry.optString("slug")}-refresh-popup")
        // The popup stays open while the fixture behind it reloads on the interval.
        val reloaded = poll(scaled(30_000, factor), 1_000) {
            val now = runCatching { tabEval(view, "String(performance.timeOrigin)") }.getOrDefault("")
            now.takeIf { it.isNotEmpty() && it != "null" && it != origin }
        }
        runCatching { coreCall("extension.closePopup", "null") }
        extra.put("timeOrigin", JSONObject().put("before", origin).put("after", reloaded ?: tabEval(view, "String(performance.timeOrigin)"))).put("tabUrl", tabUrls()[tab] ?: "")
        backgroundView(row.id)?.let { extra.put("workerConsole", JSONArray(consoleOf(it).takeLast(8))) }
        val note = "steps ${steps.toString().take(220)}"
        return when {
            reloaded != null -> Grade("P", "Auto Refresh Plus: the fixture reloaded on the 5 s preset after Start (time origin $origin -> $reloaded): $note", extra)
            popup == null -> Grade("F", "Auto Refresh Plus: popup did not render in the core check: $note", extra)
            !start.optBoolean("clicked") -> Grade("F", "Auto Refresh Plus: no Start control reached in the popup: $note", extra)
            else -> Grade("F", "Auto Refresh Plus: Start pressed and the fixture did not reload within ${scaled(30_000, factor) / 1000} s: $note", extra)
        }
    }

    /**
     * Checker Plus for Gmail: its popup asks for a Google sign-in ("Must sign in!"), the
     * account gate (`n/m`, as the desktop graded it). Beside it the desktop's round-6 fix D is
     * checked on the phone: an extension page's `fetch` of Gmail's feed, a 401 with
     * `WWW-Authenticate: Basic` and no tab to ask in, must resolve with the 401 (Chrome gives a
     * tab-less challenge up) and raise no dialog in the chrome; a fetch that hangs is ours.
     */
    private fun checkerPlus(row: Row, entry: JSONObject): Grade {
        val grade = popupLogin("Checker Plus for Gmail")(row, entry)
        val factor = speedFactor(entry)
        val extra = grade.extra ?: JSONObject()
        val bg = backgroundView(row.id)
        val auth = bg?.let { probe(it, AUTH_FETCH_PROBE, "__zenAuthFetch", scaled(20_000, factor)) } ?: JSONObject().put("error", "no background view")
        extra.put("tablessAuth", auth)
        val dialog = chromeJs("(function(){var d=document.querySelector('.zen-sheet, [role=dialog]');return d?String((d.textContent||'').replace(/\\s+/g,' ').trim().slice(0,120)):'none'})()")
        extra.put("chromeDialogAfterFetch", dialog)
        val challenged = auth.optInt("status") == 401
        val hung = auth.has("error") && auth.optString("error").startsWith("no answer")
        return when {
            grade.verdict == "F" -> Grade("F", grade.note, extra)
            hung -> Grade("F", "${grade.note}; a tab-less HTTP auth challenge (Gmail's feed, 401 Basic) fetched from its worker did not resolve within ${scaled(20_000, factor) / 1000} s: ${auth.toString().take(160)}", extra)
            else -> Grade(grade.verdict, "${grade.note}; tab-less auth challenge from its worker: ${if (challenged) "the fetch resolved with the 401 (given up, as Chrome does)" else auth.toString().take(120)}, chrome dialog ${dialog.take(40)}", extra)
        }
    }

    /**
     * Video Downloader Plus over `video.html` (its clip playing): the popup lists the clip with a
     * download control, as the desktop's round 6 graded it.
     */
    private fun videoDownloaderPlus(row: Row, entry: JSONObject): Grade {
        val factor = speedFactor(entry)
        val extra = JSONObject()
        val (tab, view) = fixture("video.html?vdplus", factor, 2_500)
        runCatching { tabEval(view, "(function(){var v=document.querySelector('video');if(v){v.muted=true;v.play().catch(function(){})}return 'played'})()") }
        SystemClock.sleep(scaled(4_000, factor))
        showTab(tab)
        val popup = openPopup(row, factor)
        var dom = JSONObject()
        if (popup != null) {
            dom = pollExpr(popup, "(function(){var t=(document.body?document.body.innerText:'').replace(/\\s+/g,' ').trim();var dl=document.querySelectorAll('a[download], [class*=\"download\"], [id*=\"download\"], button, a[href*=\"clip\"]').length;return JSON.stringify({pass:/clip|mp4|webm/i.test(t)&&dl>0&&!/no (video|media)/i.test(t.slice(0,60)),text:t.slice(0,200),controls:dl,rows:document.querySelectorAll('li, tr, .item, [class*=\"video\"]').length})})()", scaled(25_000, factor))
            dom.put("console", JSONArray(consoleOf(popup).takeLast(10)))
        }
        extra.put("popup", dom)
        val workerConsole = backgroundView(row.id)?.let { consoleOf(it).takeLast(8) } ?: emptyList()
        extra.put("workerConsole", JSONArray(workerConsole))
        SystemClock.sleep(600)
        snap("${entry.optString("slug")}-media-popup")
        runCatching { coreCall("extension.closePopup", "null") }
        // The clip list is its vendor's: the worker sends the page's URL to `api/video/fetch-video-info`
        // and lists what the service answers. A 403 from the service to the runner (the desktop's
        // round 6 was answered) leaves nothing to list: the service's refusal, not the runtime's.
        val popupConsole = dom.optJSONArray("console")?.let { c -> (0 until c.length()).map { c.optString(it) } } ?: emptyList()
        val refused = (workerConsole + popupConsole).firstOrNull { it.contains("fetch-video-info") && it.contains("403") }
        return when {
            dom.optBoolean("pass") -> Grade("P", "Video Downloader Plus: popup over the playing clip ${dom.toString().take(220)}", extra)
            popup != null && refused != null -> Grade("n/m", "Video Downloader Plus: its vendor API (api/video/fetch-video-info) answered 403 Forbidden to the runner, so its popup lists no clip (\"${dom.optString("text").take(60)}\"); the clip list is the service's (not measurable here)", extra)
            else -> Grade("F", "Video Downloader Plus: popup over the playing clip ${if (popup == null) "did not render" else dom.toString().take(220)}", extra)
        }
    }

    /**
     * TubeBuddy on a watch page: its content script mounts `div#tubebuddy_chrome_extension_installed`
     * (the desktop's reading), and its tools need a YouTube sign-in with a linked TubeBuddy
     * account: the marker mounted is the gate surface (`n/m`); nothing mounted is F.
     */
    private fun tubeBuddy(row: Row, entry: JSONObject): Grade {
        val grade = youtube(row, entry, injectedAny("tubebuddy"), "TubeBuddy's marker on a watch page", desktopSite = true)
        return if (grade.verdict == "P") Grade("n/m", "${grade.note}; its tools need a YouTube sign-in with a linked TubeBuddy account (not measurable here)", grade.extra) else grade
    }

    /**
     * The display at tablet width for one check (`wm size` to [TABLET_SIZE], px at the run's
     * density: 1371 x 800 dp at 280, the chrome's tablet shell with the web view over 1100 dp
     * wide beside its sidebar), then back to the run's size. `wm size` is a configuration change
     * the activity handles in place (`screenSize|smallestScreenSize|screenLayout`), so the chrome
     * and its tabs stay; the phone's size is read first and put back exactly.
     */
    private fun withTabletDisplay(extra: JSONObject, block: () -> Grade): Grade {
        val sizes = shellCommand("wm size")
        val phone = Regex("Override size: (\\d+x\\d+)").find(sizes)?.groupValues?.get(1)
        extra.put("displayBefore", sizes.replace("\n", "; ").trim())
        shellCommand("wm size $TABLET_SIZE")
        SystemClock.sleep(4_000)
        onScreen("tablet display")
        extra.put("formFactor", chromeJs("String(document.documentElement.dataset.formFactor||'')"))
        try {
            return block()
        } finally {
            shellCommand(if (phone != null) "wm size $phone" else "wm size reset")
            SystemClock.sleep(4_000)
            onScreen("phone display")
            extra.put("displayAfter", shellCommand("wm size").replace("\n", "; ").trim())
        }
    }

    /**
     * A YouTube row read at tablet width with the desktop site (Language Reactor, YouTube
     * Summary: their scripts run on the phone's one-column watch page and draw nothing, round
     * 7): what a tablet user sees. The watch page's layout is read with the marker (its
     * `ytd-watch-flexy` two-column state, the viewport's CSS width): a marker drawn is P; none
     * on a two-column page is F; none because the page stayed one-column at this width is `n/a`
     * with the widths (a layout Chrome on a phone would not give either).
     */
    private fun youtubeTablet(row: Row, entry: JSONObject, expr: String, label: String): Grade {
        val extra = JSONObject()
        return withTabletDisplay(extra) {
            val grade = youtube(row, entry, expr, "$label at tablet width", desktopSite = true, settleMs = 60_000)
            val tab = grade.extra?.optString("tab")?.takeIf { it.isNotEmpty() }
            val layout = tab?.let { id -> runCatching { json(tabEval(waitForView(id), YT_LAYOUT)) }.getOrNull() } ?: JSONObject()
            extra.put("layout", layout).put("youtube", grade.extra ?: JSONObject())
            snap("${entry.optString("slug")}-tablet")
            val twoColumns = layout.optBoolean("twoColumns")
            when {
                grade.verdict != "F" -> Grade(grade.verdict, "${grade.note}; layout ${layout.toString().take(160)}", extra)
                twoColumns -> Grade("F", "${grade.note}; the watch page is two-column at ${layout.optInt("innerWidth")} css px (${layout.toString().take(140)})", extra)
                layout.has("innerWidth") -> Grade("n/a", "$label: the watch page stayed one-column at tablet width (${layout.optInt("innerWidth")} css px, flexy ${layout.optString("flexy").take(60)}), a layout Chrome on a phone does not give either; the extension draws in the two-column layout only: ${grade.note.take(160)}", extra)
                else -> Grade("F", "${grade.note}; layout unread", extra)
            }
        }
    }

    /**
     * Google Scholar PDF Reader: the PDF tool reading (a takeover of `sample.pdf` or an injection
     * into it) with, beside it, what `runtime.getURL` spells for its content script and how the
     * phone's PDF route presented the document (round 7's open row).
     */
    private fun scholarPdfReader(row: Row, entry: JSONObject): Grade {
        val grade = pdfTool("Google Scholar PDF Reader", Regex("scholar|gs_|gsr", RegexOption.IGNORE_CASE), missing = "F")(row, entry)
        val extra = grade.extra ?: JSONObject()
        backgroundView(row.id)?.let { bg ->
            extra.put("getURL", tabEval(bg, "(function(){try{return JSON.stringify({readerHtml:chrome.runtime.getURL('reader.html'),root:chrome.runtime.getURL(''),id:chrome.runtime.id})}catch(e){return JSON.stringify({error:String(e&&e.message||e)})}})()"))
            extra.put("workerConsole", JSONArray(consoleOf(bg).takeLast(8)))
        }
        // How the viewer's document reads to the extension: `document.contentType` in the page's
        // realm (the `with` fallback's, which `pdfTool` read) and in the extension's world where
        // the WebView has one. Chrome's PDF document answers `application/pdf`; Scholar acts on it.
        val pdfTab = tabUrls().entries.lastOrNull { it.value.contains("sample.pdf") || it.value.startsWith("zen://pdf") }
        val pdfView = pdfTab?.let { runCatching { waitForView(it.key) }.getOrNull() }
        val pageType = extra.optJSONObject("page")?.optString("contentType") ?: ""
        val worldType = if (worlds && pdfView != null) worldEval(pdfView, row.id, "JSON.stringify({contentType:document.contentType,url:location.href})")?.let { json(it).optString("contentType") } else null
        extra.put("contentType", JSONObject().put("page", pageType).put("world", worldType ?: JSONObject.NULL))
        val typeNote = "document.contentType page \"$pageType\"" + (worldType?.let { ", world \"$it\"" } ?: "")
        return Grade(grade.verdict, "${grade.note}; $typeNote; getURL ${extra.optString("getURL").take(160)}", extra)
    }

    /**
     * RoPro (round 7's open row): its markers on the roblox.com game page (round 7's fix 4), and
     * beside them its locale fetch (`<extension origin>/locales/en.json`), which Roblox's
     * `connect-src` refuses under the `with` fallback and in a WebView's isolated world alike:
     * the row's bridge trace says whether the host answered the file over the bridge
     * (`extFetch` / `extFetchDone`, this round's fix) and the page's console keeps the policy's
     * line either way (the page's fetch is tried first).
     */
    private fun ropro(row: Row, entry: JSONObject): Grade {
        val evidence = StepEvidence(row)
        val grade = liveMarker("RoPro", "https://www.roblox.com/games/920587237", injectedAny("ropro"))(row, entry)
        val extra = grade.extra ?: JSONObject()
        val lines = evidence.trace().filter { " extFetch" in it }
        val asked = lines.count { Regex(" extFetch( |$)").containsMatchIn(it) }
        val answered = lines.count { " extFetchDone ok" in it }
        val refused = lines.count { " extFetchDone error" in it }
        val policyLines = (0 until (extra.optJSONArray("console")?.length() ?: 0)).count { i ->
            val line = extra.optJSONArray("console")?.optString(i) ?: ""
            line.contains("Refused to connect") && line.contains(Extensions.ORIGIN_SUFFIX)
        }
        extra.put("extFetch", JSONObject().put("asked", asked).put("answered", answered).put("refused", refused).put("lines", JSONArray(lines.takeLast(12))).put("policyLines", policyLines))
        // The relay is the content scripts' fetch in both isolations (a WebView's isolated world
        // runs under the document's connect-src too).
        val relay = "extension-origin fetch relay (${if (worlds) "the world's" else "the with scope's"} fetch): $asked asked, $answered answered, $refused refused; $policyLines connect-src line(s) in the page's console"
        return Grade(grade.verdict, "${grade.note}; $relay", extra)
    }

    // --- the core checks of compat round 9 (ranks 181-210 by installs; round 8's runtime rows) ---

    /**
     * A popup control found by [FIND_LABEL] (`words`, a JS regex literal over the visible
     * labels) and tapped for a trusted gesture; what was found goes on `steps`. False when the
     * popup is gone or has no such label.
     */
    private fun tapLabel(words: String, factor: Double, steps: JSONArray, name: String): Boolean {
        val live = popupView()?.takeIf { it.context == "popup" }
        if (live == null) {
            steps.put("$name: no popup up")
            return false
        }
        val hit = json(tabEval(live, FIND_LABEL.replace("__RE__", words)))
        steps.put("$name $words: ${hit.toString().take(140)}")
        if (!hit.optBoolean("clicked")) return false
        tapSettled(live, hit, factor)?.let { steps.put("$name: $it") }
        SystemClock.sleep(scaled(1_500, factor))
        return true
    }

    /**
     * The popup shows a control labelled `words` within the wait (a sub-list the last tap
     * opened: User-Agent Switcher's "Internet Explorer 10" under "Internet Explorer"); true when
     * it does, or when the popup is gone (the tap that follows records that).
     */
    private fun awaitLabel(words: String, factor: Double): Boolean =
        poll(scaled(6_000, factor), 500) {
            val live = popupView()?.takeIf { it.context == "popup" } ?: return@poll true
            if (json(tabEval(live, FIND_LABEL.replace("__RE__", words))).optBoolean("clicked")) true else null
        } == true

    /**
     * The row's popup over a settled fixture, its controls tapped in order (`clicks`: a label
     * regex each, the flow stops at the first one missing), then `expr` (a `JSON.stringify` of
     * `{pass, ...}`) polled on the fixture page, or in the popup when `onPage` is false (a label
     * prefixed `?` is optional: SEOquake's consent when it shows); a new
     * tab whose URL matches `opens` is the pass too (PrintFriendly's own page). Eye Dropper's
     * "Pick color from web page" and the picker it injects, Shimeji's ON and its mascot, Web
     * Developer's CSS > Disable All Styles and the fixture's stylesheet off, User-Agent
     * Switcher's pick and the header echo the fixture shows after its reload, SEOquake's
     * consent and the fixture's title read in the popup.
     */
    private fun popupFlow(
        label: String,
        page: String,
        clicks: List<String>,
        expr: String,
        onPage: Boolean = true,
        settleMs: Long = 25_000,
        opens: Regex? = null,
        prepare: ((WebView) -> Unit)? = null
    ): (Row, JSONObject) -> Grade = { row, entry ->
        val factor = speedFactor(entry)
        val extra = JSONObject()
        val (tab, view) = fixture(page, factor, 2_000)
        prepare?.invoke(view)
        val before = tabUrls().keys
        val since = StepEvidence(row)
        val popup = openPopup(row, factor)
        val steps = JSONArray()
        var landed = 0
        if (popup != null) {
            SystemClock.sleep(scaled(2_500, factor))
            extra.put("popupText", json(tabEval(popup, DEEP_TEXT)).optString("text").take(240))
            for ((i, words) in clicks.withIndex()) {
                val optional = words.startsWith("?")
                val re = words.removePrefix("?")
                // A control the last tap was to reveal is waited for, and the last tap repeated
                // once when it does not show (round 11's 156 column read User-Agent Switcher's
                // top-level list again at the second tap, the first not having opened its sub-list).
                if (i > 0 && !awaitLabel(re, factor)) {
                    steps.put("click ${i + 1} $re: not shown after the last tap; tapping again")
                    tapLabel(clicks[i - 1].removePrefix("?"), factor, steps, "click $i again")
                    awaitLabel(re, factor)
                }
                if (!tapLabel(re, factor, steps, "click ${i + 1}") && !optional) break
                landed++
            }
            popupView()?.takeIf { it.context == "popup" }?.let { extra.put("popupAfter", json(tabEval(it, DEEP_TEXT)).optString("text").take(240)) }
        }
        extra.put("steps", steps).put("clicksLanded", landed).put("clicksAsked", clicks.size)
        var found = JSONObject()
        var opened: Map.Entry<String, String>? = null
        if (onPage) {
            poll(scaled(settleMs, factor), 700) {
                opened = opens?.let { re -> tabUrls().entries.firstOrNull { it.key !in before && re.containsMatchIn(it.value) } }
                if (opened != null) return@poll true
                found = runCatching { json(tabEval(waitForView(tab), expr)) }.getOrElse { JSONObject().put("error", it.message ?: "eval failed") }
                if (found.optBoolean("pass")) true else null
            }
            runCatching { extra.put("console", JSONArray(consoleOf(waitForView(tab)).takeLast(10))) }
            if (worlds) runCatching { worldEval(waitForView(tab), row.id, WORLD_REPORT)?.let { extra.put("world", json(it)) } }
        } else {
            popupView()?.takeIf { it.context == "popup" }?.let {
                found = pollExpr(it, expr, scaled(settleMs, factor))
                found.put("console", JSONArray(consoleOf(it).takeLast(10)))
            }
        }
        opened?.let { o ->
            extra.put("opened", o.value.take(200))
            runCatching { waitForView(o.key) }.getOrNull()?.let { v ->
                showTab(o.key)
                extra.put("openedPage", pollExpr(v, DOM_REPORT.replace("return JSON.stringify({text:", "return JSON.stringify({pass:document.body&&document.body.querySelectorAll('*').length>3,text:"), scaled(20_000, factor)))
            }
        }
        extra.put("page", found).put("tabUrl", tabUrls()[tab] ?: "")
        backgroundView(row.id)?.let { extra.put("workerConsole", JSONArray(consoleOf(it).takeLast(8))) }
        since.record(extra, "atEnd")
        SystemClock.sleep(600)
        snap("${entry.optString("slug")}-core")
        runCatching { coreCall("extension.closePopup", "null") }
        val pass = found.optBoolean("pass") || opened != null
        Grade(
            if (pass) "P" else "F",
            "$label: " + when {
                opened != null -> "the click opened ${extensionPath(opened!!.value).take(80)}"
                popup == null -> "popup did not render in the core check"
                landed < clicks.size -> "control ${landed + 1} of ${clicks.size} not reached in the popup (${steps.toString().take(160)}); page ${found.toString().take(160)}"
                else -> "after the popup's ${clicks.size} tap(s) ${found.toString().take(240)}"
            },
            extra
        )
    }

    /**
     * Mobile simulator (a desktop concept: a device frame around the page): the action click
     * on a settled fixture runs its `js/simulator.js` in the tab, which rebuilds the document
     * around a device frame with the page itself in an `<iframe>` (the fixture tab's URL stays;
     * round 9's final run showed the frame while the driver looked for a page of the
     * extension's own), or sends the tab to a page of the extension's; either is read for the
     * frame. What it does on the phone is graded as it is.
     */
    private fun mobileSimulator(row: Row, entry: JSONObject): Grade {
        val factor = speedFactor(entry)
        val extra = JSONObject()
        val (tab, fixtureView) = fixture("page-a.html?sim", factor, 2_000)
        val before = tabUrls()
        val since = StepEvidence(row)
        coreCall("extension.openPopup", """{"id":${JSONObject.quote(row.id)},"anchor":{"x":0,"y":0,"width":0,"height":0}}""")
        val frameReport =
            """(function(){var f=document.querySelector('iframe');var r=f?f.getBoundingClientRect():{width:0,height:0};var t=(document.body?document.body.innerText:'').replace(/\s+/g,' ').trim();return JSON.stringify({pass:!!f&&r.width>100&&r.height>150,frame:f?(f.src||'').slice(0,120):null,w:Math.round(r.width),h:Math.round(r.height),devices:(t.match(/iPhone|Galaxy|Pixel|iPad/g)||[]).length,text:t.slice(0,120)})})()"""
        // Either the extension's own page in a tab, or the fixture tab rebuilt around the frame.
        var landed: Map.Entry<String, String>? = null
        var inPage: JSONObject? = null
        poll(scaled(30_000, factor), 700) {
            landed = tabUrls().entries.firstOrNull { (it.key !in before || before[it.key] != it.value) && extensionPage(it.value, row.id) }
            if (landed == null) {
                inPage = runCatching { json(tabEval(fixtureView, frameReport)) }.getOrNull()?.takeIf { it.optBoolean("pass") }
            }
            if (landed != null || inPage != null) true else null
        }
        var found = JSONObject()
        val where: String
        if (landed != null) {
            val view = waitForView(landed!!.key)
            showTab(landed!!.key)
            found = pollExpr(view, frameReport, scaled(30_000, factor))
            found.put("url", landed!!.value.take(160)).put("console", JSONArray(consoleOf(view).takeLast(10)))
            where = extensionPath(landed!!.value).take(60)
        } else if (inPage != null) {
            found = inPage!!
            found.put("url", (tabUrls()[tab] ?: "").take(160)).put("console", JSONArray(consoleOf(fixtureView).takeLast(10)))
            where = "the frame in the fixture tab"
        } else {
            extra.put("tabs", JSONArray(tabUrls().values.toList()))
            runCatching { extra.put("fixturePage", json(tabEval(fixtureView, frameReport))) }
            popupView()?.let { extra.put("popupInstead", json(tabEval(it, DEEP_TEXT)).optString("text").take(160)) }
            where = ""
        }
        extra.put("page", found).put("fixtureTab", tabUrls()[tab] ?: "")
        since.record(extra, "atEnd")
        SystemClock.sleep(800)
        snap("${entry.optString("slug")}-core")
        runCatching { coreCall("extension.closePopup", "null") }
        return Grade(
            if (found.optBoolean("pass")) "P" else "F",
            "Mobile simulator: ${if (where.isEmpty()) "the action click opened no simulator page and put no frame in the fixture tab within ${scaled(30_000, factor) / 1000} s" else "$where: ${found.toString().take(220)}"}",
            extra
        )
    }

    /**
     * Stream Recorder over `hls.html` (its playlist fetched): the action click opens the
     * recorder page for the tab (`hlsloader.com/record.html`, a page of the vendor's site the
     * worker opens with the stream it saw), which lists the fixture's stream. The desktop's
     * round 7 read it that way after its fix B.
     */
    private fun streamRecorder(row: Row, entry: JSONObject): Grade {
        val factor = speedFactor(entry)
        val extra = JSONObject()
        val (tab, view) = fixture("hls.html?rec", factor, 3_000)
        runCatching { tabEval(view, "(function(){var v=document.querySelector('video');if(v){v.muted=true;v.play().catch(function(){})}return 'played'})()") }
        SystemClock.sleep(scaled(4_000, factor))
        extra.put("fixture", json(tabEval(view, DOM_REPORT)).optString("text").take(160))
        showTab(tab)
        val before = tabUrls().keys
        val since = StepEvidence(row)
        coreCall("extension.openPopup", """{"id":${JSONObject.quote(row.id)},"anchor":{"x":0,"y":0,"width":0,"height":0}}""")
        val opened = poll(scaled(30_000, factor), 700) {
            tabUrls().entries.firstOrNull { it.key !in before && Regex("record\\.html|hlsloader\\.com", RegexOption.IGNORE_CASE).containsMatchIn(it.value) }
        }
        var found = JSONObject()
        if (opened != null) {
            val page = waitForView(opened.key)
            showTab(opened.key)
            // The WebView's own error page ("Webpage not available ... could not be loaded
            // because: net::ERR_...") quotes the URL, `record.html` in it: the pass reads the
            // recorder's words alone, and the error page is the F with its `net::` code.
            val report = """(function(){var t=(document.body?document.body.innerText:'').replace(/\s+/g,' ').trim();var err=/could not be loaded because|Webpage not available|net::ERR_/i.test(t);return JSON.stringify({pass:!err&&/m3u8|stream recorder|completed|segment|capture|index file/i.test(t)&&t.length>40,errorPage:err,text:t.slice(0,240),els:document.body?document.body.querySelectorAll('*').length:0})})()"""
            var last = JSONObject()
            poll(scaled(45_000, factor), 700) {
                last = json(tabEval(page, report))
                if (last.optBoolean("pass") || last.optBoolean("errorPage")) true else null
            }
            found = last
            found.put("url", opened.value.take(200)).put("console", JSONArray(consoleOf(page).takeLast(10)))
        } else {
            extra.put("tabs", JSONArray(tabUrls().values.toList()))
            popupView()?.let { extra.put("popupInstead", json(tabEval(it, DEEP_TEXT)).optString("text").take(160)) }
        }
        extra.put("page", found)
        backgroundView(row.id)?.let { extra.put("workerConsole", JSONArray(consoleOf(it).takeLast(10))) }
        since.record(extra, "atEnd")
        SystemClock.sleep(800)
        snap("${entry.optString("slug")}-core")
        runCatching { coreCall("extension.closePopup", "null") }
        // The recorder listens to `webRequest.onHeadersReceived` on every URL, so a document
        // reaches its tab through the phone's header relay: the fixture's gzip-encoded page
        // says whether the relay's body decodes (its own `__encoding` read, or the WebView's
        // error page), the instrument for the live page's `ERR_CONTENT_DECODING_FAILED`.
        val (gzTab, gzView) = fixture("echo-headers?gzip=1&rec", factor, 1_500)
        val gz = pollExpr(
            gzView,
            """(function(){var t=(document.body?document.body.innerText:'').replace(/\s+/g,' ').trim();var err=/could not be loaded because|Webpage not available|net::ERR_/i.test(t);return JSON.stringify({pass:!!window.__encoding,errorPage:err,encoding:window.__encoding||null,text:t.slice(0,160)})})()""",
            scaled(15_000, factor)
        )
        extra.put("gzipFixture", gz)
        runCatching { closeTab(gzTab) }
        val gzNote = when {
            gz.optBoolean("errorPage") -> "; the fixture's gzip-encoded page through the relay: the WebView's error page (${gz.optString("text").take(120)})"
            gz.optBoolean("pass") -> "; the fixture's gzip-encoded page through the relay rendered (sent ${gz.optString("encoding")})"
            else -> "; the fixture's gzip-encoded page through the relay: no reading (${gz.toString().take(120)})"
        }
        return Grade(
            if (found.optBoolean("pass")) "P" else "F",
            "Stream Recorder: ${if (opened == null) "the action click opened no recorder page within ${scaled(30_000, factor) / 1000} s" else "${opened.value.take(70)}: ${found.toString().take(220)}"}$gzNote",
            extra
        )
    }

    /**
     * A row whose whole reachable surface is a live site's page the runner is not served
     * (AIPRM's content script is declared for `chat.openai.com`, which redirects to
     * `chatgpt.com` and serves its sign-in or a challenge): the site is opened, its landing
     * recorded, `injects` looked for; found is P, the redirect or gate is `n/m` with the landing.
     */
    private fun siteGate(label: String, url: String, injects: String, declared: Regex, gate: String): (Row, JSONObject) -> Grade = { row, entry ->
        val factor = speedFactor(entry)
        val extra = JSONObject()
        val tab = createTab(url)
        val view = waitForView(tab)
        poll(scaled(45_000, factor), 500) { if (tabEval(view, "String(document.readyState === 'complete')") == "true") true else null }
        SystemClock.sleep(scaled(6_000, factor))
        val landed = json(tabEval(view, DOM_REPORT))
        val landedUrl = tabUrls()[tab] ?: ""
        val injected = pollExpr(view, INJECTED_UI.replace("__SELECTOR__", JSONObject.quote(injects)), scaled(20_000, factor))
        extra.put("site", landed).put("landedUrl", landedUrl.take(160)).put("injected", injected).put("console", JSONArray(consoleOf(view).takeLast(8)))
        backgroundView(row.id)?.let { extra.put("workerConsole", JSONArray(consoleOf(it).takeLast(8))) }
        SystemClock.sleep(600)
        snap("${entry.optString("slug")}-core")
        val text = landed.optString("text")
        when {
            injected.optBoolean("pass") -> Grade("P", "$label: its UI is on ${landedUrl.take(60)}: ${injected.toString().take(200)}", extra)
            !declared.containsMatchIn(landedUrl) -> Grade("n/m", "$label: ${url.take(50)} landed on ${landedUrl.take(60)}, outside its declared match (${declared.pattern}), so its script does not run there, in Chrome either; $gate (not measurable here)", extra)
            CHALLENGE_WORDS.containsMatchIn(text) || LOGIN_WORDS.containsMatchIn(text) || text.isEmpty() ->
                Grade("n/m", "$label: ${landedUrl.take(60)} served \"${text.take(80)}\" to the runner; $gate (not measurable here)", extra)
            else -> Grade("F", "$label: on ${landedUrl.take(60)} (\"${text.take(60)}\") nothing injected: ${injected.toString().take(160)}", extra)
        }
    }

    /**
     * `chrome.system.cpu.getInfo` / `system.memory.getInfo` from the row's worker (OKX Wallet
     * declares `system.cpu`): Chrome's shape (`numOfProcessors`, `archName`, `modelName`,
     * `features`, `processors[].usage`; `capacity`, `availableCapacity`) or the error.
     */
    private fun systemInfoProbe(bg: WebView, factor: Double): JSONObject = probe(bg, SYSTEM_INFO_PROBE, "__zenSystemInfo", scaled(10_000, factor))

    /**
     * OKX Wallet: its provider in the page world (`window.okxwallet`, the EIP-6963 announce),
     * with the `system.cpu` shape its worker gets beside it (round 8's open item c; Speechify's
     * worker logged the missing `system.cpu.getInfo`).
     */
    private fun okxWallet(row: Row, entry: JSONObject): Grade {
        val grade = domMarker(
            "OKX Wallet's provider injected into the page world",
            "wallet.html?okx",
            "JSON.stringify({pass:!!window.okxwallet,okx:typeof window.okxwallet,isOkx:!!(window.okxwallet&&(window.okxwallet.isOkxWallet||window.okxwallet.isOKExWallet)),ethereum:typeof window.ethereum,announced:(window.__eip6963||[]).slice(0,4)})",
            settleMs = 25_000
        )(row, entry)
        val extra = grade.extra ?: JSONObject()
        val bg = backgroundView(row.id)
        val system = bg?.let { systemInfoProbe(it, speedFactor(entry)) } ?: JSONObject().put("error", "no background view")
        extra.put("system", system)
        val cpu = system.optJSONObject("cpu")
        val cpuNote = when {
            cpu != null && cpu.has("numOfProcessors") -> "system.cpu.getInfo answers ${cpu.optInt("numOfProcessors")} processor(s), ${cpu.optString("archName")}, ${cpu.optJSONArray("processors")?.length() ?: 0} usage rows"
            else -> "system.cpu.getInfo: ${system.optString("cpuError").ifEmpty { system.toString() }.take(120)}"
        }
        val memory = system.optJSONObject("memory")
        val memoryNote = if (memory != null && memory.has("capacity")) "system.memory ${memory.optLong("capacity") / (1024 * 1024)} MB, ${memory.optLong("availableCapacity") / (1024 * 1024)} MB free" else "system.memory: ${system.optString("memoryError").take(80)}"
        return Grade(grade.verdict, "${grade.note}; $cpuNote; $memoryNote", extra)
    }

    /**
     * Easy Auto Refresh over `page-a.html`: its popup's interval field set to 5 s and Start
     * tapped; the fixture reloads on the interval (the desktop's reading).
     */
    private fun easyAutoRefresh(row: Row, entry: JSONObject): Grade {
        val factor = speedFactor(entry)
        val extra = JSONObject()
        val (tab, view) = fixture("page-a.html?easyrefresh", factor, 2_000)
        val origin = tabEval(view, "String(performance.timeOrigin)")
        val popup = openPopup(row, factor)
        val steps = JSONArray()
        var started = false
        if (popup != null) {
            SystemClock.sleep(scaled(3_000, factor))
            val live = popupView()?.takeIf { it.context == "popup" }
            if (live != null) {
                extra.put("popupText", json(tabEval(live, DEEP_TEXT)).optString("text").take(240))
                val set = tabEval(live, """(function(){var i=document.getElementById('interval')||document.querySelector('input[type=text], input[type=number]');if(!i)return 'no field';i.focus();i.value='5';i.dispatchEvent(new Event('input',{bubbles:true}));i.dispatchEvent(new Event('change',{bubbles:true}));return 'set '+i.value})()""")
                steps.put("interval: $set")
                started = tapLabel("/^start$/i", factor, steps, "start")
                popupView()?.takeIf { it.context == "popup" }?.let { extra.put("popupAfterStart", json(tabEval(it, DEEP_TEXT)).optString("text").take(200)) }
            }
        }
        extra.put("steps", steps)
        snap("${entry.optString("slug")}-refresh-popup")
        val reloaded = poll(scaled(30_000, factor), 1_000) {
            val now = runCatching { tabEval(view, "String(performance.timeOrigin)") }.getOrDefault("")
            now.takeIf { it.isNotEmpty() && it != "null" && it != origin }
        }
        runCatching { coreCall("extension.closePopup", "null") }
        extra.put("timeOrigin", JSONObject().put("before", origin).put("after", reloaded ?: tabEval(view, "String(performance.timeOrigin)"))).put("tabUrl", tabUrls()[tab] ?: "")
        backgroundView(row.id)?.let { extra.put("workerConsole", JSONArray(consoleOf(it).takeLast(8))) }
        val note = "steps ${steps.toString().take(220)}"
        return when {
            reloaded != null -> Grade("P", "Easy Auto Refresh: the fixture reloaded on the 5 s interval after Start (time origin $origin -> $reloaded): $note", extra)
            popup == null -> Grade("F", "Easy Auto Refresh: popup did not render in the core check: $note", extra)
            !started -> Grade("F", "Easy Auto Refresh: no Start control reached in the popup: $note", extra)
            else -> Grade("F", "Easy Auto Refresh: Start pressed and the fixture did not reload within ${scaled(30_000, factor) / 1000} s: $note", extra)
        }
    }

    /**
     * MyBib over `page-a.html`: its popup cites the page (through `wss://ws.mybib.com`, which
     * answered 502 to the desktop's runner: `n/m` on the service when the popup says so).
     */
    private fun myBib(row: Row, entry: JSONObject): Grade {
        val factor = speedFactor(entry)
        val extra = JSONObject()
        fixture("page-a.html?cite", factor, 2_000)
        val popup = openPopup(row, factor)
        var found = JSONObject()
        if (popup != null) {
            found = pollExpr(
                popup,
                """(function(){var t=(document.body?document.body.innerText:'').replace(/\s+/g,' ').trim();return JSON.stringify({pass:/Probe Page A|10\.0\.2\.2|Retrieved|Accessed|\(n\.d\.\)|\bAPA\b|\bMLA\b|Harvard/i.test(t)&&!/oh snap|something went wrong|sign in|log in/i.test(t),text:t.slice(0,240),snap:/oh snap|something went wrong/i.test(t),els:document.body?document.body.querySelectorAll('*').length:0})})()""",
                scaled(30_000, factor)
            )
            found.put("console", JSONArray(consoleOf(popup).takeLast(10)))
        }
        extra.put("popup", found)
        backgroundView(row.id)?.let { extra.put("workerConsole", JSONArray(consoleOf(it).takeLast(8))) }
        SystemClock.sleep(600)
        snap("${entry.optString("slug")}-core")
        runCatching { coreCall("extension.closePopup", "null") }
        val text = found.optString("text")
        return when {
            found.optBoolean("pass") -> Grade("P", "MyBib: the popup cites the fixture: \"${text.take(160)}\"", extra)
            popup == null -> Grade("F", "MyBib: popup did not render in the core check", extra)
            found.optBoolean("snap") || LOGIN_WORDS.containsMatchIn(text) -> Grade("n/m", "MyBib: its popup says \"${text.take(100)}\" (its citation service, wss://ws.mybib.com, answered the desktop's runner 502 the same way); the citation is the service's (not measurable here)", extra)
            else -> Grade("F", "MyBib: the popup shows no citation of the fixture within ${scaled(30_000, factor) / 1000} s: ${found.toString().take(200)}", extra)
        }
    }

    /**
     * Video Downloader PLUS (njgeh...) over `media.html` (its clip playing in `Range` pieces):
     * the popup's consent agreed, the popup reopened, the clip listed with a download control
     * (the desktop's round 7 reading). Its sniffer is an `onResponseStarted` listener with
     * `responseHeaders` (`isMedia`: a `video/` or `audio/` content-type, or a content-length of
     * 100 KB and a media extension), so the [WebRequestProbe] runs beside it (compat round 13's
     * item 4) and a failing grade carries what the runtime gave.
     */
    private fun videoDownloaderPLUS(row: Row, entry: JSONObject): Grade {
        val factor = speedFactor(entry)
        val extra = JSONObject()
        val webRequest = WebRequestProbe(row, factor).also { it.start() }
        val (tab, view) = fixture("media.html?vdplus2", factor, 2_500)
        runCatching { tabEval(view, "(function(){var v=document.querySelector('video');if(v){v.muted=true;v.play().catch(function(){})}return 'played'})()") }
        extra.put("webRequest", webRequest.read(view))
        SystemClock.sleep(scaled(4_000, factor))
        showTab(tab)
        val steps = JSONArray()
        var popup = openPopup(row, factor)
        var dom = JSONObject()
        val listExpr = """(function(){var t=(document.body?document.body.innerText:'').replace(/\s+/g,' ').trim();var dl=document.querySelectorAll('a[download], [class*="download"], [id*="download"], button, a[href*="clip"]').length;return JSON.stringify({pass:/clip|mp4|webm/i.test(t)&&dl>0&&!/no (video|media)/i.test(t.slice(0,60)),text:t.slice(0,200),controls:dl,consent:/agree|accept|terms|privacy/i.test(t)})})()"""
        if (popup != null) {
            SystemClock.sleep(scaled(2_500, factor))
            extra.put("popupFirst", json(tabEval(popup, DEEP_TEXT)).optString("text").take(200))
            // Its button reads "Agree & continue" (round 11's 156 shot): the two-word forms beside the plain ones.
            if (tapLabel("/^(i agree|agree|accept|accept all|agree (and|&) continue|accept (and|&) continue|continue|ok|got it)$/i", factor, steps, "consent")) {
                SystemClock.sleep(scaled(1_500, factor))
                runCatching { coreCall("extension.closePopup", "null") }
                SystemClock.sleep(scaled(1_000, factor))
                showTab(tab)
                popup = openPopup(row, factor)
            }
            popupView()?.takeIf { it.context == "popup" }?.let {
                dom = pollExpr(it, listExpr, scaled(25_000, factor))
                dom.put("console", JSONArray(consoleOf(it).takeLast(10)))
            }
        }
        extra.put("steps", steps).put("popup", dom)
        backgroundView(row.id)?.let { extra.put("workerConsole", JSONArray(consoleOf(it).takeLast(8))) }
        SystemClock.sleep(600)
        snap("${entry.optString("slug")}-media-popup")
        runCatching { coreCall("extension.closePopup", "null") }
        webRequest.stop()
        val measured = "; its sniffer listens to onResponseStarted with responseHeaders (a video/audio content-type, or content-length >= 100 KB with a media extension; tabId >= 0); the runtime gave it: ${webRequest.summary()}"
        return when {
            dom.optBoolean("pass") -> Grade("P", "Video Downloader PLUS: popup over the playing clip ${dom.toString().take(220)}; measured: ${webRequest.summary()}", extra)
            popup == null -> Grade("F", "Video Downloader PLUS: popup did not render in the core check (steps ${steps.toString().take(120)})$measured", extra)
            else -> Grade("F", "Video Downloader PLUS: popup over the playing clip lists no clip: ${dom.toString().take(220)} (steps ${steps.toString().take(120)})$measured", extra)
        }
    }

    /**
     * `runtime.getContexts` asked for the extension's offscreen document by `documentUrls` in
     * both spellings from its worker (round 8's open item a, OneNote Web Clipper and Google
     * Scholar PDF Reader filter by `runtime.getURL('offscreen.html')`): the document is created
     * when none is up (the extension's own `offscreen.html`), both filters must find it, and it
     * is closed again when this probe opened it.
     */
    private fun getContextsProbe(bg: WebView, factor: Double): JSONObject = probe(bg, GET_CONTEXTS_PROBE, "__zenGetContexts", scaled(15_000, factor))

    /** OneNote Web Clipper: round 8's account gate, with the `getContexts` filter probe beside it (its clipper lists its offscreen parser that way). */
    private fun oneNoteWebClipper(row: Row, entry: JSONObject): Grade {
        val grade = accountGate("OneNote Web Clipper", Regex("onenote|live\\.com|microsoftonline|login\\.microsoft|renderer\\.html", RegexOption.IGNORE_CASE), injects = "iframe[src*='gojbdfnpnhogfdgjbigejoaolejmgdhk'], [id*='oneNoteWebClipper'], [class*='oneNoteWebClipper'], [id*='onenote'], [class*='onenote']", gate = "a Microsoft account (its clipper asks for one)")(row, entry)
        val extra = grade.extra ?: JSONObject()
        val factor = speedFactor(entry)
        val bg = awakeBackground(row.id, factor)
        val contexts = bg?.let { getContextsProbe(it, factor) } ?: JSONObject().put("error", "no background view")
        extra.put("getContexts", contexts)
        bg?.let { extra.put("workerConsole", JSONArray(consoleOf(it).takeLast(8))) }
        val servedHits = contexts.optInt("byGetURL", -1)
        val chromeHits = contexts.optInt("byChromeSpelling", -1)
        val filterNote = "getContexts documentUrls filter: by runtime.getURL $servedHits, by chrome-extension:// $chromeHits, unfiltered ${contexts.optInt("all", -1)} (${contexts.optString("documentUrl").take(90)})"
        return when {
            grade.verdict == "F" -> Grade("F", "${grade.note}; $filterNote", extra)
            contexts.has("error") -> Grade("F", "${grade.note}; $filterNote: ${contexts.optString("error").take(120)}", extra)
            servedHits < 1 || chromeHits < 1 -> Grade("F", "${grade.note}; $filterNote: the filter misses the document in one spelling (Chrome finds it by either)", extra)
            else -> Grade(grade.verdict, "${grade.note}; $filterNote", extra)
        }
    }

    /**
     * Keplr: its provider in the page world (round 8's P), and beside it round 8's open item a:
     * its router admits a message when `new URL(sender.url).origin` equals the sender's
     * `location.origin`; on a WebView `chrome-extension://…` parses to an opaque origin
     * (`"null"`), so its popup's messages read `Invalid origin`. The popup is opened over the
     * fixture (its messages go through the router) and the worker's console read for the line;
     * the URL parse is probed in the worker too.
     */
    private fun keplr(row: Row, entry: JSONObject): Grade {
        val grade = domMarker("Keplr's provider injected into the page world", "wallet.html?keplr", "JSON.stringify({pass:!!(window.keplr&&typeof window.keplr.getOfflineSigner==='function'),keplr:typeof window.keplr,version:window.keplr?String(window.keplr.version||''):null,getOfflineSigner:typeof (window.keplr&&window.keplr.getOfflineSigner),getKeplr:typeof window.getOfflineSigner})", settleMs = 25_000)(row, entry)
        val extra = grade.extra ?: JSONObject()
        val factor = speedFactor(entry)
        val bg = awakeBackground(row.id, factor)
        val origins = bg?.let { probe(it, URL_ORIGIN_PROBE, "__zenUrlOrigin", scaled(8_000, factor)) } ?: JSONObject().put("error", "no background view")
        extra.put("urlOrigin", origins)
        val popup = openPopup(row, factor)
        if (popup != null) {
            SystemClock.sleep(scaled(6_000, factor))
            extra.put("popupText", json(tabEval(popup, DEEP_TEXT)).optString("text").take(200))
            extra.put("popupConsole", JSONArray(consoleOf(popup).takeLast(10)))
        }
        snap("${entry.optString("slug")}-popup-core")
        runCatching { coreCall("extension.closePopup", "null") }
        val workerLines = bg?.let { consoleOf(it) } ?: emptyList()
        val invalid = workerLines.count { it.contains("Invalid origin") } + (extra.optJSONArray("popupConsole")?.let { a -> (0 until a.length()).count { a.optString(it).contains("Invalid origin") } } ?: 0)
        extra.put("workerConsole", JSONArray(workerLines.takeLast(10))).put("invalidOriginLines", invalid)
        val parse = "new URL(chrome-extension URL).origin reads ${origins.optString("chromeSpelledOrigin").take(60)} against location.origin ${origins.optString("locationOrigin").take(60)}"
        return when {
            grade.verdict != "P" -> Grade(grade.verdict, "${grade.note}; $parse; Invalid origin lines $invalid", extra)
            invalid > 0 || (origins.has("chromeSpelledOrigin") && origins.optString("chromeSpelledOrigin") != origins.optString("locationOrigin")) ->
                Grade("F", "${grade.note}; its router refuses its own pages' messages: $parse ($invalid Invalid origin line(s) with the popup open)", extra)
            else -> Grade("P", "${grade.note}; $parse; no Invalid origin line with the popup open", extra)
        }
    }

    /**
     * A message from one of the extension's own pages to its worker and the `sender` the worker's
     * listener read: `sender.origin` against the literal `chrome-extension://<id>` (Scholar's
     * compare) and against the worker's own `location.origin` (Tampermonkey's), `sender.url`
     * beside them. The listener goes into the worker first; `page` is opened as a tab of the
     * extension's own and sends the probe message; the tab is closed again.
     */
    private fun senderOriginProbe(bg: WebView, row: Row, page: String, factor: Double): JSONObject {
        tabEval(bg, SENDER_ORIGIN_LISTEN)
        val tab = createTab("chrome-extension://${row.id}/$page")
        val view = waitForView(tab)
        poll(scaled(15_000, factor), 400) { if (tabEval(view, "String(document.readyState === 'complete')") == "true") true else null }
        SystemClock.sleep(scaled(1_000, factor))
        val sent = tabEval(view, "(function(){try{chrome.runtime.sendMessage({zenSenderProbe:true},function(){void chrome.runtime.lastError});return JSON.stringify({sent:true,getURL:chrome.runtime.getURL(" + JSONObject.quote(page) + "),locationOrigin:location.origin,href:location.href})}catch(e){return JSON.stringify({sent:false,error:String(e&&e.message||e)})}})()")
        val answer = poll(scaled(10_000, factor), 250) { tabEval(bg, "window.__zenSenderOrigin && window.__zenSenderOrigin.done ? JSON.stringify(window.__zenSenderOrigin) : null").takeIf { it != "null" } }?.let(::json)
            ?: JSONObject().put("error", "the worker's listener saw no message within ${scaled(10_000, factor) / 1000} s")
        answer.put("page", json(sent))
        runCatching { closeTab(tab) }
        return answer
    }

    /**
     * Google Scholar PDF Reader (round 8's row): the PDF reading of [scholarPdfReader], and the
     * two compares its worker makes in Chrome's spelling beside it: `sender.origin` against the
     * literal `chrome-extension://<id>` (its reader's port is admitted by that), and the
     * `getContexts` filter by `runtime.getURL('offscreen.html')`.
     */
    private fun scholarPdfReaderRound9(row: Row, entry: JSONObject): Grade {
        val grade = scholarPdfReader(row, entry)
        val extra = grade.extra ?: JSONObject()
        val factor = speedFactor(entry)
        val bg = awakeBackground(row.id, factor)
        val contexts = bg?.let { getContextsProbe(it, factor) } ?: JSONObject().put("error", "no background view")
        val sender = bg?.let { senderOriginProbe(it, row, "reader.html", factor) } ?: JSONObject().put("error", "no background view")
        extra.put("getContexts", contexts).put("senderOrigin", sender)
        val note = "getContexts by getURL ${contexts.optInt("byGetURL", -1)} / by chrome-extension:// ${contexts.optInt("byChromeSpelling", -1)}; a message from its own reader.html reads sender.origin ${sender.optString("origin").take(60)} (= its literal ${sender.optString("literal").take(50)}: ${sender.optBoolean("matchesLiteral")}; = the worker's location.origin: ${sender.optBoolean("matchesLocation")}) and sender.url ${sender.optString("url").take(70)}"
        return Grade(grade.verdict, "${grade.note}; $note", extra)
    }

    /**
     * Steam Inventory Helper (round 8's row): its markers on the market listing, and beside
     * them the CSS its content scripts inject: Chrome substitutes `__MSG_@@extension_id__` in a
     * content script's CSS (its `@font-face` sources are spelled that way); a rule still carrying
     * `__MSG_` is the runtime's miss (round 8's open item b).
     */
    private fun steamInventoryHelper(row: Row, entry: JSONObject): Grade {
        val grade = liveMarker("Steam Inventory Helper", "https://steamcommunity.com/market/listings/730/AK-47%20%7C%20Redline%20%28Field-Tested%29", injectedAny("(^|\\s)sih[-_]|sih-features|sih_"))(row, entry)
        val extra = grade.extra ?: JSONObject()
        val tab = extra.optString("tab").takeIf { it.isNotEmpty() } ?: tabUrls().entries.lastOrNull { it.value.contains("steamcommunity.com") }?.key
        val css = tab?.let { id -> runCatching { json(tabEval(waitForView(id), CSS_MESSAGE_SCAN)) }.getOrNull() } ?: JSONObject().put("error", "no tab")
        val console = extra.optJSONArray("console")?.let { a -> (0 until a.length()).map { a.optString(it) } } ?: emptyList()
        val fontErrors = console.count { it.contains("__MSG_") || (it.contains("font", ignoreCase = true) && (it.contains("Failed") || it.contains("404"))) }
        css.put("fontErrors", fontErrors)
        extra.put("css", css)
        val unsubstituted = css.optInt("unsubstituted", -1) + css.optInt("inlineUnsubstituted", 0).coerceAtLeast(0)
        val fonts = css.optInt("extensionFonts", -1)
        val note = "injected CSS: ${css.optInt("rules", -1)} rules in ${css.optInt("sheets", -1)} sheet(s), $unsubstituted with __MSG_ left in, $fonts @font-face source(s) on the extension's origin; font errors in the console $fontErrors"
        return when {
            grade.verdict == "P" && unsubstituted > 0 -> Grade("F", "${grade.note}; $note (Chrome substitutes @@extension_id)", extra)
            else -> Grade(grade.verdict, "${grade.note}; $note", extra)
        }
    }

    /**
     * Language Reactor (round 8's row, its 113 `DOMException`): the tablet-width reading, then
     * the `window.postMessage` its `runtime.onMessage` listener makes, probed in the
     * extension's content scope of the watch page (the `with` scope without worlds, the isolated
     * world with them) in four spellings – `window.postMessage`, a bare `postMessage`,
     * `self.postMessage`, and the page world's own for the control – each with a parsed object
     * and `"*"`; the console lines of the runtime's `listener threw` are collected too.
     */
    private fun languageReactor(row: Row, entry: JSONObject): Grade {
        val grade = youtubeTablet(row, entry, injectedAny("lln|language-reactor|languagereactor|lr-"), "Language Reactor's controls on a watch page")
        val extra = grade.extra ?: JSONObject()
        val tab = extra.optJSONObject("youtube")?.optString("tab")?.takeIf { it.isNotEmpty() } ?: tabUrls().entries.lastOrNull { it.value.contains("youtube.com") }?.key
        val view = tab?.let { runCatching { waitForView(it) }.getOrNull() }
        if (view != null) {
            val scoped = scopeEval(view, row.id, POST_MESSAGE_PROBE)
            extra.put("postMessageInScope", scoped?.let { json(it) } ?: JSONObject.NULL)
            extra.put("postMessageInPage", json(tabEval(view, "(function(){try{window.postMessage({topic:'LR_PS_probe',loggedIn:false},'*');return JSON.stringify({ok:true})}catch(e){return JSON.stringify({ok:false,error:String(e&&e.name)+': '+String(e&&e.message)})}})()")))
            val lines = consoleOf(view)
            extra.put("listenerThrew", JSONArray(lines.filter { it.contains("listener threw") || it.contains("DOMException") }.takeLast(8)))
            // Blink prints the unsanitized line (the frame origin the access was blocked against) to the console.
            extra.put("blockedFrameLines", JSONArray(lines.filter { it.contains("Blocked a frame") || it.contains("SecurityError") }.takeLast(6)))
        }
        val scoped = extra.optJSONObject("postMessageInScope")
        val threw = extra.optJSONArray("listenerThrew")?.length() ?: 0
        val probeNote = when {
            scoped == null -> "postMessage in the content scope: not probed (${if (view == null) "no watch tab" else "no scope answered"})"
            scoped.has("e") -> "postMessage in the content scope threw ${scoped.optString("e").take(120)}"
            else -> "postMessage in the content scope: ${scoped.optJSONObject("v")?.toString()?.take(220) ?: scoped.toString().take(220)}"
        }
        return Grade(grade.verdict, "${grade.note}; $probeNote; $threw listener-threw line(s) in the page console", extra)
    }

    /**
     * Instrumentation only: `script` in `ext`'s content scope on `view`'s main frame the way
     * `scripting.executeScript` runs it – the isolated world where the WebView has one, else
     * the `with` scope proxy through the bootstrap – as the guarded JSON (`{"v": …}` or
     * `{"e": …}`), or null when nothing answered.
     */
    private fun scopeEval(view: WebView, ext: String, script: String, timeoutSeconds: Long = 15): String? {
        val latch = CountDownLatch(1)
        var value: String? = null
        instrumentation.runOnMainSync {
            host.extensions.evalInScope(view, ext, script) { raw ->
                value = raw
                latch.countDown()
            }
        }
        latch.await(timeoutSeconds, TimeUnit.SECONDS)
        return value
    }

    // --- the core checks of compat round 10 (ranks 211-240 by installs) --------------------------

    /** The bridge's `reply error=` lines in `trace` (the layer's refusals), the "not implemented" ones apart. */
    private fun bridgeErrors(trace: List<String>): Pair<List<String>, List<String>> {
        val errors = trace.filter { " reply error=" in it }.map { it.substringAfter(" reply ").take(120) }
        return errors to errors.filter { NOT_IMPLEMENTED_WORDS.containsMatchIn(it) }
    }

    /**
     * Clear Cache: its action click runs `browsingData.remove` for its default set and reloads
     * the active tab (`reloadOnClear`, on by default), after a confirmation since 2.4: the action
     * opens its popup, which moves into the tab as an iframe and shows what will be cleared with
     * a Clear button. Over a settled fixture tab the click is made, a `permissions.request` prompt
     * it may raise first is accepted, the confirmation's Clear is taken (in the popup while it is
     * up, in the iframe through the accessibility tree), and the tab's `performance.timeOrigin`
     * moving is the reload: the pass. "Could not perform clear" in its worker (the API missing or
     * refusing) is `F`, ours, with the line and the bridge's errors; a click that neither reloaded
     * nor logged is `F` with the trace and the confirmation's state.
     */
    private fun clearCache(row: Row, entry: JSONObject): Grade {
        val factor = speedFactor(entry)
        val extra = JSONObject()
        val (_, view) = fixture("page-a.html?clear", factor, 2_000)
        val originBefore = tabEval(view, "String(performance.timeOrigin)")
        extra.put("timeOriginBefore", originBefore)
        val since = StepEvidence(row)
        coreCall("extension.openPopup", """{"id":${JSONObject.quote(row.id)},"anchor":{"x":0,"y":0,"width":0,"height":0}}""")
        extra.put("prompt", acceptPrompt(factor, 5_000))
        // Clear Cache 2.4 (April 2026) confirms before it clears, in Chrome too: the action opens
        // its popup, which moves into the tab as an iframe of the extension's origin when the tab
        // takes a script (`popup.mode` "popup" still: the popup closes itself once the iframe is
        // in) and waits for Clear. The popup's document is the driver's to click while it is up;
        // the iframe is another origin's frame in the tab's WebView, so its Clear is tapped
        // through the accessibility tree, which Chromium exposes across frames. Both are looked
        // for until the tab reloads or the wait runs out; the confirmation taken is recorded.
        // The iframe sits in an open shadow root (`[data-clear-cache]` > #shadow-root > iframe),
        // where a plain `document.querySelector` never found it (compat round 10, row 03: the
        // frame stood sized on screen while the driver read "no iframe"); the query walks the
        // shadow roots, and the frame's rect is sampled each round – the tab's side of the
        // `cc-resize` exchange – with the accessibility nodes inside it, for the trace.
        val iframeSelector = JSONObject.quote("iframe[src*=\"${row.id}\"]")
        val iframeExpr = "(function(){var sel=$iframeSelector;var find=function(root){var f=root.querySelector(sel);if(f)return f;var all=root.querySelectorAll('*');for(var i=0;i<all.length;i++){if(all[i].shadowRoot){var r=find(all[i].shadowRoot);if(r)return r}}return null};" +
            "var f=find(document);if(!f)return JSON.stringify({host:!!document.querySelector('[data-clear-cache]')});var r=f.getBoundingClientRect();return JSON.stringify({w:r.width,h:r.height,x:r.left,y:r.top,dpr:window.devicePixelRatio,src:String(f.src).slice(0,120)})})()"
        val frameSamples = JSONArray()
        val confirmed = poll(scaled(15_000, factor), 500) {
            val now = runCatching { tabEval(view, "String(performance.timeOrigin)") }.getOrNull()
            if (!now.isNullOrEmpty() && now != "null" && now != originBefore) return@poll JSONObject().put("reloadedFirst", now)
            popupView()?.let { popup ->
                val clicked = json(
                    tabEval(
                        popup,
                        "(function(){var b=Array.prototype.slice.call(document.querySelectorAll('button, [role=\"button\"]')).filter(function(e){var r=e.getBoundingClientRect();return r.width>8&&r.height>8&&/^\\s*clear\\s*$/i.test(e.textContent||'')});" +
                            "if(!b.length)return JSON.stringify({clicked:false});var r=b[0].getBoundingClientRect();try{b[0].click()}catch(e){}return JSON.stringify({clicked:true,x:r.left+r.width/2,y:r.top+r.height/2})})()"
                    )
                )
                if (clicked.optBoolean("clicked")) {
                    screenPoint(popup, clicked)?.let { tap(it.first, it.second) }
                    return@poll JSONObject().put("popupClear", clicked)
                }
            }
            val iframe = json(tabEval(view, iframeExpr))
            if (frameSamples.length() < 40) frameSamples.put(JSONObject().put("t", SystemClock.uptimeMillis()).put("frame", iframe))
            if (iframe.has("w")) {
                val button = nodes { node ->
                    val label = (node.text ?: node.contentDescription)?.toString()?.trim().orEmpty()
                    label.equals("Clear", ignoreCase = true) && (node.isClickable || node.className == "android.widget.Button")
                }.firstOrNull()
                if (button != null) {
                    val bounds = Rect().also(button::getBoundsInScreen)
                    snap("${entry.optString("slug")}-confirm")
                    tapRect(bounds)
                    return@poll JSONObject().put("iframeClear", bounds.flattenToString()).put("iframe", iframe)
                }
            }
            null
        }
        extra.put("frameSamples", frameSamples)
        if (confirmed == null) {
            // What the accessibility tree had where the frame stood, for the trace of a miss.
            val last = (0 until frameSamples.length()).map { frameSamples.getJSONObject(it).getJSONObject("frame") }.lastOrNull { it.has("w") }
            if (last != null) {
                val labels = nodes { node -> !(node.text ?: node.contentDescription).isNullOrBlank() }
                    .map { node -> Rect().also(node::getBoundsInScreen).flattenToString() + " " + ((node.text ?: node.contentDescription)?.toString()?.trim()?.take(40) ?: "") }
                extra.put("a11yLabels", JSONArray(labels.take(40)))
            }
        }
        extra.put("confirmation", confirmed ?: JSONObject().put("none", "no Clear in the popup or the tab's accessibility tree within ${scaled(15_000, factor) / 1000} s"))
        val reloaded = confirmed?.optString("reloadedFirst")?.takeIf { it.isNotEmpty() } ?: poll(scaled(25_000, factor), 500) {
            val now = runCatching { tabEval(view, "String(performance.timeOrigin)") }.getOrNull()
            if (!now.isNullOrEmpty() && now != "null" && now != originBefore) now else null
        }
        extra.put("timeOriginAfter", reloaded ?: JSONObject.NULL)
        val console = backgroundView(row.id)?.let { consoleOf(it).takeLast(20) } ?: emptyList()
        val failed = console.lastOrNull { it.contains("Could not perform clear") }
        extra.put("workerConsole", JSONArray(console))
        since.record(extra, "atEnd")
        val trace = since.trace()
        val calls = trace.count { " call browsingData." in it }
        val (errors, notImplemented) = bridgeErrors(trace)
        extra.put("browsingDataCalls", calls).put("bridgeErrors", JSONArray(errors.take(6)))
        popupView()?.let { extra.put("popupInstead", json(tabEval(it, DEEP_TEXT)).optString("text").take(160)) }
        runCatching { coreCall("extension.closePopup", "null") }
        SystemClock.sleep(600)
        snap("${entry.optString("slug")}-clear")
        return when {
            reloaded != null && failed == null && notImplemented.isEmpty() ->
                Grade("P", "Clear Cache: the action click cleared its default set ($calls browsingData call(s) on the bridge, ${errors.size} refused) and reloaded the tab (timeOrigin $originBefore -> $reloaded; confirmation ${confirmed?.keys()?.next() ?: "none"})", extra)
            failed != null || notImplemented.isNotEmpty() ->
                Grade("F", "Clear Cache: ${failed?.let { "its worker logged \"${it.take(160)}\"" } ?: "the bridge refused ${notImplemented.first()}"}; $calls browsingData call(s), tab ${if (reloaded != null) "reloaded" else "not reloaded"}", extra)
            else -> Grade("F", "Clear Cache: the action click neither reloaded the tab within ${scaled(25_000, factor) / 1000} s nor logged an error ($calls browsingData call(s), bridge errors ${errors.take(2)}; confirmation ${extra.optJSONObject("confirmation")?.toString()?.take(120)}; prompt ${extra.optJSONObject("prompt")?.toString()?.take(100)})", extra)
        }
    }

    /**
     * A window-layout row (Tab Resize's layout grid, Dualless's split ratios): its popup control
     * has the worker arrange the open tabs into new windows (`windows.create` with a tab id and a
     * frame, `windows.update`, `system.display.getInfo`). The phone has one window to give, so
     * the layout itself is `n/a`; what is measured is the popup rendering its controls, the click
     * running the flow through the bridge without a refusal (`windows.create` / `update` /
     * `getAll` and `system.display.getInfo` answering Chrome's shapes), and the tabs still open
     * after it. A "not implemented" refusal or an uncaught error in the worker is `F`, ours.
     */
    private fun windowLayout(label: String, selector: String): (Row, JSONObject) -> Grade = { row, entry ->
        val factor = speedFactor(entry)
        val extra = JSONObject()
        fixture("page-b.html?layout", factor, 1_000)
        fixture("page-a.html?layout", factor, 1_500)
        val tabsBefore = tabUrls()
        val since = StepEvidence(row)
        val popup = openPopup(row, factor)
        var click = JSONObject().put("clicked", false)
        if (popup != null) {
            SystemClock.sleep(scaled(2_500, factor))
            extra.put("popupText", json(tabEval(popup, DEEP_TEXT)).optString("text").take(200))
            click = json(
                tabEval(
                    popup,
                    "(function(){var sel=${JSONObject.quote(selector)};var all=Array.prototype.slice.call(document.querySelectorAll(sel)).filter(function(e){var r=e.getBoundingClientRect();return r.width>8&&r.height>8});" +
                        "var hit=all[0]||null;if(!hit)return JSON.stringify({clicked:false,matched:document.querySelectorAll(sel).length});var r=hit.getBoundingClientRect();try{hit.click()}catch(e){}return JSON.stringify({clicked:true,tag:hit.tagName,cls:String(hit.className).slice(0,60),n:all.length,x:r.left+r.width/2,y:r.top+r.height/2})})()"
                )
            )
            if (click.optBoolean("clicked")) {
                screenPoint(popup, click)?.let { tap(it.first, it.second) }
                SystemClock.sleep(scaled(5_000, factor))
            }
            extra.put("popupConsole", JSONArray(consoleOf(popup).takeLast(8)))
        }
        extra.put("click", click)
        snap("${entry.optString("slug")}-layout")
        since.record(extra, "atEnd")
        val trace = since.trace()
        val windowCalls = trace.filter { " call windows." in it || " call system.display." in it }.map { it.substringAfter(" call ") }
        val (errors, notImplemented) = bridgeErrors(trace)
        val workerErrors = backgroundView(row.id)?.let { consoleOf(it).filter(::isUncaught).takeLast(3) } ?: emptyList()
        extra.put("windowCalls", JSONArray(windowCalls.take(12))).put("bridgeErrors", JSONArray(errors.take(6))).put("workerUncaught", JSONArray(workerErrors))
        val tabsAfter = tabUrls()
        extra.put("tabsAfter", JSONArray(tabsAfter.values.toList()))
        runCatching { coreCall("extension.closePopup", "null") }
        val note = "popup ${if (popup == null) "absent" else "rendered"}, control ${click.toString().take(100)}; window calls ${windowCalls.groupingBy { it }.eachCount()}; bridge errors ${errors.take(3)}; tabs ${tabsBefore.size} -> ${tabsAfter.size}"
        when {
            popup == null -> Grade("F", "$label: popup did not render in the core check: $note", extra)
            !click.optBoolean("clicked") -> Grade("F", "$label: no $selector control in the popup: $note", extra)
            notImplemented.isNotEmpty() -> Grade("F", "$label: the bridge refused a window call: ${notImplemented.first()}; $note", extra)
            workerErrors.isNotEmpty() -> Grade("F", "$label: its worker threw after the click: ${workerErrors.last().take(160)}; $note", extra)
            windowCalls.isEmpty() -> Grade("F", "$label: the click reached no window call within ${scaled(5_000, factor) / 1000} s: $note", extra)
            else -> Grade("n/a", "$label: the click ran its layout through ${windowCalls.size} window call(s) without a refusal; the phone has one window to lay tabs out in, so the arrangement itself has nowhere to go (WebView limit): $note", extra)
        }
    }

    /**
     * A row whose popup control opens a web page of a service for the current tab (Lighthouse's
     * "Generate report" opens PageSpeed Insights on the tab's address): the popup opens over a
     * settled fixture tab, the control is pressed, and a new tab on `opens` is the pass; the
     * report itself is the service's.
     */
    private fun popupOpens(label: String, clickWords: String, opens: Regex): (Row, JSONObject) -> Grade = { row, entry ->
        val factor = speedFactor(entry)
        val extra = JSONObject()
        fixture("page-a.html?opens", factor, 2_000)
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
        var opened = poll(scaled(15_000, factor), 500) { tabUrls().entries.firstOrNull { it.key !in before && opens.containsMatchIn(it.value) } }
        if (opened == null && click.optBoolean("clicked") && popupView() != null) {
            extra.put("clickedByScript", tabEval(popup!!, CLICK_TARGET_SYNTH))
            opened = poll(scaled(15_000, factor), 500) { tabUrls().entries.firstOrNull { it.key !in before && opens.containsMatchIn(it.value) } }
        }
        extra.put("tabsAfter", JSONArray(tabUrls().values.toList()))
        snap("${entry.optString("slug")}-opens")
        runCatching { coreCall("extension.closePopup", "null") }
        Grade(
            if (opened != null) "P" else "F",
            "$label: popup ${if (popup == null) "did not render" else "control ${click.toString().take(90)}"}; ${if (opened == null) "no ${opens.pattern} tab opened within ${scaled(30_000, factor) / 1000} s (tabs: ${tabUrls().values.joinToString().take(120)})" else "opened ${opened.value.take(120)}"}",
            extra
        )
    }

    /**
     * Redux DevTools: its page-world script (`page.bundle.js`, a MAIN-world content script at
     * document start) puts `__REDUX_DEVTOOLS_EXTENSION__` on the page before the store runs; the
     * fixture connects a store through it, inits and sends one action. The hook there and the
     * store connected is the page side; the popup (`devpanel.html#popup`, the monitor the
     * DevTools panel shows, which the phone has no DevTools to host) listing the fixture's store
     * or action is the pass, the hook alone `PARTIAL`.
     */
    private fun reduxDevTools(row: Row, entry: JSONObject): Grade {
        val hook = domMarker(
            "Redux DevTools' page hook", "redux.html?redux",
            "JSON.stringify({pass:!!(window.__redux&&window.__redux.hook&&window.__redux.connected&&!window.__redux.error),redux:window.__redux||null,hook:typeof window.__REDUX_DEVTOOLS_EXTENSION__,compose:typeof window.__REDUX_DEVTOOLS_EXTENSION_COMPOSE__})",
            settleMs = 25_000
        )(row, entry)
        if (hook.verdict != "P") return hook
        val factor = speedFactor(entry)
        val extra = hook.extra ?: JSONObject()
        val popup = openPopup(row, factor)
        var found = JSONObject()
        if (popup != null) {
            found = pollExpr(popup, "(function(){var t=(document.body?document.body.innerText:'').replace(/\\s+/g,' ').trim();return JSON.stringify({pass:/INCREMENT|@@INIT|Zenium sweep store/i.test(t),text:t.slice(0,160),els:document.body?document.body.querySelectorAll('*').length:0})})()", scaled(20_000, factor))
            found.put("console", JSONArray(consoleOf(popup).takeLast(10)))
        }
        extra.put("popup", found)
        SystemClock.sleep(600)
        snap("${entry.optString("slug")}-monitor")
        runCatching { coreCall("extension.closePopup", "null") }
        return Grade(
            if (found.optBoolean("pass")) "P" else "PARTIAL",
            "${hook.note.take(200)}; popup monitor ${if (popup == null) "did not render" else found.toString().take(160)}",
            extra
        )
    }

    /**
     * EPUBReader: its static ruleset redirects any `.epub` main-frame address to its
     * `reader.html?filename=<address>` (a `regexSubstitution` with `\0`), and the reader fetches
     * the book and draws the chapter in its `#content_frame`. The fixture book opens in a tab;
     * the tab landing on the reader is the redirect, the chapter's heading in the reader (its
     * frame, or the page) is the pass. A tab left on the raw file is the DNR gap, `F`; the reader
     * up without the chapter is `PARTIAL`.
     */
    private fun epubReader(row: Row, entry: JSONObject): Grade {
        val factor = speedFactor(entry)
        val extra = JSONObject()
        val since = StepEvidence(row)
        val tab = createTab("$BASE/sample.epub")
        val landed = poll(scaled(30_000, factor), 500) { tabUrls()[tab]?.takeIf { extensionPage(it, row.id) } }
        extra.put("landed", landed ?: JSONObject.NULL).put("tabUrl", tabUrls()[tab] ?: JSONObject.NULL)
        var found = JSONObject()
        if (landed != null) {
            val view = waitForView(tab)
            showTab(tab)
            found = pollExpr(
                view,
                "(function(){var f=document.getElementById('content_frame');var inner='';try{inner=f&&f.contentDocument&&f.contentDocument.body?f.contentDocument.body.innerText:''}catch(e){inner='cross-origin: '+e.message}" +
                    "var outer=document.body?document.body.innerText:'';var text=(inner+' '+outer).replace(/\\s+/g,' ').trim();return JSON.stringify({pass:/Probe Chapter One/.test(text),frame:!!f,frameSrc:f?String(f.src||f.getAttribute('src')||'').slice(0,80):null,inner:inner.replace(/\\s+/g,' ').trim().slice(0,120),outer:outer.replace(/\\s+/g,' ').trim().slice(0,120),title:document.title})})()",
                scaled(40_000, factor)
            )
            found.put("console", JSONArray(consoleOf(view).takeLast(10)))
            if (!found.optBoolean("pass")) extra.put("blankTab", blankPageEvidence(view, row, 0L))
        }
        extra.put("reader", found)
        since.record(extra, "atEnd")
        SystemClock.sleep(800)
        snap("${entry.optString("slug")}-reader")
        return when {
            found.optBoolean("pass") -> Grade("P", "EPUBReader: sample.epub redirected to ${extensionPath(landed!!).take(60)} and the reader drew the chapter (\"${found.optString("inner").ifEmpty { found.optString("outer") }.take(80)}\")", extra)
            landed != null -> Grade("PARTIAL", "EPUBReader: sample.epub redirected to ${extensionPath(landed).take(60)} but the reader showed no chapter within ${scaled(40_000, factor) / 1000} s: ${found.toString().take(200)}", extra)
            else -> Grade("F", "EPUBReader: the tab stayed on ${tabUrls()[tab]?.take(80)} for ${scaled(30_000, factor) / 1000} s (its declarativeNetRequest redirect to reader.html did not fire)", extra)
        }
    }

    // --- the core checks of compat round 12 (ranks 241-270 by installs) --------------------------

    /**
     * A row whose whole surface is a page of its own (Secure Shell's terminal, `html/nassh.html`:
     * hterm draws its connection dialog in a tab): the page is opened as a tab and `expr` (a
     * `JSON.stringify` of `{pass, ...}`) polled in it. A drawn page whose core needs what the
     * phone has not got (`gate`: an SSH host to connect to) is `n/m` on that line; a page that
     * stays blank is F, with the blank tab's evidence.
     */
    private fun ownPage(label: String, page: String, expr: String, gate: String? = null, settleMs: Long = 30_000): (Row, JSONObject) -> Grade = { row, entry ->
        val factor = speedFactor(entry)
        val extra = JSONObject()
        val since = StepEvidence(row)
        val tab = createTab("chrome-extension://${row.id}/$page")
        val view = waitForView(tab)
        val found = pollExpr(view, expr, scaled(settleMs, factor))
        found.put("console", JSONArray(consoleOf(view).takeLast(10)))
        extra.put("page", found).put("url", (tabUrls()[tab] ?: "").take(160))
        if (!found.optBoolean("pass")) extra.put("blankTab", blankPageEvidence(view, row, 0L))
        since.record(extra, "atEnd")
        SystemClock.sleep(800)
        snap("${entry.optString("slug")}-own-page-core")
        when {
            found.optBoolean("pass") && gate != null -> Grade("n/m", "$label: its $page renders as a tab (${found.toString().take(200)}); the core needs $gate (not measurable here)", extra)
            found.optBoolean("pass") -> Grade("P", "$label: its $page renders as a tab: ${found.toString().take(220)}", extra)
            else -> Grade("F", "$label: its $page as a tab ${found.toString().take(220)}", extra)
        }
    }

    /**
     * A media sniffer's popup over `page` with its clip playing (CocoCut's and Chrono's over
     * `video.html`'s mp4, FetchV's over `hls.html`'s playlist): the popup opened, an optional
     * control tapped first (`panel`, a label regex: Chrono's resource sniffer), and the listing
     * (`listing`, a JS regex literal over the popup's text) polled. These list what their content
     * script or `webRequest` saw, no vendor service in between (Video Downloader Plus's reading of
     * round 9 has one), so a popup that lists nothing is F, with the worker's console beside it.
     * With `probe`, the [WebRequestProbe] measures what the runtime's `webRequest` gave the
     * sniffer while the page loaded (compat round 13's item 4), and a failing grade carries the
     * measurement beside `listener`, the events the sniffer asked for (read off its code).
     */
    private fun mediaPopup(label: String, page: String, listing: String, panel: String? = null, settleMs: Long = 25_000, probe: Boolean = false, listener: String? = null): (Row, JSONObject) -> Grade = { row, entry ->
        val factor = speedFactor(entry)
        val extra = JSONObject()
        val webRequest = if (probe) WebRequestProbe(row, factor).also { it.start() } else null
        val (fixtureTab, view) = fixture(page, factor, 2_500)
        runCatching { tabEval(view, "(function(){var v=document.querySelector('video');if(v){v.muted=true;v.play().catch(function(){})}return 'played'})()") }
        webRequest?.let { extra.put("webRequest", it.read(view)) }
        SystemClock.sleep(scaled(5_000, factor))
        extra.put("fixture", json(tabEval(view, "(function(){var v=document.querySelector('video');return JSON.stringify({video:v?(v.paused?'paused':'playing'):'none',src:v?(v.currentSrc||v.src||'').slice(-48):null,readyState:document.readyState})})()")))
        showTab(fixtureTab)
        val since = StepEvidence(row)
        val popup = openPopup(row, factor)
        val steps = JSONArray()
        var found = JSONObject()
        if (popup != null) {
            SystemClock.sleep(scaled(3_000, factor))
            extra.put("popupFirst", json(tabEval(popup, DEEP_TEXT)).optString("text").take(200))
            if (panel != null) tapLabel(panel, factor, steps, "panel")
            popupView()?.takeIf { it.context == "popup" }?.let { live ->
                found = pollExpr(live, DEEP_TEXT.replace("return JSON.stringify({text:", "return JSON.stringify({pass:$listing.test(text)&&!/no (video|media|download)s? (found|detected|yet)/i.test(text.slice(0,80)),controls:document.querySelectorAll('a[download], [class*=\"download\"], [id*=\"download\"], button').length,text:"), scaled(settleMs, factor))
                found.put("console", JSONArray(consoleOf(live).takeLast(10)))
            }
        }
        extra.put("steps", steps).put("popup", found)
        backgroundView(row.id)?.let { extra.put("workerConsole", JSONArray(consoleOf(it).takeLast(8))) }
        since.record(extra, "atEnd")
        SystemClock.sleep(600)
        snap("${entry.optString("slug")}-media-popup")
        runCatching { coreCall("extension.closePopup", "null") }
        webRequest?.stop()
        val measured = webRequest?.let { "; its sniffer listens to ${listener ?: "webRequest"}; the runtime gave it: ${it.summary()}" } ?: ""
        when {
            found.optBoolean("pass") -> Grade("P", "$label: popup over the playing clip lists it: ${found.toString().take(220)}${if (webRequest != null) "; measured: ${webRequest.summary()}" else ""}", extra)
            popup == null -> Grade("F", "$label: popup did not render in the core check$measured", extra)
            else -> Grade("F", "$label: popup over the playing clip lists no clip: ${found.toString().take(220)}$measured", extra)
        }
    }

    /**
     * What the runtime's `webRequest` gives a media sniffer today, measured while a page loads
     * (compat round 13's item 4, rows 28 Chrono Download Manager and C6 Video Downloader PLUS,
     * over `media.html`: one clip in `Range` pieces with a seek for its tail, the same clip under
     * an extension-less URL, one XHR and one `fetch`). Two listeners record it. The extension's
     * own background registers one on every `chrome.webRequest` event (`requestHeaders` asked of
     * the request stage, `responseHeaders` of the response stage) and keeps what it hears: the
     * events the runtime emits, the `type` each carries, whether the headers came. Beside it, an
     * `onSendHeaders` listener on the request engine ([Blocking.addListener], the desktop-parity
     * registry over `shouldInterceptRequest`) keeps, per request, the header names WebView hands
     * the embedder and the type the engine inferred – which is where a media load's type comes
     * from (`ResourceType.guessKnown`: the main-frame flag, `Accept`, the URL's extension; a
     * `Sec-Fetch-Dest` the embedder never sees cannot be read). [read] waits for the page to have
     * played, seeked and fetched and takes both records; [stop] removes both listeners (the
     * background's registrations are the extension's persisted listeners until then).
     */
    private inner class WebRequestProbe(private val row: Row, private val factor: Double) {
        val result = JSONObject()
        private val engineSeen = java.util.Collections.synchronizedList(ArrayList<JSONObject>())
        private var removeEngine: (() -> Unit)? = null

        fun start() {
            val bg = awakeBackground(row.id, factor)
            result.put("background", if (bg == null) JSONObject().put("error", "no background view") else json(tabEval(bg, WEBREQ_PROBE_START)))
            val listener = WebRequestListener { d ->
                if (engineSeen.size < 80) {
                    val headers = d.requestHeaders ?: emptyMap()
                    fun header(name: String): String? = headers.entries.firstOrNull { it.key.equals(name, ignoreCase = true) }?.value
                    engineSeen.add(
                        JSONObject().put("url", d.url.takeLast(60)).put("type", d.resourceType.dnrName).put("method", d.method)
                            .put("headers", JSONArray(headers.keys.sorted()))
                            .put("accept", header("Accept")?.take(60))
                            .put("range", header("Range"))
                            .put("secFetchDest", header("Sec-Fetch-Dest"))
                    )
                }
                null
            }
            removeEngine = host.blocking.addListener(WebRequestEvent.ON_SEND_HEADERS, listener, ListenerOptions(registrant = "compat-sweep-probe"))
        }

        /** Both records once `view`'s page played, seeked and fetched (or the wait ran out), with the [summary]. */
        fun read(view: WebView): JSONObject {
            val page = poll(scaled(25_000, factor), 500) {
                val s = json(tabEval(view, MEDIA_STATE))
                if (s.optBoolean("playing") && s.optInt("seeked") > 0 && !s.isNull("xhr") && !s.isNull("fetch") && (s.optBoolean("streamMeta") || s.has("streamError"))) s else null
            } ?: json(tabEval(view, MEDIA_STATE))
            SystemClock.sleep(scaled(2_000, factor))
            result.put("page", page)
            backgroundView(row.id)?.let { result.put("events", json(tabEval(it, WEBREQ_PROBE_READ))) }
            result.put("engine", JSONArray(engineSeen.toList()))
            result.put("headProbe", headProbe(listOf("$BASE/clip.mp4", "$BASE/stream?clip=2", "$BASE/data.json?xhr=1")))
            result.put("summary", summary())
            return result
        }

        /**
         * The cost of the alternative the engine ask weighs against a response-stage relay – a
         * runtime-side `HEAD` of each observed load, doubling the requests: its wall time from
         * this process to the fixture server and what it answered (status, content-type,
         * content-length, `Accept-Ranges`), per URL of the page.
         */
        private fun headProbe(urls: List<String>): JSONArray {
            val out = JSONArray()
            for (url in urls) {
                val started = SystemClock.uptimeMillis()
                val entry = JSONObject().put("url", url.takeLast(40))
                runCatching {
                    val connection = java.net.URL(url).openConnection() as java.net.HttpURLConnection
                    connection.requestMethod = "HEAD"
                    connection.connectTimeout = 5_000
                    connection.readTimeout = 5_000
                    entry.put("status", connection.responseCode).put("contentType", connection.contentType)
                        .put("contentLength", connection.getHeaderField("Content-Length")).put("acceptRanges", connection.getHeaderField("Accept-Ranges"))
                    connection.disconnect()
                }.onFailure { entry.put("error", it.toString().take(80)) }
                entry.put("ms", SystemClock.uptimeMillis() - started)
                out.put(entry)
            }
            return out
        }

        fun stop() {
            removeEngine?.invoke()
            removeEngine = null
            backgroundView(row.id)?.let { runCatching { tabEval(it, WEBREQ_PROBE_STOP, 5) } }
        }

        /** One line per load of the page: the events the extension heard (with the type each carried) and what the engine saw of the request. */
        fun summary(): String {
            val events = result.optJSONObject("events")?.optJSONArray("events") ?: JSONArray()
            val heard = (0 until events.length()).map { events.getJSONObject(it) }
            val engine = result.optJSONArray("engine") ?: JSONArray()
            val seen = (0 until engine.length()).map { engine.getJSONObject(it) }
            val loads = listOf("clip.mp4" to Regex("clip\\.mp4"), "stream (no extension)" to Regex("/stream"), "XHR" to Regex("data\\.json\\?xhr"), "fetch" to Regex("data\\.json\\?fetch"))
            val parts = loads.map { (name, re) ->
                val own = heard.filter { re.containsMatchIn(it.optString("url")) }
                val byEvent = own.groupBy { it.optString("ev") }.entries.joinToString(" ") { (ev, list) -> "$ev(${list.map { it.optString("type") }.distinct().joinToString("|")})x${list.size}" }
                val e = seen.firstOrNull { re.containsMatchIn(it.optString("url")) }
                val request = e?.let { "engine type ${it.optString("type")}, Accept ${it.optString("accept", "-")}, Range ${it.optString("range", "absent")}, Sec-Fetch-Dest ${it.optString("secFetchDest", "absent")}" } ?: "the engine saw no request"
                "$name: ${if (own.isEmpty()) "the extension heard nothing" else "heard $byEvent"}; $request"
            }
            val responseStage = heard.count { it.optString("ev") in RESPONSE_STAGE_EVENTS }
            val background = result.optJSONObject("background")
            val registered = background?.opt("registered")?.toString() ?: "?"
            return "$registered events registered; ${parts.joinToString("; ")}; response-stage events heard: $responseStage" +
                (result.optJSONObject("events")?.optJSONArray("errors")?.takeIf { it.length() > 0 }?.let { "; errors $it" } ?: "")
        }
    }

    /**
     * A JSON viewer (JSONVue): `data.json`, served as `application/json`, is re-rendered by its
     * content script – the WebView's own `<pre>` hidden behind a tree of keyed, collapsible
     * nodes. The tree is the pass: elements beyond the `<pre>`, the fixture's keys as nodes of
     * their own, the raw `<pre>` no longer the one thing shown.
     */
    private fun jsonViewer(label: String): (Row, JSONObject) -> Grade = { row, entry ->
        val factor = speedFactor(entry)
        val tab = createTab("$BASE/data.json")
        val view = waitForView(tab)
        val found = pollExpr(view, JSON_TREE, scaled(20_000, factor))
        val extra = JSONObject().put("page", found).put("console", JSONArray(consoleOf(view).takeLast(10)))
        if (worlds) worldEval(view, row.id, WORLD_REPORT)?.let { extra.put("world", json(it)) }
        if (!found.optBoolean("pass")) extra.put("errors", targetErrors(view))
        SystemClock.sleep(600)
        snap("${entry.optString("slug")}-json-core")
        Grade(if (found.optBoolean("pass")) "P" else "F", "$label: JSON document re-rendered: ${found.toString().take(240)}", extra)
    }

    /**
     * A cursor pack (Cute Cursors, Custom Cursor's kin): a pack card tapped in the popup writes
     * the choice to storage, and its content script on the fixture page sets `cursor: url(...)`
     * on the document (a `<style>` of its own, or html / body's style): that computed style is
     * the pass, as [customCursor] reads Custom Cursor's `#custom-cursor` (the phone has no
     * pointer to draw it with; the style is the effect). Every pack thumbnail broken in the
     * popup names the vendor's CDN refusing the runner, nothing to pick: `n/m`.
     */
    private fun cursorPack(label: String): (Row, JSONObject) -> Grade = { row, entry ->
        val factor = speedFactor(entry)
        val extra = JSONObject()
        val (_, view) = fixture("page-a.html?cursorpack", factor)
        val popup = openPopup(row, factor)
        var pick = JSONObject().put("clicked", false)
        var thumbs = JSONObject()
        if (popup != null) {
            SystemClock.sleep(scaled(4_000, factor))
            pick = poll(scaled(8_000, factor), 1_000) { json(tabEval(popup, CURSOR_PICK)).takeIf { it.optBoolean("clicked") } } ?: json(tabEval(popup, CURSOR_PICK))
            // The click as a finger too: a card may listen for pointer events, not click.
            if (pick.optBoolean("clicked")) tapSettled(popup, pick, factor)?.let { pick.put("tap", it) }
            thumbs = json(tabEval(popup, "(function(){var imgs=Array.prototype.slice.call(document.querySelectorAll('img'));return JSON.stringify({thumbs:imgs.length,broken:imgs.filter(function(i){return i.complete&&i.naturalWidth===0}).length})})()"))
            extra.put("popupText", json(tabEval(popup, DEEP_TEXT)).optString("text").take(200)).put("popupConsole", JSONArray(consoleOf(popup).takeLast(8))).put("thumbs", thumbs)
        }
        extra.put("pick", pick)
        val found = pollExpr(view, CURSOR_URL, scaled(14_000, factor))
        extra.put("page", found).put("console", JSONArray(consoleOf(view).takeLast(10)))
        if (worlds) worldEval(view, row.id, WORLD_REPORT)?.let { extra.put("world", json(it)) }
        SystemClock.sleep(600)
        snap("${entry.optString("slug")}-cursor-popup")
        runCatching { coreCall("extension.closePopup", "null") }
        val cdnRefused = thumbs.optInt("thumbs", 0) > 2 && thumbs.optInt("broken", 0) == thumbs.optInt("thumbs", 0)
        when {
            found.optBoolean("pass") -> Grade("P", "$label: popup picked ${pick.toString().take(100)}; fixture page cursor ${found.toString().take(200)}", extra)
            popup == null -> Grade("F", "$label: popup did not render in the core check", extra)
            cdnRefused -> Grade("n/m", "$label: every pack thumbnail in the popup is broken (${thumbs.optInt("broken")} of ${thumbs.optInt("thumbs")}), the vendor's CDN refusing the runner, so nothing is there to pick (not measurable here); fixture page cursor ${found.toString().take(160)}", extra)
            else -> Grade("F", "$label: popup ${if (pick.optBoolean("clicked")) "picked ${pick.toString().take(100)}" else "had no pack card to pick (${pick.toString().take(100)})"}; fixture page cursor ${found.toString().take(200)}", extra)
        }
    }

    /**
     * Proxy SwitchyOmega 3 (ZeroOmega): its popup (`popup-iframe.html`, the profile list in a
     * same-origin frame) switches `chrome.proxy.settings` between its profiles. Its default
     * "proxy" profile is a fixed server at `127.0.0.1:8080`, where nothing listens on the
     * emulator, so once ProxyController has the override the fixture comes back as the
     * `ERR_PROXY_CONNECTION_FAILED` error page (Zenium's own, `zen://error?code=-100`, in the
     * tab; [PAGE_OR_ERROR]), and "[Direct]" picked next brings the fixture back:
     * the two readings together are the pass (the extension's choice applied and cleared at the
     * WebView). The worker's `chrome.proxy` shape is read first, as [vpn] reads it. The runtime
     * drops a disabled extension's proxy value on its own, so the row's cleanup leaves no override.
     */
    private fun proxySwitcher(row: Row, entry: JSONObject): Grade {
        val factor = speedFactor(entry)
        val extra = JSONObject()
        val bg = awakeBackground(row.id, factor)
        val proxy = if (bg != null) probe(bg, PROXY_PROBE, "__zenProxyProbe", scaled(10_000, factor)) else JSONObject().put("pass", false).put("note", "no background view")
        extra.put("proxy", proxy)
        val (tab, view) = fixture("echo-headers?omega", factor, 1_500)
        extra.put("fixtureBefore", json(tabEval(view, PAGE_OR_ERROR)))
        val steps = JSONArray()
        val since = StepEvidence(row)
        val pickProfile = { words: String, name: String ->
            showTab(tab)
            val popup = openPopup(row, factor)
            var hit = JSONObject().put("clicked", false)
            if (popup != null) {
                SystemClock.sleep(scaled(3_000, factor))
                hit = json(tabEval(popup, FRAMED_CLICK_LABEL.replace("__RE__", words)))
                steps.put("$name $words: ${hit.toString().take(160)}")
                if (hit.optBoolean("clicked")) tapSettled(popup, hit, factor)?.let { steps.put("$name: $it") }
                SystemClock.sleep(scaled(2_000, factor))
                popupView()?.takeIf { it.context == "popup" }?.let { extra.put("popupAfter${name.replaceFirstChar { c -> c.uppercase() }}", json(tabEval(it, FRAMED_TEXT)).optString("text").take(200)) }
            } else steps.put("$name: popup did not render")
            runCatching { coreCall("extension.closePopup", "null") }
            hit
        }
        val reloaded = {
            showTab(tab)
            coreCall("tab.reload", """{"tabId":${JSONObject.quote(tab)}}""")
            SystemClock.sleep(scaled(1_500, factor))
            pollExpr(view, PAGE_OR_ERROR, scaled(20_000, factor))
        }
        val proxied = pickProfile("/^proxy$/i", "proxy")
        var through = JSONObject()
        if (proxied.optBoolean("clicked")) {
            through = reloaded()
            extra.put("throughProxy", through)
            SystemClock.sleep(600)
            snap("${entry.optString("slug")}-through-proxy")
        }
        val direct = pickProfile("/^\\[?direct\\]?$/i", "direct")
        var back = JSONObject()
        if (direct.optBoolean("clicked")) {
            back = reloaded()
            extra.put("backDirect", back)
        }
        extra.put("steps", steps)
        bg?.let { extra.put("workerConsole", JSONArray(consoleOf(it).takeLast(10))) }
        since.record(extra, "atEnd")
        SystemClock.sleep(600)
        snap("${entry.optString("slug")}-core")
        val failedThrough = through.optBoolean("errorPage")
        val restored = back.optBoolean("loaded")
        val note = "chrome.proxy: ${proxy.toString().take(160)}; profile taps ${steps.toString().take(220)}; fixture through the proxy profile: ${through.toString().take(140)}; back on [Direct]: ${back.toString().take(120)}"
        return when {
            failedThrough && restored -> Grade("P", "ZeroOmega: the proxy profile's fixed server reached ProxyController (the fixture came back as the ${through.optString("code").ifEmpty { "proxy error" }} error page) and [Direct] cleared it (the fixture loaded again): $note", extra)
            failedThrough -> Grade("PARTIAL", "ZeroOmega: the proxy profile's fixed server reached ProxyController (${through.optString("code").ifEmpty { "the error page" }}) but [Direct] did not bring the fixture back within the wait: $note", extra)
            !proxy.optBoolean("pass") -> Grade("F", "ZeroOmega: the proxy API is not Chrome's shape in the worker: $note", extra)
            !proxied.optBoolean("clicked") -> Grade("F", "ZeroOmega: no 'proxy' profile to tap in the popup: $note", extra)
            else -> Grade("F", "ZeroOmega: the proxy profile tapped and the fixture still loaded directly (the override never reached the WebView): $note", extra)
        }
    }

    /**
     * ImTranslator: its popup (`router.html`, the translator in a frame of its own) takes a
     * phrase in its source box and "Translate" runs it through its service (Google's or
     * Microsoft's endpoint, per its settings) into the target box. "Bonjour le monde" typed,
     * Translate tapped, "Hello world" (or any translation) in the target box is the pass; the
     * service's refusal shown instead is `n/m`.
     */
    private fun imTranslator(row: Row, entry: JSONObject): Grade {
        val factor = speedFactor(entry)
        val extra = JSONObject()
        fixture("page-a.html?imtranslator", factor, 1_500)
        val since = StepEvidence(row)
        val popup = openPopup(row, factor)
        val steps = JSONArray()
        var found = JSONObject()
        if (popup != null) {
            SystemClock.sleep(scaled(4_000, factor))
            extra.put("popupFirst", json(tabEval(popup, FRAMED_TEXT)).optString("text").take(200))
            val typed = poll(scaled(12_000, factor), 1_000) { json(tabEval(popup, IMTRANSLATOR_TYPE)).takeIf { it.optBoolean("typed") } } ?: json(tabEval(popup, IMTRANSLATOR_TYPE))
            steps.put("type: ${typed.toString().take(160)}")
            if (typed.optBoolean("typed")) {
                val hit = json(tabEval(popup, FRAMED_CLICK_LABEL.replace("__RE__", "/^translate$/i")))
                steps.put("translate: ${hit.toString().take(160)}")
                if (hit.optBoolean("clicked")) tapSettled(popup, hit, factor)?.let { steps.put("translate: $it") }
                popupView()?.takeIf { it.context == "popup" }?.let { live ->
                    found = pollExpr(live, IMTRANSLATOR_RESULT, scaled(25_000, factor))
                    found.put("console", JSONArray(consoleOf(live).takeLast(10)))
                }
            }
        }
        extra.put("steps", steps).put("popup", found)
        backgroundView(row.id)?.let { extra.put("workerConsole", JSONArray(consoleOf(it).takeLast(8))) }
        since.record(extra, "atEnd")
        SystemClock.sleep(600)
        snap("${entry.optString("slug")}-translate-popup")
        runCatching { coreCall("extension.closePopup", "null") }
        val refused = popup != null && !found.optBoolean("pass") && CHALLENGE_WORDS.containsMatchIn(found.optString("target") + " " + found.optString("text"))
        return when {
            found.optBoolean("pass") -> Grade("P", "ImTranslator: \"Bonjour le monde\" translated in the popup: ${found.toString().take(220)}", extra)
            refused -> Grade("n/m", "ImTranslator: popup renders and its service answered with a refusal (\"${found.optString("target").take(80)}\"); the translation is the service's (not measurable here)", extra)
            popup == null -> Grade("F", "ImTranslator: popup did not render in the core check", extra)
            else -> Grade("F", "ImTranslator: popup ${found.toString().take(200)} (steps ${steps.toString().take(200)})", extra)
        }
    }

    /**
     * WeVideo Screen & Webcam Recorder: its popup's record controls ask for `getDisplayMedia`
     * (a screen or a tab) and `getUserMedia` (the webcam); the WebView offers no display capture
     * (`getDisplayMedia` is not there, [captureLimit]'s reading), so with the popup rendering its
     * controls the core is the WebView's limit, `n/a`. A popup that asks for a WeVideo sign-in
     * first is `n/m`; no popup is F.
     */
    private fun recorderPopup(label: String, controls: String): (Row, JSONObject) -> Grade = { row, entry ->
        val factor = speedFactor(entry)
        val extra = JSONObject()
        val (_, view) = fixture("audio.html?wevideo", factor, 2_000)
        val media = json(tabEval(view, "JSON.stringify({getDisplayMedia:typeof (navigator.mediaDevices&&navigator.mediaDevices.getDisplayMedia),getUserMedia:typeof (navigator.mediaDevices&&navigator.mediaDevices.getUserMedia)})"))
        extra.put("page", media)
        val popup = openPopup(row, factor)
        var found = JSONObject()
        if (popup != null) {
            SystemClock.sleep(scaled(4_000, factor))
            found = pollExpr(popup, DEEP_TEXT.replace("return JSON.stringify({text:", "return JSON.stringify({pass:$controls.test(text)||/\\b(log ?in|sign ?in|create account|get started|welcome)\\b/i.test(text),controls:$controls.test(text),login:/\\b(log ?in|sign ?in|create account|get started|welcome)\\b/i.test(text),buttons:document.querySelectorAll('button, [role=button]').length,getDisplayMedia:typeof (navigator.mediaDevices&&navigator.mediaDevices.getDisplayMedia),text:"), scaled(20_000, factor))
            found.put("console", JSONArray(consoleOf(popup).takeLast(10)))
        }
        extra.put("popup", found)
        SystemClock.sleep(600)
        snap("${entry.optString("slug")}-recorder-popup")
        runCatching { coreCall("extension.closePopup", "null") }
        val note = "popup ${if (popup == null) "absent" else "\"${found.optString("text").take(100)}\" (${found.optInt("buttons")} buttons)"}; getDisplayMedia in the popup: ${found.optString("getDisplayMedia")}, in the page: ${media.optString("getDisplayMedia")}"
        when {
            popup == null -> Grade("F", "$label: popup did not render in the core check: $note", extra)
            found.optBoolean("controls") && found.optString("getDisplayMedia") == "undefined" -> Grade("n/a", "$label: the popup renders its record controls, but the WebView has no screen, window or tab capture to offer them (getDisplayMedia absent; getUserMedia reaches the camera and microphone alone): WebView limit. $note", extra)
            found.optBoolean("controls") -> Grade("PARTIAL", "$label: the popup renders its record controls and this WebView has getDisplayMedia; the recording itself was not driven: $note", extra)
            found.optBoolean("login") -> Grade("n/m", "$label: the popup asks for a WeVideo sign-in first; the recorder needs an account (not measurable here): $note", extra)
            else -> Grade("F", "$label: the popup shows neither its record controls nor a sign-in: $note", extra)
        }
    }

    /**
     * A row whose effect needs a device the phone has not got (CrxMouse's gestures: a right
     * button's drag, a wheel) once its content scripts are in the page: the fixture is read for
     * the scripts – the runtime's own stats of the extension's world (groups applied, the
     * extension's `chrome.runtime.id`) and `injects`, a selector of what the scripts leave in the
     * DOM. Attached is `n/a` with the reason; nothing attached within the wait is F.
     */
    private fun contentAttached(label: String, reason: String, injects: String? = null): (Row, JSONObject) -> Grade = { row, entry ->
        val factor = speedFactor(entry)
        val extra = JSONObject()
        val (_, view) = fixture("page-a.html?attached", factor, 3_000)
        var world = JSONObject()
        var dom = JSONObject()
        poll(scaled(15_000, factor), 1_000) {
            world = json((if (worlds) worldEval(view, row.id, WORLD_REPORT) else tabEval(view, WORLD_REPORT)) ?: "null")
            dom = injects?.let { json(tabEval(view, INJECTED_UI.replace("__SELECTOR__", JSONObject.quote(it)))) } ?: JSONObject()
            if (attachedIn(world, row) || dom.optBoolean("pass")) true else null
        }
        extra.put("world", world).put("injected", dom).put("console", JSONArray(consoleOf(view).takeLast(10)))
        SystemClock.sleep(600)
        snap("${entry.optString("slug")}-attached")
        val stats = world.optJSONObject("stats")
        val how = listOfNotNull(
            stats?.let { "${it.optInt("applied")} script group(s) applied" },
            world.optString("runtimeId").takeIf { it.equals(row.id, ignoreCase = true) }?.let { "chrome.runtime.id is its own" },
            dom.takeIf { it.optBoolean("pass") }?.let { "its <${it.optString("tag")}> in the DOM" }
        ).joinToString(", ")
        when {
            attachedIn(world, row) || dom.optBoolean("pass") -> Grade("n/a", "$label: its content scripts are in the page ($how); $reason", extra)
            else -> Grade("F", "$label: its content scripts did not attach to the fixture within ${scaled(15_000, factor) / 1000} s: ${world.toString().take(200)}", extra)
        }
    }

    /** The runtime's stats of a world say the row's scripts ran there: a group applied, or the world's `chrome.runtime.id` the row's. */
    private fun attachedIn(world: JSONObject, row: Row): Boolean {
        val stats = world.optJSONObject("stats")
        return (stats != null && stats.optInt("applied", 0) > 0) || world.optString("runtimeId").equals(row.id, ignoreCase = true)
    }

    /**
     * Unpaywall over `doi.html` (a landing page naming an open-access PLOS ONE article by DOI in
     * `citation_doi`): its content script reads the DOI, asks `api.oadoi.org` for a free copy and
     * draws its tab (an `<iframe>` of its `unpaywall.html`) at the page's edge: the frame is the
     * pass. Its service refusing the runner (the page's console: the `oadoi.org` request failed)
     * is `n/m`, the service's.
     */
    private fun unpaywall(row: Row, entry: JSONObject): Grade {
        val grade = domMarker("Unpaywall's tab on a page with a DOI", "doi.html?unpaywall", UNPAYWALL_TAB, settleMs = 35_000)(row, entry)
        if (grade.verdict == "P") return grade
        val console = grade.extra?.optJSONArray("console")?.let { c -> (0 until c.length()).map { c.optString(it) } } ?: emptyList()
        val refused = console.firstOrNull { Regex("oadoi|unpaywall", RegexOption.IGNORE_CASE).containsMatchIn(it) && Regex("failed to fetch|\\b(403|429|5\\d\\d)\\b|net::ERR|CORS|blocked", RegexOption.IGNORE_CASE).containsMatchIn(it) }
        return if (refused != null) Grade("n/m", "Unpaywall: its service (api.oadoi.org) refused the runner (\"${refused.take(140)}\"), so its tab has nothing to draw (not measurable here)", grade.extra) else grade
    }

    // --- the core checks of compat round 13 (ranks 271-300 by installs) --------------------------

    /** A URL decoded twice (Gmail's compose address inside accounts.google.com's `continue=`), for a match; the URL itself when decoding fails. */
    private fun decodedTwice(url: String): String =
        runCatching { java.net.URLDecoder.decode(java.net.URLDecoder.decode(url, "UTF-8"), "UTF-8") }.getOrDefault(url)

    /**
     * Send from Gmail: the action click runs `infopasser.js` in the tab (the page's title and
     * address go to the worker), and the worker opens Gmail's compose with them
     * (`windows.create` on `mail.google.com/mail/?view=cm&fs=1&tf=1&su=<title>&body=<url>`); a
     * visitor without a session lands on `accounts.google.com`, the compose address in its
     * `continue=`. `P` when a tab opens whose address (decoded twice) matches `opens` and
     * carries the fixture's address (`carries`); `PARTIAL` when it opens without it; `F` when
     * nothing opens. Gmail's sign-in is where the compose goes next: recorded, the gate.
     */
    private fun actionOpens(label: String, page: String, opens: Regex, carries: Regex): (Row, JSONObject) -> Grade = { row, entry ->
        val factor = speedFactor(entry)
        val extra = JSONObject()
        val (_, view) = fixture(page, factor, 2_500)
        val before = tabUrls().keys
        val since = StepEvidence(row)
        coreCall("extension.openPopup", """{"id":${JSONObject.quote(row.id)},"anchor":{"x":0,"y":0,"width":0,"height":0}}""")
        val opened = poll(scaled(25_000, factor), 500) {
            tabUrls().entries.firstOrNull { it.key !in before && opens.containsMatchIn(decodedTwice(it.value)) }
        }
        extra.put("tabsAfterClick", JSONArray(tabUrls().values.toList()))
        var landedText = ""
        if (opened != null) {
            extra.put("opened", opened.value.take(300)).put("decoded", decodedTwice(opened.value).take(300))
            runCatching { waitForView(opened.key) }.getOrNull()?.let { v ->
                showTab(opened.key)
                landedText = pollExpr(v, DOM_REPORT.replace("return JSON.stringify({text:", "return JSON.stringify({pass:document.body&&document.body.innerText.trim().length>0,text:"), scaled(15_000, factor)).optString("text")
                extra.put("landedText", landedText.take(200))
            }
        }
        extra.put("page", json(tabEval(view, DOM_REPORT))).put("console", JSONArray(consoleOf(view).takeLast(8)))
        if (worlds) worldEval(view, row.id, WORLD_REPORT)?.let { extra.put("world", json(it)) }
        since.record(extra, "atEnd")
        SystemClock.sleep(600)
        snap("${entry.optString("slug")}-core")
        runCatching { coreCall("extension.closePopup", "null") }
        val carried = opened != null && carries.containsMatchIn(decodedTwice(opened.value))
        when {
            carried -> Grade("P", "$label: the action click opened ${opened!!.value.take(100)} with the fixture's address in the compose body (landed on \"${landedText.take(60)}\")", extra)
            opened != null -> Grade("PARTIAL", "$label: the action click opened ${opened.value.take(120)} without the fixture's address in it (\"${landedText.take(60)}\")", extra)
            else -> Grade("F", "$label: the action click opened no compose tab within ${scaled(25_000, factor) / 1000} s (tabs: ${tabUrls().values.joinToString().take(160)})", extra)
        }
    }

    /**
     * An ad blocker whose rulesets ship disabled until its account or trial is activated (Total
     * Adblock: every `declarative_net_request` ruleset `enabled: false`, its popup a sign-in /
     * activation): graded as [adBlocker] when anything is stopped; otherwise `n/m` when the popup
     * reads as the activation gate (`gate` words), the row's ruleset state in the note.
     */
    private fun gatedAdBlocker(label: String, gate: Regex): (Row, JSONObject) -> Grade = { row, entry ->
        val grade = adBlocker(row, entry)
        val popupText = entry.optString("popupText")
        if (grade.verdict == "P" || grade.verdict == "PARTIAL" || !gate.containsMatchIn(popupText)) grade
        else Grade("n/m", "$label: nothing stopped with its rulesets shipped off (${grade.extra?.optJSONArray("ruleSets")?.toString()?.take(120)}); its popup asks for the account (\"${popupText.take(100)}\"); the core needs a subscription (not measurable here)", grade.extra)
    }

    /**
     * A row whose content scripts match a frame of another origin inside the page (Buster:
     * reCAPTCHA's `api2/bframe` challenge frame, where its solve button lives): the fixture
     * renders the widget, and the runtime's endpoint table for the tab's view is read for a
     * sub-frame endpoint of the row's whose URL matches `frame` (its bootstrap said hello
     * there). The core itself (`reason`) is not measurable here: `n/m` with the attach as the
     * measured shape; `F` when the frame is in the page and the scripts never attached; `n/m`
     * on the widget's side when Google's frames never came.
     */
    private fun frameAttach(label: String, page: String, frame: Regex, reason: String, settleMs: Long = 30_000): (Row, JSONObject) -> Grade = { row, entry ->
        val factor = speedFactor(entry)
        val extra = JSONObject()
        val (_, view) = fixture(page, factor, 3_000)
        var endpoints: List<String> = emptyList()
        var widget = JSONObject()
        val attached = poll(scaled(settleMs, factor), 1_000) {
            widget = json(tabEval(view, "JSON.stringify(window.__recaptcha||{})"))
            instrumentation.runOnMainSync { endpoints = host.extensions.endpointSnapshot(view) }
            endpoints.firstOrNull { it.contains(" ${row.id.take(8)} ") && it.contains("main=false") && frame.containsMatchIn(it) }
        }
        val frames = widget.optJSONArray("frames")?.let { f -> (0 until f.length()).map { f.optJSONObject(it)?.optString("src") ?: "" } } ?: emptyList()
        val frameInPage = frames.any { frame.containsMatchIn(it) }
        extra.put("widget", widget).put("endpoints", JSONArray(endpoints.filter { it.contains(" ${row.id.take(8)} ") }.take(8))).put("console", JSONArray(consoleOf(view).takeLast(8)))
        if (worlds) worldEval(view, row.id, WORLD_REPORT)?.let { extra.put("world", json(it)) }
        SystemClock.sleep(600)
        snap("${entry.optString("slug")}-frame")
        when {
            attached != null -> Grade("n/m", "$label: its content script attached to the widget's challenge frame (${attached.substringAfter("url=").substringBefore(" ep=").take(80)}); $reason (not measurable here)", extra)
            frameInPage -> Grade("F", "$label: the widget's frames are in the page (${frames.joinToString().take(120)}) and its content scripts did not attach to the challenge frame within ${scaled(settleMs, factor) / 1000} s (its endpoints: ${extra.optJSONArray("endpoints")?.toString()?.take(160)})", extra)
            else -> Grade("n/m", "$label: Google's reCAPTCHA frames did not come up on the fixture within ${scaled(settleMs, factor) / 1000} s (${widget.toString().take(120)}): nothing for its scripts to attach to (not measurable here)", extra)
        }
    }

    /**
     * Open Multiple URLs: two fixture addresses typed into its popup's list (a Vue textarea: the
     * value set and an `input` event dispatched, as typing yields), "Open URLs" tapped, and the
     * tabs it opens (`tabs.create` per line) read off the tab list: both is `P`, one `PARTIAL`.
     */
    private fun openMultipleUrls(row: Row, entry: JSONObject): Grade {
        val factor = speedFactor(entry)
        val extra = JSONObject()
        fixture("page-a.html?omu", factor, 1_500)
        val before = tabUrls().keys
        val since = StepEvidence(row)
        val popup = openPopup(row, factor)
        val steps = JSONArray()
        var typed = JSONObject()
        if (popup != null) {
            SystemClock.sleep(scaled(2_000, factor))
            extra.put("popupText", json(tabEval(popup, DEEP_TEXT)).optString("text").take(200))
            typed = json(tabEval(popup, TEXTAREA_TYPE.replace("__TEXT__", JSONObject.quote("$BASE/page-b.html?omu1\n$BASE/page-c.html?omu2"))))
            extra.put("typed", typed)
            SystemClock.sleep(scaled(800, factor))
            tapLabel("/open urls/i", factor, steps, "open")
        }
        val wanted = listOf("page-b.html?omu1", "page-c.html?omu2")
        var opened: List<String> = emptyList()
        poll(scaled(25_000, factor), 700) {
            opened = tabUrls().filterKeys { it !in before }.values.filter { u -> wanted.any { u.contains(it) } }
            if (opened.size >= 2) true else null
        }
        extra.put("steps", steps).put("opened", JSONArray(opened)).put("tabsAfter", JSONArray(tabUrls().values.toList()))
        popupView()?.takeIf { it.context == "popup" }?.let { extra.put("popupAfter", json(tabEval(it, DEEP_TEXT)).optString("text").take(200)) }
        since.record(extra, "atEnd")
        SystemClock.sleep(600)
        snap("${entry.optString("slug")}-core")
        runCatching { coreCall("extension.closePopup", "null") }
        return when {
            popup == null -> Grade("F", "Open Multiple URLs: popup did not render in the core check", extra)
            opened.size >= 2 -> Grade("P", "Open Multiple URLs: both addresses typed into its list opened as tabs (${opened.joinToString().take(120)})", extra)
            opened.size == 1 -> Grade("PARTIAL", "Open Multiple URLs: one of the two addresses opened (${opened.first().take(80)}); typed ${typed.toString().take(100)}; ${steps.toString().take(120)}", extra)
            else -> Grade("F", "Open Multiple URLs: no tab opened within ${scaled(25_000, factor) / 1000} s after \"Open URLs\" (typed ${typed.toString().take(100)}; ${steps.toString().take(140)})", extra)
        }
    }

    /**
     * New Tab Redirect: its `main.html` overrides the new tab (`chrome_url_overrides.newtab`);
     * `redirect.js` there reads the `url` option from `storage.local` and sends the tab to it
     * (`document.location.href` for an http(s) address). The option is set as its options page
     * saves it (`storage.local.set({url})`, from its worker's view: the check has no options UI
     * step), the override is enabled as Momentum's is, a new tab is opened, and the pass is the
     * tab landing on the fixture address; a tab that stays on `main.html` is `PARTIAL` (the
     * override works, the redirect did not), no extension page `F`.
     */
    private fun newTabRedirect(row: Row, entry: JSONObject): Grade {
        val extra = JSONObject()
        val factor = speedFactor(entry)
        val target = "$BASE/page-b.html?ntr"
        val bg = awakeBackground(row.id, factor)
        val set = bg?.let { view ->
            tabEval(view, "(function(){var r={done:false};window.__zenNtr=r;try{chrome.storage.local.set({url:${JSONObject.quote(target)},showWelcome:false},function(){r.error=chrome.runtime.lastError?String(chrome.runtime.lastError.message):null;r.done=true})}catch(e){r.error=String(e&&e.message||e);r.done=true}return 'asked'})()")
            poll(scaled(8_000, factor), 250) { tabEval(view, "window.__zenNtr&&window.__zenNtr.done?JSON.stringify(window.__zenNtr):null").takeIf { it != "null" } }?.let(::json)
        }
        extra.put("optionSet", set ?: JSONObject().put("error", "no background view to set the option from"))
        coreCall("extension.setNewTabOverride", JSONObject().put("id", row.id).put("enabled", true).toString())
        SystemClock.sleep(1_000)
        val before = tabUrls().keys
        runCatching { coreCall("tab.new", "null") }.onFailure { coreCall("tab.create", """{"active":true}""") }
        var newTab: Map.Entry<String, String>? = null
        val landed = poll(scaled(30_000, factor), 500) {
            val now = tabUrls().filterKeys { it !in before }
            newTab = now.entries.firstOrNull() ?: newTab
            now.entries.firstOrNull { it.value.contains("page-b.html?ntr") }
        }
        extra.put("tabsAfter", JSONArray(tabUrls().values.toList()))
        val record = extensions().firstOrNull { it.getString("id") == row.id }
        extra.put("record", JSONObject().put("newTabOverride", record?.opt("newTabOverride")).put("newTabPage", record?.opt("newTabPage")))
        newTab?.let { t -> runCatching { waitForView(t.key) }.getOrNull()?.let { v -> extra.put("newTabPage", json(tabEval(v, DOM_REPORT))).put("console", JSONArray(consoleOf(v).takeLast(8))) } }
        SystemClock.sleep(600)
        snap("${entry.optString("slug")}-core")
        val opened = newTab
        return when {
            landed != null -> Grade("P", "New Tab Redirect: the new tab was sent to ${landed.value.take(80)} (its `url` option set to the fixture address)", extra)
            opened != null && extensionPage(opened.value, row.id) -> Grade("PARTIAL", "New Tab Redirect: the new tab opened its ${extensionPath(opened.value).take(40)} and stayed there within ${scaled(30_000, factor) / 1000} s (option set: ${set?.toString()?.take(80)})", extra)
            opened != null -> Grade("F", "New Tab Redirect: the new tab opened ${opened.value.take(80)}, not the extension's page (record newTabOverride=${record?.opt("newTabOverride")})", extra)
            else -> Grade("F", "New Tab Redirect: tab.new opened no tab within ${scaled(30_000, factor) / 1000} s", extra)
        }
    }

    /**
     * eJOY AI Dictionary: its content script (a Vite module graph loaded through `import()`)
     * mounts `#eJOY__extension_root` on every page and answers a word's selection (`mouseup`)
     * with its lookup inside that root. A word of the fixture is double-tapped as [dictionary]
     * taps it, then selected by script with a mouse's events; the pass is the root drawing more
     * than it held before the taps (a bubble, an icon), or the word in its text; the root
     * mounted but nothing drawn is `F` with the console; a lookup asking for its account `n/m`.
     */
    private fun ejoy(row: Row, entry: JSONObject): Grade {
        val factor = speedFactor(entry)
        val extra = JSONObject()
        val (_, view) = fixture("page-a.html?ejoy", factor, 3_000)
        val mounted = poll(scaled(20_000, factor), 700) { if (tabEval(view, "String(!!document.getElementById('eJOY__extension_root'))") == "true") true else null }
        extra.put("rootMounted", mounted == true)
        val baseline = json(tabEval(view, EJOY_ROOT))
        extra.put("baseline", baseline)
        val word = json(tabEval(view, DICTIONARY_WORD))
        extra.put("word", word)
        val wordText = word.optString("word")
        var found = JSONObject()
        val grew = { f: JSONObject -> f.optInt("drawn") > baseline.optInt("drawn") || (f.optInt("drawn") > 0 && wordText.isNotEmpty() && f.optString("text").contains(wordText, ignoreCase = true)) }
        screenPoint(view, word)?.let { tap(it.first, it.second); SystemClock.sleep(90); tap(it.first, it.second) }
        var shown = poll(scaled(8_000, factor), 600) { found = json(tabEval(view, EJOY_ROOT)); if (grew(found)) true else null }
        if (shown == null) {
            extra.put("synthesised", tabEval(view, DICTIONARY_DBLCLICK))
            shown = poll(scaled(12_000, factor), 600) { found = json(tabEval(view, EJOY_ROOT)); if (grew(found)) true else null }
        }
        extra.put("root", found).put("console", JSONArray(consoleOf(view).takeLast(10)))
        if (worlds) worldEval(view, row.id, WORLD_REPORT)?.let { extra.put("world", json(it)) }
        SystemClock.sleep(600)
        snap("${entry.optString("slug")}-bubble")
        val text = found.optString("text")
        return when {
            shown != null && LOGIN_WORDS.containsMatchIn(text) -> Grade("n/m", "eJOY AI Dictionary: the word's lookup drew in its root, asking for its account (\"${text.take(80)}\"); the core needs an eJOY account (not measurable here)", extra)
            shown != null -> Grade("P", "eJOY AI Dictionary: double-tap on \"$wordText\" -> its root drew ${found.optInt("drawn")} element(s) (${baseline.optInt("drawn")} before): ${found.toString().take(200)}", extra)
            mounted == true -> Grade("F", "eJOY AI Dictionary: its root mounted but drew nothing new after the word's double-tap and a synthesised selection: ${found.toString().take(200)}", extra)
            else -> Grade("F", "eJOY AI Dictionary: its root (#eJOY__extension_root) did not mount on the fixture within ${scaled(20_000, factor) / 1000} s: ${found.toString().take(160)}", extra)
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
        Row("bihmplhobchoageeokmgbdihknkjbknd", "Touch VPN", "touch-vpn", core = vpn("Touch VPN", pac = true, consent = true)),
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
        Row("adbacgifemdbhdkfppmeilbgppmhaobf", "RoPro - Enhance Your Roblox Experience", "ropro", core = ::ropro),
        Row("jpkfgepcmmchgfbjblnodjhldacghenp", "Pie Adblock - A Powerful Free Ad Blocker", "pie-adblock", core = ::adBlocker),
        Row("mihcahmgecmbnbcchbopgniflfhgnkff", "Google Mail Checker", "google-mail-checker", core = accountGate("Google Mail Checker", Regex("accounts\\.google|mail\\.google|gmail", RegexOption.IGNORE_CASE), gate = "a Google account (the unread count is Gmail's feed)")),
        // Stylish's slider is a fixed 360 px host div whose iframe (index.html) sits under a CLOSED
        // shadow root: the host is what the page's DOM shows, the iframe is not reachable from it.
        Row("fjnbnpbmkenffdnngjfgmeleoegfcffe", "Stylish - Custom themes for any website", "stylish", core = accountGate("Stylish", Regex("userstyles|stylish", RegexOption.IGNORE_CASE), injects = "div[id^='stylish-main-extension-slider']", gate = "its styles gateway listing styles for the site (none for the runner on the desktop) and a Stylish account")),
        Row("hnmpcagpplmpfojmgmnngilcnanddlhb", "Free VPN For Chrome - VPN Extension - Windscribe", "windscribe", core = vpn("Windscribe", pac = true)),
        Row("agionbommeaifngbhincahgmoflcikhm", "Image downloader - Imageye", "imageye", core = imageList("Imageye")),
        Row("nmigaijibiabddkkmjhlehchpmgbokfj", "Sound Booster - increase volume up", "sound-booster", core = ::soundBooster),
        Row("bfogiafebfohielmmehodmfbbebbbpei", "Keeper Password Manager & Digital Vault", "keeper", account = true, core = popupLogin("Keeper")),
        Row("ammjkodgmmoknidbanneddgankgfejfh", "7TV", "7tv", core = liveMarker("7TV", "https://www.twitch.tv/directory", injectedAny("seventv|7tv"))),
        Row("mbniclmhobmnbdlbpiphghaielnnpgdp", "Lightshot (screenshot tool)", "lightshot", core = clickCapture("Lightshot", Regex("screenshot\\.html", RegexOption.IGNORE_CASE))),
        Row("cndibmoanboadcifjkjbdpjgfedanolh", "BetterCampus (prev. BetterCanvas)", "bettercampus", core = accountGate("BetterCampus", Regex("bettercampus|bettercanvas", RegexOption.IGNORE_CASE), gate = "a Canvas LMS session (its welcome page asks for the school's LMS address)")),
        // Round 8 reads Language Reactor and YouTube Summary at tablet width (their scripts drew
        // nothing on the phone's one-column watch page in round 7).
        Row("hoombieeljmmljlkjmnheibnpciblicm", "Language Reactor", "language-reactor", core = ::languageReactor),
        Row("jplgfhpmjnbigmhklmmbgecoobifkmpa", "Proton VPN: Fast & Secure", "proton-vpn", core = vpn("Proton VPN")),
        Row("nmmicjeknamkfloonkhhcjmomieiodli", "YouTube Summary with ChatGPT & Claude", "youtube-summary", core = { row, entry -> youtubeTablet(row, entry, injectedAny("yt_ai_summary|ytsummary"), "the summary box on a watch page") }),
        Row("cnpniohnfphhjihaiiggeabnkjhpaldj", "Image Downloader", "image-downloader", core = imageList("Image Downloader")),
        Row("pocpnlppkickgojjlmhdmidojbmbodfm", "Chromebook Recovery Utility", "chromebook-recovery", core = accountGate("Chromebook Recovery Utility", Regex("window\\.html|recovery", RegexOption.IGNORE_CASE), page = "window.html", gate = "Chrome's private imageWriterPrivate API (allowlisted to this Google extension) and a USB drive; its window says the platform is unsupported, as on Linux")),
        Row("dmghijelimhndkbmpgbldicpogfkceaj", "Dark Mode", "dark-mode", core = ::darkMode),
        Row("bfgdeiadkckfbkeigkoncpdieiiefpig", "Bitmoji", "bitmoji", account = true, core = popupLogin("Bitmoji")),
        Row("hniebljpgcogalllopnjokppmgbhaden", "Screen Recorder", "screen-recorder", core = ::desktopCaptureLimit),
        Row("dahenjhkoodjbpjheillcadbppiidmhp", "Google Scholar PDF Reader", "scholar-pdf-reader", core = ::scholarPdfReaderRound9),
        Row("bkbeeeffjjeopflfhgeknacdieedcoml", "Microsoft Defender Browser Protection", "defender-browser-protection", core = warningPage("Microsoft Defender Browser Protection", "https://demo.smartscreen.msft.net/phishingdemo.html", Regex("BrowserProtectionWarning", RegexOption.IGNORE_CASE))),
        // Compat round 8: the desktop's round-6 list (ranks 151-180 by installs,
        // `.github/scripts/ext-compat/next30-round6.json`), graded as the desktop graded them
        // (desktop-compat-sweep-6.md) with the phone's feasibility classes: an account or a
        // vendor's service is `n/m` with its gate surface rendered (the password managers, the
        // clippers, the AI sidebars, the shopping rows); a native companion (WithSecure's
        // `app.withsecure_chrome_https`) is `n/m` once `connectNative` answers as Chrome does
        // without the host; the `chrome.proxy` VPNs are measured against what ProxyController
        // applies; a live site the phone has no fixture for (Steam's market, a YouTube watch
        // page) is read on the site. Round 7's open rows (Language Reactor, YouTube Summary,
        // Google Scholar PDF Reader, RoPro) are the rows above, graded again on this round's
        // reading and fixes.
        Row("oijdcdmnjjgnnhgljmhkjlablaejfeeb", "The QR Code Generator", "qr-code-generator", core = popupMarker("The QR Code Generator", "(function(){var best=null,bw=0;var all=document.querySelectorAll('svg, canvas, img');for(var i=0;i<all.length;i++){var b=all[i].getBoundingClientRect();if(b.width*b.height>bw){bw=b.width*b.height;best=all[i]}}var r=best?best.getBoundingClientRect():{width:0,height:0};var paths=best&&best.tagName.toLowerCase()==='svg'?best.querySelectorAll('path, rect').length:-1;return JSON.stringify({pass:r.width>60&&r.height>60&&(paths<0||paths>4),via:best?best.tagName.toLowerCase():'none',w:Math.round(r.width),h:Math.round(r.height),paths:paths,text:(document.body?document.body.innerText:'').replace(/\\s+/g,' ').trim().slice(0,80)})})()")),
        Row("hlkenndednhfkekhgcdicdfddnkalmdm", "Cookie-Editor", "cookie-editor", core = ::cookieEditor),
        Row("imdndkajeppdomiimjkcbhkafeeooghd", "Browsing Protection by WithSecure", "withsecure-browsing-protection", core = serviceBacked("Browsing Protection by WithSecure", "its site verdicts come from the WithSecure security application (app.withsecure_chrome_https, a desktop companion) over native messaging; without it the action opens its \"Security application not found\" page, as Chrome shows it", native = true)),
        Row("gojbdfnpnhogfdgjbigejoaolejmgdhk", "OneNote Web Clipper", "onenote-web-clipper", core = ::oneNoteWebClipper),
        Row("hfapbcheiepjppjbnkphkmegjlipojba", "Klarna", "klarna", core = accountGate("Klarna", Regex("klarna", RegexOption.IGNORE_CASE), injects = "iframe[src*='hfapbcheiepjppjbnkphkmegjlipojba'], iframe[src*='klapp'], [id*='klarna'], [class*='klarna']", gate = "a Klarna account (its drawer opens at \"Sign in\")", site = "https://www.hm.com/")),
        Row("ghgabhipcejejjmhhchfonmamedcbeod", "Click&Clean", "click-and-clean", core = ::clickAndClean),
        Row("oofgbpoabipfcfjapgnbbjjaenockbdp", "SetupVPN", "setupvpn", core = vpn("SetupVPN", connectWords = "/^(start connection|connect|start)$/i")),
        Row("bfbmjmiodbnnpllbbbfblcplfjjepjdn", "Turn Off the Lights", "turn-off-the-lights", core = actionMarker("Turn Off the Lights", "video.html?lights", "(function(){var el=document.querySelector('#stefanvdlightareoff1, [id*=\"stefanvdlight\"], [class*=\"stefanvdlight\"], [id*=\"turnoffthelights\"]');var r=el?el.getBoundingClientRect():{width:0,height:0};var cs=el?getComputedStyle(el):null;return JSON.stringify({pass:!!el&&r.width>100&&r.height>100&&cs.display!=='none'&&parseFloat(cs.opacity)>0.05,id:el?el.id:null,w:Math.round(r.width),h:Math.round(r.height),opacity:cs?cs.opacity:null,background:cs?cs.backgroundColor:null})})()")),
        Row("omdakjcmkglenbhjadbccaookpfjihpa", "TunnelBear VPN", "tunnelbear", core = vpn("TunnelBear")),
        Row("eiimnmioipafcokbfikbljfdeojpcgbh", "BlockSite", "blocksite", core = ::blockSite),
        Row("hipncndjamdcmphkgngojegjblibadbe", "Planet VPN", "planet-vpn", core = vpn("Planet VPN", consent = true, tapConsent = true, connectWords = "/^(connect to vpn|connect|turn on)$/i")),
        Row("hkdmdpdhfaamhgaojpelccmeehpfljgf", "Video Downloader Plus", "video-downloader-plus", core = ::videoDownloaderPlus),
        Row("becfinhbfclcgokjlobojlnldbfillpf", "AITOPIA", "aitopia", core = accountGate("AITOPIA", Regex("aitopia", RegexOption.IGNORE_CASE), injects = "iframe[src*='becfinhbfclcgokjlobojlnldbfillpf'], [id*='aitopia'], [class*='aitopia']", gate = "an AITOPIA account (its sidebar chats through its service)")),
        Row("edacconmaakjimmfgnblocblbcdcpbko", "Session Buddy", "session-buddy", core = actionPage("Session Buddy", Regex("session-buddy\\.html|main\\.html", RegexOption.IGNORE_CASE), "(function(){var t=(document.body?document.body.innerText:'').replace(/\\s+/g,' ').trim();var probes=(t.match(/Probe Page [ABC]/g)||[]).length;return JSON.stringify({pass:probes>=2||/\\b\\d+ tabs?\\b/i.test(t)&&t.length>40,probes:probes,text:t.slice(0,200),els:document.body?document.body.querySelectorAll('*').length:0})})()", listOf("page-b.html?session", "page-c.html?session"))),
        Row("ljflmlehinmoeknoonhibbjpldiijjmm", "Speechify", "speechify", core = accountGate("Speechify", Regex("speechify", RegexOption.IGNORE_CASE), injects = "iframe[src*='ljflmlehinmoeknoonhibbjpldiijjmm'], [id*='speechify'], [class*='speechify'], speechify-root, #speechify-root", gate = "a Speechify account (its welcome modal signs in)")),
        Row("hgeljhfekpckiiplhkigfehkdpldcggm", "Auto Refresh Plus", "auto-refresh-plus", core = ::autoRefresh),
        Row("lneaocagcijjdpkcabeanfpdbmapcjjg", "VPNLY", "vpnly", core = vpn("VPNLY", consent = true, tapConsent = true)),
        Row("jaoafpkngncfpfggjefnekilbkcpjdgp", "uVPN", "uvpn", core = vpn("uVPN", connectSelector = "div.btn, .btn")),
        Row("fdjamakpfbbddfjaooikfcpapjohcfmg", "Dashlane", "dashlane", account = true, core = popupLogin("Dashlane")),
        Row("cmeakgjggjdlcpncigglobpjbkabhmjl", "Steam Inventory Helper", "steam-inventory-helper", core = ::steamInventoryHelper),
        Row("lphicbbhfmllgmomkkhjfkpbdlncafbn", "LetyShops", "letyshops", account = true, core = popupLogin("LetyShops")),
        Row("oeopbcgkkoapgobdbedcemjljbihmemj", "Checker Plus for Gmail", "checker-plus-gmail", account = true, core = ::checkerPlus),
        Row("ijejnggjjphlenbhmjhhgcdpehhacaal", "Scrnli", "scrnli", core = popupCapture("Scrnli", "/visible page|visible part|capture visible|visible/i")),
        Row("dmkamcknogkgcdfhhbddcghachkejeap", "Keplr", "keplr", core = ::keplr),
        Row("iginnfkhmmfhlkagcmpgofnjhanpmklb", "Boxel Rebound", "boxel-rebound", core = popupMarker("Boxel Rebound", "(function(){var c=document.querySelector('canvas');var r=c?c.getBoundingClientRect():{width:0,height:0};return JSON.stringify({pass:!!c&&c.width>100&&c.height>100&&r.width>60,w:c?c.width:0,h:c?c.height:0,shown:Math.round(r.width)+'x'+Math.round(r.height),canvases:document.querySelectorAll('canvas').length})})()")),
        Row("mhkhmbddkmdggbhaaaodilponhnccicb", "TubeBuddy", "tubebuddy", core = ::tubeBuddy),
        Row("oiiaigjnkhngdbnoookogelabohpglmd", "HubSpot Sales", "hubspot-sales", account = true, core = popupLogin("HubSpot Sales")),
        Row("ofaokhiedipichpaobibbnahnkdoiiah", "Instant Data Scraper", "instant-data-scraper", core = actionPage("Instant Data Scraper", Regex("popup\\.html", RegexOption.IGNORE_CASE), "(function(){var t=(document.body?document.body.innerText:'').replace(/\\s+/g,' ').trim();var hits=['Aster lamp','Birch shelf','Lighting','Storage'].filter(function(w){return t.indexOf(w)>=0}).length;return JSON.stringify({pass:hits>=2,hits:hits,cells:document.querySelectorAll('td').length,text:t.slice(0,200)})})()", listOf("table.html?scrape"))),
        Row("ghmbeldphafepmbegfdlkpapadhbakde", "Proton Pass", "proton-pass", account = true, core = popupLogin("Proton Pass")),
        Row("hbapdpeemoojbophdfndmlgdhppljgmp", "Keywords Everywhere", "keywords-everywhere", core = accountGate("Keywords Everywhere", Regex("keywordseverywhere", RegexOption.IGNORE_CASE), gate = "an API key and a Google results page to draw its widgets on (Google serves its robot check to the runner, as it did the desktop)")),
        // Compat round 9: the desktop's round-7 list (ranks 181-210 by installs,
        // `.github/scripts/ext-compat/next30-round7.json`), graded as the desktop graded them
        // (desktop-compat-sweep-7.md) with the phone's feasibility classes: an account, a live
        // call or a vendor's service is `n/m` with its gate surface rendered (Tactiq, Wordtune,
        // Apollo.io, NaturalReader, Google Meet Enhanced Experience, MyBib's citation service);
        // the `chrome.proxy` VPNs are measured against what ProxyController applies (Surfshark,
        // ExpressVPN, whose native host is a desktop app); Mobile simulator is a desktop concept
        // graded as it behaves; PrintFriendly and Eye Dropper, F on the desktop's `activeTab`
        // limit, are graded on what the phone's action-click grant gives; a live site the phone
        // has no fixture for (Flipkart's product page, old.reddit.com, a YouTube watch page,
        // chatgpt.com) is read on the site. Round 8's runtime-owned open rows (OneNote Web
        // Clipper, Keplr, Google Scholar PDF Reader, Steam Inventory Helper, Language Reactor) are
        // the rows above, re-pointed at this round's readings of the spelling, CSS placeholder
        // and postMessage items.
        Row("ohlencieiipommannpdfcmfdpjjmeolj", "PrintFriendly: Print, PDF Editor & Full Page Screenshot", "printfriendly", core = popupFlow("PrintFriendly", "page-a.html?pf", listOf("/printfriendly view/i"), injectedAny("(^|\\s)pf-|printfriendly"), opens = Regex("printfriendly\\.com", RegexOption.IGNORE_CASE))),
        // Read on the desktop site (its scraper's selectors are the desktop page's; flipkart served
        // the phone its mobile page, rounds 11-12) and on amazon.in when flipkart refuses the runner.
        Row("ojplmecpdpgccookcobabopnaifgidhf", "Buyhatke: Price History & Tracker, Spend Lens", "buyhatke", core = liveMarker("Buyhatke", "https://www.flipkart.com/apple-iphone-15-black-128-gb/p/itm6ac6485515ae4", injectedAny("bh-crx-root|buyhatke"), settleMs = 60_000, desktop = true, mirrors = listOf("https://www.amazon.in/dp/B0CHX1W1XY"))),
        Row("ckejmhbmlajgoklhgbapkiccekfoccmk", "Mobile simulator - responsive testing tool", "mobile-simulator", core = ::mobileSimulator),
        Row("edlifbnjlicfpckhgjhflgkeeibhhcii", "Screenshot Tool - Screen Capture & Editor", "screenshot-tool", core = popupCapture("Screenshot Tool", "/capture visible area|visible area/i")),
        Row("khncfooichmfjbepaaaebmommgaepoid", "Unhook - Remove YouTube Recommended & Shorts", "unhook", core = { row, entry -> youtube(row, entry, "(function(){var h=document.documentElement;var attrs=[];for(var i=0;i<h.attributes.length;i++){var n=h.attributes[i].name;if(/^hide_|unhook/i.test(n))attrs.push(n)}var related=document.querySelectorAll('ytd-compact-video-renderer, ytm-compact-video-renderer, ytm-video-with-context-renderer');var shown=0;for(var j=0;j<related.length;j++){var r=related[j].getBoundingClientRect();if(r.width>0&&r.height>0)shown++}return JSON.stringify({pass:attrs.length>0,attrs:attrs.slice(0,8),n:attrs.length,related:related.length,relatedShown:shown})})()", "Unhook's hide attributes on a watch page") }),
        Row("fggkaccpbmombhnjkjokndojfgagejfb", "Tactiq: AI note taker for Google Meet, Zoom and MS Teams", "tactiq", core = accountGate("Tactiq", Regex("tactiq|accounts\\.google", RegexOption.IGNORE_CASE), gate = "a live Google Meet call and a Tactiq account (its popup: key features are missing without them)")),
        Row("kbmfpngjjgdllneeigpgjifpgocmfgmb", "Reddit Enhancement Suite", "reddit-enhancement-suite", core = liveMarker("Reddit Enhancement Suite", "https://old.reddit.com/r/programming/", injectedAny("RESNotifications|RESConsole|(^|\\s)res-[a-z]"), settleMs = 60_000)),
        Row("dpacanjfikmhoddligfbehkpomnbgblf", "AHA Music - Song Finder for Browser", "aha-music", core = captureLimit("AHA Music", "/identif|listening|no sound|song|find|record/i")),
        Row("ailoabdmgclmfmhdagmlohpjlbpffblp", "Surfshark Chrome VPN extension", "surfshark", core = vpn("Surfshark", connectWords = "/^(connect|quick[- ]connect|it's time to connect!?)$/i")),
        Row("ojnbohmppadfgpejeebfnmnknjdlckgj", "AIPRM for ChatGPT", "aiprm", core = siteGate("AIPRM for ChatGPT", "https://chat.openai.com/", "[id*='AIPRM'], [class*='AIPRM'], [id*='aiprm'], [class*='aiprm']", Regex("^https://chat\\.openai\\.com/", RegexOption.IGNORE_CASE), gate = "ChatGPT's page served to a signed-in user (OpenAI served its robot check to the desktop's runner)")),
        Row("hmdcmlfkchdmnmnmheododdhjedfccka", "Eye Dropper", "eye-dropper", core = popupFlow("Eye Dropper", "styled-light.html?eyedropper", listOf("/pick a color from (this web|active tab)|pick color/i"), injectedAny("eye-dropper-overlay|color-toolbox|color-tooltip|edropper"))),
        Row("mcohilncbfahbmgdjkbpemcciiolgcge", "OKX Wallet", "okx-wallet", core = ::okxWallet),
        Row("fgddmllnllkalaagkghckoinaemmogpe", "ExpressVPN: VPN & proxy browser extension", "expressvpn", core = vpn("ExpressVPN", consent = true, tapConsent = true, connectWords = "/^(use proxy mode|connect|connect now)$/i")),
        Row("iogidnfllpdhagebkblkgbfijkbkjdmm", "Stream Recorder - HLS & m3u8 Video Downloader", "stream-recorder", core = ::streamRecorder),
        Row("bfbameneiokkgbdmiekhjnmfkcnldhhm", "Web Developer", "web-developer", core = popupFlow("Web Developer", "styled-light.html?webdev", listOf("/^css$/i", "/^disable all styles$/i"), "(function(){var sheets=document.styleSheets;var disabled=0,total=0;for(var i=0;i<sheets.length;i++){total++;if(sheets[i].disabled)disabled++}var links=document.querySelectorAll('link[rel~=stylesheet]');var linksOff=0;for(var j=0;j<links.length;j++){if(links[j].disabled)linksOff++}var bg=getComputedStyle(document.body).backgroundColor;return JSON.stringify({pass:(disabled>0&&disabled===total)||linksOff===links.length&&links.length>0||(bg==='rgba(0, 0, 0, 0)'||bg==='rgb(255, 255, 255)'),disabled:disabled,total:total,links:links.length,linksOff:linksOff,background:bg})})()")),
        Row("oemmndcbldboiebfnladdacbdfmadadm", "PDF Viewer", "pdf-viewer", core = pdfTool("PDF Viewer", Regex("viewer\\.html|content/web|pdf\\.?js|oemmndcbldboiebfnladdacbdfmadadm", RegexOption.IGNORE_CASE), missing = "F")),
        Row("gohjpllcolmccldfdggmamodembldgpc", "Shimeji Browser Extension", "shimeji", core = popupFlow("Shimeji", "page-a.html?shimeji", listOf("/^(on|off)$/i"), injectedAny("shimeji"), settleMs = 30_000)),
        Row("djflhoibgkdhkhhcedjiklpkjnoahfmg", "User-Agent Switcher for Chrome", "user-agent-switcher", core = popupFlow("User-Agent Switcher", "echo-headers?ua", listOf("/^internet explorer$/i", "/^internet explorer 10$/i"), "(function(){var ua=(window.__headers&&(window.__headers['User-Agent']||window.__headers['user-agent']))||(document.getElementById('ua')||{}).textContent||'';return JSON.stringify({pass:/MSIE 10\\.0/.test(ua),ua:ua.slice(0,120),navigator:navigator.userAgent.slice(0,80)})})()", settleMs = 30_000)),
        Row("akdgnmcogleenhbclghghlkkdndkjdjc", "SEOquake: On-Page SEO Checker", "seoquake", core = popupFlow("SEOquake", "page-a.html?seoquake", listOf("?/^(i agree|agree|accept|accept all|allow|got it|continue|ok)$/i"), "(function(){var parts=[];var walk=function(root){var it=document.createNodeIterator(root,NodeFilter.SHOW_TEXT);var n;while((n=it.nextNode())){var p=n.parentNode;if(p&&/^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(p.nodeName))continue;var t=n.textContent.replace(/\\s+/g,' ').trim();if(t)parts.push(t)}var all=root.querySelectorAll('*');for(var i=0;i<all.length;i++)if(all[i].shadowRoot)walk(all[i].shadowRoot)};if(document.body)walk(document.body);var t=parts.join(' ');return JSON.stringify({pass:/Probe Page A/i.test(t)&&/title|description|keyword|links|density|meta/i.test(t),text:t.slice(0,240),els:document.body?document.body.querySelectorAll('*').length:0})})()", onPage = false, settleMs = 30_000)),
        Row("eedlgdlajadkbbjoobobefphmfkcchfk", "Ecosia - The search engine that plants trees", "ecosia", core = searchOverride("Ecosia", Regex("ecosia\\.org", RegexOption.IGNORE_CASE), Regex("ecosia", RegexOption.IGNORE_CASE))),
        Row("kohfgcgbkjodfcfkcackpagifgbcmimk", "NaturalReader - AI Text to Speech", "naturalreader", core = accountGate("NaturalReader", Regex("naturalreaders?\\.com|sidepanel\\.html", RegexOption.IGNORE_CASE), injects = "#nr-ext-capsule, [id*='nr-ext'], [class*='nr-ext'], iframe[src*='kohfgcgbkjodfcfkcackpagifgbcmimk']", gate = "a NaturalReader account (reading with its voices is its service's)")),
        Row("nllcnknpjnininklegdoijpljgdjkijc", "Wordtune: AI Paraphrasing and Grammar Tool", "wordtune", core = accountGate("Wordtune", Regex("wordtune", RegexOption.IGNORE_CASE), injects = "iframe[src*='nllcnknpjnininklegdoijpljgdjkijc'], [id*='wordtune'], [class*='wordtune']", gate = "a Wordtune account (its popup signs in)")),
        Row("epcnnfbjfcgphgdmggkamkmgojdagdnn", "uBlock", "ublock", core = ::adBlocker),
        Row("alhgpfoeiimagjlnfekdhkjlkiomcapa", "Apollo.io: Free B2B Phone Number & Email Finder", "apollo-io", core = accountGate("Apollo.io", Regex("apollo\\.io|sidepanel|side-panel", RegexOption.IGNORE_CASE), injects = "iframe[src*='alhgpfoeiimagjlnfekdhkjlkiomcapa'], [id*='apollo'], [class*='apollo']", gate = "an Apollo account (the action opens its side panel; finding contacts is its service's)")),
        Row("hodiladlefdpcbemnbbcpclbmknkiaem", "Google Meet Enhanced Experience", "meet-enhanced", core = accountGate("Google Meet Enhanced Experience", Regex("meet\\.google|accounts\\.google", RegexOption.IGNORE_CASE), gate = "a live Google Meet call (its features act inside one; its settings popup renders)")),
        Row("aabcgdmkeabbnleenpncegpcngjpnjkc", "Easy Auto Refresh", "easy-auto-refresh", core = ::easyAutoRefresh),
        Row("phidhnmbkbkbkbknhldmpmnacgicphkf", "MyBib: Free Citation Generator", "mybib", core = ::myBib),
        // Its content scripts match `https://*/*`, `http://localhost/*` and `http://127.0.0.1/*` (its host
        // permissions say the same), so the fixture server's `http://10.0.2.2:8765` is outside them, in
        // Chrome too (round 9's final run: 0 groups applied on `wallet.html`); the provider is read on a live https page.
        Row("egjidjbpglichdcondbcbdnbeeppgdph", "Trust Wallet", "trust-wallet", core = liveMarker("Trust Wallet's provider injected into the page world", "https://example.com/?trust", "(function(){if(!window.__eip6963){window.__eip6963=[];window.addEventListener('eip6963:announceProvider',function(e){try{var i=e.detail&&e.detail.info;window.__eip6963.push({name:i&&i.name,rdns:i&&i.rdns})}catch(_){}});window.dispatchEvent(new Event('eip6963:requestProvider'))}var announced=window.__eip6963.slice(0,4);var eth=window.ethereum;var pass=!!(window.trustwallet||(eth&&eth.isTrust)||announced.some(function(a){return /trust/i.test(String((a&&(a.name||a.rdns))||''))}));return JSON.stringify({pass:pass,trustwallet:typeof window.trustwallet,isTrust:!!(eth&&eth.isTrust),ethereum:typeof eth,announced:announced})})()", settleMs = 30_000)),
        Row("njgehaondchbmjmajphnhlojfnbfokng", "Video Downloader PLUS", "video-downloader-plus-njg", core = ::videoDownloaderPLUS),
        Row("fllaojicojecljbmefodhfapmkghcbnh", "Google Analytics Opt-out Add-on (by Google)", "ga-opt-out", core = domMarker("Google Analytics Opt-out Add-on's page signal", "gtag.html?gaoptout", "JSON.stringify({pass:!!(window._gaUserPrefs&&typeof window._gaUserPrefs.ioo==='function'&&window._gaUserPrefs.ioo()===true),prefs:typeof window._gaUserPrefs,attribute:document.documentElement.hasAttribute('data-google-analytics-opt-out'),signalScript:!!document.querySelector('script[src*=\"gaoptout_signal\"]')})", settleMs = 20_000)),
        // Compat round 10: ranks 211-240 by installs (`.github/scripts/ext-compat/next30-round8.json`,
        // compiled by the desktop rounds' method for a future desktop release round to reuse),
        // graded with the phone's feasibility classes as rounds 4-9 graded theirs: an account or
        // a vendor's service is `n/m` with its gate surface rendered (Helium 10, Scopus, Jitsi,
        // Mote, Brisk, the two Don Johnston rows), a desktop application over native messaging
        // (1C:Enterprise) is `n/m` once `connectNative` answers as Chrome does without the
        // host, the `chrome.proxy` rows are measured against what ProxyController applies, a
        // window layout (Tab Resize, Dualless) is `n/a` once its window calls answer, a live
        // site the phone has no fixture for (Twitch, Steam's market, FACEIT, WhatsApp Web) is
        // read on the site.
        Row("nlbejmccbhkncgokjcmghpfloaajcffj", "Hotspot Shield Free VPN Proxy - Unlimited VPN", "hotspot-shield", core = vpn("Hotspot Shield", pac = true)),
        Row("bjogjfinolnhfhkbipphpdlldadpnmhc", "SEO META in 1 CLICK", "seo-meta", core = popupMarker("SEO META in 1 CLICK", "(function(){var t=(document.body?document.body.innerText:'').replace(/\\s+/g,' ').trim();var title=document.getElementById('seoTitle');var tt=title?(title.textContent||title.value||''):'';return JSON.stringify({pass:/Probe Page A/.test(tt)||/Probe Page A/.test(t),seoTitle:tt.slice(0,80),text:t.slice(0,160)})})()", settleMs = 25_000)),
        Row("cppjkneekbjaeellbfkmgnhonkkjfpdn", "Clear Cache", "clear-cache", core = ::clearCache),
        Row("ohcpnigalekghcmgcdcenkpelffpdolg", "ColorPick Eyedropper", "colorpick-eyedropper", core = actionMarker("ColorPick Eyedropper", "page-a.html?colorpick", "(function(){var box=document.getElementById('color_pick_click_box');var mark=document.getElementById('colorpick-watermark');var r=box?box.getBoundingClientRect():{width:0,height:0};return JSON.stringify({pass:!!box||!!mark,box:!!box,watermark:!!mark,w:Math.round(r.width),h:Math.round(r.height)})})()")),
        Row("jbojhlhhggfmmkpefknmbdhlaghehini", "Privacy Extension For WhatsApp Web", "privacy-whatsapp-web", core = liveMarker("Privacy Extension For WhatsApp Web", "https://web.whatsapp.com/", "(function(){var links=document.querySelectorAll('link.pfwa, style.pfwa-variables, .pfwa').length;return JSON.stringify({pass:links>0,styles:links,title:document.title,host:location.host})})()")),
        Row("ekmeppjgajofkpiofbebgcbohbmfldaf", "OrangeMonkey", "orangemonkey", core = { row, entry -> userscripts(row, entry, Regex("/options/index\\.html", RegexOption.IGNORE_CASE)) }),
        Row("bkpenclhmiealbebdopglffmfdiilejc", "Tab Resize - split screen layouts", "tab-resize", core = windowLayout("Tab Resize", ".resize-container .resize-selector")),
        Row("hnfanknocfeofbddgcijnmhnfnkdnaad", "Coinbase Wallet extension", "coinbase-wallet", core = domMarker("Coinbase Wallet's provider injected into the page world", "$LOCALHOST_BASE/wallet.html?coinbase", "JSON.stringify({pass:!!(window.coinbaseWalletExtension||(window.ethereum&&(window.ethereum.isCoinbaseWallet||window.ethereum.isCoinbaseBrowser))||(window.__wallet&&window.__wallet.announced&&window.__wallet.announced.some(function(n){return /coinbase/i.test(n)}))),coinbaseWalletExtension:typeof window.coinbaseWalletExtension,ethereum:typeof window.ethereum,isCoinbaseWallet:!!(window.ethereum&&window.ethereum.isCoinbaseWallet),announced:window.__wallet?window.__wallet.announced:null})", settleMs = 30_000)),
        Row("cfnpidifppmenkapgihekkeednfoenal", "TrafficLight", "trafficlight", core = siteVerdict("TrafficLight")),
        Row("fadndhdgpmmaapbmfcknlfgcflmmmieb", "FrankerFaceZ", "frankerfacez", core = liveMarker("FrankerFaceZ", "https://www.twitch.tv/directory", "(function(){var src=document.body&&document.body.dataset?document.body.dataset.ffzSource:null;var re=/ffz/i;var n=0,shown=0;var all=document.querySelectorAll('*');for(var i=0;i<all.length;i++){var e=all[i];var key=e.tagName+' '+(e.id||'')+' '+(typeof e.className==='string'?e.className:'');if(re.test(key)){n++;var r=e.getBoundingClientRect();if(r.width>0&&r.height>0)shown++}}return JSON.stringify({pass:!!src||n>0,ffzSource:src||null,n:n,visible:shown,ffz:typeof window.ffz,title:document.title})})()")),
        Row("njmehopjdpcckochcggncklnlmikcbnb", "Helium 10 for Amazon Sellers, Influencers & Brands", "helium-10", core = accountGate("Helium 10", Regex("helium10", RegexOption.IGNORE_CASE), gate = "a Helium 10 account (its popup signs in) and an Amazon product page to draw on")),
        Row("lmhkpmbekcpmknklioeibfkpmmfibljd", "Redux DevTools", "redux-devtools", core = ::reduxDevTools),
        Row("mjbepbhonbojpoaenhckjocchgfiaofo", "Ace Script", "ace-script", core = { row, entry -> userscripts(row, entry, Regex("/src/install\\.html", RegexOption.IGNORE_CASE)) }),
        Row("pcblbflgdkdfdjpjifeppkljdnaekohj", "Brisk Teaching - AI that Works Where Teachers Work", "brisk-teaching", core = accountGate("Brisk Teaching", Regex("brisk|accounts\\.google", RegexOption.IGNORE_CASE), injects = "plasmo-csui, #plasmo-shadow-container, [class*='brisk-menu'], [id*='brisk']", gate = "a Google sign-in (its menu signs in with Google)")),
        Row("jfiihjeimjpkpoaekpdpllpaeichkiod", "Page Marker - Draw on Web", "page-marker", core = actionMarker("Page Marker", "page-a.html?marker", "(function(){var c=document.getElementById('pageMarker_canvas')||document.querySelector('canvas[id*=\"pageMarker\"]');var bar=document.getElementById('pageMarker_draggable');var r=c?c.getBoundingClientRect():{width:0,height:0};return JSON.stringify({pass:!!c&&r.width>100&&r.height>100,canvas:!!c,toolbar:!!bar,w:Math.round(r.width),h:Math.round(r.height)})})()")),
        Row("jjicbefpemnphinccgikpdaagjebbnhg", "CSFloat Market Checker", "csfloat", core = liveMarker("CSFloat Market Checker", "https://steamcommunity.com/market/listings/730/AK-47%20%7C%20Redline%20%28Field-Tested%29", injectedAny("csfloat"))),
        Row("cnjifjpddelmedmihgijeibhnjfabmlf", "Obsidian Web Clipper", "obsidian-web-clipper", core = popupMarker("Obsidian Web Clipper", "(function(){var name=document.getElementById('note-name-field');var body=document.getElementById('note-content-field');var nv=name?(name.value||name.textContent||''):'';var bv=body?(body.value||body.textContent||''):'';var t=(document.body?document.body.innerText:'').replace(/\\s+/g,' ').trim();return JSON.stringify({pass:/Probe Page A/.test(nv)||/Probe Page A|quick brown fox/.test(bv),name:nv.slice(0,60),body:bv.slice(0,80),text:t.slice(0,120)})})()", settleMs = 30_000)),
        Row("pbhelknnhilelbnhfpcjlcabhmfangik", "1C:Enterprise extension", "1c-enterprise", core = serviceBacked("1C:Enterprise extension", "it bridges the page to the 1C:Enterprise platform (a desktop application) over native messaging; without the host, connectNative disconnects as Chrome's does", native = true)),
        Row("donbcfbmhbcapadipfkeojnmajbakjdc", "Ruffle - Flash Emulator", "ruffle", core = domMarker("Ruffle's player over the page's Flash tags", "flash.html?ruffle", "(function(){var all=document.querySelectorAll('*');var tags=[],canvases=0;for(var i=0;i<all.length;i++){var e=all[i];if(/^ruffle-/i.test(e.tagName)){tags.push(e.tagName.toLowerCase());if(e.shadowRoot)canvases+=e.shadowRoot.querySelectorAll('canvas').length}}var embed=document.getElementById('swf-embed');return JSON.stringify({pass:tags.length>0&&canvases>0,tags:tags.slice(0,4),canvases:canvases,player:typeof window.RufflePlayer,embed:embed?embed.tagName.toLowerCase():'gone'})})()", settleMs = 45_000)),
        Row("oakfpjifgmfpainopanfgfckhkcfgacb", "Yandex Access", "yandex-access", core = vpn("Yandex Access", pac = true, hasPopup = false)),
        Row("mokknliiomknodkdmpcellamkopbdmao", "Repeek (formerly FACEIT Enhancer)", "repeek", core = liveMarker("Repeek", "https://www.faceit.com/en/players/s1mple", injectedAny("repeek"))),
        Row("blipmdconlkpinefehnmjammfjpmpbjk", "Lighthouse", "lighthouse", core = popupOpens("Lighthouse", "/generate report|generate/i", Regex("pagespeed\\.web\\.dev", RegexOption.IGNORE_CASE))),
        Row("jhhclmfgfllimlhabjkgkeebkbiadflb", "EPUBReader", "epubreader", core = ::epubReader),
        Row("ojplelelocihfchkdaebocpankipadmp", "Scopus Document Download Manager", "scopus-download-manager", core = accountGate("Scopus Document Download Manager", Regex("scopus|elsevier", RegexOption.IGNORE_CASE), gate = "a Scopus session (its popup says it works with Scopus authenticated users)")),
        Row("bgdpkilkheacbboffppjgceiplijhfpd", "Dualless", "dualless", core = windowLayout("Dualless", ".split-panel-win")),
        Row("kglhbbefdnlheedjiejgomgmfplipfeb", "Jitsi Meetings", "jitsi-meetings", core = accountGate("Jitsi Meetings", Regex("calendar\\.google|outlook\\.(live|office)|accounts\\.google|login\\.microsoft", RegexOption.IGNORE_CASE), gate = "a Google or Outlook calendar session (its popup links to both)")),
        Row("ajphlblkfpppdpkgokiejbjfohfohhmk", "Mote for Google Chrome", "mote", core = accountGate("Mote", Regex("mote\\.com|justmote", RegexOption.IGNORE_CASE), injects = "[class*='mote-'], [id*='mote-'], mote-app, #mote-root", gate = "a Mote account (its click sends a signed-out user to mote.com/login)")),
        Row("epbobagokhieoonfplomdklollconnkl", "Scribbr Citation Generator", "scribbr", core = popupMarker("Scribbr Citation Generator", "(function(){var t=(document.body?document.body.innerText:'').replace(/\\s+/g,' ').trim();return JSON.stringify({pass:/Probe Page A/.test(t),text:t.slice(0,200)})})()", settleMs = 30_000, notMeasurable = Regex("something went wrong|try again|could not|unable to|failed|log ?in|sign ?in", RegexOption.IGNORE_CASE), gate = "its citation service (api.scribbr.com)")),
        Row("mloajfnmjckfjbeeofcdaecbelnblden", "Snap&Read", "snap-and-read", account = true, core = popupLogin("Snap&Read")),
        Row("ifajfiofeifbbhbionejdliodenmecna", "Co:Writer", "cowriter", account = true, core = popupLogin("Co:Writer")),
        // Compat round 12: ranks 241-270 by installs (`.github/scripts/ext-compat/next30-round9.json`,
        // compiled by the desktop rounds' method for a future desktop release round to reuse),
        // graded with the phone's feasibility classes as rounds 4-10 graded theirs: an account or
        // a vendor's service is `n/m` with its gate surface rendered (Pear Deck, LibKey Nomad,
        // Merlin, Grass, MozBar, Boomerang, ShopBack, Watch2Gether), a smart-card or document
        // signing host over native messaging (ArkSigner, Ntko) is `n/m` once `connectNative`
        // answers as Chrome does without the host, the `chrome.proxy` rows (UltraSurf, Turbo VPN,
        // ZeroOmega) are measured against what ProxyController applies, a devtools panel (Web
        // Scraper), a mouse's gestures (CrxMouse) and display capture (WeVideo, Audio Master)
        // are `n/a` once their scripts attach or their popups render, the rest read a real effect
        // on a fixture or in a popup. The five largest downloads last, so a run that dies keeps the rest.
        Row("pllcidbcfbamjfbfpemnnjohnfcliakf", "ArkSigner", "arksigner", core = serviceBacked("ArkSigner", "it signs documents with a smart card through the ArkSigner desktop host over native messaging; without the host, connectNative disconnects as Chrome's does", native = true)),
        Row("paijmjmfnjcbjlimjeminlepannmimbi", "Pear Deck Power-Up", "pear-deck", core = accountGate("Pear Deck Power-Up", Regex("peardeck|accounts\\.google|docs\\.google", RegexOption.IGNORE_CASE), gate = "a Google Slides presentation in a signed-in account and a Pear Deck account")),
        Row("lkoeejijapdihgbegpljiehpnlkadljb", "LibKey Nomad", "libkey-nomad", core = accountGate("LibKey Nomad", Regex("thirdiron|libkey|browzine", RegexOption.IGNORE_CASE), page = "index.html#/select-library", gate = "a library membership (its first run picks a library)")),
        Row("lppkeogbkjlmmbjenbogdndlgmpiddda", "Ntko", "ntko", core = serviceBacked("Ntko", "it drives the NTKO office document control (a desktop host) over native messaging; without the host, connectNative disconnects as Chrome's does", native = true)),
        Row("mjnbclmflcpookeapghfhapeffmpodij", "UltraSurf", "ultrasurf", core = vpn("UltraSurf")),
        Row("anflghppebdhjipndogapfagemgnlblh", "Cute Cursors", "cute-cursors", core = cursorPack("Cute Cursors")),
        Row("ekhbcipncbkfpkaianbjbcbmfehjflpf", "CocoCut", "cococut", core = mediaPopup("CocoCut", "video.html?cococut", "/clip|mp4|webm|video/i")),
        Row("camppjleccjaphfdbohjdohecfnoikec", "Merlin AI", "merlin-ai", core = accountGate("Merlin AI", Regex("getmerlin|merlin", RegexOption.IGNORE_CASE), page = "sidepanel.html", injects = "[class*='merlin'], [id*='merlin']", gate = "a Merlin account")),
        Row("afpbjjgbdimpioenaedcjgkaigggcdpp", "QR Code Generator", "qr-code-generator-afp", core = popupMarker("QR Code Generator", QR_DRAWN)),
        Row("noaijdpnepcgjemiklgfkcfbkokogabh", "ImTranslator", "imtranslator", core = ::imTranslator),
        Row("ilehaonighjijnmpnagapkhpcdbhclfg", "Grass Lite Node", "grass-lite-node", account = true, core = popupLogin("Grass Lite Node")),
        Row("chklaanhfefbnpoihckbnefhakgolnmc", "JSONVue", "jsonvue", core = jsonViewer("JSONVue")),
        Row("eakacpaijcpapndcfffdgphdiccmpknp", "MozBar", "mozbar", core = accountGate("MozBar", Regex("moz\\.com", RegexOption.IGNORE_CASE), injects = "#mozbar, [id*='mozbar'], [class*='mozbar']", gate = "a Moz account (its toolbar signs in)")),
        Row("mdanidgdpmkimeiiojknlnekblgmpdll", "Boomerang for Gmail", "boomerang-gmail", core = accountGate("Boomerang for Gmail", Regex("mail\\.google|accounts\\.google|boomerang", RegexOption.IGNORE_CASE), gate = "a Gmail session (its scripts run on mail.google.com)")),
        Row("bnlofglpdlboacepdieejiecfbfpmhlb", "Turbo VPN", "turbo-vpn", core = vpn("Turbo VPN")),
        Row("lgjhepbpjcmfmjlpkkdjlbgomamkgonb", "Google Docs Dark Mode", "google-docs-dark-mode", core = siteGate("Google Docs Dark Mode", "https://docs.google.com/document/u/0/", "link[href*='lgjhepbpjcmfmjlpkkdjlbgomamkgonb'], style[id*='dark'], [class*='docs-dark']", Regex("^https://docs\\.google\\.com/document/"), "a Google sign-in (its script runs on a document)")),
        Row("jnhgnonknehpejjnehehllkliplmbmhn", "Web Scraper", "web-scraper", core = notOnThePhone("Web Scraper: its whole surface is a devtools panel (devtools_page); the phone has no devtools to host it: WebView limit")),
        // Fonts Ninja's content script mounts `<fn-ninja-root data-fn="v9" popover="manual">` on
        // `document.documentElement` with a closed shadow root, and its `frame.html` loads inside
        // it (the page context's hello in the bridge); the host is what the page can see of it.
        Row("eljapbgkmlngdpckoiiibecpemleclhh", "Fonts Ninja", "fonts-ninja", core = actionMarker("Fonts Ninja", "styled-light.html?fonts", "(function(){var host=document.querySelector('fn-ninja-root, [data-fn]');var f=document.querySelector('iframe[src*=\"frame.html\"], iframe[src*=\"eljapbgkmlngdpckoiiibecpemleclhh\"]');var marks=document.querySelectorAll('[id*=\"fontsninja\"], [class*=\"fontsninja\"], [id*=\"fonts-ninja\"], [class*=\"fonts-ninja\"], fonts-ninja, [id*=\"fontface-ninja\"], [class*=\"fontface-ninja\"]');var el=host||f;var r=el?el.getBoundingClientRect():{width:0,height:0};var open=false;try{open=!!host&&host.matches(':popover-open')}catch(e){}return JSON.stringify({pass:!!host||!!f||marks.length>0,host:host?host.tagName.toLowerCase():null,dataFn:host?host.getAttribute('data-fn'):null,shadow:host?(host.shadowRoot?'open':'closed or none'):null,popoverOpen:open,frame:!!f,marks:marks.length,w:Math.round(r.width),h:Math.round(r.height)})})()")),
        Row("pfnededegaaopdmhkdmcofjmoldfiped", "ZeroOmega", "zeroomega", core = ::proxySwitcher),
        Row("iplffkdpngmdjhlpjmppncnlhomiipha", "Unpaywall", "unpaywall", core = ::unpaywall),
        Row("dfffkbbackkpgmddopaeohbdgfckogdn", "Audio Master mini", "audio-master-mini", core = captureLimit("Audio Master mini", "/volume|bass|boost|equal/i")),
        Row("iodihamcpbpeioajjeobimgagajmlibd", "Secure Shell", "secure-shell", core = ownPage("Secure Shell", "html/nassh.html", "(function(){var t=(document.body?document.body.innerText:'').replace(/\\s+/g,' ').trim();var term=document.querySelector('#terminal, x-row, .hterm, iframe');var fields=document.querySelectorAll('input, select, textarea, [contenteditable]').length;var rows=document.querySelectorAll('x-row').length;return JSON.stringify({pass:!!term||fields>0||t.length>40,terminal:!!term,fields:fields,rows:rows,text:t.slice(0,160)})})()", gate = "an SSH host to connect to")),
        Row("cimpffimgeipdhnhjohpbehjkcdpjolg", "Watch2Gether", "watch2gether", core = accountGate("Watch2Gether", Regex("w2g\\.tv|watch2gether", RegexOption.IGNORE_CASE), gate = "a Watch2Gether room on w2g.tv (its share opens one)")),
        // Over `media.html` with the webRequest probe (round 13's item 4): its sniffer is an
        // `onHeadersReceived` listener with `responseHeaders` (`bg/bg.min.js`), reading the
        // content-type, content-length and content-disposition, or the URL's media extension.
        Row("mciiogijehkdemklbdcbfkefimifhecn", "Chrono Download Manager", "chrono-download-manager", core = mediaPopup("Chrono Download Manager", "media.html?chrono", "/clip|mp4|webm|video/i", panel = "/sniffer|resources|media/i", probe = true, listener = "onHeadersReceived with responseHeaders (content-type image/audio/video, content-length, content-disposition; or the URL's media extension; tabId != -1)")),
        Row("nfmmmhanepmpifddlkkmihkalkoekpfd", "FetchV", "fetchv", core = mediaPopup("FetchV", "hls.html?fetchv", "/m3u8|stream|hls|download|clip/i")),
        Row("jlgkpaicikihijadgifklkbpdajbkhjo", "CrxMouse", "crxmouse", core = contentAttached("CrxMouse", "its gestures need a mouse's right button and wheel, which the phone has not got: not applicable")),
        Row("cmdgdghfledlbkbciggfjblphiafkcgg", "SBlock", "sblock", core = ::adBlocker),
        Row("djjjmdgomejlopjnccoejdhgjmiappap", "ShopBack", "shopback", core = accountGate("ShopBack", Regex("shopback", RegexOption.IGNORE_CASE), injects = "[id*='shopback'], [class*='shopback']", gate = "a ShopBack account and a merchant page")),
        Row("pohmgobdeajemcifpoldnnhffjnnkhgf", "WeVideo Screen & Webcam Recorder", "wevideo-recorder", core = recorderPopup("WeVideo Screen & Webcam Recorder", "/record|screen|webcam|camera/i")),
        Row("acmacodkjbdgmoleebolmdjonilkdbch", "Rabby Wallet", "rabby-wallet", core = domMarker("Rabby Wallet's provider injected into the page world", "wallet.html?rabby", "JSON.stringify({pass:!!(window.rabby||(window.ethereum&&window.ethereum.isRabby)||(window.__wallet&&window.__wallet.announced&&window.__wallet.announced.some(function(n){return /rabby/i.test(n)}))),rabby:typeof window.rabby,ethereum:typeof window.ethereum,isRabby:!!(window.ethereum&&window.ethereum.isRabby),announced:window.__wallet?window.__wallet.announced:null})", settleMs = 30_000)),
        // Compat round 13: ranks 271-300 by installs (`.github/scripts/ext-compat/next30-round10.json`,
        // compiled by the desktop rounds' method for a future desktop release round to reuse),
        // graded with the phone's feasibility classes as rounds 4-12 graded theirs: a desktop host
        // over native messaging (Foxit PDF Creator, KeePassXC-Browser) is `n/m` once `connectNative`
        // answers as Chrome does without the host; an account or a vendor's service is `n/m` with
        // its gate surface rendered (Text Blaze, Smarty, Streak, Cuponomia, MaxAI, Adobe Photoshop's
        // side panel, Total Adblock's activation, Voice In's setup page and microphone); a site the
        // phone has no fixture for is read live (RoGold on roblox.com, The Camelizer over an Amazon
        // product page); a script that attaches to another origin's frame is read off the runtime's
        // endpoint table (Buster in reCAPTCHA's challenge frame); the rest read a real effect on a
        // fixture, in a popup or on the tab list: the fixture's consent banners hidden (I don't care
        // about cookies' insertCSS), Gmail's compose opened with the page's address (Send from
        // Gmail), two typed addresses opened as tabs (Open Multiple URLs), a new tab sent to the
        // option's address (New Tab Redirect), a Wallet Standard registration or a provider in the
        // page (Slush, Solflare), a cross-origin fetch the page could read once the header rule went
        // in (Allow CORS: a response-header edit on a subresource, which the header stage relays for
        // documents alone – measured, not assumed), the page's colours scanned into a popup (Color
        // Picker), the fixture host blocked in a popup (StayFocusd), WOT's slider frame mounted by
        // the action click, eJOY's lookup on a double-tapped word. Six rows declare a
        // `minimum_chrome_version` above WebView 113's (Text Blaze 147, KeePassXC-Browser 124,
        // Buster 123, Tampermonkey BETA 120, Send from Gmail 116, CyberGhost 116): the runtime holds
        // the field against Zenium's platform version (the store's 152), installs them, and warns
        // once on the error console where the WebView's engine is below it
        // (`extensionHost.warnEngineBelowMinimum`); the 113 column measures them on that engine.
        // The five largest downloads last, so a run that dies keeps the rest.
        Row("cifnddnffldieaamihfkhkdgnbhfmaci", "Foxit PDF Creator", "foxit-pdf-creator", core = serviceBacked("Foxit PDF Creator", "it converts the page to PDF through the Foxit PDF Editor desktop host over native messaging; without the host, connectNative disconnects as Chrome's does", native = true)),
        Row("opcgpfmipidbgpenhmajoajpbobppdil", "Slush - A Sui wallet", "slush", core = domMarker("Slush's Wallet Standard registration in the page world", "wallet.html?slush", WALLET_STANDARD.replace("__RE__", "/slush|sui wallet/i").replace("__GLOBALS__", "o.suiWallet!=='undefined'||o.slush!=='undefined'"), settleMs = 30_000)),
        Row("phfkifnjcmdcmljnnablahicoabkokbg", "Custom Cursors for Chrome", "custom-cursors-for-chrome", core = cursorPack("Custom Cursors for Chrome")),
        Row("mafcicncghogpdpaieifglifaagndbni", "RoGold - Level Up Roblox", "rogold", core = liveMarker("RoGold", "https://www.roblox.com/games/920587237", injectedAny("rogold"))),
        Row("pgphcomnlaojlmmcjmiddhdapjpbgeoc", "Send from Gmail (by Google)", "send-from-gmail", core = actionOpens("Send from Gmail", "page-a.html?sendgmail", Regex("mail\\.google\\.com/mail/\\?view=cm|accounts\\.google\\.com", RegexOption.IGNORE_CASE), Regex("10\\.0\\.2\\.2:8765/page-a\\.html\\?sendgmail", RegexOption.IGNORE_CASE))),
        Row("idgadaccgipmpannjkmfddolnnhmeklj", "Text Blaze", "text-blaze", core = accountGate("Text Blaze", Regex("blaze\\.today|accounts\\.google", RegexOption.IGNORE_CASE), gate = "a Text Blaze account (its dashboard signs in; its snippets live there)")),
        Row("fihnjjcciajhdojfnbdddfaoknhalnja", "I don't care about cookies", "idcac", core = domMarker("I don't care about cookies' stylesheet over the fixture's consent banners", "cookie-banner.html?idcac", COOKIE_BANNERS_HIDDEN, settleMs = 30_000)),
        Row("ffbkglfijbcbgblgflchnbphjdllaogb", "CyberGhost VPN", "cyberghost-vpn", core = vpn("CyberGhost VPN")),
        Row("ghnomdcacenbmilgjigehppbamfndblo", "The Camelizer", "the-camelizer", core = popupMarker("The Camelizer", CAMELIZER_CHART, page = "https://www.amazon.com/dp/B00FLYWNYQ", settleMs = 40_000, notMeasurable = Regex("robot|captcha|enter the characters|where are we|not (seem to be )?on amazon|unknown error|try again|continue shopping|something went wrong", RegexOption.IGNORE_CASE), gate = "Amazon serving the product page to the runner and camelcamelcamel.com's chart", fixtureSettleMs = 6_000)),
        Row("mpbjkejclgfgadiemmefgebjfooflfhl", "Buster: Captcha Solver for Humans", "buster", core = frameAttach("Buster", "recaptcha.html?buster", Regex("recaptcha/(api2|enterprise)/bframe"), "its solve button lives in the audio challenge, which Google's test key never asks for, and the solve needs a speech service")),
        Row("oboonakemofpalcgghocfoadofidjkkk", "KeePassXC-Browser", "keepassxc-browser", core = serviceBacked("KeePassXC-Browser", "it fills credentials from the KeePassXC desktop application over native messaging; without the host, connectNative disconnects as Chrome's does", native = true)),
        Row("edjkecefjhobekadlkdkopkggdefpgfp", "Smarty", "smarty", core = accountGate("Smarty", Regex("joinsmarty|smarty", RegexOption.IGNORE_CASE), injects = "[id*='smarty'], [class*='smarty']", gate = "a Smarty account and a merchant checkout (its coupons run there)")),
        Row("digojkgonhgmnohbapdfjllpnmjmdhpg", "ProctorExam Activity Sharing", "proctorexam", core = serviceBacked("ProctorExam Activity Sharing", "its content script runs on a ProctorExam exam session alone (proctorexam.com/student_sessions, check_requirements), relaying the page's messages to its worker for the tab sharing an exam needs")),
        Row("oifijhaokejakekmnjmphonojcfkpbbh", "Open Multiple URLs", "open-multiple-urls", core = ::openMultipleUrls),
        Row("lhobafahddgcelffkeicbaginigeejlf", "Allow CORS: Access-Control-Allow-Origin", "allow-cors", core = popupFlow("Allow CORS", "cors.html?allowcors", clicks = listOf("/toggle/i"), expr = CORS_UNLOCKED, settleMs = 20_000)),
        Row("clldacgmdnnanihiibdgemajcfkmfhia", "Color Picker for Chrome", "color-picker", core = popupFlow("Color Picker for Chrome", "styled-light.html?colors", clicks = listOf("/scan colors|analy[sz]e|scan page|scan/i"), expr = COLOR_SWATCHES, onPage = false, settleMs = 20_000)),
        Row("hmffdimoneaieldiddcmajhbjijmnggi", "EasyBib Toolbar", "easybib-toolbar", core = popupMarker("EasyBib Toolbar", EASYBIB_CITATION, settleMs = 30_000, notMeasurable = Regex("sign ?in|log ?in|something went wrong|try again|unable|could not|error", RegexOption.IGNORE_CASE), gate = "Chegg's citation service (gateway.chegg.com)")),
        Row("nbcojefnccbanplpoffopkoepjmhgdgh", "Hoxx VPN Proxy", "hoxx-vpn", core = vpn("Hoxx VPN Proxy")),
        Row("bhmmomiinigofkjcapegjjndpbikblnp", "WOT: Website Security & Safety Checker", "wot", core = actionMarker("WOT", "page-a.html?wot", WOT_SLIDER)),
        Row("laankejkbhbdhmipfmgcngdelahlfoji", "StayFocusd", "stayfocusd", core = popupFlow("StayFocusd", "page-a.html?stayfocusd", clicks = listOf("/block entire site|block this (url|site)|block site/i"), expr = STAYFOCUSD_BLOCKED, onPage = false, settleMs = 20_000)),
        Row("pnnfemgpilpdaojpnkjdgfgbnnjojfik", "Streak CRM for Gmail", "streak-crm", core = accountGate("Streak CRM for Gmail", Regex("mail\\.google|accounts\\.google|streak", RegexOption.IGNORE_CASE), gate = "a Gmail session (its scripts run on mail.google.com)")),
        Row("amfojhdiedpdnlijjbhjnhokbnohfdfb", "eJOY AI Dictionary", "ejoy", core = ::ejoy),
        Row("gcalenpjmijncebpfijmoaglllgpjagf", "Tampermonkey BETA", "tampermonkey-beta", core = { row, entry -> userscripts(row, entry, Regex("/ask\\.html")) }),
        Row("icpgjfneehieebagbmdbhnlpiopdcmna", "New Tab Redirect", "new-tab-redirect", core = ::newTabRedirect),
        Row("pjnefijmagpdjfhhkpljicbbpicelgko", "Voice In", "voice-in", core = accountGate("Voice In", Regex("setup\\.html|dictanote", RegexOption.IGNORE_CASE), injects = "[id^='voicein_']", gate = "the microphone permission and a language pick on its setup page (its first click opens it; the emulator has no microphone)")),
        Row("gidejehfgombmkfflghejpncblgfkagj", "Cuponomia", "cuponomia", core = accountGate("Cuponomia", Regex("cuponomia", RegexOption.IGNORE_CASE), injects = "[id*='cuponomia'], [class*='cuponomia']", gate = "a Brazilian merchant page and a Cuponomia account (its cashback)")),
        Row("mhnlakgilnojmhinhkckjpncpbhabphi", "MaxAI", "maxai", core = accountGate("MaxAI", Regex("maxai|accounts\\.google", RegexOption.IGNORE_CASE), injects = "#USE_CHAT_GPT_AI_ROOT, [id*='MAXAI'], [id*='maxai'], [class*='maxai']", gate = "a MaxAI account")),
        Row("gekdekpbfehejjiecgonmgmepbdnaggp", "Total Adblock", "total-adblock", core = gatedAdBlocker("Total Adblock", Regex("sign ?in|log ?in|activat|subscri|trial|account|get started|protect|upgrade", RegexOption.IGNORE_CASE))),
        Row("bhhhlbepdkbapadjdnnojkbgioiodbic", "Solflare Wallet", "solflare-wallet", core = domMarker("Solflare's provider injected into the page world", "wallet.html?solflare", WALLET_STANDARD.replace("__RE__", "/solflare/i").replace("__GLOBALS__", "o.solflare!=='undefined'||o.isSolflare===true"), settleMs = 30_000)),
        Row("kjchkpkjpiloipaonppkmepcbhcncedo", "Adobe Photoshop", "adobe-photoshop", core = accountGate("Adobe Photoshop", Regex("adobe\\.com|photoshop", RegexOption.IGNORE_CASE), page = "sidepanel.html", gate = "an Adobe account (its side panel signs in)"))
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

    /**
     * The document has content: text, more than a handful of elements (an icon-only popup), or an
     * embedded document or drawing (Tag Assistant's side panel is one cross-origin frame of
     * tagassistant.google.com and nothing else; what the frame shows is its own).
     */
    private fun rendered(view: WebView): Boolean =
        tabEval(view, "String(!!document.body && (document.body.innerText.trim().length > 0 || document.body.querySelectorAll('*').length > 3 || !!document.body.querySelector('iframe,embed,object,canvas,video,img,svg')))", 5) == "true"

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

    /**
     * A core command through the chrome, with the allowance for a chrome another page's renderer
     * work holds up ([coreInvokeUnderStall]): every WebView of the process shares one renderer
     * main thread, and on WebView 156 Trust Wallet's background posted at the flood guard's rate
     * for 43 s after its popup stage while the harness's fixed 15 s `app.getState` ran out in
     * [closeExtraTabs] (round 12, run 35892151969: the 156 core never read). A poll the chrome
     * answered late is not charged to the wait; the wait ends at two minutes whatever came. The
     * stall a read measured goes on the row (`coreStall`: reads that stalled, the longest poll, the
     * last command) so a grade made under one says so.
     */
    private fun coreCall(name: String, args: String = "null"): String =
        coreInvokeUnderStall(name, args, onStall = { longest ->
            val entry = rowEntry
            if (entry != null) {
                val stall = entry.optJSONObject("coreStall") ?: JSONObject().also { entry.put("coreStall", it) }
                stall.put("reads", stall.optInt("reads") + 1)
                    .put("longestPollMs", maxOf(stall.optLong("longestPollMs"), longest))
                    .put("last", name)
                Log.w(TAG, "CORE STALL ${entry.optString("name")}: $name answered after a poll of $longest ms")
            }
        })

    /** The core's UI state (`app.getState`) through [coreCall]. */
    private fun coreSnapshot(): JSONObject = JSONObject(coreCall("app.getState"))

    /** The row under way, for the evidence a core read under a stall leaves on it. */
    private var rowEntry: JSONObject? = null

    private fun extensions(): List<JSONObject> {
        val list = coreSnapshot().optJSONArray("extensions") ?: JSONArray()
        return (0 until list.length()).map { list.getJSONObject(it) }
    }

    private fun extensionAction(id: String): JSONObject? = extensions().firstOrNull { it.getString("id") == id }?.optJSONObject("action")

    /** Every tab of the core's snapshot: id to URL. */
    private fun tabUrls(): Map<String, String> {
        val tabs = coreSnapshot().optJSONObject("tabs") ?: return emptyMap()
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

    private fun createTab(url: String): String = coreCall("tab.create", """{"url":${JSONObject.quote(url)},"active":true}""").trim('"')

    private fun closeTab(tabId: String) {
        runCatching { coreCall("tab.close", """{"tabId":${JSONObject.quote(tabId)},"force":true}""") }
    }

    /**
     * Every tab but the fixture goes (what an extension opened, what a check created). The list is
     * read off the host's tab views on the UI thread ([hostTabIds]), a path the renderer's queue
     * does not hold: the core's `app.getState` answers from the renderer main thread the row's
     * pages share, and a row that opened nothing (Trust Wallet's popup was a sheet) makes no core
     * read here at all; the closes themselves go through [coreCall] with its allowance.
     */
    private fun closeExtraTabs() {
        for (id in hostTabIds()) if (id != fixtureTab) closeTab(id)
        SystemClock.sleep(600)
    }

    /** The ids of the tabs with a view in the host right now, read on the UI thread (no core round trip). */
    private fun hostTabIds(): List<String> {
        var ids: List<String> = emptyList()
        instrumentation.runOnMainSync { ids = host.tabs.all().map { it.tabId } }
        return ids
    }

    private fun showTab(tabId: String) {
        coreCall("tab.activate", """{"tabId":${JSONObject.quote(tabId)}}""")
        poll(8_000, 200) { if (activeCoreTab(coreSnapshot())?.optString("id") == tabId) true else null }
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

    /** The row's `identity.launchWebAuthFlow` sheet when one is up, or null. */
    private fun authSheetView(id: String): WebView? {
        var v: WebView? = null
        instrumentation.runOnMainSync { v = host.extensions.authSheetView(id) }
        return v
    }

    /** The URL the row's auth sheet is on, or null without a sheet or before its first page. */
    private fun authSheetUrl(id: String): String? {
        var url: String? = null
        instrumentation.runOnMainSync { url = host.extensions.authSheetView(id)?.url?.takeIf { it.isNotEmpty() && it != "about:blank" } }
        return url
    }

    private fun backgroundView(id: String): ExtensionWebView? {
        var v: ExtensionWebView? = null
        instrumentation.runOnMainSync { v = host.extensions.backgroundView(id) }
        return v
    }

    /**
     * The background's view, woken when it idled out: an MV3 worker stops half a minute after its
     * last traffic (Chrome's clock too), and a probe of its APIs that comes later than that found
     * no view in round 7's driver ("no background view"). The runtime starts it again on request
     * (`Extensions.wakeBackground`, as Chrome's management page starts an inactive worker for its
     * inspector) and the view is answered once its `chrome` is there.
     */
    private fun awakeBackground(id: String, factor: Double): ExtensionWebView? {
        backgroundView(id)?.let { view ->
            if (runCatching { tabEval(view, "String(typeof chrome === 'object' && !!chrome.runtime)", 5) }.getOrNull() == "true") return view
        }
        instrumentation.runOnMainSync { host.extensions.wakeBackground(id) }
        return poll(scaled(15_000, factor), 400) {
            val view = backgroundView(id) ?: return@poll null
            if (runCatching { tabEval(view, "String(typeof chrome === 'object' && !!chrome.runtime && document.readyState !== 'loading')", 5) }.getOrNull() == "true") view else null
        }?.also { SystemClock.sleep(scaled(800, factor)) }
    }

    /**
     * What a sheet shows as the user sees it, read from the accessibility tree rather than the
     * document: a page that keeps its whole UI in a closed shadow root (Click&Clean attaches one to
     * its body and builds its menu inside) reads as empty to a script yet is drawn as Chrome draws
     * it. The visible nodes inside the view's screen bounds, with their labels.
     */
    private fun seenInView(view: WebView): JSONObject {
        val bounds = Rect()
        instrumentation.runOnMainSync {
            val xy = IntArray(2)
            view.getLocationOnScreen(xy)
            bounds.set(xy[0], xy[1], xy[0] + view.width, xy[1] + view.height)
        }
        val labels = ArrayList<String>()
        var count = 0
        if (bounds.width() > 0 && bounds.height() > 0) {
            for (node in nodes { it.isVisibleToUser }) {
                val rect = Rect().also(node::getBoundsInScreen)
                if (rect.isEmpty || !bounds.contains(rect.centerX(), rect.centerY())) continue
                count++
                val text = (node.text ?: node.contentDescription)?.toString()?.replace(Regex("\\s+"), " ")?.trim().orEmpty()
                if (text.isNotEmpty() && labels.size < 24) labels += text.take(40)
            }
        }
        return JSONObject().put("nodes", count).put("labels", JSONArray(labels))
    }

    /** A sheet whose document reads empty but that shows labelled content: the shadow-root case. */
    private fun shownDespiteEmptyDom(seen: JSONObject): Boolean = (seen.optJSONArray("labels")?.length() ?: 0) >= 3

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
            runCatching { coreCall(command, JSONObject().put("requestId", prompt.optString("id")).put("accept", true).toString()) }
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
     * the navigation bar's window, the bottom band the larger of the bars' inset and the tappable
     * inset – the band DemoHarness taps within. (The band was held to 48 dp by hand while the
     * recipe's plain `cmd overlay enable` left the gestural overlay on beside the three-button
     * one and SystemUI reported the gestural bar's 24 dp under a 48 dp button window – the taps
     * the system took for its own, Overview opened and the launcher on screen, were within 48 dp
     * of the bottom edge; the recipe enables the buttons exclusively now and the insets say 48.)
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
            val bottomBand = maxOf(bars?.bottom ?: 0, tappable?.bottom ?: 0)
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
        if (!onScreen("tap at $x,$y")) return
        // The main thread answering first: a down whose timestamp has aged in a stalled queue is
        // read by the WebView as the start of a long-press ([tapSettled]).
        instrumentation.runOnMainSync { }
        Finger().tap(x, y)
    }

    /**
     * A finger on a control of `view` at `css` (`x`, `y` in its CSS px) that cannot land as a
     * long-press, and that reads what the tap left. The instrumentation's tap is a down, 60 ms, an
     * up, each queued for the main thread; under a stall the down's timestamp ages in the queue,
     * the WebView's long-press timer runs against it and fires before the up is read, and the
     * control's text is selected with the Copy / Select all menu up instead of clicked (round
     * 11b's 6.2, Clear Cache's Clear on 156; round 12's retry read the top document's selection,
     * which a control in the extension's own frame – Clear Cache's confirmation iframe, another
     * origin – never shows). Here the down and the up go through the WebView's own
     * `dispatchTouchEvent` in one turn of the main thread ([tapThroughView]), 50 ms apart by their
     * timestamps and both taken before any timer can run, so the queue's age never separates
     * them. What the tap left is then read – a selection in the document, or the selection menu
     * on screen ([selectionMenuUp]) – and either is pressed away (BACK ends the action mode) and
     * the control tapped once more; the record says so. Null for a plain tap.
     */
    private fun tapSettled(view: WebView, css: JSONObject, factor: Double): String? {
        val point = screenPoint(view, css) ?: return "no screen point for ${css.toString().take(80)}"
        if (!onScreen("tap at ${point.first},${point.second}")) return "the browser was off screen"
        tapThroughView(view, point)
        SystemClock.sleep(scaled(700, factor))
        val selected = runCatching { tabEval(view, "String(!!window.getSelection && getSelection().toString().trim().length > 0)", 5) }.getOrNull() == "true"
        val menu = selectionMenuUp()
        if (!selected && menu == null) return null
        snap("tap-long-press")
        if (selected) runCatching { tabEval(view, "(function(){getSelection().removeAllRanges();return 'cleared'})()", 5) }
        if (menu != null) {
            back()
            SystemClock.sleep(scaled(600, factor))
        }
        SystemClock.sleep(scaled(500, factor))
        tapThroughView(view, point)
        val left = listOfNotNull(if (selected) "text selected in the document" else null, menu?.let { "the selection menu up ($it)" }).joinToString(", ")
        return "the first tap landed as a long-press ($left); ${if (menu != null) "BACK pressed the menu away" else "the selection cleared"} and the control tapped again"
    }

    /**
     * The down and the up of a tap at a screen point through `view`'s own `dispatchTouchEvent`,
     * in one turn of the main thread with fresh timestamps 50 ms apart: the WebView reads them
     * as one tap whatever the queue behind them held.
     */
    private fun tapThroughView(view: WebView, screen: Pair<Float, Float>) {
        instrumentation.runOnMainSync {
            val location = IntArray(2)
            view.getLocationOnScreen(location)
            val x = screen.first - location[0]
            val y = screen.second - location[1]
            val downTime = SystemClock.uptimeMillis()
            val down = MotionEvent.obtain(downTime, downTime, MotionEvent.ACTION_DOWN, x, y, 0)
            val up = MotionEvent.obtain(downTime, downTime + 50, MotionEvent.ACTION_UP, x, y, 0)
            down.source = InputDevice.SOURCE_TOUCHSCREEN
            up.source = InputDevice.SOURCE_TOUCHSCREEN
            try {
                view.dispatchTouchEvent(down)
                view.dispatchTouchEvent(up)
            } finally {
                down.recycle()
                up.recycle()
            }
        }
    }

    /**
     * The WebView's text-selection menu on screen (its floating action mode: Copy, Select all,
     * Share, Web search, Paste – a window of its own in the accessibility tree), as its labels;
     * null when none is up. Two of its words in one window that is not the activity's make it.
     */
    private fun selectionMenuUp(): String? {
        val screenHeight = app.resources.displayMetrics.heightPixels
        for (window in ui.windows) {
            val root = window.root ?: continue
            val bounds = Rect().also(window::getBoundsInScreen)
            if (bounds.height() >= screenHeight * 9 / 10) continue
            val labels = ArrayList<String>()
            val queue = ArrayDeque(listOf(root))
            var visited = 0
            while (queue.isNotEmpty() && visited++ < 500) {
                val node = queue.removeFirst()
                val text = (node.text ?: node.contentDescription)?.toString()?.trim().orEmpty()
                if (SELECTION_MENU_WORDS.matches(text)) labels.add(text)
                for (i in 0 until node.childCount) node.getChild(i)?.let(queue::add)
            }
            if (labels.size >= 2) return labels.joinToString(" / ")
        }
        return null
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

    /**
     * The app's windows over its activity's: the native sheets – an extension's popup, options
     * page or side panel in an `ExtensionSheet`, an install or permission prompt
     * (`NativePromptSheet`), a page dialog, an auth sheet – each a `BottomSheetDialog` whose
     * window covers the screen behind its scrim, so [dismissDialog]'s height test never meets
     * one. The activity's own window is the lowest of the app's; every window of the app's
     * above it is a surface the back gesture dismisses. Empty with the activity alone up.
     */
    private fun extraWindows(): List<AccessibilityWindowInfo> {
        val own = ui.windows.filter {
            it.type == AccessibilityWindowInfo.TYPE_APPLICATION && it.root?.packageName?.toString() == app.packageName
        }
        if (own.size < 2) return emptyList()
        val lowest = own.minByOrNull { it.layer } ?: return emptyList()
        return own.filter { it !== lowest }
    }

    /** A window's first texts (labels and descriptions, breadth first) behind its layer: the evidence of what was up. */
    private fun windowTexts(window: AccessibilityWindowInfo): String {
        val root = window.root ?: return "layer ${window.layer}: (no root)"
        val texts = ArrayList<String>()
        val queue = ArrayDeque(listOf(root))
        var visited = 0
        while (queue.isNotEmpty() && visited++ < 1_000 && texts.size < 12) {
            val node = queue.removeFirst()
            (node.text ?: node.contentDescription)?.toString()?.trim()?.takeIf { it.isNotEmpty() }?.let(texts::add)
            for (i in 0 until node.childCount) node.getChild(i)?.let(queue::add)
        }
        return "layer ${window.layer}: ${texts.joinToString(" | ").take(240)}"
    }

    /**
     * Every native sheet over the browser down at a row boundary, before the next capture: the
     * core's close for the extension sheet it tracks, then one back per window of the app's
     * still over the activity's, until none is (four at most). Round 12's UltraSurf row left
     * its welcome popup up – its worker opens it at install with `action.openPopup()`, and the
     * row's own close found nothing tracked – and the rows after it graded under the sheet,
     * their stills carrying UltraSurf's surface over Fonts Ninja's and ZeroOmega's pages
     * (`ext-android-16-webview156-22-fonts-ninja-core.png` and its 113 twin). What was up is
     * kept as evidence on the row and in the run (`sheetsDismissed`: the moment, each window's
     * texts, the backs pressed, what they left), with one still of it. A back is pressed only
     * with such a window on screen, never at the activity itself; a boundary with nothing up
     * costs one read of the window list.
     */
    private fun dismissSheets(entry: JSONObject?, moment: String) {
        val up = extraWindows()
        if (up.isEmpty()) return
        val texts = JSONArray(up.map { windowTexts(it) })
        Log.w(TAG, "$moment: ${up.size} window(s) of the app's over the browser: ${texts.join(" || ")}")
        snap("sheets-up")
        runCatching { coreCall("extension.closePopup", "null") }
        SystemClock.sleep(500)
        var backs = 0
        while (backs < 4 && extraWindows().isNotEmpty()) {
            back()
            backs++
            SystemClock.sleep(700)
        }
        val left = JSONArray(extraWindows().map { windowTexts(it) })
        val report = JSONObject().put("at", moment).put("windows", texts).put("backs", backs).put("left", left)
        sheetsDismissed.put(report)
        entry?.let { (it.optJSONArray("sheetsDismissed") ?: JSONArray().also { list -> it.put("sheetsDismissed", list) }).put(report) }
        if (left.length() > 0) Log.e(TAG, "$moment: ${left.length()} window(s) still up after $backs back(s): ${left.join(" || ")}")
        else Log.w(TAG, "$moment: the browser alone on screen after $backs back(s)")
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

    /**
     * The main thread answering: a runnable posted to it from a thread of this watch's own once
     * the last one has run, and every thread's stack written to `hang-main-thread-N.txt` beside
     * results.json when it has not run for [HANG_MAIN_THREAD_MS], again every
     * [HANG_DUMP_AGAIN_MS] while the stall lasts. Run 35787391495's 113 job: Redux DevTools'
     * package fetched and verified, its install prompt due, then the process wrote nothing for
     * two hours – no frame, no line of the driver's, whose own timeouts never fired because its
     * thread was inside a synchronous call to the main thread – until the system died under the
     * step's cap, with no stack anywhere (`hide_error_dialogs` keeps the ANR dialog off, and the
     * driver had injected no input for the input dispatcher to time out on). The sweep script
     * pulls the file with the row's others and takes ART's own trace and the native backtrace
     * on its side once the process has been silent in logcat for five minutes
     * (android-ext-compat-sweep.sh).
     */
    private inner class MainThreadWatch {
        private var thread: Thread? = null
        @Volatile private var running = false
        @Volatile private var lastAnswer = 0L
        @Volatile private var pending = false
        /** The row in flight, for the dump's first line. */
        @Volatile var row = "before the first row"
        private val handler = Handler(Looper.getMainLooper())
        private var dumps = 0
        private var longestStallMs = 0L
        private var stalls = 0

        fun start() {
            running = true
            lastAnswer = SystemClock.uptimeMillis()
            thread = Thread {
                var nextDumpAt = HANG_MAIN_THREAD_MS
                var stalled = false
                while (running) {
                    if (!pending) {
                        pending = true
                        handler.post {
                            lastAnswer = SystemClock.uptimeMillis()
                            pending = false
                        }
                    }
                    SystemClock.sleep(1_000)
                    val stall = SystemClock.uptimeMillis() - lastAnswer
                    if (stall > longestStallMs) longestStallMs = stall
                    if (stall >= nextDumpAt) {
                        if (!stalled) stalls++
                        stalled = true
                        dump(stall)
                        nextDumpAt += HANG_DUMP_AGAIN_MS
                    } else if (stall < 1_000 && stalled) {
                        stalled = false
                        nextDumpAt = HANG_MAIN_THREAD_MS
                        Log.w(TAG, "HANG over: the main thread answers again ($row)")
                    }
                }
            }.apply {
                isDaemon = true
                name = "CompatSweep main-thread watch"
                start()
            }
        }

        fun stop() {
            running = false
            thread?.join(2_000)
        }

        private fun dump(stallMs: Long) {
            val main = Looper.getMainLooper().thread
            val text = buildString {
                appendLine("main thread not answering for $stallMs ms; row in flight: $row; uptime ${SystemClock.uptimeMillis()} ms")
                appendLine("== main (${main.state})")
                for (frame in main.stackTrace) appendLine("    at $frame")
                for ((other, frames) in Thread.getAllStackTraces()) {
                    if (other === main) continue
                    appendLine("== ${other.name} (${other.state})")
                    for (frame in frames) appendLine("    at $frame")
                }
            }
            dumps++
            val file = File(out, "hang-main-thread-$dumps.txt")
            runCatching { file.writeText(text) }
            // One line per dump; the sweep script's silence watch leaves `HANG` lines out of its count.
            Log.e(TAG, "HANG: the main thread has not answered for $stallMs ms ($row); every thread's stack in ${file.name}")
        }

        fun report(): JSONObject = JSONObject()
            .put("stalls", stalls)
            .put("dumps", dumps)
            .put("longestStallMs", longestStallMs)
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
                    val heap = runtime.totalMemory() - runtime.freeMemory()
                    if (baselinePssKb < 0) baselinePssKb = pss
                    peakPssKb = maxOf(peakPssKb, pss)
                    peakHeapBytes = maxOf(peakHeapBytes, heap)
                    rowPeakPssKb = maxOf(rowPeakPssKb, pss)
                    rowPeakHeapBytes = maxOf(rowPeakHeapBytes, heap)
                    samples++
                    SystemClock.sleep(500)
                }
            }.apply { isDaemon = true; start() }
        }

        fun stop() {
            running = false
            thread?.join(2_000)
        }

        /** The row's own peaks (since [mark]): the Java heap a row's popup stage climbs to is read per row (Trust Wallet's storm, round 11b's 6.2). */
        @Volatile private var rowPeakPssKb = 0L
        @Volatile private var rowPeakHeapBytes = 0L
        @Volatile private var rowSamplesAtMark = 0

        fun mark() {
            val runtime = Runtime.getRuntime()
            rowPeakPssKb = 0L
            rowPeakHeapBytes = runtime.totalMemory() - runtime.freeMemory()
            rowSamplesAtMark = samples
        }

        fun rowReport(): JSONObject = JSONObject()
            .put("samples", samples - rowSamplesAtMark)
            .put("peakPssKb", rowPeakPssKb)
            .put("peakJavaHeapBytes", rowPeakHeapBytes)
            .put("maxHeapBytes", Runtime.getRuntime().maxMemory())

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
        /**
         * The same server on the device's own `localhost`, through the port the sweep script
         * reverses (`adb reverse tcp:8765 tcp:8765`): for Coinbase Wallet, whose provider scripts
         * are registered for every https host and for `http://localhost` alone (no plain http
         * host), so a `10.0.2.2` fixture is a page Chrome would not inject into either.
         */
        private const val LOCALHOST_BASE = "http://localhost:8765"
        private const val YOUTUBE_URL = "https://www.youtube.com/watch?v=jNQXAC9IVRw"
        private const val INSTALL_TIMEOUT_MS = 240_000L
        /** uBlock Origin (MV2) on Edge Add-ons: the heaviest row, run last by default. */
        private const val UBO_MV2 = "odfafepnkmbhccpbejgmiehpchacaeak"
        private const val BACKGROUND_TIMEOUT_MS = 40_000L
        private const val BACKGROUND_SETTLE_MS = 6_000L
        private const val POPUP_TIMEOUT_MS = 30_000L
        /** After the action click opened a tab: how long a sheet gets to follow it before the tab is read as the click's whole answer. */
        private const val POPUP_AFTER_TAB_MS = 5_000L
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
        /** The main thread not answering this long is a hang (the longest stalls the runs' `Davey!` frames show are two or three seconds): [MainThreadWatch]. */
        private const val HANG_MAIN_THREAD_MS = 90_000L
        /** A stall that lasts is dumped again this often (the sweep script's own silence watch fires at five minutes). */
        private const val HANG_DUMP_AGAIN_MS = 300_000L
        /**
         * The Install control among the matches: the deepest of them. A manager's button may be
         * a `div` whose ancestors carry the same text and nothing else (OrangeMonkey's
         * `.confirm--box` around its `.confirm--button`), and a click on the ancestor never
         * reaches the button's own handler (run 35787391495 clicked the box for 46 s of nothing).
         */
        private const val USERSCRIPT_INSTALL_DEEPEST =
            "var deepest=function(list){var hits=list.filter(isInstall);return hits.filter(function(h){return !hits.some(function(o){return o!==h&&h.contains(o)})})[0]||null};var hit=deepest(buttons)||deepest(nodes);"
        /**
         * A userscript manager's install page: whether its Install button is up and its spinner
         * down (Tampermonkey's `ask.html` shows "Please wait..." while its background answers),
         * the button's state, the page's text.
         */
        private const val USERSCRIPT_INSTALL_PAGE_STATE =
            "(function(){var label=function(n){return (n.value||n.textContent||'').trim()};var visible=function(n){return n.offsetParent!==null};" +
                "var isInstall=function(n){return /^(install|install script|confirm installation)$/i.test(label(n))&&visible(n)};" +
                "var buttons=Array.prototype.slice.call(document.querySelectorAll('button, input[type=button], input[type=submit]'));var nodes=Array.prototype.slice.call(document.querySelectorAll('a, [role=button], div, span'));" +
                USERSCRIPT_INSTALL_DEEPEST +
                "var text=(document.body?document.body.innerText:'').replace(/\\s+/g,' ').trim();var waiting=/please wait/i.test(text);" +
                "return JSON.stringify({pass:!!hit&&!waiting,waiting:waiting,button:hit?{label:label(hit),tag:hit.tagName,disabled:!!hit.disabled||/(^|\\s)disabled(\\s|$)/.test(String(hit.className||''))}:null,buttons:buttons.map(label).filter(Boolean).slice(0,8),text:text.slice(0,200),readyState:document.readyState})})()"
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
        /** A bridge refusal that is the layer's own gap (an API the phone's runtime has not got), not the extension's error. */
        private val NOT_IMPLEMENTED_WORDS = Regex("not implemented|is not a function|no handler|unknown (?:namespace|method|api)", RegexOption.IGNORE_CASE)
        /** How long a raised prompt may go without a reachable positive button before the command answers it. */
        private const val PROMPT_TAP_TIMEOUT_MS = 8_000L
        /** Taps on the prompt's own button before the command answers it, and the wait between them. */
        private const val PROMPT_TAPS = 2
        private const val PROMPT_RETAP_MS = 3_000L
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
        /**
         * The shim's flow bound counters of a page's engines (`BootStats.flow`, by endpoint):
         * what a burst of messages met at the page (posted, read, held, dropped, fences); `{}`
         * where the page has no debug stats.
         */
        private const val FLOW_REPORT =
            "JSON.stringify((window.__zenExtStats&&window.__zenExtStats.flow)||{})"
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
         * [WebRequestProbe]'s listener on every `chrome.webRequest` event from the extension's
         * background (`requestHeaders` asked of the request stage, `responseHeaders` of the
         * response stage, `<all_urls>`): each delivery's event, `type`, URL tail, method, tab,
         * status and whether the headers came, kept on `self.__zenWebReq` until [WEBREQ_PROBE_STOP].
         */
        private const val WEBREQ_PROBE_START =
            "(function(){if(self.__zenWebReq)return JSON.stringify({registered:'already'});var E=['onBeforeRequest','onBeforeSendHeaders','onSendHeaders','onHeadersReceived','onResponseStarted','onBeforeRedirect','onCompleted','onErrorOccurred'];" +
                "var spec={onBeforeSendHeaders:['requestHeaders'],onSendHeaders:['requestHeaders'],onHeadersReceived:['responseHeaders'],onResponseStarted:['responseHeaders'],onBeforeRedirect:['responseHeaders'],onCompleted:['responseHeaders']};var log=[],fns={},errors=[];" +
                "E.forEach(function(ev){var fn=function(d){if(log.length<200)log.push({ev:ev,type:d.type,url:String(d.url||'').slice(-60),method:d.method,tabId:d.tabId,status:d.statusCode,reqH:d.requestHeaders?d.requestHeaders.length:null,resH:d.responseHeaders?d.responseHeaders.length:null})};fns[ev]=fn;" +
                "try{var e=chrome.webRequest&&chrome.webRequest[ev];if(!e){errors.push(ev+': missing');return}if(spec[ev])e.addListener(fn,{urls:['<all_urls>']},spec[ev]);else e.addListener(fn,{urls:['<all_urls>']})}catch(x){errors.push(ev+': '+(x&&x.message||x))}});" +
                "self.__zenWebReq={log:log,fns:fns,errors:errors};return JSON.stringify({registered:E.length-errors.length,errors:errors})})()"
        private const val WEBREQ_PROBE_READ =
            "(function(){var w=self.__zenWebReq;if(!w)return JSON.stringify({error:'no probe (the background restarted?)'});var by={};w.log.forEach(function(e){by[e.ev]=(by[e.ev]||0)+1});return JSON.stringify({count:w.log.length,byEvent:by,events:w.log.slice(0,60),errors:w.errors})})()"
        private const val WEBREQ_PROBE_STOP =
            "(function(){var w=self.__zenWebReq;if(!w)return 'none';var n=0;Object.keys(w.fns).forEach(function(ev){try{chrome.webRequest[ev].removeListener(w.fns[ev]);n++}catch(e){}});delete self.__zenWebReq;return 'removed '+n})()"
        /** `media.html`'s own record of its loads (`window.__media`): the clip playing and seeked, the extension-less clip's metadata, the XHR's and the fetch's status. */
        private const val MEDIA_STATE = "JSON.stringify(window.__media||{})"
        /** The `webRequest` events of the response stage, which WebView shows the embedder nothing of. */
        private val RESPONSE_STAGE_EVENTS = setOf("onHeadersReceived", "onResponseStarted", "onBeforeRedirect", "onCompleted")
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
        /**
         * The page after an injection the probe did not find: whether the element is in the DOM
         * at all and how it sits (classes, rect, computed display / visibility, shadow root),
         * the elements the extension left (tags with a `gw-` or `th-` prefix, elements with an
         * id or class of the same prefixes), the content scripts' globals (`window.texthelp`'s
         * keys, `thFrameInit`), the custom elements defined, and the frames of the page.
         */
        private const val INJECTION_MISS =
            "(function(){var out={};var el=document.querySelector(__SELECTOR__);out.present=!!el;if(el){var r=el.getBoundingClientRect();var cs=getComputedStyle(el);out.element={tag:el.tagName.toLowerCase(),classes:String(el.className||'').slice(0,160),rect:Math.round(r.width)+'x'+Math.round(r.height)+'@'+Math.round(r.left)+','+Math.round(r.top),display:cs.display,visibility:cs.visibility,opacity:cs.opacity,shadow:!!el.shadowRoot,shadowEls:el.shadowRoot?el.shadowRoot.querySelectorAll('*').length:0,children:el.children.length,text:String((el.shadowRoot&&el.shadowRoot.textContent)||el.textContent||'').replace(/\\s+/g,' ').trim().slice(0,120)}}" +
                "var tags={};var all=document.querySelectorAll('*');for(var i=0;i<all.length;i++){var e=all[i];var t=e.tagName.toLowerCase();if(/^(gw|th)-/.test(t)||/(^|\\s)(gw|th)-/.test(String(e.className||''))||/^(gw|th)-/.test(e.id||''))tags[t+(e.id?'#'+e.id:'')]=(tags[t+(e.id?'#'+e.id:'')]||0)+1}out.extensionElements=tags;" +
                "var th=window.texthelp;out.texthelp=th?Object.keys(th).slice(0,20):null;out.rw4gc=th&&th.RW4GC?Object.keys(th.RW4GC).slice(0,30):null;out.thFrameInit=window.thFrameInit;" +
                "out.customElements=['gw-toolbar','gw-toolbarbutton','gw-iconbutton'].filter(function(n){return !!customElements.get(n)});" +
                "out.frames=Array.prototype.map.call(document.querySelectorAll('iframe'),function(f){var fr=f.getBoundingClientRect();return (f.getAttribute('src')||'(no src)').slice(0,120)+' '+Math.round(fr.width)+'x'+Math.round(fr.height)}).slice(0,12);" +
                "out.bodyEls=document.body?document.body.querySelectorAll('*').length:0;return JSON.stringify(out)})()"

        /**
         * The UI an extension injected into the page, by a selector: every match is read (the
         * first match may be the bundle's `<style>` of custom properties, Speechify's, or a 0x0
         * inline wrapper whose fixed-position panel is the thing to see, AITOPIA's), and the box
         * that counts is the largest visible one among a match, its shadow root's nodes and its
         * own descendants; the text is the host's.
         */
        private const val INJECTED_UI =
            "(function(){var list=document.querySelectorAll(__SELECTOR__);if(!list.length)return JSON.stringify({pass:false});" +
                "var visible=function(e){var r=e.getBoundingClientRect();var cs=getComputedStyle(e);return r.width>0&&r.height>0&&cs.visibility!=='hidden'&&cs.display!=='none'?r:null};" +
                "var skip=/^(STYLE|SCRIPT|LINK|TEMPLATE|META|NOSCRIPT)$/;var host=null,best=null,rect=null;" +
                "var consider=function(h,e){var r=visible(e);if(r&&(!rect||r.width*r.height>rect.width*rect.height)){host=h;best=e;rect=r}};" +
                "for(var i=0;i<list.length;i++){var el=list[i];if(skip.test(el.tagName))continue;if(!host)host=el;consider(el,el);" +
                "var nodes=el.shadowRoot?el.shadowRoot.querySelectorAll('*'):[];for(var j=0;j<nodes.length&&j<4000;j++)consider(el,nodes[j]);" +
                "var kids=el.querySelectorAll('*');for(var k=0;k<kids.length&&k<4000;k++)consider(el,kids[k])}" +
                "if(!host)host=list[0];if(!best)best=host;" +
                "var text='';if(best.tagName==='IFRAME'){try{var d=best.contentDocument;text=d&&d.body?String(d.body.innerText||''):''}catch(e){}}" +
                "if(!text)text=String((host.shadowRoot&&host.shadowRoot.textContent)||host.textContent||'');text=text.replace(/\\s+/g,' ').trim();" +
                "return JSON.stringify({pass:!!rect,tag:best.tagName.toLowerCase(),w:rect?Math.round(rect.width):0,h:rect?Math.round(rect.height):0,text:text.slice(0,120),host:host.tagName.toLowerCase(),shadow:!!host.shadowRoot,hostBox:Math.round(host.getBoundingClientRect().width)+'x'+Math.round(host.getBoundingClientRect().height),matches:list.length})})()"

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
        /** The fixture page's cursor for any cursor pack ([cursorPack]): a `cursor: url(...)` computed on html / body, or a `<style>` that sets one. */
        private const val CURSOR_URL =
            "(function(){var body=getComputedStyle(document.body).cursor;var html=getComputedStyle(document.documentElement).cursor;" +
                "var styles=Array.prototype.filter.call(document.querySelectorAll('style'),function(s){return /cursor\\s*:\\s*url\\(/i.test(s.textContent||'')}).map(function(s){return (s.id||s.className||'style')+': '+(s.textContent||'').replace(/\\s+/g,' ').slice(0,60)});" +
                "return JSON.stringify({pass:/url\\(/.test(html+body)||styles.length>0,body:body.slice(0,60),html:html.slice(0,60),styles:styles.slice(0,3)})})()"
        /**
         * A JSON document re-rendered by a viewer ([jsonViewer]): the WebView's own `<pre>` no
         * longer the one thing shown, a tree of keyed / collapsible nodes in its place.
         */
        private const val JSON_TREE =
            "(function(){var pre=document.querySelectorAll('pre');var rawShown=Array.prototype.some.call(pre,function(p){var cs=getComputedStyle(p);return cs.display!=='none'&&cs.visibility!=='hidden'&&p.offsetParent!==null&&(p.textContent||'').length>20&&!p.querySelector('*')});" +
                "var els=document.body?document.body.querySelectorAll('*').length:0;var keyed=document.querySelectorAll('[class*=\"key\"], [class*=\"prop\"], .string, .number, .num, .boolean, .bool, .null, [class*=\"collaps\"], [class*=\"expand\"], [class*=\"toggle\"], [class*=\"json\"]').length;" +
                "var text=(document.body?document.body.innerText:'').replace(/\\s+/g,' ').trim();return JSON.stringify({pass:els>12&&keyed>3&&!rawShown,els:els,keyed:keyed,rawPre:rawShown,pre:pre.length,contentType:document.contentType,text:text.slice(0,120)})})()"
        /**
         * The documents a popup is made of: its own and every same-origin `<iframe>` it holds
         * (ZeroOmega's `popup-iframe.html`, ImTranslator's `router.html`), each with the frame's
         * offset in the top document's CSS px, so a control found in a frame can be tapped.
         */
        private const val FRAMED_DOCS =
            "var docs=[{d:document,dx:0,dy:0}];Array.prototype.forEach.call(document.querySelectorAll('iframe'),function(f){try{var cd=f.contentDocument;if(cd&&cd.body){var r=f.getBoundingClientRect();docs.push({d:cd,dx:r.left,dy:r.top})}}catch(e){}});"
        /** [CLICK_LABEL] over [FRAMED_DOCS]: the control's centre comes out in the top document's CSS px. */
        private const val FRAMED_CLICK_LABEL =
            "(function(){var re=__RE__;" + FRAMED_DOCS + "var visible=function(n){var r=n.getBoundingClientRect();return r.width>10&&r.height>10};" +
                "var label=function(e){return ((e.getAttribute&&(e.getAttribute('aria-label')||e.getAttribute('title')))||e.value||e.textContent||'').replace(/\\s+/g,' ').trim()};var cands=[];var texts=[];" +
                "docs.forEach(function(doc){var walk=function(root){var all=root.querySelectorAll('button, a, [role=button], input[type=button], input[type=submit], label, div, span, li, p');for(var i=0;i<all.length;i++){var e=all[i];var l=label(e);if(l.length>0&&l.length<60&&re.test(l)&&visible(e))cands.push({e:e,doc:doc});if(e.shadowRoot)walk(e.shadowRoot)}};" +
                "if(doc.d.body){walk(doc.d.body);texts.push((doc.d.body.innerText||'').replace(/\\s+/g,' ').trim().slice(0,120))}});" +
                "var leaves=cands.filter(function(c){return !cands.some(function(o){return o!==c&&c.e.contains(o.e)})});var hit=leaves[0];" +
                "if(!hit)return JSON.stringify({clicked:false,frames:docs.length-1,text:texts.join(' | ').slice(0,240)});var r=hit.e.getBoundingClientRect();try{hit.e.click()}catch(e){}" +
                "return JSON.stringify({clicked:true,label:label(hit.e).slice(0,40),tag:hit.e.tagName,inFrame:hit.doc.d!==document,x:hit.doc.dx+r.left+r.width/2,y:hit.doc.dy+r.top+r.height/2})})()"
        /** The text of a popup and of the same-origin frames in it ([FRAMED_DOCS]). */
        private const val FRAMED_TEXT =
            "(function(){" + FRAMED_DOCS + "var parts=[];docs.forEach(function(doc){if(doc.d.body)parts.push((doc.d.body.innerText||'').replace(/\\s+/g,' ').trim())});" +
                "var text=parts.join(' | ').replace(/\\s+/g,' ').trim();return JSON.stringify({text:text.slice(0,400),len:text.length,frames:docs.length-1})})()"
        /**
         * The fixture tab after a reload with a proxy override in place: an error page, or the
         * `echo-headers` page loaded (`window.__headers`). The error page is Zenium's own
         * (`zen://error?code=-100&description=ERR_PROXY_CONNECTION_FAILED&url=...`, "This site
         * can't be reached ... unexpectedly closed the connection." in the tab) since the core
         * puts it in place of the WebView's; the WebView's stock page (`net::ERR_...` quoted,
         * "Webpage not available") is still read for a load that failed before the core's hook.
         * The code is the `description` parameter, else the `ERR_...` token of the text.
         */
        private const val PAGE_OR_ERROR =
            "(function(){var t=(document.body?document.body.innerText:'').replace(/\\s+/g,' ').trim();var zen=/^zen:\\/\\/error/i.test(location.href);var err=zen||/could not be loaded because|Webpage not available|This site can.t be reached|net::ERR_|\\bERR_[A-Z_]{4,}\\b/i.test(t);" +
                "var m=location.href.match(/[?&]description=(ERR_[A-Z_]+)/)||t.match(/(?:net::)?(ERR_[A-Z_]+)/);var code=m?m[1]:'';var loaded=!!window.__headers&&!err;" +
                "return JSON.stringify({pass:err||loaded,errorPage:err,zenError:zen,loaded:loaded,code:code,text:t.slice(0,160),url:location.href.slice(0,80)})})()"
        /** ImTranslator's popup: "Bonjour le monde" put in its first shown text box (in the popup or a frame of it), with the input events a keyboard would send. */
        private const val IMTRANSLATOR_TYPE =
            "(function(){" + FRAMED_DOCS + "var visible=function(n){var r=n.getBoundingClientRect();return r.width>40&&r.height>16};var hit=null,doc=null;" +
                "docs.forEach(function(d){if(hit)return;var boxes=Array.prototype.slice.call(d.d.querySelectorAll('textarea, [contenteditable=true], [contenteditable=\"\"]')).filter(visible);if(boxes.length){hit=boxes[0];doc=d}});" +
                "if(!hit){var texts=[];docs.forEach(function(d){if(d.d.body)texts.push((d.d.body.innerText||'').replace(/\\s+/g,' ').trim().slice(0,100))});return JSON.stringify({typed:false,frames:docs.length-1,text:texts.join(' | ').slice(0,200)})}" +
                "hit.focus();if(hit.tagName==='TEXTAREA'){hit.value='Bonjour le monde'}else{hit.textContent='Bonjour le monde'}hit.dispatchEvent(new Event('input',{bubbles:true}));hit.dispatchEvent(new Event('change',{bubbles:true}));hit.dispatchEvent(new KeyboardEvent('keyup',{bubbles:true,key:'e'}));" +
                "return JSON.stringify({typed:true,tag:hit.tagName,id:hit.id||null,inFrame:doc.d!==document})})()"
        /** ImTranslator's popup after Translate: the target box's text (any shown box or result element whose text is not the source phrase), "Hello world" the pass. */
        private const val IMTRANSLATOR_RESULT =
            "(function(){" + FRAMED_DOCS + "var visible=function(n){var r=n.getBoundingClientRect();return r.width>40&&r.height>16};var source='Bonjour le monde';var targets=[];var all=[];" +
                "docs.forEach(function(d){Array.prototype.forEach.call(d.d.querySelectorAll('textarea, [contenteditable], [id*=\"result\"], [id*=\"target\"], [id*=\"translat\"], [class*=\"result\"], [class*=\"target\"], [class*=\"translat\"], [class*=\"output\"]'),function(e){if(!visible(e))return;" +
                "var t=(e.tagName==='TEXTAREA'?e.value:(e.innerText||e.textContent||'')).replace(/\\s+/g,' ').trim();all.push(t.slice(0,40));if(t&&t!==source&&t.indexOf(source)<0&&t.length>2&&t.length<400&&!/^(translate|settings|options)/i.test(t))targets.push(t)})});" +
                "var texts=[];docs.forEach(function(d){if(d.d.body)texts.push((d.d.body.innerText||'').replace(/\\s+/g,' ').trim())});var text=texts.join(' | ');var target=targets[0]||'';var hello=/hello,? world|hi world/i;" +
                "return JSON.stringify({pass:hello.test(target)||hello.test(text),target:target.slice(0,120),candidates:all.slice(0,6),text:text.slice(0,200)})})()"
        /** Unpaywall's tab on the DOI fixture: the `<iframe>` of its `unpaywall.html` (or any element of its naming) drawn at the page's edge. */
        private const val UNPAYWALL_TAB =
            "(function(){var f=document.querySelector('iframe[src*=\"unpaywall\"], iframe[src*=\"iplffkdpngmdjhlpjmppncnlhomiipha\"], #unpaywall, [id*=\"unpaywall\"], [class*=\"unpaywall\"]');var r=f?f.getBoundingClientRect():{width:0,height:0};" +
                "return JSON.stringify({pass:!!f&&r.width>10&&r.height>10,tag:f?f.tagName.toLowerCase():null,src:f&&f.getAttribute('src')?f.getAttribute('src').slice(0,80):null,w:Math.round(r.width),h:Math.round(r.height),doi:(document.querySelector('meta[name=\"citation_doi\"]')||{}).content||null})})()"
        /**
         * A QR code drawn in a popup (The QR Code Generator's and QR Code Generator's SVG or
         * canvas of the tab's address): the largest drawing over 60 px a side, an SVG with more
         * than four paths or rects.
         */
        private const val QR_DRAWN =
            "(function(){var best=null,bw=0;var all=document.querySelectorAll('svg, canvas, img');for(var i=0;i<all.length;i++){var b=all[i].getBoundingClientRect();if(b.width*b.height>bw){bw=b.width*b.height;best=all[i]}}var r=best?best.getBoundingClientRect():{width:0,height:0};" +
                "var paths=best&&best.tagName.toLowerCase()==='svg'?best.querySelectorAll('path, rect').length:-1;return JSON.stringify({pass:r.width>60&&r.height>60&&(paths<0||paths>4),via:best?best.tagName.toLowerCase():'none',w:Math.round(r.width),h:Math.round(r.height),paths:paths,text:(document.body?document.body.innerText:'').replace(/\\s+/g,' ').trim().slice(0,80)})})()"
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
        /** The WebView's selection action mode's labels (Chromium's, in English on the runner's image). */
        private val SELECTION_MENU_WORDS = Regex("Copy|Select all|Share|Web search|Paste|Cut|Translate", RegexOption.IGNORE_CASE)
        /** A live page's "not found" (Amazon's dog page, a store's 404): the site served no product, so a live row's read is `n/m`, not a grade of the extension. */
        private val NOT_FOUND_WORDS = Regex("couldn.t find that page|page not found|looking for something\\?|this page isn.t available|error 404|404 not found", RegexOption.IGNORE_CASE)
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
            "(function(){var hindi=/hindi|\\u0939\\u093f(\\u0928|\\u0902)\\u0926\\u0940/i;var label=function(e){return ((e.getAttribute&&(e.getAttribute('aria-label')||e.getAttribute('title')))||e.value||e.textContent||'').replace(/\\s+/g,' ').trim()};var shown=function(e){var r=e.getBoundingClientRect();return r.width>0&&r.height>0};var text=function(e){return (e.textContent||'').replace(/\\s+/g,' ').trim()};" +
                "var selectedTree=document.getElementById('selected');var selectedSide=function(){if(selectedTree)return hindi.test(text(selectedTree));var els=Array.prototype.slice.call(document.querySelectorAll('select, [role=listbox], ul, ol, table, div'));var right=els.filter(function(e){return shown(e)&&/selected|chosen|enabled|active|right|second/i.test(e.id+' '+e.className+' '+(e.getAttribute('aria-label')||''))});" +
                "return right.some(function(e){return hindi.test(e.textContent||Array.prototype.map.call(e.options||[],function(o){return o.text}).join(' '))})};" +
                "if(selectedSide())return JSON.stringify({pass:true,how:'already'});var picked=null;var add=null;var how='';" +
                // The page as shipped (v102): a Closure goog.ui.tree of the tools under #inputtools, one row
                // per tool ("Hindi - <native name>" is the transliteration, the keyboards and handwriting
                // carry their kind), #language-filter narrowing the rows on keyup; a tree node is selected
                // on MOUSEDOWN (Closure's tree, not on click), which shows #input_text_button_right ("Move
                // the selected input tool to the right"), whose click moves the tool into #selected.
                "var tree=document.getElementById('inputtools');if(tree){var filter=document.getElementById('language-filter');if(filter){filter.value='hindi';filter.dispatchEvent(new KeyboardEvent('keyup',{bubbles:true,key:'i'}))}" +
                "var rows=Array.prototype.slice.call(tree.querySelectorAll('.goog-tree-row, .goog-tree-item-label, li.ita-kd-menuitem, li')).filter(function(e){return shown(e)&&hindi.test(text(e))&&text(e).length<60});" +
                "var row=rows.find(function(e){return /^hindi\\s*-\\s*\\u0939\\u093f\\u0928\\u094d\\u0926\\u0940$/i.test(text(e))})||rows.find(function(e){return !/keyboard|handwrit|phonetic|inscript|qwerty/i.test(text(e))})||rows[0];" +
                "if(row){var target=row.querySelector('.goog-tree-item-label')||row;['mousedown','mouseup','click'].forEach(function(t){target.dispatchEvent(new MouseEvent(t,{bubbles:true,cancelable:true,view:window,button:0}))});picked='row '+text(row).slice(0,30);" +
                "var btn=document.getElementById('input_text_button_right');if(btn){btn.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true,view:window,button:0}));add='#input_text_button_right ('+getComputedStyle(btn).display+')';how='tree'}" +
                // The tree's own shortcut: a double-click on the row moves the tool across (its DBLCLICK handler).
                "if(!selectedSide()){target.dispatchEvent(new MouseEvent('dblclick',{bubbles:true,cancelable:true,view:window,button:0,detail:2}));how='tree dblclick'}}}" +
                "if(selectedSide())return JSON.stringify({pass:true,how:how,picked:picked,add:add,selects:document.querySelectorAll('select').length,options:document.querySelectorAll('option').length,text:document.body?document.body.innerText.replace(/\\s+/g,' ').trim().slice(0,120):''});" +
                "var opts=Array.prototype.slice.call(document.querySelectorAll('option'));var opt=opts.find(function(o){return hindi.test(o.text)&&!/transliteration.*keyboard|keyboard/i.test(o.text)})||opts.find(function(o){return hindi.test(o.text)});" +
                "if(opt){opt.selected=true;opt.parentNode.dispatchEvent(new Event('change',{bubbles:true}));opt.dispatchEvent(new MouseEvent('dblclick',{bubbles:true}));picked='option '+opt.text.slice(0,30)}" +
                "else{var items=Array.prototype.slice.call(document.querySelectorAll('li, [role=option], [role=listitem], tr, div, span')).filter(function(e){return shown(e)&&hindi.test(label(e))&&label(e).length<60});var leaf=items.filter(function(e){return !items.some(function(o){return o!==e&&e.contains(o)})})[0];if(leaf){leaf.click();picked='item '+label(leaf).slice(0,30)}}" +
                "var generic=Array.prototype.slice.call(document.querySelectorAll('button, a, [role=button], input[type=button], div, span, img')).filter(shown).find(function(e){var l=label(e)+' '+(e.id||'')+' '+(e.className||'')+' '+(e.getAttribute('alt')||'');return /^(add|>>|>|\\u2192|\\u25b6|\\u25ba)$|add|arrow-?right|to-?right|moveRight|move-right/i.test(l)&&!/remove|left|delete/i.test(l)});" +
                "if(generic){generic.click();add=(label(generic)||generic.id||generic.className||generic.tagName).slice(0,30);how=how||'generic'}" +
                "return JSON.stringify({pass:selectedSide(),how:how,picked:picked,add:add,selects:document.querySelectorAll('select').length,options:opts.length,text:document.body?document.body.innerText.replace(/\\s+/g,' ').trim().slice(0,120):''})})()"
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

        // --- compat round 8 ---------------------------------------------------------------------

        /** [CLICK_LABEL] without the script's `click()`: the control found and measured, for a finger to press (a handler that checks `isTrusted`). */
        private val FIND_LABEL = CLICK_LABEL.replace("try{hit.click()}catch(e){}", "")
        /** The display size for the tablet-width reads (px at the sweep's density 280: 1371 x 800 dp). */
        private const val TABLET_SIZE = "2400x1400"
        /**
         * Cookie-Editor's popup: the fixture's two cookies (`zen_probe`, `zen_session`) listed
         * (through open shadow roots), the permission request still up, the text.
         */
        private const val COOKIE_LIST =
            "(function(){var parts=[];var walk=function(root){var it=document.createNodeIterator(root,NodeFilter.SHOW_TEXT);var n;while((n=it.nextNode())){var t=n.textContent.replace(/\\s+/g,' ').trim();if(t)parts.push(t)}var all=root.querySelectorAll('*');for(var i=0;i<all.length;i++)if(all[i].shadowRoot)walk(all[i].shadowRoot)};if(document.body)walk(document.body);" +
                "var text=parts.join(' ');var names=['zen_probe','zen_session'].filter(function(n){return text.indexOf(n)>=0});var asking=/request permission|allow|grant/i.test(text)&&names.length===0;" +
                "return JSON.stringify({pass:names.length===2,fixtureCookies:names.length,names:names,asking:asking,text:text.replace(/\\s+/g,' ').slice(0,200),rows:document.querySelectorAll('li, .cookie, [class*=\"cookie\"]').length})})()"
        /**
         * Cookie-Editor's delete control for the `zen_probe` cookie: its row (the innermost element
         * whose text names that cookie and not the other) expanded by a click on its header, then
         * the row's delete / trash control (an aria label, a title, a class) measured for a finger;
         * a delete control anywhere in the popup when the row has none of its own.
         */
        private const val COOKIE_DELETE =
            "(function(){var visible=function(n){var r=n.getBoundingClientRect();return r.width>8&&r.height>8};var label=function(e){return ((e.getAttribute&&(e.getAttribute('aria-label')||e.getAttribute('title')))||'')+' '+(e.className&&typeof e.className==='string'?e.className:'')+' '+(e.id||'')+' '+(e.textContent||'').replace(/\\s+/g,' ').trim().slice(0,30)};" +
                "var del=/delete|trash|remove/i;var rows=Array.prototype.slice.call(document.querySelectorAll('li, div, section, details, article, tr')).filter(function(e){var t=(e.textContent||'');return t.indexOf('zen_probe')>=0&&t.indexOf('zen_session')<0&&visible(e)});" +
                "var row=rows.filter(function(e){return !rows.some(function(o){return o!==e&&e.contains(o)})})[0]||null;if(!row)return JSON.stringify({clicked:false,rows:rows.length,reason:'no row names zen_probe alone'});" +
                "var header=row.querySelector('summary, .header, [class*=\"header\"], button, [role=button]')||row;try{header.click()}catch(e){}" +
                "var controls=Array.prototype.slice.call(row.querySelectorAll('button, a, [role=button], input[type=button], span, i, svg')).filter(function(e){return del.test(label(e))});var hit=controls.filter(visible)[0]||controls[0];" +
                "if(!hit){var any=Array.prototype.slice.call(document.querySelectorAll('button, a, [role=button]')).filter(function(e){return del.test(label(e))&&visible(e)});hit=any[0]||null}" +
                "if(!hit)return JSON.stringify({clicked:false,rows:rows.length,rowText:(row.textContent||'').replace(/\\s+/g,' ').trim().slice(0,80),reason:'no delete control'});var r=hit.getBoundingClientRect();" +
                "return JSON.stringify({clicked:true,label:label(hit).replace(/\\s+/g,' ').trim().slice(0,60),tag:hit.tagName,x:r.left+r.width/2,y:r.top+r.height/2,w:Math.round(r.width),h:Math.round(r.height),inRow:row.contains(hit)})})()"
        /** From a worker with the `history` permission: `history.search` for the fixture's visit (`__MATCH__` on the URL). Lands on `window.__zenHistory`. */
        private const val HISTORY_PROBE =
            "(function(){var p=window.__zenHistory={done:false,present:false,n:0,error:null,history:typeof chrome.history,search:typeof (chrome.history&&chrome.history.search)};" +
                "try{chrome.history.search({text:'',maxResults:500,startTime:0},function(items){if(chrome.runtime.lastError)p.error=String(chrome.runtime.lastError.message);items=items||[];p.n=items.length;p.present=items.some(function(i){return __MATCH__.test(i.url||'')});p.urls=items.slice(0,6).map(function(i){return String(i.url||'').slice(0,60)});p.done=true})}" +
                "catch(e){p.error='threw: '+String(e&&e.message||e);p.done=true}setTimeout(function(){if(!p.done){p.error='no answer within 8 s';p.done=true}},8000);return 'asked'})()"
        /** From a worker: `declarativeNetRequest.getDynamicRules`, the count and the first rules' actions. Lands on `window.__zenDnr`. */
        private const val DNR_DYNAMIC_RULES =
            "(function(){var p=window.__zenDnr={done:false,n:0,rules:[],error:null,dnr:typeof chrome.declarativeNetRequest};" +
                "try{chrome.declarativeNetRequest.getDynamicRules(function(rules){if(chrome.runtime.lastError)p.error=String(chrome.runtime.lastError.message);rules=rules||[];p.n=rules.length;p.rules=rules.slice(0,4).map(function(r){return (r.action&&r.action.type)+' '+((r.action&&r.action.redirect&&(r.action.redirect.url||r.action.redirect.regexSubstitution))||'')+' <- '+((r.condition&&(r.condition.urlFilter||r.condition.regexFilter))||'')});p.done=true})}" +
                "catch(e){p.error='threw: '+String(e&&e.message||e);p.done=true}setTimeout(function(){if(!p.done){p.error='no answer within 8 s';p.done=true}},8000);return 'asked'})()"
        /**
         * A sheet's close control over a popup's menu (BlockSite's promo): the topmost drawn
         * element at the sheet's top-right corner region with a close label, a `×`, an `svg` in
         * a small box, or a class naming close; measured for a finger.
         */
        private const val SHEET_CLOSE =
            "(function(){var visible=function(n){var r=n.getBoundingClientRect();return r.width>8&&r.height>8&&r.width<80&&r.height<80};var label=function(e){return ((e.getAttribute&&(e.getAttribute('aria-label')||e.getAttribute('title')))||'')+' '+(typeof e.className==='string'?e.className:'')+' '+(e.id||'')+' '+(e.textContent||'').replace(/\\s+/g,' ').trim().slice(0,10)};" +
                "var cands=Array.prototype.slice.call(document.querySelectorAll('button, a, [role=button], span, div, svg, i, img')).filter(function(e){return visible(e)&&(/close|dismiss|\\u00d7|\\u2715|\\u2716|xmark|x-icon/i.test(label(e))||(e.tagName==='svg'&&e.getBoundingClientRect().width<40))});" +
                "var hit=cands.sort(function(a,b){var ra=a.getBoundingClientRect(),rb=b.getBoundingClientRect();return (ra.top-rb.top)||(rb.right-ra.right)})[0]||null;if(!hit)return JSON.stringify({clicked:false,candidates:cands.length});var r=hit.getBoundingClientRect();" +
                "return JSON.stringify({clicked:true,label:label(hit).replace(/\\s+/g,' ').trim().slice(0,50),tag:hit.tagName,x:r.left+r.width/2,y:r.top+r.height/2})})()"
        /**
         * From an extension page: a `fetch` of Gmail's feed (`https://mail.google.com/mail/feed/atom`,
         * a 401 with `WWW-Authenticate: Basic` for a visitor without a session) with the status it
         * resolved to, or the error; a tab-less HTTP auth challenge Chrome gives up at once. Lands
         * on `window.__zenAuthFetch`.
         */
        private const val AUTH_FETCH_PROBE =
            "(function(){var p=window.__zenAuthFetch={done:false,status:null,statusText:null,authenticate:null,error:null,ms:null,askedAt:Date.now()};" +
                "fetch('https://mail.google.com/mail/feed/atom',{credentials:'include',cache:'no-store'}).then(function(r){p.status=r.status;p.statusText=r.statusText;p.authenticate=r.headers.get('www-authenticate');p.ms=Date.now()-p.askedAt;p.done=true},function(e){p.error=String(e&&e.message||e);p.ms=Date.now()-p.askedAt;p.done=true});" +
                "setTimeout(function(){if(!p.done){p.error='no answer within 18 s';p.done=true}},18000);return 'asked'})()"
        /** A YouTube watch page's layout: the viewport's CSS width, `ytd-watch-flexy`'s column state, the secondary column drawn. */
        private const val YT_LAYOUT =
            "(function(){var flexy=document.querySelector('ytd-watch-flexy');var attrs=flexy?Array.prototype.map.call(flexy.attributes,function(a){return a.name}).filter(function(n){return /column|theater|fullscreen|flexy/.test(n)}).join(' '):'';var secondary=document.querySelector('#secondary, #secondary-inner');var sr=secondary?secondary.getBoundingClientRect():{width:0,height:0};" +
                "var two=(flexy&&flexy.hasAttribute('is-two-columns_'))||sr.width>200&&sr.height>200;return JSON.stringify({twoColumns:!!two,innerWidth:innerWidth,innerHeight:innerHeight,dpr:devicePixelRatio,docWidth:document.documentElement.clientWidth,flexy:attrs.slice(0,120),secondary:Math.round(sr.width)+'x'+Math.round(sr.height),host:location.host,mobile:!!document.querySelector('ytm-app, ytm-watch')})})()"
        // --- compat round 9 ---------------------------------------------------------------------
        /**
         * `system.cpu.getInfo` and `system.memory.getInfo` from a worker (OKX Wallet declares
         * `system.cpu`): Chrome's shapes, or the errors, on `window.__zenSystemInfo`.
         */
        private const val SYSTEM_INFO_PROBE =
            "(function(){var r={done:false};window.__zenSystemInfo=r;var pending=2;var finish=function(){if(--pending<=0){r.done=true}};" +
                "try{if(chrome.system&&chrome.system.cpu&&chrome.system.cpu.getInfo){chrome.system.cpu.getInfo(function(info){var e=chrome.runtime.lastError;if(e){r.cpuError=e.message}else if(!info){r.cpuError='no info'}else{r.cpu={numOfProcessors:info.numOfProcessors,archName:info.archName,modelName:info.modelName,features:info.features,processors:(info.processors||[]).map(function(p){return p.usage}),temperatures:info.temperatures}}finish()})}else{r.cpuError='chrome.system.cpu is '+(chrome.system?typeof chrome.system.cpu:'absent (no chrome.system)');finish()}}catch(e){r.cpuError=String(e&&e.message||e);finish()}" +
                "try{if(chrome.system&&chrome.system.memory&&chrome.system.memory.getInfo){chrome.system.memory.getInfo(function(info){var e=chrome.runtime.lastError;if(e){r.memoryError=e.message}else{r.memory=info}finish()})}else{r.memoryError='chrome.system.memory is '+(chrome.system?typeof chrome.system.memory:'absent (no chrome.system)');finish()}}catch(e){r.memoryError=String(e&&e.message||e);finish()}" +
                "return 'asked'})()"
        /**
         * `runtime.getContexts` for the extension's offscreen document, filtered by
         * `documentUrls` in both spellings and by `documentOrigins` (OneNote Web Clipper's and
         * Scholar PDF Reader's `offscreen.html` lookups by `runtime.getURL`); the document is
         * created for the probe when none is up and closed again after.
         */
        private const val GET_CONTEXTS_PROBE =
            "(function(){var r={done:false};window.__zenGetContexts=r;var path='offscreen.html';var served=chrome.runtime.getURL(path);var chromeSpelled='chrome-extension://'+chrome.runtime.id+'/'+path;r.getURL=served;r.chromeSpelled=chromeSpelled;var finish=function(){r.done=true};" +
                "var gc=function(f){return chrome.runtime.getContexts(f)};" +
                "var query=function(created){return Promise.all([gc({contextTypes:['OFFSCREEN_DOCUMENT'],documentUrls:[served]}),gc({contextTypes:['OFFSCREEN_DOCUMENT'],documentUrls:[chromeSpelled]}),gc({contextTypes:['OFFSCREEN_DOCUMENT']}),gc({contextTypes:['OFFSCREEN_DOCUMENT'],documentOrigins:[new URL(served).origin]}),gc({contextTypes:['OFFSCREEN_DOCUMENT'],documentOrigins:['chrome-extension://'+chrome.runtime.id]})]).then(function(res){r.byGetURL=res[0].length;r.byChromeSpelling=res[1].length;r.all=res[2].length;r.byServedOrigin=res[3].length;r.byChromeOrigin=res[4].length;r.documentUrl=res[2][0]?res[2][0].documentUrl:null;r.documentOrigin=res[2][0]?res[2][0].documentOrigin:null;r.created=created;if(created&&chrome.offscreen&&chrome.offscreen.closeDocument){return chrome.offscreen.closeDocument().catch(function(){})}}).then(finish,function(e){r.error=String(e&&e.message||e);finish()})};" +
                "try{if(!chrome.runtime.getContexts){r.error='runtime.getContexts missing';finish();return 'x'}" +
                "gc({contextTypes:['OFFSCREEN_DOCUMENT']}).then(function(list){if(list.length>0)return query(false);if(!chrome.offscreen||!chrome.offscreen.createDocument){r.error='no offscreen document up and chrome.offscreen missing';finish();return}return chrome.offscreen.createDocument({url:path,reasons:['DOM_PARSER'],justification:'compat probe'}).then(function(){return new Promise(function(res){setTimeout(res,1500)})}).then(function(){return query(true)})}).catch(function(e){r.error=String(e&&e.message||e);finish()})}catch(e){r.error=String(e&&e.message||e);finish()}" +
                "return 'asked'})()"
        /** `new URL('chrome-extension://<id>/popup.html').origin` in a worker against its `location.origin` (Keplr's router compares the two). */
        private const val URL_ORIGIN_PROBE =
            "(function(){var r={done:false};window.__zenUrlOrigin=r;try{var id=chrome.runtime.id;var chromeUrl='chrome-extension://'+id+'/popup.html';var u=new URL(chromeUrl);r.chromeSpelledOrigin=u.origin;r.chromeSpelledHost=u.host;r.chromeSpelledPath=u.pathname;r.getURLOrigin=new URL(chrome.runtime.getURL('popup.html')).origin;r.locationOrigin=location.origin;r.selfOrigin=typeof self.origin==='string'?self.origin:null;r.match=r.chromeSpelledOrigin===r.locationOrigin}catch(e){r.error=String(e&&e.message||e)}r.done=true;return 'asked'})()"
        /** A worker listener that records the `sender` of a probe message from one of the extension's own pages; the literal Scholar compares it with. */
        private const val SENDER_ORIGIN_LISTEN =
            "(function(){var r={done:false,literal:'chrome-extension://'+chrome.runtime.id};window.__zenSenderOrigin=r;try{chrome.runtime.onMessage.addListener(function(m,s){if(m&&m.zenSenderProbe){r.origin=s.origin;r.url=s.url;r.id=s.id;r.matchesLiteral=s.origin===r.literal;r.matchesLocation=s.origin===location.origin;r.done=true}})}catch(e){r.error=String(e&&e.message||e);r.done=true}return 'listening'})()"
        /**
         * The stylesheets a page holds after a content script's CSS went in: rules still
         * carrying `__MSG_` (Chrome substitutes `@@extension_id` in content-script CSS) and the
         * `@font-face` sources on the extension's own origin.
         */
        private const val CSS_MESSAGE_SCAN =
            "(function(){var sheets=0,rules=0,bad=0,fonts=0,adopted=0;var ext=/ext\\.zenium\\.invalid|chrome-extension:\\/\\//;var all=[];for(var i=0;i<document.styleSheets.length;i++)all.push(document.styleSheets[i]);var ad=document.adoptedStyleSheets||[];for(var a=0;a<ad.length;a++){all.push(ad[a]);adopted++}for(var i=0;i<all.length;i++){var s=all[i];var list=null;try{list=s.cssRules}catch(e){}if(!list)continue;sheets++;for(var j=0;j<list.length;j++){var t=list[j].cssText||'';rules++;if(t.indexOf('__MSG_')>=0)bad++;if(list[j].type===5&&ext.test(t))fonts++}}" +
                "var styles=document.querySelectorAll('style');var inline=0;for(var k=0;k<styles.length;k++){if((styles[k].textContent||'').indexOf('__MSG_')>=0)inline++}return JSON.stringify({sheets:sheets,adopted:adopted,rules:rules,unsubstituted:bad,inlineUnsubstituted:inline,extensionFonts:fonts})})()"
        /**
         * `window.postMessage` from a content script's scope in four spellings (Language
         * Reactor's `runtime.onMessage` listener posts the message it got to its page script
         * with `window.postMessage(message, "*")`; on 113 it threw a `DOMException`, round 8):
         * each attempt's outcome, and what `window` and `postMessage` are in that scope.
         */
        private const val POST_MESSAGE_PROBE =
            "(function(){var out={};var msg={topic:'LR_PS_probe',loggedIn:false};function attempt(name,fn){try{fn();out[name]='ok'}catch(e){out[name]=String(e&&e.name)+': '+String(e&&e.message)}}" +
                "attempt('windowPostMessage',function(){window.postMessage(msg,'*')});attempt('barePostMessage',function(){postMessage(msg,'*')});attempt('selfPostMessage',function(){self.postMessage(msg,'*')});" +
                "attempt('windowPostMessageParsed',function(){window.postMessage(JSON.parse('{\"topic\":\"LR_PS_probe\",\"loggedIn\":false}'),'*')});attempt('windowPostMessageString',function(){window.postMessage('LR_PS_probe','*')});attempt('topPostMessage',function(){window.top.postMessage(msg,'*')});" +
                "out.windowTag=(function(){try{return Object.prototype.toString.call(window)+' self='+(window===self)+' top='+(window===window.top)}catch(e){return String(e)}})();" +
                "out.postMessageFn=(function(){try{var f=window.postMessage;return typeof f+' '+String(f.name)+'/'+f.length+' native='+/\\[native code\\]/.test(Function.prototype.toString.call(f))}catch(e){return String(e)+(e&&e.stack?' @ '+String(e.stack).split('\\n').slice(0,3).join(' | ').slice(0,300):'')}})();" +
                // The step that throws, named against the real window: its `postMessage` descriptor, a
                // direct read, the native `bind` and a bare `call` on it, and whether `bind` is native.
                "out.real=(function(){var o={};try{var real=Function('return this')();o.realIsScopeWindow=(real===window);var d=Object.getOwnPropertyDescriptor(real,'postMessage');o.desc=d?(('get' in d)?'accessor':'data '+typeof d.value+' '+/\\[native code\\]/.test(Function.prototype.toString.call(d.value))):'none';" +
                "var f;try{f=Reflect.get(real,'postMessage');o.get='ok '+typeof f}catch(e){o.get=String(e)}" +
                "try{var b=Function.prototype.bind.call(f,real);o.bind='ok '+String(b.name)}catch(e){o.bind=String(e)}" +
                "try{Function.prototype.call.call(f,real,msg,'*');o.call='ok'}catch(e){o.call=String(e)}" +
                "o.bindNative=/\\[native code\\]/.test(Function.prototype.toString.call(Function.prototype.bind));o.href=String(real.location&&real.location.href).slice(0,80)}catch(e){o.error=String(e)}return o})();" +
                "return JSON.stringify(out)})()"

        // --- compat round 13 --------------------------------------------------------------------

        /** A popup's textarea filled as typing fills it: the value set, then `input` and `change` dispatched (a Vue / React model listens to `input`). */
        private const val TEXTAREA_TYPE =
            "(function(){var ta=document.querySelector('textarea');if(!ta)return JSON.stringify({typed:false,reason:'no textarea',text:document.body?document.body.innerText.replace(/\\s+/g,' ').trim().slice(0,80):''});ta.focus();ta.value=__TEXT__;" +
                "ta.dispatchEvent(new Event('input',{bubbles:true}));ta.dispatchEvent(new Event('change',{bubbles:true}));return JSON.stringify({typed:true,id:ta.id||null,length:ta.value.length})})()"
        /** eJOY's root (`#eJOY__extension_root`, its shadow root when it has one): how many of its elements are drawn, and its text. */
        private const val EJOY_ROOT =
            "(function(){var host=document.getElementById('eJOY__extension_root');var root=host&&(host.shadowRoot||host);var drawn=[];var text='';if(root){var all=root.querySelectorAll('*');for(var i=0;i<all.length;i++){var e=all[i];var r=e.getBoundingClientRect();if(r.width>20&&r.height>20&&getComputedStyle(e).visibility!=='hidden'&&getComputedStyle(e).display!=='none')drawn.push((e.tagName+' '+(e.id||'')+' '+(typeof e.className==='string'?e.className:'')).replace(/\\s+/g,' ').trim().slice(0,40))}text=(root.textContent||'').replace(/\\s+/g,' ').trim()}" +
                "var hr=host?host.getBoundingClientRect():null;return JSON.stringify({host:!!host,shadow:!!(host&&host.shadowRoot),drawn:drawn.length,first:drawn.slice(0,4),text:text.slice(0,120),hostBox:hr?Math.round(hr.width)+'x'+Math.round(hr.height):null,selection:String(getSelection()).trim().slice(0,30)})})()"
        /** `cookie-banner.html`'s four banners: hidden (display none, visibility hidden, a zero box) or removed by the blocker's stylesheet or script; `pass` when at least two are. */
        private const val COOKIE_BANNERS_HIDDEN =
            "(function(){var b=window.__banners?window.__banners():{};var ids=['cookie-notice','cookieConsent','cookieConsentBar','onetrust-consent-sdk'];var hidden=ids.filter(function(id){return b[id]&&b[id].hidden});var how={};ids.forEach(function(id){how[id]=b[id]?b[id].how:'?'});" +
                "var sheets=document.querySelectorAll('style').length;return JSON.stringify({pass:hidden.length>=2,hidden:hidden.length,how:how,accepted:b.accepted||[],styles:sheets})})()"
        /** WOT's slider: the `<iframe>` its content script mounts on the action click (its own origin's page), or an element of its naming. */
        private const val WOT_SLIDER =
            "(function(){var f=Array.prototype.slice.call(document.querySelectorAll('iframe')).filter(function(i){return /bhmmomiinigofkjcapegjjndpbikblnp|mywot/i.test(i.src||'')||/wot/i.test((i.id||'')+' '+(typeof i.className==='string'?i.className:''))});var marks=document.querySelectorAll('[id*=\"wot-\"], [class*=\"wot-\"], [id^=\"wot\"], [class^=\"wot\"], wot-slider');" +
                "var r=f[0]?f[0].getBoundingClientRect():{width:0,height:0};return JSON.stringify({pass:f.length>0||marks.length>0,frames:f.length,src:f[0]?(f[0].src||'').slice(0,80):null,w:Math.round(r.width),h:Math.round(r.height),marks:marks.length,allFrames:document.querySelectorAll('iframe').length})})()"
        /** Color Picker's popup after its scan: the page's colours as swatches (`.cp-analyzer-swatch`) or hex codes in the text; `pass` at two. */
        private const val COLOR_SWATCHES =
            "(function(){var sw=document.querySelectorAll('.cp-analyzer-swatch, .cp-analyzer-hex, [class*=\"swatch\"]');var t=document.body?document.body.innerText:'';var hexes=(t.match(/#[0-9a-fA-F]{6}\\b/g)||[]);var uniq=hexes.filter(function(h,i){return hexes.indexOf(h)===i});" +
                "return JSON.stringify({pass:sw.length>=2||uniq.length>=2,swatches:sw.length,hexes:uniq.slice(0,6),text:t.replace(/\\s+/g,' ').trim().slice(0,160)})})()"
        /** StayFocusd's popup after "Block entire site": the fixture host among its blocked sites, or its time-remaining view. */
        private const val STAYFOCUSD_BLOCKED =
            "(function(){var t=document.body?document.body.innerText.replace(/\\s+/g,' ').trim():'';var host=/10\\.0\\.2\\.2|localhost/.test(t);var state=/allow entire site|time remaining|blocked|unblock|remove/i.test(t);" +
                "return JSON.stringify({pass:host&&state,host:host,state:state,text:t.slice(0,200)})})()"
        /** The Camelizer's popup over an Amazon product page: its price-history chart (a camelcamelcamel image or a canvas) drawn, or a price line. */
        private const val CAMELIZER_CHART =
            "(function(){var t=document.body?document.body.innerText.replace(/\\s+/g,' ').trim():'';var img=Array.prototype.slice.call(document.querySelectorAll('img')).filter(function(i){var r=i.getBoundingClientRect();return /camel|chart/i.test(i.src||'')&&r.width>100&&r.height>50});var canvas=Array.prototype.slice.call(document.querySelectorAll('canvas')).filter(function(c){var r=c.getBoundingClientRect();return r.width>100&&r.height>50});" +
                "var lost=/where are we|not (seem to be )?on amazon|unknown error|try again/i.test(t);return JSON.stringify({pass:!lost&&(img.length>0||canvas.length>0||/price history|lowest|highest|current price/i.test(t)),images:img.length,canvases:canvas.length,lost:lost,text:t.slice(0,200)})})()"
        /** EasyBib's popup over the fixture: a citation of the page (its title or its host in the text), or the service's word. */
        private const val EASYBIB_CITATION =
            "(function(){var t=document.body?document.body.innerText.replace(/\\s+/g,' ').trim():'';var cite=/Probe Page A|10\\.0\\.2\\.2/i.test(t);var fields=document.querySelectorAll('input, textarea, [contenteditable]').length;" +
                "return JSON.stringify({pass:cite,cited:cite,fields:fields,text:t.slice(0,200)})})()"
        /** `cors.html`'s repeated cross-origin fetch: succeeded at least once since the page loaded (the response header an extension set let the page read it). */
        private const val CORS_UNLOCKED =
            "(function(){var c=window.__cors||{};return JSON.stringify({pass:(c.ok||0)>0,attempts:c.attempts||0,ok:c.ok||0,firstOkAttempt:c.firstOkAttempt,lastStatus:c.lastStatus,lastError:c.lastError,target:c.target})})()"
        /** `wallet.html`'s Wallet Standard registry and page globals for a Sui / Solana wallet named by `__RE__` (a regex literal). */
        private const val WALLET_STANDARD =
            "(function(){var w=window.__wallet||{};var re=__RE__;var std=(w.standard||[]).filter(function(n){return re.test(n)});var o=w.others||{};var globals=Object.keys(o).filter(function(k){return o[k]!=='undefined'&&o[k]!==false});" +
                "return JSON.stringify({pass:std.length>0||__GLOBALS__,standard:w.standard||[],matched:std,others:o,globals:globals,announced:w.announced||[],error:w.standardError||null})})()"
    }
}
