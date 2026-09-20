package app.zen.chromium

import android.app.Activity
import android.app.UiAutomation
import android.os.Build
import android.os.SystemClock
import android.util.Log
import android.view.View
import android.view.ViewTreeObserver
import android.webkit.TracingConfig
import android.webkit.TracingController
import android.webkit.WebView
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.OutputStream
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.zip.GZIPOutputStream

/**
 * What a performance driver measures with, besides its gestures (the performance program's
 * method: measured, not guessed). Three captures, each read by `.github/scripts/android-perf-analyze.py`
 * on the runner afterwards:
 *
 *  - the frame stats of the app's own window from `dumpsys gfxinfo <package>`: [gfxReset] before a
 *    scene, [gfxFrameStats] after it – the summary (frames, janky frames, the 50 / 90 / 95 / 99th
 *    percentiles) covers every frame since the reset, and the `---PROFILEDATA---` rows carry the
 *    last 120 frames' stage timestamps (input, animation, measure / layout, draw, sync, command
 *    issue, swap, GPU), so the long stage of a slow frame can be named. One dump per scene, never
 *    inside one: the dump runs on the app's RenderThread and would be a jank of its own;
 *  - a Perfetto trace of the device (`sched gfx view input wm am binder_driver webview` and
 *    SurfaceFlinger's frame timeline; `.github/scripts/android-perf-bar-hide.pbtx`, pushed to the
 *    device by the workflow script) run as a detached session across the whole sequence
 *    ([perfettoStart], [perfettoStop]), with each scene's window recorded in the trace's clock
 *    (`CLOCK_BOOTTIME`, [nowBoot]) and marked as an async slice under the app's atrace tag
 *    ([sceneBegin], [sceneEnd]) so the analysis cuts the trace per scene;
 *  - the WebViews' own Chromium trace through `android.webkit.TracingController` ([blinkStart],
 *    [blinkStop]): every WebView of the process – the chrome and the page – records `blink`, `cc`,
 *    `v8`, `renderer.scheduler`, `input` and the DevTools timeline categories, so the chrome
 *    renderer's main thread shows its style recalculation, layout, paint and script per frame.
 *    The JSON is written gzipped; its `ts` are `CLOCK_MONOTONIC` microseconds ([nowMono]).
 *
 * [ViewCounters] counts, in process and for free, what the hypotheses are about: layout passes of
 * the window, draws, and changes of the page WebView's bounds.
 */
class PerfCapture(private val ui: UiAutomation, val packageName: String, private val tag: String) {
    /** Run a shell command with the instrumentation's shell permissions; its output. `Runtime.exec` tokenises: no quoting, no pipes. */
    fun shell(command: String): String {
        val fd = ui.executeShellCommand(command)
        return FileInputStream(fd.fileDescriptor).bufferedReader().use { it.readText() }.also { fd.close() }
    }

    // --- dumpsys gfxinfo -------------------------------------------------------------------------

    fun gfxReset() {
        shell("dumpsys gfxinfo $packageName reset")
    }

    fun gfxFrameStats(): String = shell("dumpsys gfxinfo $packageName framestats")

    // --- Perfetto ---------------------------------------------------------------------------------

    /** The workflow script pushed the trace config and the traced daemon answers. */
    fun perfettoAvailable(): Boolean {
        val config = shell("ls $PERFETTO_CONFIG")
        if (!config.contains(PERFETTO_CONFIG) || config.contains("No such file")) {
            Log.w(tag, "no Perfetto config at $PERFETTO_CONFIG: no system trace")
            return false
        }
        return true
    }

    /**
     * Start a detached Perfetto session named `key` writing to `output` (the config has
     * `write_into_file`, so the service owns the file and no client process has to live on).
     * False when the session did not start (the output says why).
     */
    fun perfettoStart(key: String, output: String): Boolean {
        shell("setprop persist.traced.enable 1")
        val out = shell("perfetto -c $PERFETTO_CONFIG --txt -o $output --detach=$key")
        SystemClock.sleep(1_500)
        val running = shell("perfetto --is_detached=$key")
        Log.i(tag, "perfetto start: ${out.trim()} | detached: ${running.trim()}")
        return !out.contains("error", ignoreCase = true) && !out.contains("failed", ignoreCase = true)
    }

    /** Stop the detached session `key`; the service flushes the rest of the trace into the file. */
    fun perfettoStop(key: String): String {
        val out = shell("perfetto --attach=$key --stop")
        Log.i(tag, "perfetto stop: ${out.trim()}")
        return out
    }

    // --- the WebViews' Chromium trace -------------------------------------------------------------

    private val blinkExecutor = Executors.newSingleThreadExecutor()

