package app.zen.chromium

import android.content.Intent
import android.graphics.Rect
import android.os.Debug
import android.os.SystemClock
import android.util.Log
import android.view.accessibility.AccessibilityNodeInfo
import androidx.core.content.FileProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.zen.chromium.ext.ExtensionStore
import org.json.JSONArray
import org.json.JSONObject
import org.json.JSONTokener
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * Exercises the extension store on an emulator, so the temporary `android-ext-store-demo`
 * workflow can record it: two extensions installed from the Chrome Web Store by id through the
 * chrome's command API (`window.zen.invoke`, what the management page calls), the native
 * install prompt answered by a touch, the management page listing them, disable and enable, a
 * real update check against the store's Omaha endpoint, a `.zip` of uBlock Origin's GitHub build
 * handed over by a `VIEW` intent as another app would, and an uninstall.
 *
 * Asserts what the engine leaves behind after each step: the record in `app.getState`, the files
 * under `files/zen/extensions/<id>/<version>/` (one version directory, no staging left), and the
 * registry document `files/zen/extensions.json`. Timings and the peak memory of the app process
 * go to `results.json` for the workflow to upload; the renderer's memory is sampled by the driver
 * script from outside.
 */
@RunWith(AndroidJUnit4::class)
class ExtensionStoreDemo : DemoHarness("ext-store-demo-state.json", "ext-android-store", "ext-store-demo") {
    override val tag = TAG
    private var shots = 0
    private val results = JSONObject()
    private val installs = JSONArray()
    private val memory = MemorySampler()
    private val root get() = File(app.filesDir, "zen/extensions")
    private val registryFile get() = File(app.filesDir, "zen/extensions.json")

    @Test
    fun record() {
        // The harness clears the profile's files, not its directories: an earlier run's tree goes too.
        root.deleteRecursively()
        memory.start()
        try {
            runDemo()
        } finally {
            memory.stop()
            results.put("appProcessMemory", memory.report())
            results.put("installs", installs)
            File(out, "results.json").writeText(results.toString(2))
        }
    }

    override fun warmUp() {
        val state = zen("app.getState")
        assertTrue(
            "the Android host must turn the extension capability on",
            state.getJSONObject("capabilities").getBoolean("extensions")
        )
        assertEquals("a fresh profile has no extensions", 0, state.getJSONArray("extensions").length())
        results.put("root", root.absolutePath)
        SystemClock.sleep(1_500)
    }

    override fun demo() {
        snap("browser-idle")

        // 1. uBlock Origin Lite and Dark Reader from the Chrome Web Store, by id; the prompt is
        //    the native confirm dialog, answered with a touch on "Add extension".
        val ubol = installFromStore(UBOL_ID, "confirm-ubo-lite")
        val dark = installFromStore(DARK_READER_ID, null)

        // 2. The management page lists both (unstyled for the phone; the UI PR styles it).
        openAddons()
        waitFor(ubol.getString("name"), 15_000) ?: Log.w(TAG, "the page did not show ${ubol.getString("name")}")
        waitFor(dark.getString("name"), 5_000)
        beat()
        snap("addons-installed")

        // 3. Disable, then enable again; the state and the registry follow.
        zen("extension.setEnabled", JSONObject().put("id", UBOL_ID).put("enabled", false))
        assertFalse(awaitExtension(UBOL_ID) { !it.getBoolean("enabled") }.getBoolean("enabled"))
        awaitRegistry("disabled in the registry") { record(it, UBOL_ID)?.getBoolean("enabled") == false }
        beat()
        snap("addons-disabled")
        zen("extension.setEnabled", JSONObject().put("id", UBOL_ID).put("enabled", true))
        awaitExtension(UBOL_ID) { it.getBoolean("enabled") }
        awaitRegistry("enabled in the registry") { record(it, UBOL_ID)?.getBoolean("enabled") == true }

        // 4. A real update check: one Omaha request for both, answered by the store.
        val checkStarted = SystemClock.uptimeMillis()
        zen("extension.checkForUpdates")
        val checkMs = SystemClock.uptimeMillis() - checkStarted
        val checked = JSONObject()
        for (ext in extensions()) {
            checked.put(
                ext.getString("id"),
                JSONObject()
                    .put("version", ext.getString("version"))
                    .put("updateState", ext.getString("updateState"))
                    .put("availableVersion", ext.opt("availableVersion"))
                    .put("updateError", ext.opt("updateError"))
                    .put("updateCheckedAt", ext.opt("updateCheckedAt"))
            )
            assertFalse("the check must stamp ${ext.getString("id")}: $ext", ext.isNull("updateCheckedAt"))
            assertTrue(
                "the store must answer for ${ext.getString("id")}: $ext",
                ext.getString("updateState") in setOf("up-to-date", "available", "updating")
            )
        }
        Log.i(TAG, "update check in $checkMs ms: $checked")
        results.put("updateCheck", JSONObject().put("ms", checkMs).put("extensions", checked))
        awaitRegistry("lastUpdateCheck stamped") { it.optLong("lastUpdateCheck", 0L) > 0L }

        // 5. Sideload: uBlock Origin's own .chromium.zip (pushed by the driver script), handed
        //    over through the manifest's VIEW filter with a content URI, as a file manager would.
        val sideloaded = sideload()

        // 6. Uninstall Dark Reader: the record, its directory and its registry entry go.
        zen("extension.remove", JSONObject().put("id", DARK_READER_ID))
        awaitGone(DARK_READER_ID)
        awaitRegistry("removed from the registry") { record(it, DARK_READER_ID) == null }
        val darkDir = File(root, DARK_READER_ID)
        waitUntil(10_000) { !darkDir.exists() }
        assertFalse("${darkDir.path} must be gone after the uninstall", darkDir.exists())
        beat()
        snap("addons-final")

        val ids = extensions().map { it.getString("id") }.toSet()
        assertEquals(setOf(UBOL_ID, sideloaded.getString("id")), ids)
        results.put("registry", JSONObject(registryFile.readText()))
        results.put("tree", tree(root))
    }

