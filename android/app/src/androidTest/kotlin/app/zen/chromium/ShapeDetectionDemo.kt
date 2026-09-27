package app.zen.chromium

import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.PointF
import android.os.Build
import android.os.Process
import android.os.SystemClock
import android.util.Log
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.webkit.WebViewCompat
import org.json.JSONArray
import org.json.JSONObject
import org.json.JSONTokener
import org.junit.Test
import org.junit.runner.RunWith
import java.io.ByteArrayOutputStream
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * A page constructing a `BarcodeDetector` must not kill the app (W6-D31). The WebView binds
 * Chromium's shape-detection service on its in-process GPU thread, whose first act is the Google
 * Play services client's availability check; that client reads the host app's
 * `com.google.android.gms.version` meta-data and, finding none, threw
 * `GooglePlayServicesMissingManifestValueException` across the JNI boundary - an uncaught Java
 * exception there ends the process (`FATAL EXCEPTION: Chrome_InProcGpuThread`, SIG 9) before any
 * promise can reject. The manifest now carries the value; this driver is the page:
 *
 *  - a loopback page ([DemoServer]) with an image and a script that constructs `BarcodeDetector`,
 *    asks `getSupportedFormats()`, runs `detect(img)`, then does the same for `FaceDetector` and
 *    `TextDetector` where the WebView exposes them - every outcome caught and recorded on
 *    `window.__shape`, so a promise that rejects is heard, not lost;
 *  - the checks: the process is the same one afterwards and the WebView still answers. On a
 *    device WITHOUT `com.google.android.gms` (the AOSP images the nightly's `tablet-webview` shard
 *    boots) the outcome is pinned exactly: the provider is not created, the pipe closes, so
 *    `getSupportedFormats()` resolves `[]` (empty, nothing else) and `detect()` rejects
 *    `NotSupportedError: Barcode Detection not implemented.` - that message and not the "service
 *    unavailable" one, because the page calls `detect()` in the same synchronous run as the
 *    constructor, before the disconnect task can reach Blink, so the request is pending when the
 *    pipe closes. On a device WITH Play services `detect()` resolves (nothing to find in the
 *    pattern) or, should the module be unusable, rejects `NotSupportedError` - either passes there;
 *    an unexpected error or a death does not anywhere;
 *  - the same again on a second page of the same origin (the pipe is bound anew per page);
 *  - the manifest value as the package manager hands it to the client (`metaData.getInt`), the
 *    WebView package and version, and the image, in `shape-detection-findings.txt`.
 *
 * The findings file is written line by line, so a run that dies keeps what it saw up to the
 * death; on the manifest before this fix the driver's own process (the instrumentation shares
 * it) went down at `new BarcodeDetector()` and the workflow reported "Process crashed", with the
 * exception's stack in the artifact's logcat.txt. See [DemoHarness] for the plumbing.
 */
@RunWith(AndroidJUnit4::class)
class ShapeDetectionDemo : DemoHarness("shape-detection-demo-state.json", "shape-detection", "shape-detection-demo") {
    override val tag = "ShapeDetectionDemo"
    private lateinit var server: DemoServer
    private lateinit var findings: File
    private val host get() = (activity as MainActivity).host
    private var failures = 0

    @Test
    fun record() {
        val page = "text/html; charset=utf-8" to readAsset("shape-detection-demo-page.html").toByteArray()
        server = DemoServer(
            PORT,
            mapOf(
                "/" to page,
                "/second.html" to page,
                "/pattern.png" to ("image/png" to patternPng())
            )
        ).also { it.start() }
        try {
            runDemo()
        } finally {
            server.close()
        }
        if (failures > 0) throw AssertionError("$failures shape detection check(s) failed; see shape-detection-findings.txt")
    }

    override fun warmUp() {
        findings = File(out, "shape-detection-findings.txt")
        findings.writeText(
            "Zenium Android shape detection crash check (API ${Build.VERSION.SDK_INT}, ${width}x$height, density $density)\n\n"
        )
        finding("image: ${Build.FINGERPRINT}")
        finding("webview: ${webViewPackage()}")
        finding("play services on the device: ${playServicesPresence()}")
        finding("manifest com.google.android.gms.version as the package manager reads it (metaData.getInt): ${gmsVersionMetaData()}")
        finding("demo server: ${server.selfCheck()}")
        awaitLoaded("$ORIGIN/")
        SystemClock.sleep(1_500)
    }