    /** Start tracing every WebView of the process with `categories`; false when the API is missing or tracing was already on. */
    fun blinkStart(categories: List<String>): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.P) return false
        var started = false
        InstrumentationRegistry.getInstrumentation().runOnMainSync {
            val controller = TracingController.getInstance()
            if (controller.isTracing) {
                Log.w(tag, "WebView tracing was already on")
                return@runOnMainSync
            }
            val config = TracingConfig.Builder()
                .addCategories(*categories.toTypedArray())
                .setTracingMode(TracingConfig.RECORD_CONTINUOUSLY)
                .build()
            controller.start(config)
            started = controller.isTracing
        }
        Log.i(tag, "WebView tracing ${if (started) "started" else "did not start"}: $categories")
        return started
    }

    /**
     * Stop tracing and write the JSON, gzipped, to `file`; waits until Chromium has closed the
     * stream (the write is asynchronous and can take a while for a long trace). False when
     * nothing was being traced or the write did not finish in time.
     */
    fun blinkStop(file: File, timeoutSeconds: Long = 120): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.P) return false
        val closed = CountDownLatch(1)
        val stream: OutputStream = object : GZIPOutputStream(FileOutputStream(file), 1 shl 16) {
            override fun close() {
                try {
                    super.close()
                } finally {
                    closed.countDown()
                }
            }
        }
        var stopped = false
        InstrumentationRegistry.getInstrumentation().runOnMainSync {
            val controller = TracingController.getInstance()
            stopped = controller.isTracing && controller.stop(stream, blinkExecutor)
        }
        if (!stopped) {
            stream.close()
            Log.w(tag, "WebView tracing was not on; nothing written to ${file.name}")
            return false
        }
        val done = closed.await(timeoutSeconds, TimeUnit.SECONDS)
        Log.i(tag, "WebView trace ${file.name}: ${if (done) "${file.length()} bytes" else "still writing after $timeoutSeconds s"}")
        return done
    }

    /** The WebView provider and version the traces come from (the API 34 image's own, or a swapped-in snapshot). */
    fun webViewVersion(): String {
        val pkg = WebView.getCurrentWebViewPackage() ?: return "unknown"
        return "${pkg.packageName} ${pkg.versionName}"
    }

    // --- clocks and markers -----------------------------------------------------------------------

    /** `CLOCK_BOOTTIME` in ns: Perfetto's trace clock. */
    fun nowBoot(): Long = SystemClock.elapsedRealtimeNanos()

    /** `CLOCK_MONOTONIC` in µs: the clock behind Chromium's trace `ts`. */
    fun nowMono(): Long = System.nanoTime() / 1_000

    private val cookies = AtomicInteger(1)

    /** Mark the start of a scene in the system trace (an async slice under the app's atrace tag); the cookie ends it. */
    fun sceneBegin(name: String): Int {
        val cookie = cookies.getAndIncrement()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) android.os.Trace.beginAsyncSection("$MARKER $name", cookie)
        return cookie
    }

    fun sceneEnd(name: String, cookie: Int) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) android.os.Trace.endAsyncSection("$MARKER $name", cookie)
    }

    companion object {
        /** Where the workflow script leaves the trace config (`adb push`; shell can read it, the app cannot write there). */
        const val PERFETTO_CONFIG = "/data/local/tmp/zen-perfetto.pbtx"
        /** The one directory the traced service and shell both write in; the script pulls `zen-*.pftrace` from it. */
        const val PERFETTO_DIR = "/data/misc/perfetto-traces"
        /** The prefix of the scene markers in the system trace. */
        const val MARKER = "zenperf"
        /**
         * The chrome's own trace categories: the renderer's high-level stages (`blink`: style,
         * layout, paint; `cc`: the compositor's frames; `v8`: script and GC; `renderer.scheduler`:
         * its tasks; `input`) plus the DevTools timeline, which names each frame's
         * `UpdateLayoutTree` / `Layout` / `Paint` / `FunctionCall` the way the Performance panel does.
         */
        val BLINK_CATEGORIES = listOf(
            "blink",
            "cc",
            "v8",
            "renderer.scheduler",
            "input",
            "devtools.timeline",
            "disabled-by-default-devtools.timeline",
            "disabled-by-default-devtools.timeline.frame"
        )
    }
}

/**
 * In-process counters for a scene: how many times the window laid out (`OnGlobalLayoutListener`:
 * one per traversal that ran a layout pass), how many times it drew (`OnDrawListener`), and how
 * many times the page WebView's bounds changed (`OnLayoutChangeListener` fires only when the
 * frame moved or resized: a resize of the page, which Chromium follows with a layout of the
 * document). Attach once ([attach]), [reset] before a scene, [snapshot] after it.
 */
class ViewCounters(private val activity: Activity, private val page: () -> View?) {
    val layouts = AtomicInteger()
    val draws = AtomicInteger()
    val pageBounds = AtomicInteger()
    private var attachedTo: View? = null

    fun attach() {
        InstrumentationRegistry.getInstrumentation().runOnMainSync {
            val observer: ViewTreeObserver = activity.window.decorView.viewTreeObserver
            observer.addOnGlobalLayoutListener { layouts.incrementAndGet() }
            observer.addOnDrawListener { draws.incrementAndGet() }
            attachPage()
        }
    }

    /** The page view may be a new one after a navigation to another tab; called from the main thread. */
    private fun attachPage() {
        val view = page() ?: return
        if (view === attachedTo) return
        attachedTo = view
        view.addOnLayoutChangeListener { _, l, t, r, b, ol, ot, or, ob ->
            if (l != ol || t != ot || r != or || b != ob) pageBounds.incrementAndGet()
        }
    }

    fun reset() {
        InstrumentationRegistry.getInstrumentation().runOnMainSync { attachPage() }
        layouts.set(0)
        draws.set(0)
        pageBounds.set(0)
    }

    fun snapshot(): Map<String, Int> = mapOf("layouts" to layouts.get(), "draws" to draws.get(), "pageBounds" to pageBounds.get())
}