    // --- the steps ------------------------------------------------------------------------------

    private fun installFromStore(id: String, shot: String?): JSONObject {
        val started = SystemClock.uptimeMillis()
        var promptMs = 0L
        zen("extension.installFromStore", JSONObject().put("ref", id), onDialog = { button ->
            val up = SystemClock.uptimeMillis()
            SystemClock.sleep(1_200)
            if (shot != null) snap(shot)
            tapRect(button)
            promptMs = SystemClock.uptimeMillis() - up
        })
        val total = SystemClock.uptimeMillis() - started
        val ext = awaitExtension(id) { true }
        Log.i(TAG, "installed $id ${ext.getString("version")} in ${total - promptMs} ms (+$promptMs ms in the prompt): $ext")
        assertTrue("$id must be enabled after the install", ext.getBoolean("enabled"))
        assertEquals("chrome-web-store", ext.getString("source"))
        assertEquals("chrome-web-store", ext.getString("publisher"))
        assertTrue("a store install carries an update URL", !ext.isNull("updateUrl"))
        assertTrue("the runtime must not have refused ${ext.getString("name")}: ${ext.opt("error")}", ext.isNull("error"))

        val dir = checkInstallDirectory(id, ext.getString("version"), ext.getString("path"))
        val registry = awaitRegistry("$id in the registry") { record(it, id) != null }
        val record = record(registry, id) ?: error("no record")
        assertEquals(2, registry.getInt("version"))
        assertEquals(ext.getString("version"), record.getString("version"))
        assertEquals(dir.absolutePath, record.getString("path"))
        assertEquals("chrome-web-store", record.getString("source"))
        assertTrue(record.getBoolean("enabled"))

        installs.put(
            JSONObject()
                .put("id", id)
                .put("name", ext.getString("name"))
                .put("version", ext.getString("version"))
                .put("source", "chrome-web-store")
                .put("installMs", total - promptMs)
                .put("promptMs", promptMs)
                .put("files", dir.walkTopDown().count { it.isFile })
                .put("bytesOnDisk", dir.walkTopDown().filter { it.isFile }.sumOf { it.length() })
                .put("permissions", ext.getJSONArray("permissions"))
                .put("hostPermissions", ext.getJSONArray("hostPermissions"))
                .put("warnings", ext.getJSONArray("warnings"))
        )
        return ext
    }

