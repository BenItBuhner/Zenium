package app.zen.chromium

import android.app.Instrumentation
import android.os.Build
import android.os.Bundle
import android.os.SystemClock
import android.util.Log
import android.webkit.WebView
import androidx.core.content.pm.PackageInfoCompat
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import app.zen.chromium.UnloadProbeLatencyStats.Arm
import app.zen.chromium.UnloadProbeLatencyStats.MISSED
import app.zen.chromium.UnloadProbeLatencyStats.Sample
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * A measurement, not a demo (seed A10 step 1, after A7 / #789): what the unload probe
 * ([TabWebView.probeThenLoad]) costs a load the core asks for, on whatever device this runs on.
 * The probe asks the page's `beforeunload` by a navigation of its own ahead of every such load;
 * over a page with NO handler that asking is pure latency, and the Design Lead's ruling of
 * 10-02 (option (i): the probe stays on every core-asked load) waits on a device's number for
 * it – the emulator's (run 36972071132: light 594 / 813 ms median / p95 with the probe against
 * 346 / 618 without, dark 475 / 817 against 506 / 626, a 100–900 ms spread) says nothing a
 * phone would. Kept and opt-in: in no nightly manifest, run by hand on a connected device
 * (`android/docs/unload-probe-latency.md` has the one-liner) or by a one-off workflow.
 *
 * The scene: one tab on a plain page served from this process ([DemoServer] on 127.0.0.1:18138,
 * no `beforeunload` anywhere), loaded again and again by the view's own `loadUrl` – the entry
 * `Host`'s `view.load` takes for a typed address, a bookmark, a history row – with a fresh query
 * each time so every load is a navigation and never a reload. Two arms, interleaved in PAIRS:
 * one load WITH the probe (the product as shipped) and one WITHOUT (the probe held off by
 * [UnloadProbeRules.debugHoldProbe], the debug-only switch), back to back on the same page, the
 * order alternating pair by pair (with/without, then without/with) so neither arm sits on the
 * device's drift; two warm-up loads first, not counted. Default twenty pairs (`-e loads N`).
 *
 * The reading: from the harness's `loadUrl` call on the main thread (stamped right before it)
 * to the view's words about the TARGET on the same thread – `onPageStarted` (the chrome's
 * `startLoading` event, the reading judged), the history commit (`navigated`), the first
 * progress report and `onPageFinished` (`stopLoading`). They are read by wrapping the demo
 * tab's [PageHost] through [TabWebView.host] (the seam `TabHost.adopt` uses): every word passes
 * to the real host unchanged, the ones measured are stamped on the way. Nothing of the boot
 * path is touched for it – no line in `TabWebView.kt`, none in `Host.kt`. Each sample proves
 * its arm: the view's address right after `loadUrl` returns is the probe's `.invalid` one with
 * the probe (its navigation is pending until Chromium drops it) and the target's without; a
 * hold that never took voids the run.
 *
 * The findings – per arm median, p95, min, max, mean and N; the arms' deltas; the PAIRED delta
 * (with minus without inside each pair); the device, API level, `ro.hardware`, WebView; an
 * ADVISORY verdict against one frame at 60 Hz (16.7 ms; the Lead's decision rule, nothing
 * asserted on it) – go to the log under [tag], to `unload-probe-latency.txt` in the handshake
 * directory (the workflow collects `*.txt`; `run-as` reads it on a device) and to the same file
 * in the app's external files directory (plain `adb pull`), and to the instrumentation's stream
 * (`am instrument -w` prints it as it comes). The run fails when a load never starts or the
 * hold never took; never on the numbers. [UnloadProbeLatencyStats] has the arithmetic, pinned
 * on the JVM. A perf reading, so [runPerfDemo] (no events hold; see the rule at [runDemo]); it
 * answers the recorder's handshake itself – nothing to record. See [DemoHarness].
 */
@RunWith(AndroidJUnit4::class)
class UnloadProbeLatency : DemoHarness("unload-probe-latency-state.json", "unload-probe-latency", HANDSHAKE_DIR) {
    override val tag = "UnloadProbeLatency"
    private lateinit var server: DemoServer
    private lateinit var findings: File
    private val host get() = (activity as MainActivity).host
    private val samples = ArrayList<Sample>()
    private val faults = ArrayList<String>()
    private var sequence = 0

