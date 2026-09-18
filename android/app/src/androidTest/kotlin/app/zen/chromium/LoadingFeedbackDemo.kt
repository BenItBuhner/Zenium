package app.zen.chromium

import android.os.Build
import android.os.SystemClock
import android.util.Log
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONArray
import org.json.JSONObject
import org.json.JSONTokener
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.io.FileInputStream

/**
 * Shows the loading feedback on a device so the `android-loading-demo` workflow can record it:
 * the 2 px load bar along the top edge of the page during a slow load (a page whose scripts come
 * late from the demo's own server) and on a fast one; a toast with an Undo action over the page,
 * its action tapped with a finger (the page hands the touch through the strip the card covers),
 * the next one swiped off sideways; a toast held under a finger past its time; three stacked
 * banners, one replaced by its key, the top one swiped up, one closed, the last one's action
 * taken; and, when the WebView follows the animator scale, a toast and a load with motion
 * reduced. What it measures goes to `loading-findings.txt` next to the screenshots (`PASS` or
 * `FAIL` per check; the test itself only fails when the driver could not run).
 *
 * The pages come from a loopback server inside this process ([DemoServer]). The messages are
 * raised through the chrome's `window.__zenMessages` (src/android/main.tsx): nothing in the app
 * raises an action toast or a banner of its own yet. The profile (`loading-demo-state.json`)
 * holds two tabs of those pages. The `theme` instrumentation argument (`light`, the default, or
 * `dark`) picks the colour scheme. See [DemoHarness] for the plumbing.
 */
@RunWith(AndroidJUnit4::class)
class LoadingFeedbackDemo : DemoHarness("loading-demo-state.json", "loading-$THEME", "loading-demo") {
    override val tag = "LoadingFeedbackDemo"
    private lateinit var server: DemoServer
    private lateinit var findings: File
    private val host get() = (activity as MainActivity).host

    @Test
    fun record() {
        server = DemoServer(
            PORT,
            mapOf(
                "/" to DemoServer.page(
                    "Loading feedback",
                    "<p>The load bar runs along the top edge of this page; messages come up over its edges.</p>"
                ),
                "/other.html" to DemoServer.page("The other tab", "<p>Served at once: the bar fills and fades.</p>"),
                "/slow" to DemoServer.page(
                    "A slow page",
                    "<p>Its scripts take their time to arrive.</p>" +
                        "<script src=\"/slow-a.js\"></script><script src=\"/slow-b.js\"></script>" +
                        "<p>Loaded.</p>"
                ),
                "/slow-a.js" to ("text/javascript" to "document.body.dataset.a='1'".toByteArray()),
                "/slow-b.js" to ("text/javascript" to "document.body.dataset.b='1'".toByteArray())
            ),
            delays = mapOf("/slow-a.js" to SLOW_A_MS, "/slow-b.js" to SLOW_B_MS)
        ).also { it.start() }
        try {
            runDemo()
        } finally {
            server.close()
        }
    }

    override fun patchState(json: String): String =
        json.replace("\"colorScheme\": \"light\"", "\"colorScheme\": \"$THEME\"")

    /**
     * Let the page come up, then pay for the message layer's first mount and the sampler off
     * camera: a toast and a banner raised and sent off again.
     */
    override fun warmUp() {
        shell("cmd uimode night ${if (THEME == "dark") "yes" else "no"}")
        SystemClock.sleep(2_500)
        ensureForeground()
        findings = File(out, "loading-findings.txt")
        findings.writeText(
            "Zenium Android loading feedback checks ($THEME; API ${Build.VERSION.SDK_INT}, ${width}x$height, density $density)\n\n"
        )
        finding("demo server: ${server.selfCheck()}")
        awaitLoaded("$ORIGIN/")
        chromeJs(SAMPLER)
        chromeJs(
            "window.__zenMessages.pushToast('Warm-up', 'info', {duration: 600});" +
                "window.__zenMessages.dismissBanner(window.__zenMessages.showBanner({title: 'Warm-up'}))"
        )
        SystemClock.sleep(3_000)
        finding("start: active ${activeCoreTab()?.optString("url")}, toasts ${toasts().length()}, banners ${banners().length()}")
        Log.i(tag, "warm-up done")
    }