    private fun sideload(): JSONObject {
        val pushed = File(app.filesDir, "ext-store-input/$SIDELOAD_NAME")
        assertTrue("the driver script must place the uBlock Origin .chromium.zip at ${pushed.path}", pushed.isFile)
        val shared = File(File(app.cacheDir, "share").apply { mkdirs() }, SIDELOAD_NAME)
        pushed.copyTo(shared, overwrite = true)
        val uri = FileProvider.getUriForFile(app, "${app.packageName}.files", shared)
        val before = extensions().map { it.getString("id") }.toSet()

        // Implicit, restricted to this package: the manifest filter (application/x-chrome-extension)
        // has to match for the activity to be found, and singleTask routes it to onNewIntent.
        val intent = Intent(Intent.ACTION_VIEW)
            .setDataAndType(uri, ExtensionStore.CRX_MIME_TYPE)
            .setPackage(app.packageName)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_GRANT_READ_URI_PERMISSION)
        val started = SystemClock.uptimeMillis()
        app.startActivity(intent)
        val button = awaitDialog(60_000) ?: error("no install prompt for the sideloaded package")
        val up = SystemClock.uptimeMillis()
        SystemClock.sleep(1_200)
        snap("confirm-sideload")
        tapRect(button)
        val promptMs = SystemClock.uptimeMillis() - up
        val ext = awaitNew(before, 120_000)
        val total = SystemClock.uptimeMillis() - started
        Log.i(TAG, "sideloaded ${ext.getString("id")} ${ext.getString("version")} in ${total - promptMs} ms: $ext")
        assertEquals("zip", ext.getString("source"))
        assertTrue("an unsigned zip has no publisher", ext.isNull("publisher"))
        assertEquals("uBlock Origin", ext.getString("name"))
        assertTrue(ext.getBoolean("enabled"))

