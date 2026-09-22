package app.zen.chromium

import android.content.Intent
import android.graphics.Rect
import android.net.Uri
import android.os.SystemClock
import android.util.Log
import android.view.accessibility.AccessibilityNodeInfo
import android.webkit.WebView
import androidx.core.content.FileProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.zen.chromium.ext.ExtensionFiles
import app.zen.chromium.ext.ExtensionStore
import app.zen.chromium.ext.ExtensionWebView
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.io.FileOutputStream
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream

/**
 * The two native sheets of the extension platform, still by still, in the light and the dark
 * scheme, for the design gate: the extension sheet (`ext/ExtensionSheet.kt`, the WebView host of
 * a popup) with its one dp open-path hairline and the token inks, and the install prompt on the
 * fallback path (`ext/ExtensionPromptFallback.kt`, a `NativePromptSheet`) – the prompt
 * `extensionHost.ts`'s `nativeConfirm` raises when no live window can show the chrome's own
 * sheet. That path is real here, not forced: a package handed to the activity's `VIEW` intent is
 * queued by `ExtensionStore.sideload` while the chrome is still loading, and the store's `start()`
 * installs it with no window up, so the prompt is the chassis's.
 *
 * The workflow script pushes the demo's unpacked extensions under `files/zen/extensions/`; the
 * driver lays them out as installs (as `ExtensionDemo` does) except Dark Reader, which it zips
 * into the cache and hands over as the sideload: the light prompt is answered with Add extension
 * (so its popup is the extension sheet's still), the dark one – after the install is removed
 * again – with Cancel. Stills: `ext-android-13-prompt-fallback-{light,dark}.png` and
 * `ext-android-13-sheet-popup-{light,dark}.png` under `files/ext-sheets/`.
 */
@RunWith(AndroidJUnit4::class)
class ExtensionSheetStills : DemoHarness("ext-demo-state.json", "ext-android-13", "ext-sheets") {
    override val tag = TAG
    private val results = JSONObject()
    private val root get() = File(app.filesDir, "zen/extensions")
    private val packageFile get() = File(File(app.cacheDir, "share").apply { mkdirs() }, "dark-reader.zip")
    private val host: Host get() = (activity as MainActivity).host

    @Test
    fun record() {
        try {
            runDemo()
        } finally {
            shellCommand("cmd uimode night no")
            File(out, "results.json").writeText(results.toString(2))
        }
    }

    /**
     * The pushed folders as installs, Dark Reader as the package to sideload: its folder – flat
     * as the script pushed it, or laid out as `<id>/<version>/` by a driver that ran before – is
     * zipped with the manifest at the root and taken out of the profile, so the handover is an
     * install and not an update.
     */
    override fun seedMore(zen: File) {
        val candidate = File(root, SIDELOAD_ID)
        if (candidate.isDirectory) {
            val source = ExtensionSeed.layOutInstall(candidate) ?: candidate
            zip(source, packageFile)
            candidate.deleteRecursively()
        }
        check(packageFile.isFile) { "the driver script must push Dark Reader's unpacked folder to ${candidate.path}" }
        val records = JSONArray()
        val installed = JSONObject()
        for (dir in root.listFiles().orEmpty().filter { it.isDirectory && ExtensionFiles.isExtensionId(it.name) }.sortedBy { it.name }) {
            val versionDir = ExtensionSeed.layOutInstall(dir) ?: continue
            val manifest = runCatching { JSONObject(File(versionDir, "manifest.json").readText()) }.getOrNull() ?: continue
            records.put(ExtensionSeed.record(dir.name, versionDir, manifest))
            installed.put(dir.name, versionDir.name)
        }
        results.put("seededInstalls", installed)
        File(zen, "extensions.json").writeText(ExtensionSeed.registry(records).toString())
    }

    override fun warmUp() {}