    override fun demo() {
        shot("01-page")
        slowLoad()
        fastLoad()
        toastWithUndo()
        toastSwipedOff()
        toastHeld()
        bannersStacked()
        reducedMotion()
        SystemClock.sleep(1_000)
        shot("20-end")
        finding("\nend: toasts ${toasts().length()}, banners ${banners().length()}")
    }

    // --- the load bar ----------------------------------------------------------------------------

    /** A page whose scripts arrive late: the bar climbs, creeps and waits, then fills and fades. */
    private fun slowLoad() {
        finding("\nLoad bar on a slow page (scripts $SLOW_A_MS and $SLOW_B_MS ms late)")
        startSampling()
        navigate("$ORIGIN/slow")
        SystemClock.sleep(900)
        shot("02-slow-load-early")
        val early = bar()
        SystemClock.sleep(1_400)
        shot("03-slow-load-mid")
        val mid = bar()
        awaitLoaded("$ORIGIN/slow", 15_000)
        SystemClock.sleep(120)
        shot("04-slow-load-done")
        SystemClock.sleep(1_200)
        val run = Samples(stopSampling())
        finding("  at 0.9 s: ${early.describe()}; at 2.3 s: ${mid.describe()}")
        finding("  shown while the scripts were awaited ${verdict(early.shown && mid.shown && mid.fill < 0.999)}")
        finding("  the fill only grew (${"%.2f".format(early.fill)} then ${"%.2f".format(mid.fill)}) ${verdict(mid.fill >= early.fill)}")
        finding("  ${run.describe()}")
        finding("  filled to the end and faded out ${verdict(run.completed())}")
    }

    /** A page served at once: the bar still shows, fills and fades, in well under a second. */
    private fun fastLoad() {
        finding("\nLoad bar on a fast page")
        startSampling()
        navigate("$ORIGIN/other.html")
        SystemClock.sleep(220)
        shot("05-fast-load")
        awaitLoaded("$ORIGIN/other.html")
        SystemClock.sleep(1_200)
        val run = Samples(stopSampling())
        finding("  ${run.describe()}")
        finding("  shown, filled and faded ${verdict(run.completed())}")
    }

    // --- toasts ----------------------------------------------------------------------------------

    /**
     * A toast with Undo while the page shows: the card sits over the page's bottom edge, the page
     * is clipped out of that strip (the cover band) and a finger on Undo, which lands on the page
     * view, reaches the button.
     */
    private fun toastWithUndo() {
        finding("\nToast with an action while the page shows (the cover band)")
        chromeJs(
            "window.__demoUndo = 0; window.__zenMessages.pushToast('Tab closed', 'info', " +
                "{action: {label: 'Undo', onPick: () => { window.__demoUndo++ }}})"
        )
        SystemClock.sleep(1_300)
        shot("06-toast-undo")
        val cover = cover()
        finding("  the page view clips ${"%.0f".format(cover.second)} CSS px off its bottom under the card ${verdict(cover.second >= 40f)}")
        val undo = waitFor("Undo", 6_000) ?: run {
            finding("  no Undo button in the accessibility tree FAIL")
            return
        }
        finding("  Undo at $undo, the page's bottom edge at ${pageBottom()} px: the button is over the page ${verdict(undo.bottom <= pageBottom() + 2)}")
        Finger().tap(undo.exactCenterX(), undo.exactCenterY())
        SystemClock.sleep(1_500)
        val undone = chromeJs("window.__demoUndo") == "1"
        finding("  a finger on Undo ran the action ${verdict(undone)}; toasts left ${toasts().length()} ${verdict(toasts().length() == 0)}")
        shot("07-toast-undone")
        val after = cover()
        finding("  the strip is back to ${"%.0f".format(after.second)} CSS px ${verdict(after.second == 0f)}")
    }