    override fun demo() {
        val pid = Process.myPid()
        finding("\nprocess $pid; the page at $ORIGIN/ constructs BarcodeDetector, asks getSupportedFormats() and detect(img), then FaceDetector and TextDetector where exposed")
        shot("00-page")
        tapPage("#run")
        var probe = awaitProbe()
        if (probe == null) {
            finding("  the Detect button did not start the probe; starting it from the harness")
            tabJs("window.runShape()")
            probe = awaitProbe()
        }
        shot("01-after-detect")
        report("first page", probe, pid)

        finding("\na second page of the same origin binds the service anew")
        navigate("$ORIGIN/second.html")
        tabJs("window.runShape()")
        val second = awaitProbe()
        shot("02-second-page")
        report("second page", second, pid)
        finding("\nend: process ${Process.myPid()} ${verdict(Process.myPid() == pid)}, the WebView answers ${tabJs("1+1")} ${verdict(tabJs("1+1") == "2")}")
    }

    // --- the checks ------------------------------------------------------------------------------

    private fun report(label: String, probe: JSONObject?, pid: Int) {
        val alive = Process.myPid() == pid && tabJs("1+1") == "2"
        finding("  $label: process alive and the WebView answering ${verdict(alive)}")
        if (probe == null) {
            finding("  $label: the probe did not finish (phase ${jsonString(tabJs("window.__shape && window.__shape.phase"))}) ${verdict(false)}")
            return
        }
        finding("  $label: phase ${probe.optString("phase")}")
        val steps = probe.optJSONArray("steps") ?: JSONArray()
        var barcodeSeen = false
        for (i in 0 until steps.length()) {
            val step = steps.getJSONObject(i)
            val name = step.optString("name")
            val type = step.optString("type")
            if (type == "undefined") {
                finding("    $name: not exposed by this WebView (typeof undefined) ${verdict(name != "BarcodeDetector")}")
                continue
            }
            if (name == "BarcodeDetector") barcodeSeen = true
            val formats = step.optJSONArray("formats")
            val formatsError = step.optString("formatsError", "")
            if (step.has("formats") || formatsError.isNotEmpty()) {
                // Without GMS the provider is never created: the statics' pipe closes and Blink
                // resolves with the empty list - exactly `[]`, not "some array".
                val ok = formats != null && formatsError.isEmpty() && (gmsPresent || formats.length() == 0)
                val shown = if (formats != null && formatsError.isEmpty()) formats.toString() else formatsError
                val expectation = if (gmsPresent) "an array" else "exactly [] (no GMS)"
                finding("    $name.getSupportedFormats(): $shown - expected $expectation ${verdict(ok)}")
            }
            val constructed = step.optBoolean("constructed", false)
            finding("    new $name(): ${if (constructed) "constructed" else "threw"} ${verdict(constructed)}")
            val resolved = step.optString("detect", "")
            val error = step.optString("detectError", "")
            val ok = if (gmsPresent) {
                resolved.isNotEmpty() || error.startsWith("NotSupportedError")
            } else {
                error == NO_GMS_DETECT_ERROR
            }
            val note = when {
                resolved.isNotEmpty() -> "$resolved (a detector behind Play services)"
                !gmsPresent && error == NO_GMS_DETECT_ERROR -> "rejected $error (no GMS: the provider is not created and the pipe closes on the pending request; the page's catch heard it)"
                !gmsPresent && error.isNotEmpty() -> "rejected $error - expected exactly \"$NO_GMS_DETECT_ERROR\" without GMS"
                error.startsWith("NotSupportedError") -> "rejected $error (Play services present but the detector unusable)"
                error.isNotEmpty() -> "rejected $error"
                else -> "neither resolved nor rejected"
            }
            finding("    $name.detect(img): $note ${verdict(ok)}")
        }
        finding("  $label: BarcodeDetector exposed to the page ${verdict(barcodeSeen)}")
    }