    /** The seeded profile's colour scheme, from the `theme` argument. */
    override fun patchState(json: String): String =
        json.replace("\"colorScheme\": \"light\"", "\"colorScheme\": \"$THEME\"")

    @Test
    fun probeLatency() {
        val page = DemoServer.page("No handler here", "<p>A plain page: nothing on it objects to leaving.</p>")
        server = DemoServer(
            PORT,
            mapOf(
                "/" to page,
                "/page.html" to page,
                "/other.html" to DemoServer.page("Nothing here objects either", "<p>The other tab.</p>")
            )
        ).also { it.start() }
        try {
            runPerfDemo()
        } finally {
            server.close()
            instrumentation.runOnMainSync { UnloadProbeRules.debugHoldProbe(false) }
        }
        if (faults.isNotEmpty()) error(faults.joinToString("\n"))
    }

    override fun warmUp() {
        findings = File(out, FINDINGS)
        findings.writeText("")
        // Nothing to record: the recorder's handshake is answered here, so the one-liner on a
        // device waits for no workflow, and the workflow's own answer (DEMO_RECORD=0) finds it given.
        File(out, "recording").writeText("a measurement: nothing to record\n")
        note("server: ${server.selfCheck()}")
        awaitLoaded(TAB, "$ORIGIN/")
        SystemClock.sleep(1_000)
    }

    override fun demo() {
        if (!BuildConfig.DEBUG) {
            faults += "the measurement needs a debuggable build: the hold for the baseline arm is a debug-only switch"
            return
        }
        val view = onMain { host.tabs.get(TAB) } ?: run {
            faults += "the tab $TAB has no view"
            return
        }
        val real = onMain { view.host }
        val tap = Tap(real)
        onMain { view.host = tap }
        val began = SystemClock.uptimeMillis()
        try {
            // Not counted: the first probe's and the first load's own costs (classes, the renderer's caches).
            load(view, tap, Arm.WITH, pair = -1)
            load(view, tap, Arm.WITHOUT, pair = -1)
            for (pair in 0 until LOADS) {
                val first = if (pair % 2 == 0) Arm.WITH else Arm.WITHOUT
                load(view, tap, first, pair)
                load(view, tap, first.other(), pair)
            }
        } finally {
            onMain {
                if (view.host === tap) view.host = real
                UnloadProbeRules.debugHoldProbe(false)
            }
        }
        report(SystemClock.uptimeMillis() - began)
    }

    /**
     * One load of the page under `arm`, stamped and waited for: the hold set for the call alone
     * (the view reads it inside `loadUrl`, on the main thread, and nothing re-reads it after),
     * the clock read right before the call, the view's address right after it (the arm's
     * proof), then the target's start and finish waited for, and a settle. A load that never
     * starts is a fault (the run fails at its end, the evidence so far kept); one that started
     * and never finished is noted – the reading judged is the start.
     */
    private fun load(view: TabWebView, tap: Tap, arm: Arm, pair: Int) {
        val n = ++sequence
        val url = "$ORIGIN/page.html?load=$n"
        val pending = Pending(TAB)
        tap.armed = pending
        var after: String? = null
        instrumentation.runOnMainSync {
            UnloadProbeRules.debugHoldProbe(arm == Arm.WITHOUT)
            // As Host's `view.load` has it: the core's rules for the destination (none here) ahead of the load.
            view.presetResolvedRules(url, null)
            pending.t0 = System.nanoTime()
            view.loadUrl(url)
            after = view.url
            UnloadProbeRules.debugHoldProbe(false)
        }
        val started = pending.startedLatch.await(LOAD_WAIT_MS, TimeUnit.MILLISECONDS)
        val finished = started && pending.finishedLatch.await(LOAD_WAIT_MS, TimeUnit.MILLISECONDS)
        tap.armed = null
        val sample = Sample(
            pair = pair,
            arm = arm,
            startedMs = pending.ms(pending.startedNs),
            navigatedMs = pending.ms(pending.navigatedNs),
            progressMs = pending.ms(pending.progressNs),
            finishedMs = pending.ms(pending.finishedNs),
            probePending = UnloadProbeRules.isProbeUrl(after ?: "")
        )
        val label = if (pair < 0) "warm-up" else "sample"
        note("$label ${sample.line()} (load $n, pending ${after ?: "null"})")
        if (!started) faults += "load $n (${arm.label}) never started within $LOAD_WAIT_MS ms"
        else if (!finished) note("  load $n (${arm.label}) started but never finished within $LOAD_WAIT_MS ms")
        if (pair >= 0) samples += sample
        SystemClock.sleep(SETTLE_MS)
    }