        val dir = checkInstallDirectory(ext.getString("id"), ext.getString("version"), ext.getString("path"))
        awaitRegistry("the sideload in the registry") { record(it, ext.getString("id"))?.getString("source") == "zip" }
        installs.put(
            JSONObject()
                .put("id", ext.getString("id"))
                .put("name", ext.getString("name"))
                .put("version", ext.getString("version"))
                .put("source", "zip")
                .put("uri", uri.toString())
                .put("packageBytes", pushed.length())
                .put("installMs", total - promptMs)
                .put("promptMs", promptMs)
                .put("files", dir.walkTopDown().count { it.isFile })
                .put("bytesOnDisk", dir.walkTopDown().filter { it.isFile }.sumOf { it.length() })
        )
        return ext
    }

    /** `<root>/<id>/<version>/` with a manifest, and nothing else (no staging) beside it. */
    private fun checkInstallDirectory(id: String, version: String, path: String): File {
        val dir = File(path)
        assertTrue("${dir.path} must be a directory", dir.isDirectory)
        assertEquals(root.absolutePath, dir.parentFile?.parentFile?.absolutePath)
        assertEquals(id, dir.parentFile?.name)
        assertEquals(version, dir.name)
        assertTrue("${dir.path} must hold manifest.json", File(dir, "manifest.json").isFile)
        val siblings = dir.parentFile?.list()?.toList() ?: emptyList()
        assertEquals("only the version directory may remain: $siblings", listOf(dir.name), siblings)
        return dir
    }

    private fun openAddons() {
        zen("urlbar.runCommand", JSONObject().put("action", "addons.open"))
        waitFor("Add-ons and Themes", 10_000) ?: Log.w(TAG, "the add-ons page never showed its title")
    }

    // --- state and registry -----------------------------------------------------------------------

    private fun extensions(): List<JSONObject> {
        val list = zen("app.getState").getJSONArray("extensions")
        return (0 until list.length()).map { list.getJSONObject(it) }
    }

    private fun awaitExtension(id: String, timeoutMs: Long = 15_000, ready: (JSONObject) -> Boolean): JSONObject {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        var last: JSONObject? = null
        while (SystemClock.uptimeMillis() < deadline) {
            last = extensions().firstOrNull { it.getString("id") == id }
            if (last != null && ready(last)) return last
            SystemClock.sleep(400)
        }
        error("$id did not reach the expected state within $timeoutMs ms: $last")
    }

    private fun awaitNew(before: Set<String>, timeoutMs: Long): JSONObject {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            extensions().firstOrNull { it.getString("id") !in before }?.let { return it }
            SystemClock.sleep(500)
        }
        error("no new extension appeared within $timeoutMs ms")
    }

    private fun awaitGone(id: String, timeoutMs: Long = 15_000) {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            if (extensions().none { it.getString("id") == id }) return
            SystemClock.sleep(400)
        }
        error("$id is still listed after $timeoutMs ms")
    }

    /** The registry document once `ready` holds (it is written 300 ms after a change). */
    private fun awaitRegistry(what: String, timeoutMs: Long = 10_000, ready: (JSONObject) -> Boolean): JSONObject {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        var last: JSONObject? = null
        while (SystemClock.uptimeMillis() < deadline) {
            if (registryFile.isFile) {
                runCatching { JSONObject(registryFile.readText()) }.getOrNull()?.let { registry ->
                    last = registry
                    if (ready(registry)) return registry
                }
            }
            SystemClock.sleep(300)
        }
        error("extensions.json never showed $what within $timeoutMs ms: $last")
    }

    private fun record(registry: JSONObject, id: String): JSONObject? {
        val list = registry.optJSONArray("extensions") ?: return null
        return (0 until list.length()).map { list.getJSONObject(it) }.firstOrNull { it.getString("id") == id }
    }

    private fun waitUntil(timeoutMs: Long, condition: () -> Boolean) {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (!condition() && SystemClock.uptimeMillis() < deadline) SystemClock.sleep(250)
    }

    private fun tree(dir: File): JSONArray {
        val listing = JSONArray()
        dir.walkTopDown().sortedBy { it.path }.forEach { file ->
            if (file != dir) listing.put("${file.toRelativeString(dir)}${if (file.isDirectory) "/" else " (${file.length()} bytes)"}")
        }
        return listing
    }

    // --- the chrome's command API ----------------------------------------------------------------

    private fun zen(command: String): JSONObject = zen(command, null)

    /**
     * `window.zen.invoke(command, args)` in the chrome WebView, awaited from here. While the call
     * is pending, the native install prompt is handed to `onDialog` with the bounds of its
     * positive button (once).
     */
    private fun zen(command: String, args: JSONObject?, onDialog: (Rect) -> Unit = { tapRect(it) }): JSONObject {
        val argsJs = args?.toString() ?: "undefined"
        eval(
            """
            window.__extDemo = undefined;
            window.zen.invoke(${JSONObject.quote(command)}, $argsJs).then(
              (v) => { window.__extDemo = JSON.stringify({ ok: v === undefined ? null : v }); },
              (e) => { window.__extDemo = JSON.stringify({ err: String((e && e.message) || e) }); }
            );
            """.trimIndent()
        )
        var prompted = false
        val deadline = SystemClock.uptimeMillis() + 180_000
        while (SystemClock.uptimeMillis() < deadline) {
            val result = eval("window.__extDemo === undefined ? null : window.__extDemo")
            if (result != "null") {
                val envelope = JSONObject(JSONTokener(result).nextValue() as String)
                if (envelope.has("err")) error("$command rejected: ${envelope.getString("err")}")
                return when (val value = envelope.get("ok")) {
                    is JSONObject -> value
                    JSONObject.NULL -> JSONObject()
                    else -> JSONObject().put("value", value)
                }
            }
            if (!prompted) {
                findDialogButton()?.let { button ->
                    prompted = true
                    onDialog(button)
                }
            }
            SystemClock.sleep(250)
        }
        error("$command did not answer within 180 s")
    }

    /** Evaluate JavaScript in the chrome WebView (main thread) and wait for its JSON result. */
    private fun eval(script: String): String {
        val latch = CountDownLatch(1)
        var result = "null"
        instrumentation.runOnMainSync {
            (activity as MainActivity).host.chrome.evaluateJavascript(script) {
                result = it ?: "null"
                latch.countDown()
            }
        }
        assertTrue("the chrome did not answer", latch.await(20, TimeUnit.SECONDS))
        return result
    }

    // --- the native install prompt ---------------------------------------------------------------

    /** The positive button of the install prompt (a Material dialog), when one is up. */
    private fun findDialogButton(): Rect? = nodes { node ->
        node.isVisibleToUser && node.isClickable &&
            node.text?.toString()?.trim()?.let { text -> POSITIVE_BUTTONS.any { it.equals(text, ignoreCase = true) } } == true
    }
        .map { Rect().also(it::getBoundsInScreen) }
        .filter { it.width() > 0 && it.height() > 0 }
        .minByOrNull { it.width() * it.height() }

    private fun awaitDialog(timeoutMs: Long): Rect? {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            findDialogButton()?.let { return it }
            SystemClock.sleep(300)
        }
        return null
    }

    private fun tapRect(rect: Rect) {
        Finger().tap(rect.exactCenterX(), rect.exactCenterY())
        SystemClock.sleep(700)
    }

    /** Breadth-first search of every window on screen (the app and the dialog). */
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
        shot("${shots.toString().padStart(2, '0')}-$name")
    }

    /** Peak PSS and Java heap of the app process, sampled twice a second while the demo runs. */
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
    }

    companion object {
        private const val TAG = "ExtensionStoreDemo"
        const val UBOL_ID = "ddkjiahejlhfcafbddmgiahcphecmpfh"
        const val DARK_READER_ID = "eimadpbcbfnmbkopoojfekhnkhdbieeh"
        /** Where the driver script copies uBlock Origin's `.chromium.zip` before the run. */
        const val SIDELOAD_NAME = "uBlock0.chromium.zip"
        /** The install prompt's positive labels (hostStore.ts installPromptText). */
        private val POSITIVE_BUTTONS = setOf("Add extension", "Update extension", "Allow")
    }
}