    /** The next toast swiped off to the right with a finger, pausing part-way. */
    private fun toastSwipedOff() {
        finding("\nToast swiped off sideways")
        chromeJs("window.__zenMessages.pushToast('Downloaded photo.jpg', 'info', {action: {label: 'Open', onPick: () => {}}})")
        SystemClock.sleep(1_300)
        val text = waitFor("Downloaded photo.jpg", 6_000) ?: run {
            finding("  no toast in the accessibility tree FAIL")
            return
        }
        Finger().apply {
            down(text.exactCenterX(), text.exactCenterY())
            moveBy(NUDGE, 0f, 60)
            moveBy(0.22f * width, 0f, 350)
            hold(350)
            shot("08-toast-swiping")
            val dragged = chromeJs("(document.querySelector('.zen-message-toast') || {style: {}}).style.transform || ''")
            finding("  under the finger the card followed: $dragged ${verdict(dragged.contains("translate3d(") && !dragged.contains("translate3d(0.00px"))}")
            moveBy(0.30f * width, 0f, 110)
            up()
        }
        SystemClock.sleep(1_600)
        shot("09-toast-swiped")
        finding("  let go with a fling: toasts left ${toasts().length()} ${verdict(toasts().length() == 0)}")
    }

    /** A 2.5 s toast under a finger for 4.5 s does not go; let go, it goes after its remaining time. */
    private fun toastHeld() {
        finding("\nToast held under a finger")
        chromeJs("window.__zenMessages.pushToast('Held under a finger', 'info', {duration: $HELD_MS})")
        SystemClock.sleep(900)
        val text = waitFor("Held under a finger", 6_000) ?: run {
            finding("  no toast in the accessibility tree FAIL")
            return
        }
        Finger().apply {
            down(text.exactCenterX(), text.exactCenterY())
            hold(4_500)
            shot("10-toast-held")
            val live = liveToasts()
            finding("  held 4.5 s on a $HELD_MS ms toast: still up ${verdict(live == 1)} (live toasts $live)")
            up()
        }
        SystemClock.sleep(3_800)
        shot("11-toast-released-gone")
        finding("  let go: gone after what was left of its time ${verdict(toasts().length() == 0)}")
    }

    // --- banners ---------------------------------------------------------------------------------

    private fun bannersStacked() {
        finding("\nBanners: three stacked, one replaced by its key, swipe, close, action")
        banner("Install Zenium?", "Add it to your home screen for quick access", "Download", "Install", "install")
        SystemClock.sleep(1_100)
        banner("Make Zenium your default browser", "Links from other apps will open here", "Smartphone", "Make default", "default")
        SystemClock.sleep(1_100)
        banner("Pop-up blocked", "127.0.0.1 tried to open a new window", null, "Show", "popup")
        SystemClock.sleep(1_600)
        shot("12-banners-three")
        var titles = bannerTitles()
        finding("  three raised, newest on top: $titles ${verdict(titles.size == 3 && titles.first() == "Pop-up blocked")}")
        val cover = cover()
        finding("  the page view clips ${"%.0f".format(cover.first)} CSS px off its top under the stack ${verdict(cover.first >= 120f)}")

        // The same key again: the first banner is replaced, not joined; still three.
        banner("Install Zenium?", "It is ready to be added to your home screen", "Download", "Install", "install")
        SystemClock.sleep(1_600)
        shot("13-banner-key-replaced")
        titles = bannerTitles()
        finding("  the install key again: $titles ${verdict(titles.size == 3 && titles.first() == "Install Zenium?" && titles.count { it == "Install Zenium?" } == 1)}")

        // The top one swiped up, pausing part-way.
        val top = waitFor("Install Zenium?", 6_000)
        if (top == null) {
            finding("  no banner in the accessibility tree FAIL")
        } else {
            Finger().apply {
                down(top.exactCenterX(), top.exactCenterY())
                moveBy(0f, -NUDGE, 60)
                moveBy(0f, -26 * density, 320)
                hold(350)
                shot("14-banner-swiping")
                moveBy(0f, -80 * density, 100)
                up()
            }
            SystemClock.sleep(1_600)
            shot("15-banners-two")
            titles = bannerTitles()
            finding("  the top one swiped up: $titles ${verdict(titles.size == 2 && titles.first() == "Pop-up blocked")}")
        }

        // The close button of the one now on top.
        val close = waitFor("Dismiss", 6_000)
        if (close == null) {
            finding("  no close button in the accessibility tree FAIL")
        } else {
            Finger().tap(close.exactCenterX(), close.exactCenterY())
            SystemClock.sleep(1_600)
            shot("16-banner-one")
            titles = bannerTitles()
            finding("  its close button: $titles ${verdict(titles.size == 1 && titles.first() == "Make Zenium your default browser")}")
        }

        // The last one's action.
        val action = waitFor("Make default", 6_000)
        if (action == null) {
            finding("  no action button in the accessibility tree FAIL")
        } else {
            Finger().tap(action.exactCenterX(), action.exactCenterY())
            SystemClock.sleep(1_600)
            val picked = chromeJs("window.__demoPicked") == "\"default\""
            finding("  its action: ran ${verdict(picked)}, banners left ${banners().length()} ${verdict(banners().length() == 0)}")
        }
        shot("17-banners-gone")
        val after = cover()
        finding("  the strip is back to ${"%.0f".format(after.first)} CSS px ${verdict(after.first == 0f)}")
    }

    private fun banner(title: String, detail: String, icon: String?, action: String, key: String) {
        chromeJs(
            "window.__zenMessages.showBanner({title: ${JSONObject.quote(title)}, detail: ${JSONObject.quote(detail)}, " +
                "icon: ${if (icon != null) "window.__zenMessages.icons.$icon" else "undefined"}, key: ${JSONObject.quote(key)}, " +
                "action: {label: ${JSONObject.quote(action)}, onPick: () => { window.__demoPicked = ${JSONObject.quote(key)} }}})"
        )
    }

    // --- reduced motion --------------------------------------------------------------------------

    /**
     * Animator scale 0 is what makes the WebView report `prefers-reduced-motion`; when it picks
     * the change up live, a toast appears in its slot on a fade and the bar fades in 120 ms.
     */
    private fun reducedMotion() {
        finding("\nReduced motion (animator duration scale 0)")
        shell("settings put global animator_duration_scale 0")
        shell("settings put global transition_animation_scale 0")
        shell("settings put global window_animation_scale 0")
        try {
            var reduced = false
            val deadline = SystemClock.uptimeMillis() + 4_000
            while (!reduced && SystemClock.uptimeMillis() < deadline) {
                reduced = chromeJs("matchMedia('(prefers-reduced-motion: reduce)').matches") == "true"
                if (!reduced) SystemClock.sleep(400)
            }
            finding("  the chrome sees prefers-reduced-motion: $reduced")
            if (!reduced) {
                finding("  (the WebView did not follow the scale within the run; the reduced-motion pass is skipped, not failed)")
                return
            }
            chromeJs(
                "window.__rm = null; window.__zenMessages.pushToast('Motion reduced', 'info', {action: {label: 'OK', onPick: () => {}}});" +
                    "requestAnimationFrame(() => setTimeout(() => { const c = document.querySelector('.zen-message-toast');" +
                    "window.__rm = c ? c.style.transform + ' @ ' + c.style.opacity : 'none' }, 40))"
            )
            SystemClock.sleep(1_300)
            shot("18-reduced-toast")
            val appearing = chromeJs("window.__rm === null ? '' : window.__rm").let { (JSONTokener(it).nextValue() as? String).orEmpty() }
            finding("  the card 40 ms in: $appearing; in its slot, fading in ${verdict(appearing.contains("translate3d(0.00px, 0.00px") && !appearing.endsWith("@ "))}")
            startSampling()
            navigate("$ORIGIN/slow")
            SystemClock.sleep(1_800)
            shot("19-reduced-load-bar")
            awaitLoaded("$ORIGIN/slow", 15_000)
            SystemClock.sleep(1_200)
            val run = Samples(stopSampling())
            finding("  ${run.describe()}")
            finding("  the bar still shows, fills and goes ${verdict(run.completed())}")
        } finally {
            shell("settings put global animator_duration_scale 1")
            shell("settings put global transition_animation_scale 1")
            shell("settings put global window_animation_scale 1")
        }
    }

    // --- the chrome ------------------------------------------------------------------------------

    private class Bar(val present: Boolean, val shown: Boolean, val fill: Float, val opacity: Float) {
        fun describe(): String =
            if (!present) "no bar" else "bar ${if (shown) "shown" else "hidden"}, fill ${"%.2f".format(fill)}, opacity ${"%.2f".format(opacity)}"
    }

    /** The bar as the chrome draws it now: shown, and how far the fill is. */
    private fun bar(): Bar {
        val raw = chromeJs(
            "(() => { const b = document.querySelector('.zen-load-progress'); if (!b) return 'none';" +
                "const f = b.firstElementChild; const m = f && f.style.transform.match(/scaleX\\(([\\d.]+)\\)/);" +
                "return [b.dataset.shown === 'true' ? 1 : 0, m ? parseFloat(m[1]) : 0, parseFloat(getComputedStyle(b).opacity)].join(' ') })()"
        )
        val text = (JSONTokener(raw).nextValue() as? String).orEmpty()
        if (text == "none" || text.isEmpty()) return Bar(false, false, 0f, 0f)
        val parts = text.split(' ')
        return Bar(true, parts[0] == "1", parts[1].toFloat(), parts[2].toFloat())
    }

    /** Per-frame samples of the bar over one load: `[ms, shown, fill, opacity]`. */
    private class Samples(private val rows: JSONArray) {
        private fun row(i: Int) = rows.getJSONArray(i)
        private val n get() = rows.length()
        private val shownAt: Int? = (0 until n).firstOrNull { row(it).getInt(1) == 1 }?.let { row(it).getInt(0) }
        private val fullAt: Int? = (0 until n).firstOrNull { row(it).getDouble(2) >= 0.999 }?.let { row(it).getInt(0) }
        private val hiddenAt: Int? =
            fullAt?.let { full -> (0 until n).firstOrNull { row(it).getInt(0) >= full && row(it).getInt(1) == 0 } }?.let { row(it).getInt(0) }
        private val fadedAt: Int? =
            hiddenAt?.let { hidden -> (0 until n).firstOrNull { row(it).getInt(0) >= hidden && row(it).getDouble(3) < 0.05 } }?.let { row(it).getInt(0) }
        private val maxFill: Double = (0 until n).maxOfOrNull { row(it).getDouble(2) } ?: 0.0

        fun completed(): Boolean = shownAt != null && fullAt != null && fadedAt != null && (fadedAt - fullAt) <= 900

        fun describe(): String =
            "$n frames: shown at ${shownAt ?: "-"} ms, full at ${fullAt ?: "-"} ms, hidden at ${hiddenAt ?: "-"} ms, " +
                "faded at ${fadedAt ?: "-"} ms (max fill ${"%.2f".format(maxFill)})"
    }

    private fun startSampling() {
        chromeJs("window.__barStart()")
    }

    private fun stopSampling(): JSONArray {
        val raw = chromeJs("window.__barStop()")
        return JSONArray((JSONTokener(raw).nextValue() as? String) ?: "[]")
    }

    private fun toasts(): JSONArray = JSONArray(json("JSON.stringify(window.__zenStores.ui.get().toasts)"))

    private fun liveToasts(): Int = json("String(window.__zenStores.ui.get().toasts.filter(t => !t.leaving).length)").toInt()

    private fun banners(): JSONArray = JSONArray(json("JSON.stringify(window.__zenStores.ui.get().banners)"))

    /** Titles of the banners on screen, the newest (on top) first. */
    private fun bannerTitles(): List<String> {
        val arr = JSONArray(json("JSON.stringify(window.__zenStores.ui.get().banners.filter(b => !b.leaving).map(b => b.title))"))
        return (0 until arr.length()).map { arr.getString(it) }
    }

    /** A JS expression that evaluates to a string, decoded. */
    private fun json(code: String): String = (JSONTokener(chromeJs(code)).nextValue() as? String).orEmpty()

    // --- the page view ---------------------------------------------------------------------------

    private fun <T> onMain(block: () -> T): T {
        var result: T? = null
        instrumentation.runOnMainSync { result = block() }
        @Suppress("UNCHECKED_CAST")
        return result as T
    }

    private fun shownTabView(): TabWebView? = host.tabs.all().firstOrNull { it.isShown }

    /** The strips the page view clips off its top and bottom for the message cards (CSS px). */
    private fun cover(): Pair<Float, Float> = onMain { shownTabView()?.let { it.cover.top to it.cover.bottom } ?: (0f to 0f) }

    /** Where the page view ends on screen (px). */
    private fun pageBottom(): Int = onMain {
        shownTabView()?.let { view ->
            val at = IntArray(2)
            view.getLocationOnScreen(at)
            at[1] + view.height
        } ?: 0
    }

    private fun navigate(url: String) {
        val tabId = activeCoreTab()?.optString("id").orEmpty()
        coreInvoke("tab.navigate", "{\"tabId\":${JSONObject.quote(tabId)},\"input\":${JSONObject.quote(url)}}")
    }

    private fun awaitLoaded(url: String, timeoutMs: Long = 20_000) {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            val (current, progress) = onMain { shownTabView().let { (it?.url ?: "") to (it?.progress ?: 0) } }
            if (current == url && progress == 100) return
            SystemClock.sleep(150)
        }
        Log.w(tag, "gave up waiting for $url")
    }

    // --- findings --------------------------------------------------------------------------------

    private fun verdict(ok: Boolean) = if (ok) "PASS" else "FAIL"

    private fun finding(line: String) {
        Log.i(tag, line.trim())
        findings.appendText(line + "\n")
    }

    /** Run a shell command with the instrumentation's shell permissions; returns its output. */
    private fun shell(command: String): String {
        val fd = ui.executeShellCommand(command)
        return FileInputStream(fd.fileDescriptor).bufferedReader().use { it.readText() }.also { fd.close() }
    }

    companion object {
        private const val PORT = 18127
        private const val ORIGIN = "http://127.0.0.1:$PORT"
        private const val SLOW_A_MS = 1_600L
        private const val SLOW_B_MS = 3_400L
        private const val HELD_MS = 2_500L
        private val THEME = InstrumentationRegistry.getArguments().getString("theme").let {
            if (it == "dark") "dark" else "light"
        }

        /**
         * Installed in the chrome once: a frame-by-frame sampler of the load bar between
         * `__barStart()` and `__barStop()` (which answers with the samples as JSON text), each
         * sample `[ms since start, shown, fill 0…1, opacity]`.
         */
        private val SAMPLER = """
            window.__barLog = { on: false, samples: [] };
            window.__barStart = () => {
              const log = window.__barLog;
              log.samples = [];
              log.on = true;
              const t0 = performance.now();
              const step = () => {
                if (!log.on) return;
                const b = document.querySelector('.zen-load-progress');
                const f = b && b.firstElementChild;
                const m = f && f.style.transform.match(/scaleX\(([\d.]+)\)/);
                log.samples.push([
                  Math.round(performance.now() - t0),
                  b && b.dataset.shown === 'true' ? 1 : 0,
                  m ? parseFloat(m[1]) : 0,
                  b ? parseFloat(getComputedStyle(b).opacity) : 0
                ]);
                requestAnimationFrame(step);
              };
              requestAnimationFrame(step);
            };
            window.__barStop = () => { window.__barLog.on = false; return JSON.stringify(window.__barLog.samples); };
        """.trimIndent()
    }
}