    /** The findings block: written down, logged, sent on the instrumentation's stream. */
    private fun report(tookMs: Long) {
        val emulator = isEmulator()
        val header = listOf(
            "device: ${Build.MANUFACTURER} ${Build.MODEL} (${Build.DEVICE}), API ${Build.VERSION.SDK_INT} (Android ${Build.VERSION.RELEASE}), " +
                "ro.hardware ${Build.HARDWARE}, abi ${Build.SUPPORTED_ABIS.firstOrNull()}" + if (emulator) " -- EMULATOR" else "",
            "build: ${Build.FINGERPRINT}",
            "webview: ${webViewVersion()}",
            "page: $ORIGIN/page.html?load=<n> (no beforeunload handler; the one document, a fresh query each load), served by DemoServer in this process",
            "loads: $LOADS pairs asked, each one load with the probe and one without back to back on the same page, the order alternating pair by pair; " +
                "2 warm-up loads not counted; $SETTLE_MS ms settle after each load; the run took ${tookMs / 1000} s",
            "span: the harness's loadUrl call on the main thread (the entry Host's view.load takes) -> the view's words about the target, same thread",
            "conditions: theme $THEME; background work ${if (holdBackgroundWork) "held (the startup sweeps off)" else "not held"}; " +
                "display ${width}x$height @ $density; run ${timestamp()}"
        )
        val block = UnloadProbeLatencyStats.block(header, samples, emulator, LOADS)
        if (UnloadProbeLatencyStats.holdNeverTook(samples)) {
            faults += "the hold never took: every without-arm load still had the probe pending, so the two arms measured the same thing"
        }
        findings.appendText("\n$block")
        for (line in block.lines()) if (line.isNotEmpty()) Log.i(tag, line)
        runCatching {
            val external = File(app.getExternalFilesDir(null), FINDINGS)
            findings.copyTo(external, overwrite = true)
            Log.i(tag, "findings: ${findings.path} and ${external.path}")
        }.onFailure { Log.w(tag, "the findings could not be copied to the external files directory", it) }
        val status = Bundle()
        status.putString("unload-probe-latency.block", block)
        status.putString(Instrumentation.REPORT_KEY_STREAMRESULT, "\n$block\n")
        instrumentation.sendStatus(0, status)
    }

    // --- the tap -------------------------------------------------------------------------------

    /**
     * The demo tab's host wrapped: every word passes to the real host unchanged, and the ones
     * the measurement reads are stamped on the way (`System.nanoTime()`, the clock the call was
     * stamped with) onto the load pending, if one is. Main thread throughout, as the view's
     * callbacks are.
     */
    private class Tap(val real: PageHost) : PageHost by real {
        @Volatile var armed: Pending? = null

        override fun documentStarted(tab: TabWebView) {
            armed?.started(tab.tabId)
            real.documentStarted(tab)
        }

        override fun viewEvent(tabId: String, name: String, payload: Any?) {
            when (name) {
                "startLoading" -> armed?.started(tabId)
                "navigated" -> armed?.navigated(tabId)
                "stopLoading" -> armed?.finished(tabId)
            }
            real.viewEvent(tabId, name, payload)
        }

        override fun progress(tabId: String, percent: Int) {
            armed?.progress(tabId)
            real.progress(tabId, percent)
        }
    }