    override fun demo() {
        // 1. Light: the package at the activity's VIEW intent before the chrome is up; the prompt
        //    is the chassis's sheet, answered with Add extension.
        val lightPrompt = promptStill("light", accept = true)
        results.put("promptLight", lightPrompt)
        awaitExtension(SIDELOAD_ID, 120_000)

        // 2. Dark Reader's popup in the extension sheet, light.
        results.put("popupLight", popupStill("light"))

        // 3. The dark scheme: the chrome's setting and the system's night mode together.
        coreInvoke("settings.update", """{"colorScheme":"dark"}""")
        shellCommand("cmd uimode night yes")
        SystemClock.sleep(4_000)
        ensureForeground()
        results.put("popupDark", popupStill("dark"))

        // 4. The install removed, the same handover again in the dark: the prompt, then Cancel.
        coreInvoke("extension.remove", """{"id":${JSONObject.quote(SIDELOAD_ID)}}""")
        waitUntil(15_000) { extensions().none { it.optString("id") == SIDELOAD_ID } }
        results.put("promptDark", promptStill("dark", accept = false))
        SystemClock.sleep(1_500)
    }

    // --- the prompt on the fallback path ---------------------------------------------------------

    /**
     * A fresh activity started with the package's VIEW intent (the task cleared: a new Host, the
     * chrome booting again), the prompt awaited by its verb, a still, the verb or Cancel touched.
     */
    private fun promptStill(scheme: String, accept: Boolean): JSONObject {
        val uri = FileProvider.getUriForFile(app, "${app.packageName}.files", packageFile)
        // The quiet handover: the store's start() collects the package whatever the chrome's boot
        // time, so the prompt is the fallback's (a debuggable build's flag; ExtensionStore.sideload).
        val intent = Intent(app, MainActivity::class.java)
            .setAction(Intent.ACTION_VIEW)
            .setDataAndType(uri, ExtensionStore.CRX_MIME_TYPE)
            .putExtra(ExtensionStore.EXTRA_QUIET_HANDOVER, true)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK or Intent.FLAG_GRANT_READ_URI_PERMISSION)
        val started = SystemClock.uptimeMillis()
        activity = instrumentation.startActivitySync(intent)
        val verb = awaitButton(ACCEPT_LABELS, 90_000) ?: error("no install prompt for the sideloaded package in the $scheme scheme")
        val promptAt = SystemClock.uptimeMillis() - started
        var themeDark = false
        var showing = false
        instrumentation.runOnMainSync {
            themeDark = host.themeDark
            showing = host.extPrompt.showing
        }
        // The sheet's rise and the chrome's first frame behind it.
        SystemClock.sleep(2_500)
        shot("prompt-fallback-$scheme")
        awaitShots()
        val labels = buttonLabels()
        val report = JSONObject()
            .put("promptAfterMs", promptAt)
            .put("hostThemeDark", themeDark)
            .put("fallbackShowing", showing)
            .put("buttons", JSONArray(labels))
            .put("verbBounds", verb.flattenToString())
        Log.i(TAG, "$scheme prompt: $report")
        // The still is only worth the gate as the fallback's own sheet in the scheme asked for:
        // the renderer's sheet answering instead (the chrome caught the sideload event after all),
        // or the host still on the other scheme's inks, is said here, with the evidence kept.
        check(showing) { "the $scheme prompt is not the fallback's sheet (ExtensionPromptFallback.showing is false)" }
        check(themeDark == (scheme == "dark")) { "the host draws the $scheme prompt with the ${if (themeDark) "dark" else "light"} inks" }
        val target = if (accept) verb else awaitButton(setOf(CANCEL_LABEL), 5_000) ?: error("no Cancel on the prompt")
        Finger().tap(target.exactCenterX(), target.exactCenterY())
        waitUntil(10_000) { awaitButton(ACCEPT_LABELS, 0) == null }
        report.put("answered", if (accept) "accept" else "cancel")
        return report
    }

    // --- the popup in the extension sheet --------------------------------------------------------

    private fun popupStill(scheme: String): JSONObject {
        coreInvoke("extension.openPopup", """{"id":${JSONObject.quote(SIDELOAD_ID)},"anchor":{"x":0,"y":0,"width":0,"height":0}}""")
        val ready = waitUntil(45_000) {
            val view = popupView() ?: return@waitUntil false
            eval(view, "String(!!(document.body && document.body.innerText.length > 40))") == "true"
        }
        // The sheet's rise and the popup's own layout after its text is in.
        SystemClock.sleep(3_000)
        shot("sheet-popup-$scheme")
        awaitShots()
        val view = popupView()
        val report = JSONObject()
            .put("ready", ready)
            .put("url", view?.let { eval(it, "location.href") })
            .put("textLength", view?.let { eval(it, "String(document.body ? document.body.innerText.length : -1)") })
        Log.i(TAG, "$scheme popup: $report")
        coreInvoke("extension.closePopup")
        waitUntil(10_000) { popupView() == null }
        SystemClock.sleep(1_000)
        return report
    }

    private fun popupView(): ExtensionWebView? {
        var v: ExtensionWebView? = null
        instrumentation.runOnMainSync { v = host.extensions.popupView() }
        return v
    }

    // --- helpers ---------------------------------------------------------------------------------

    private fun extensions(): List<JSONObject> {
        val list = coreState().optJSONArray("extensions") ?: JSONArray()
        return (0 until list.length()).map { list.getJSONObject(it) }
    }

    private fun awaitExtension(id: String, timeoutMs: Long) {
        check(waitUntil(timeoutMs) { extensions().any { it.optString("id") == id && it.optBoolean("enabled") } }) {
            "$id was not listed as installed and enabled within $timeoutMs ms"
        }
    }

    /** A visible, clickable node reading one of `labels`, in any window on screen; the smallest when several. */
    private fun awaitButton(labels: Set<String>, timeoutMs: Long): Rect? {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        do {
            val found = nodes { node ->
                node.isVisibleToUser && node.isClickable &&
                    node.text?.toString()?.trim()?.let { text -> labels.any { it.equals(text, ignoreCase = true) } } == true
            }
                .map { Rect().also(it::getBoundsInScreen) }
                .filter { it.width() > 0 && it.height() > 0 }
                .minByOrNull { it.width() * it.height() }
            if (found != null) return found
            if (timeoutMs > 0) SystemClock.sleep(300)
        } while (SystemClock.uptimeMillis() < deadline)
        return null
    }

    private fun buttonLabels(): List<String> =
        nodes { it.isVisibleToUser && it.isClickable && !it.text.isNullOrBlank() }.map { it.text.toString().trim() }.distinct()

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

    private fun waitUntil(timeoutMs: Long, condition: () -> Boolean): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            if (condition()) return true
            SystemClock.sleep(250)
        }
        return condition()
    }

    private fun eval(view: WebView, script: String): String {
        val latch = CountDownLatch(1)
        var value = "null"
        instrumentation.runOnMainSync {
            view.evaluateJavascript(script) { raw ->
                value = raw?.let { if (it.startsWith("\"")) runCatching { JSONObject("{\"v\":$it}").getString("v") }.getOrDefault(it) else it } ?: "null"
                latch.countDown()
            }
        }
        latch.await(10, TimeUnit.SECONDS)
        return value
    }

    /** `dir`'s files as a zip with the manifest at the root; the store's `_metadata` left out. */
    private fun zip(dir: File, target: File) {
        ZipOutputStream(FileOutputStream(target)).use { out ->
            for (file in dir.walkTopDown().filter { it.isFile }) {
                val path = file.relativeTo(dir).path.replace(File.separatorChar, '/')
                if (path.startsWith("_metadata/")) continue
                out.putNextEntry(ZipEntry(path))
                file.inputStream().use { it.copyTo(out) }
                out.closeEntry()
            }
        }
    }

    companion object {
        private const val TAG = "ExtensionSheetStills"
        const val SIDELOAD_ID = "eimadpbcbfnmbkopoojfekhnkhdbieeh"
        /** The prompt's verbs (`promptCopy.ts`). */
        private val ACCEPT_LABELS = setOf("Add extension", "Update extension", "Allow")
        private const val CANCEL_LABEL = "Cancel"
    }
}