    /** Poll the page for the probe's end, up to 20 s; the recorded object or null. */
    private fun awaitProbe(timeoutMs: Long = 20_000): JSONObject? {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            val raw = tabJs("JSON.stringify(window.__shape || null)")
            val json = runCatching { JSONObject(jsonString(raw)) }.getOrNull()
            if (json != null && json.optString("phase") == "done") return json
            SystemClock.sleep(400)
        }
        return null
    }

    // --- the device ------------------------------------------------------------------------------

    private fun webViewPackage(): String =
        runCatching { WebViewCompat.getCurrentWebViewPackage(app)?.let { "${it.packageName} ${it.versionName}" } }.getOrNull()
            ?: "(unknown)"

    /**
     * Whether `com.google.android.gms` is installed - the package the WebView's provider is built
     * on. Absent, the outcome is fully determined (no provider, the pipe closes) and pinned exactly;
     * present, the detector's own answer is accepted as it comes.
     */
    private val gmsPresent: Boolean by lazy {
        runCatching { app.packageManager.getPackageInfo("com.google.android.gms", 0) }.isSuccess
    }

    private fun playServicesPresence(): String {
        val gms = runCatching { app.packageManager.getPackageInfo("com.google.android.gms", 0).versionName }.getOrNull()
        val vending = runCatching { app.packageManager.getPackageInfo("com.android.vending", 0).versionName }.getOrNull()
        val pin = if (gmsPresent) "the Play branch: detect() may resolve" else "no GMS: [] and \"$NO_GMS_DETECT_ERROR\" pinned exactly"
        return "com.google.android.gms ${gms ?: "absent"}, com.android.vending ${vending ?: "absent"} ($pin)"
    }

    /** What `GooglePlayServicesUtilLight` reads: the int under the key on our ApplicationInfo, 0 when absent. */
    private fun gmsVersionMetaData(): String = runCatching {
        val info = app.packageManager.getApplicationInfo(app.packageName, PackageManager.GET_META_DATA)
        val value = info.metaData?.getInt("com.google.android.gms.version", 0) ?: 0
        "$value ${verdict(value == 12451000)}"
    }.getOrElse { "unreadable: $it ${verdict(false)}" }

    /** A 16x16 checker pattern, PNG: nothing a barcode detector finds, something detect() decodes. */
    private fun patternPng(): ByteArray {
        val bitmap = Bitmap.createBitmap(16, 16, Bitmap.Config.ARGB_8888)
        for (y in 0 until 16) for (x in 0 until 16) {
            bitmap.setPixel(x, y, if ((x / 2 + y / 2) % 2 == 0) Color.BLACK else Color.WHITE)
        }
        return ByteArrayOutputStream().also { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }.toByteArray()
    }

    // --- the page --------------------------------------------------------------------------------

    private fun <T> onMain(block: () -> T): T {
        var result: T? = null
        instrumentation.runOnMainSync { result = block() }
        @Suppress("UNCHECKED_CAST")
        return result as T
    }

    private fun shownTabView(): TabWebView? = host.tabs.all().firstOrNull { it.isShown }

    /** Evaluate in the page on screen; the JSON text of the value ("" when nothing answered). */
    private fun tabJs(code: String): String {
        var result = ""
        val latch = CountDownLatch(1)
        instrumentation.runOnMainSync {
            val tab = shownTabView()
            if (tab == null) {
                latch.countDown()
            } else {
                tab.evaluate(code) { value ->
                    result = value ?: ""
                    latch.countDown()
                }
            }
        }
        latch.await(10, TimeUnit.SECONDS)
        return result
    }

    private fun jsonString(raw: String): String = runCatching { JSONTokener(raw).nextValue() as? String }.getOrNull() ?: raw

    private fun navigate(url: String) {
        onMain { shownTabView()?.loadUrl(url) }
        awaitLoaded(url)
        SystemClock.sleep(1_000)
    }

    private fun awaitLoaded(url: String, timeoutMs: Long = 20_000) {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            val (current, progress) = onMain { shownTabView().let { (it?.url ?: "") to (it?.progress ?: 0) } }
            if (current == url && progress == 100) return
            SystemClock.sleep(250)
        }
        Log.w(tag, "gave up waiting for $url")
    }

    /** Where the middle of the first element matching `selector` is on screen, or null. */
    private fun pagePoint(selector: String): PointF? {
        val raw = tabJs(
            "(function(){var e=document.querySelector(${JSONObject.quote(selector)});if(!e)return null;" +
                "var r=e.getBoundingClientRect();return [r.left+r.width/2,r.top+r.height/2]})()"
        )
        val point = runCatching { JSONArray(raw) }.getOrNull()?.takeIf { it.length() == 2 } ?: return null
        val origin = onMain { shownTabView()?.let { v -> IntArray(2).also(v::getLocationOnScreen) } } ?: return null
        return PointF(
            origin[0] + point.getDouble(0).toFloat() * density,
            origin[1] + point.getDouble(1).toFloat() * density
        )
    }

    private fun tapPage(selector: String) {
        val p = pagePoint(selector) ?: run {
            Log.w(tag, "nothing matches $selector on the page")
            return
        }
        Finger().tap(p.x, p.y)
    }

    private fun verdict(ok: Boolean): String {
        if (!ok) failures++
        return if (ok) "PASS" else "FAIL"
    }

    private fun finding(line: String) {
        Log.i(tag, line.trim())
        findings.appendText(line + "\n")
    }

    companion object {
        private const val PORT = 18131
        private const val ORIGIN = "http://127.0.0.1:$PORT"
        /**
         * What the page records (`e.name + ': ' + e.message`) when the provider is never created:
         * Blink's `BarcodeDetector::OnConnectionError` rejecting the request pending on the pipe
         * (`barcode_detector.cc`). The page calls `detect()` in the constructor's own synchronous
         * run, so the request is always pending when the disconnect task arrives - never the
         * "Barcode detection service unavailable." a call after the disconnect would get.
         */
        private const val NO_GMS_DETECT_ERROR = "NotSupportedError: Barcode Detection not implemented."
    }
}