    /** One load's stamps: the call's, then the first of each word about `tabId` after it (0 for none yet). */
    private class Pending(private val tabId: String) {
        @Volatile var t0 = 0L
        @Volatile var startedNs = 0L
        @Volatile var navigatedNs = 0L
        @Volatile var progressNs = 0L
        @Volatile var finishedNs = 0L
        val startedLatch = CountDownLatch(1)
        val finishedLatch = CountDownLatch(1)

        fun started(id: String) {
            if (id != tabId || t0 == 0L || startedNs != 0L) return
            startedNs = System.nanoTime()
            startedLatch.countDown()
        }

        fun navigated(id: String) {
            if (id != tabId || t0 == 0L || navigatedNs != 0L) return
            navigatedNs = System.nanoTime()
        }

        /** The first progress report of the target: one before its start is the load before's. */
        fun progress(id: String) {
            if (id != tabId || startedNs == 0L || progressNs != 0L) return
            progressNs = System.nanoTime()
        }

        fun finished(id: String) {
            if (id != tabId || startedNs == 0L || finishedNs != 0L) return
            finishedNs = System.nanoTime()
            finishedLatch.countDown()
        }

        /** `ns` as ms after the call; [MISSED] for a word that never came. */
        fun ms(ns: Long): Double = if (ns == 0L) MISSED else (ns - t0) / 1_000_000.0
    }

    // --- helpers -------------------------------------------------------------------------------

    private fun awaitLoaded(tabId: String, url: String, timeoutMs: Long = 20_000) {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            val (current, progress) = onMain { host.tabs.get(tabId).let { (it?.url ?: "") to (it?.progress ?: 0) } }
            if (current == url && progress == 100) return
            SystemClock.sleep(250)
        }
        note("  (gave up waiting for $url in $tabId)")
    }

    private fun webViewVersion(): String {
        val webview = WebView.getCurrentWebViewPackage() ?: return "no WebView package"
        return "${webview.packageName} ${webview.versionName} (code ${PackageInfoCompat.getLongVersionCode(webview)})"
    }

    /** Whether this is an emulator (its numbers are said to be the emulator's): the goldfish / ranchu hardware, a generic build. */
    private fun isEmulator(): Boolean =
        Build.HARDWARE in setOf("ranchu", "goldfish", "cutf", "cutf_cvm") ||
            Build.FINGERPRINT.startsWith("generic") || Build.FINGERPRINT.contains("emulator") ||
            Build.MODEL.contains("sdk_gphone") || Build.MODEL.contains("Emulator") || Build.PRODUCT.startsWith("sdk")

    private fun timestamp(): String =
        SimpleDateFormat("yyyy-MM-dd HH:mm:ss 'UTC'", Locale.ROOT).apply { timeZone = TimeZone.getTimeZone("UTC") }.format(Date())

    private fun note(line: String) {
        Log.i(tag, line.trim())
        findings.appendText(line + "\n")
    }

    private fun <T> onMain(block: () -> T): T {
        var result: T? = null
        instrumentation.runOnMainSync { result = block() }
        @Suppress("UNCHECKED_CAST")
        return result as T
    }

    private companion object {
        private const val HANDSHAKE_DIR = "unload-probe-latency"
        private const val FINDINGS = "unload-probe-latency.txt"
        private const val PORT = 18138
        private const val ORIGIN = "http://127.0.0.1:$PORT"
        private const val TAB = "tab_demo"
        /** How long a load may take to start, and then to finish, before it is given up on. */
        private const val LOAD_WAIT_MS = 20_000L
        /** The `theme` argument: `dark`, else light (the shared script's `DEMO_THEME`). */
        private val THEME = InstrumentationRegistry.getArguments().getString("theme").let {
            if (it == "dark") "dark" else "light"
        }
        /** The `loads` argument: pairs to measure, twenty unless asked otherwise. */
        private val LOADS = InstrumentationRegistry.getArguments().getString("loads")?.toIntOrNull()?.coerceAtLeast(1) ?: 20
        /** The `settleMs` argument: the pause after each load, before the next. */
        private val SETTLE_MS = InstrumentationRegistry.getArguments().getString("settleMs")?.toLongOrNull()?.coerceAtLeast(0L) ?: 600L
    }
}
