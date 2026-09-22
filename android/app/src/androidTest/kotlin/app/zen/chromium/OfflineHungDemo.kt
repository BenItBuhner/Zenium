package app.zen.chromium

import android.graphics.Rect
import android.net.Uri
import android.os.Build
import android.os.SystemClock
import android.util.Log
import android.view.accessibility.AccessibilityNodeInfo
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/**
 * Wave 4's offline and hung-page rows (W4-5: ERR-07 the offline banner and Back online, ERR-06
 * the offline error page reloading itself when the network returns, ERR-16 / OS-36 the
 * unresponsive-page prompt, ERR-15 the crash page's variants) under real fingers, for the
 * `android-offline-hung-demo` workflow to record. Every claim is read off the host (the
 * connectivity judge, the unresponsive policy, the tabs' URLs), the chrome's DOM or the
 * accessibility tree, never off the still alone, and the run FAILS when one does not hold.
 *
 * The scenes, in order:
 *  1. the radios off (`svc wifi disable`, `svc data disable`): the §9.33 banner "No internet
 *     connection" stands at the frame's top once the core's second has passed;
 *  2. a page asked for while offline lands on the error page with the offline words;
 *  3. the radios back: "Back online" as a toast, and the error page reloads itself into the
 *     page – no finger on Reload;
 *  4. the crash page: the debug hook ends the shared renderer as a crash would ([DebugHooks];
 *     a WebView has no `chrome://crash`), the chrome rebuilds and the page in front comes back
 *     as "This page crashed" with Reload; a finger on Reload brings the page back;
 *  5. the same page ended again within the minute: "This page crashed again" suggesting closing
 *     other tabs, Show tabs beside Reload; a finger on Show tabs opens the overview;
 *  6. another tab ended as the system's kill: "This page was closed to free up memory";
 *  7. a page of the driver's own hangs its renderer for twelve seconds and a finger taps it: the
 *     native prompt (`UnresponsivePrompt`, the run's stills of the §9.23 imitation in both
 *     themes) after the platform's ~5 s; the page answering again takes the prompt down;
 *  8. a page that hangs for good: Wait keeps the page and the prompt returns after the policy's
 *     grace; Exit page ends the renderer and the page comes back as the crash page's `hung`
 *     variant.
 *
 * Two acts, light and dark, chosen by the `theme` argument. Only asserts what it read; the
 * recording, the stills (`android-offline-hung-*.png`) and the findings file are the evidence.
 */
@RunWith(AndroidJUnit4::class)
class OfflineHungDemo : DemoHarness("offline-hung-demo-state.json", "android-offline-hung", "offline-hung-demo") {
    override val tag = "OfflineHungDemo"
    private lateinit var server: DemoServer
    private lateinit var findings: File
    private val failures = ArrayList<String>()

    private val host: Host get() = (activity as MainActivity).host

    @Test
    fun record() {
        server = DemoServer(PORT, routes()).also { it.start() }
        try {
            runDemo()
        } finally {
            // The emulator is left as it was found: online, in the light scheme.
            radios(true)
            if (THEME == "dark") shell("cmd uimode night no")
            server.close()
        }
        if (failures.isNotEmpty()) error("the offline and hung-page rows did not hold up: ${failures.joinToString("; ")}")
    }

    override fun patchState(json: String): String =
        json.replace("\"colorScheme\": \"light\"", "\"colorScheme\": \"$THEME\"")

    /** The system's colour scheme before the app starts, so the app is born in it (OmniboxPolishDemo's lesson). */
    override fun beforeLaunch() {
        shell("cmd uimode night ${if (THEME == "dark") "yes" else "no"}")
        SystemClock.sleep(1_500)
    }

    override fun warmUp() {
        findings = File(out, "android-offline-hung-findings.txt")
        findings.writeText(
            "Zenium Android offline / hung-page check (API ${Build.VERSION.SDK_INT}, ${width}x$height, density $density, $THEME)\n" +
                "site: ${server.selfCheck()}\n\n"
        )
        val loaded = awaitPage("example.com", 25_000)
        finding("warm-up: the seeded page ${if (loaded) "is up" else "did NOT report complete"}")
        val client = WebViewFeatureReport.rendererClient()
        finding("warm-up: renderer client $client; host connectivity online=${hostOnline()}")
        // The first pill tap pays for the editor's layout off camera.
        val point = pillPoint()
        Finger().tap(point.x, point.y)
        if (waitFor(CLEAR_LABEL, 6_000) != null) {
            SystemClock.sleep(1_500)
            back()
        }
        SystemClock.sleep(2_000)
        Log.i(tag, "warm-up done")
    }

    override fun demo() {
        offlineScenes()
        crashScenes()
        hungScenes()
        finding("done: ${failures.size} claim(s) failed")
    }

    // --- 1-3: offline ----------------------------------------------------------------------------

    private fun offlineScenes() {
        // 1. The radios off: the host's judge says offline, the core's second passes, the banner stands.
        val lostAt = SystemClock.uptimeMillis()
        radios(false)
        claim(awaitHostOnline(false, 20_000), "the host's connectivity judge saw the radios go off")
        val banner = waitFor(OFFLINE_BANNER, 12_000)
        val bannerMs = SystemClock.uptimeMillis() - lostAt
        claim(banner != null, "the offline banner '$OFFLINE_BANNER' is in the tree (${bannerMs} ms after the radios went)")
        val bannerDom = chromeJs(BANNER_TITLE_JS)
        claim(bannerDom.contains(OFFLINE_BANNER), "the banner card is in the chrome's banner stack (DOM reads $bannerDom)")
        SystemClock.sleep(1_200)
        shot("01-offline-banner")

        // 2. A page asked for while offline: the error page, with the offline words.
        coreInvoke("tab.navigate", """{"tabId":"$TAB_OFFLINE","input":"https://example.org/"}""")
        val errorUrl = awaitErrorPage("example.org", 25_000)
        claim(errorUrl != null, "the page asked for offline landed on the error page (${errorUrl ?: pageState()})")
        val code = errorUrl?.let { Uri.parse(it).getQueryParameter("code") }
        claim(code in OFFLINE_CODES, "the error page's code is an offline one (code=$code; ${OFFLINE_CODES.joinToString()} say offline)")
        val reload = waitFor(RELOAD_LABEL, 8_000)
        claim(reload != null, "the error page offers Reload")
        SystemClock.sleep(800)
        shot("02-offline-error-page")

        // 3. The radios back: the toast, and the page reloads itself.
        watchToasts()
        radios(true)
        claim(awaitHostOnline(true, 30_000), "the host's connectivity judge saw the network validate again")
        val toast = awaitToastSeen(BACK_ONLINE, 12_000)
        claim(toast, "'$BACK_ONLINE' showed as a toast")
        shot("03-back-online")
        val reloaded = awaitPage("example.org", 30_000)
        claim(reloaded, "the offline error page reloaded itself into the page (no finger on Reload; page ${pageState()})")
        SystemClock.sleep(600)
        claim(findByLabel(OFFLINE_BANNER) == null, "the offline banner has gone with the network back")
        shot("04-reloaded-by-itself")
    }

    // --- 4-6: the crash page's variants -------------------------------------------------------------

    private fun crashScenes() {
        // 4. A crash: the page in front comes back as the crash page; Reload brings the page back.
        activate(TAB_CRASH, "/notes")
        settleBeforeExit()
        endRenderer(RendererExits.Exit.CRASH)
        val crash = awaitCrashPage("crash", repeat = false, 40_000)
        claim(crash != null, "the crash ends on the crash page (${crash ?: pageState()})")
        claim(waitFor(CRASH_TITLE, 8_000) != null, "the crash page reads '$CRASH_TITLE'")
        SystemClock.sleep(800)
        shot("05-crash-page")
        touchPageControl(RELOAD_LABEL)
        claim(awaitPage("/notes", 20_000), "Reload on the crash page brought the page back (${pageState()})")
        SystemClock.sleep(800)
        shot("06-crash-reloaded")

        // 5. Again within the minute: the repeat variant with Show tabs, which opens the overview.
        endRenderer(RendererExits.Exit.CRASH)
        val again = awaitCrashPage("crash", repeat = true, 40_000)
        claim(again != null, "a second crash within the minute ends on the repeat variant (${again ?: pageState()})")
        claim(waitFor(CRASH_AGAIN_TITLE, 8_000) != null, "the repeat variant reads '$CRASH_AGAIN_TITLE'")
        claim(findByLabel(SHOW_TABS_LABEL) != null, "the repeat variant offers Show tabs beside Reload")
        SystemClock.sleep(800)
        shot("07-crash-again")
        touchPageControl(SHOW_TABS_LABEL)
        val overview = awaitSurface(true, 8_000)
        claim(overview, "Show tabs opened the tab overview")
        SystemClock.sleep(1_500)
        shot("08-show-tabs-overview")
        back()
        claim(awaitSurface(false, 8_000), "back from the overview returns to the crash page")
        SystemClock.sleep(800)
        touchPageControl(RELOAD_LABEL)
        claim(awaitPage("/notes", 20_000), "Reload on the repeat variant brought the page back (${pageState()})")

        // 6. The system's kill on another tab: the memory page.
        activate(TAB_MEMORY, "/gallery")
        settleBeforeExit()
        endRenderer(RendererExits.Exit.MEMORY)
        val memory = awaitCrashPage("memory", repeat = false, 40_000)
        claim(memory != null, "the system's kill ends on the memory page (${memory ?: pageState()})")
        claim(waitFor(MEMORY_TITLE, 8_000) != null, "the memory page reads '$MEMORY_TITLE'")
        SystemClock.sleep(800)
        shot("09-memory-page")
        touchPageControl(RELOAD_LABEL)
        claim(awaitPage("/gallery", 20_000), "Reload on the memory page brought the page back (${pageState()})")
        SystemClock.sleep(600)
    }

    // --- 7-8: the unresponsive page -------------------------------------------------------------------

    private fun hungScenes() {
        // 7. A page that hangs for twelve seconds, a tap on it: the prompt after ~5 s; the page answering again takes it down.
        activate(TAB_HUNG, "/recover")
        SystemClock.sleep(HANG_AFTER_MS + 700)
        val tappedAt = SystemClock.uptimeMillis()
        tapPage()
        val shown = awaitPrompt(true, 20_000)
        val promptMs = SystemClock.uptimeMillis() - tappedAt
        claim(shown, "the unresponsive prompt showed $promptMs ms after the tap on the hung page")
        claim(promptNode(WAIT_LABEL) != null && promptNode(EXIT_LABEL) != null, "the prompt offers Wait and Exit page")
        claim(promptNode(SITE) != null, "the prompt's title block names the site ($SITE)")
        SystemClock.sleep(1_500)
        // The native sheet's still: the run's design record for the §9.23 imitation.
        shot("10-unresponsive-prompt")
        val gone = awaitPrompt(false, 25_000)
        claim(gone, "the renderer answering again took the prompt down")
        claim(!hostPromptShowing(), "no prompt stands once the page answers")
        SystemClock.sleep(800)
        shot("11-responsive-again")

        // 8. A page that hangs for good: Wait keeps the page; the prompt returns after the grace; Exit page ends the renderer.
        activate(TAB_HUNG, "/hang")
        SystemClock.sleep(HANG_AFTER_MS + 700)
        tapPage()
        claim(awaitPrompt(true, 20_000), "the prompt showed for the page that hangs for good")
        SystemClock.sleep(1_000)
        touchPrompt(WAIT_LABEL)
        claim(awaitPrompt(false, 6_000), "Wait took the prompt down")
        SystemClock.sleep(800)
        shot("12-waited")
        // The renderer stays hung; the prompt comes back once the policy's grace has passed and an input goes unanswered again.
        val returned = keepTappingUntilPrompt(UnresponsivePolicy.WAIT_GRACE_MS + 20_000)
        claim(returned, "the prompt returned after the ${UnresponsivePolicy.WAIT_GRACE_MS / 1000} s grace with the page still hung")
        SystemClock.sleep(1_000)
        touchPrompt(EXIT_LABEL)
        val hung = awaitCrashPage("hung", repeat = false, 40_000)
        claim(hung != null, "Exit page ended the renderer and the page came back as the crash page's hung variant (${hung ?: pageState()})")
        claim(waitFor(CRASH_TITLE, 8_000) != null, "the hung variant reads '$CRASH_TITLE'")
        SystemClock.sleep(1_000)
        shot("13-exit-page-crash")
        // The app is left healthy for the recorder's last frames: a page that does not hang.
        coreInvoke("tab.navigate", """{"tabId":"$TAB_HUNG","input":"${server.origin}/calm"}""")
        awaitPage("/calm", 15_000)
        SystemClock.sleep(1_000)
        shot("14-calm-again")
    }

    // --- the renderer ---------------------------------------------------------------------------

    /** The debug hook ([Host.debugEndRenderer]) on the main thread; a release build would refuse, which is a failed claim. */
    private fun endRenderer(exit: RendererExits.Exit) {
        var done = false
        instrumentation.runOnMainSync { done = host.debugEndRenderer(exit) }
        claim(done, "the debug hook ended the renderer as $exit")
    }

    /** The host's tabs settle before the renderer goes: a load still in flight would race the exit's record. */
    private fun settleBeforeExit() = SystemClock.sleep(1_500)

    /**
     * The crash page for the page in front, `zen://error?code=-1` with `variant` and `repeat` as
     * the rebooted core wrote them (`crashPageUrl`), painted; the URL, or null when it never
     * came. A rebuild after a rapid one loads the fresh chrome late (HostLifecycle's backoff), so
     * the wait is generous.
     */
    private fun awaitCrashPage(variant: String, repeat: Boolean, timeoutMs: Long): String? {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            val (url, progress) = pageState()
            if (url.startsWith(ERROR_PREFIX) && progress == 100) {
                val uri = Uri.parse(url)
                val code = uri.getQueryParameter("code")
                val got = uri.getQueryParameter("variant") ?: "crash"
                val gotRepeat = uri.getQueryParameter("repeat") == "1"
                if (code == CRASH_CODE && got == variant && gotRepeat == repeat) {
                    Log.i(tag, "crash page up: $url")
                    SystemClock.sleep(1_500)
                    return url
                }
                Log.i(tag, "an error page, not the one awaited: $url")
            }
            SystemClock.sleep(250)
        }
        return null
    }

    // --- the prompt -----------------------------------------------------------------------------

    private fun hostPromptShowing(): Boolean {
        var showing = false
        instrumentation.runOnMainSync { showing = host.unresponsive.showing }
        return showing
    }

    private fun awaitPrompt(shown: Boolean, timeoutMs: Long): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            if (hostPromptShowing() == shown) return true
            SystemClock.sleep(150)
        }
        return hostPromptShowing() == shown
    }

    /**
     * The prompt's control reading `label`, in the sheet's own window (a `BottomSheetDialog` is a
     * window over the activity's); the windows are walked top-most first, so the sheet's few nodes
     * answer before the hung WebViews' trees would be asked.
     */
    private fun promptNode(label: String): AccessibilityNodeInfo? = findInWindows(app.packageName) { it == label }

    /** A real touch on the prompt's `label`; a fault of the run when the sheet has no such control on screen. */
    private fun touchPrompt(label: String) {
        val node = promptNode(label) ?: run {
            touchFault("the prompt has no '$label' to touch")
            return
        }
        if (!touchTap(node)) touchFault("'$label' on the prompt could not be touched")
    }

    /**
     * A finger on the page's middle: an input the hung renderer cannot acknowledge, which is what
     * starts the platform's unresponsive clock. Above the pill, below the status bar.
     */
    private fun tapPage() {
        val y = (touchable.top + pill.top) / 2f
        Finger().tap(width / 2f, y)
    }

    /** Taps the hung page every few seconds until the prompt is back (or `timeoutMs` pass). */
    private fun keepTappingUntilPrompt(timeoutMs: Long): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            if (hostPromptShowing()) return true
            tapPage()
            val next = SystemClock.uptimeMillis() + 3_000
            while (SystemClock.uptimeMillis() < next) {
                if (hostPromptShowing()) return true
                SystemClock.sleep(150)
            }
        }
        return hostPromptShowing()
    }

    // --- the pages ------------------------------------------------------------------------------

    /** The core switches to `tabId` (not the surface under test) and its page `path` is up. */
    private fun activate(tabId: String, path: String) {
        coreInvoke("tab.activate", """{"tabId":"$tabId"}""")
        val url = "${server.origin}$path"
        val (now, _) = pageState()
        if (!now.startsWith(url)) coreInvoke("tab.navigate", """{"tabId":"$tabId","input":"$url"}""")
        claim(awaitPage(path, 20_000), "the page $path is up on $tabId (${pageState()})")
    }

    /** The tab on screen: its URL and progress, read on the main thread. */
    private fun pageState(): Pair<String, Int> {
        var state = "" to 0
        instrumentation.runOnMainSync {
            val tab = host.tabs.all().firstOrNull { it.isShown }
            state = (tab?.url ?: "") to (tab?.progress ?: 0)
        }
        return state
    }

    private fun awaitPage(urlPart: String, timeoutMs: Long): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            val (url, progress) = pageState()
            if (url.contains(urlPart) && !url.startsWith(ERROR_PREFIX) && progress == 100) {
                Log.i(tag, "loaded $url")
                return true
            }
            SystemClock.sleep(250)
        }
        Log.w(tag, "gave up waiting for $urlPart; page is ${pageState()}")
        return false
    }

    /** The zen://error page for `failed` on screen, painted; its URL (the failed URL rides percent-encoded), or null. */
    private fun awaitErrorPage(failed: String, timeoutMs: Long): String? {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            val (url, progress) = pageState()
            if (url.startsWith(ERROR_PREFIX) && Uri.decode(url).contains(failed) && progress == 100) {
                Log.i(tag, "error page up: $url")
                SystemClock.sleep(1_500)
                return url
            }
            SystemClock.sleep(250)
        }
        return null
    }

    /**
     * A real touch on the page's control reading `label` (the crash page's Reload or Show tabs:
     * the WebView's tree), found afresh right before the finger lands and above the pill – the
     * chrome's bar can carry a Reload of its own, and the page's is the one under test; a fault
     * of the run when the page has none on screen.
     */
    private fun touchPageControl(label: String) {
        val deadline = SystemClock.uptimeMillis() + 8_000
        while (SystemClock.uptimeMillis() < deadline) {
            val node = freshNodes { it == label }.firstOrNull {
                val bounds = Rect().also { r -> it.getBoundsInScreen(r) }
                boundsOnScreen(bounds) && bounds.bottom <= pill.top
            }
            if (node != null && touchTap(node)) return
            nudgeFrame()
            SystemClock.sleep(250)
        }
        touchFault("the page has no '$label' above the pill to touch")
    }

    // --- connectivity ---------------------------------------------------------------------------

    private fun radios(on: Boolean) {
        val verb = if (on) "enable" else "disable"
        shell("svc wifi $verb")
        shell("svc data $verb")
    }

    private fun hostOnline(): Boolean {
        var online = false
        instrumentation.runOnMainSync { online = host.connectivity.online }
        return online
    }

    private fun awaitHostOnline(expected: Boolean, timeoutMs: Long): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            if (hostOnline() == expected) {
                Log.i(tag, if (expected) "online again (validated)" else "offline")
                return true
            }
            SystemClock.sleep(300)
        }
        return hostOnline() == expected
    }

    // --- evidence -------------------------------------------------------------------------------

    private fun claim(ok: Boolean, text: String) {
        finding("${if (ok) "OK  " else "FAIL"} $text")
        if (!ok) failures += text
    }

    private fun finding(line: String) {
        Log.i(tag, line)
        findings.appendText(line + "\n")
    }

    override fun noteLine(line: String) = finding(line)

    private fun shell(command: String): String = shellCommand(command)

    // --- the site -------------------------------------------------------------------------------

    /**
     * The driver's pages on the loopback: two plain ones for the crash scenes, a calm one for the
     * hung tab to rest on, and the two that hang their renderer [HANG_AFTER_MS] after they load –
     * one for [RECOVER_MS], one for good. The hung pages listen for touches without `passive`,
     * so a finger's touch is an event the renderer's main thread must answer (a page with no
     * touch listener has its touches answered by the compositor, which is not what hangs).
     */
    private fun routes(): Map<String, Pair<String, ByteArray>> = mapOf(
        "/notes" to DemoServer.page("Field notes", "<p>Rain from the west by noon; the ridge path is closed until the culvert is rebuilt.</p>"),
        "/gallery" to DemoServer.page("Gallery", "<p>Forty-one photographs of the harbour at low tide, one for each week the crane stood.</p>"),
        "/calm" to DemoServer.page("Calm page", "<p>Nothing on this page runs. It is where the hung tab rests between its acts.</p>"),
        "/recover" to DemoServer.page(
            "Busy for a while",
            "<p>In a moment this page's script will run without pause for ${RECOVER_MS / 1000} seconds, then answer again.</p>" +
                "<script>$TOUCH_LISTENER;setTimeout(function(){var end=Date.now()+$RECOVER_MS;while(Date.now()<end){}},$HANG_AFTER_MS)</script>"
        ),
        "/hang" to DemoServer.page(
            "Busy for good",
            "<p>In a moment this page's script will run without pause and never answer again.</p>" +
                "<script>$TOUCH_LISTENER;setTimeout(function(){for(;;){}},$HANG_AFTER_MS)</script>"
        )
    )

    companion object {
        private const val PORT = 18170
        private const val TAB_OFFLINE = "tab_offline"
        private const val TAB_CRASH = "tab_crash"
        private const val TAB_MEMORY = "tab_memory"
        private const val TAB_HUNG = "tab_hung"
        /** The hung pages start their loop this long after they load, so the load itself completes. */
        private const val HANG_AFTER_MS = 1_500L
        /** How long the recovering page stays busy: past the platform's ~5 s, the tree's reads and the prompt's still. */
        private const val RECOVER_MS = 16_000L
        /** A touch listener that is not passive: the touch waits on the page's main thread. */
        private const val TOUCH_LISTENER =
            "document.addEventListener('touchstart',function(){},{passive:false});document.addEventListener('click',function(){})"
        /** The site the prompt's title block names for the driver's pages ([UnresponsiveSite]). */
        private const val SITE = "127.0.0.1"
        private const val ERROR_PREFIX = "zen://error"
        /** `CRASH_ERROR_CODE` in `shared/url.ts`. */
        private const val CRASH_CODE = "-1"
        /** The offline codes (`core/connectivity.ts`): ERR_INTERNET_DISCONNECTED, ERR_NAME_NOT_RESOLVED, ERR_ADDRESS_UNREACHABLE. */
        private val OFFLINE_CODES = setOf("-106", "-105", "-109")
        /** The URL bar's clear button: there once the bar is open. */
        private const val CLEAR_LABEL = "Clear"
        private const val RELOAD_LABEL = "Reload"
        private const val SHOW_TABS_LABEL = "Show tabs"
        private const val WAIT_LABEL = "Wait"
        private const val EXIT_LABEL = "Exit page"
        /** `connectivityMessages.ts` and `zenPages.ts`. */
        private const val OFFLINE_BANNER = "No internet connection"
        private const val BACK_ONLINE = "Back online"
        private const val CRASH_TITLE = "This page crashed"
        private const val CRASH_AGAIN_TITLE = "This page crashed again"
        private const val MEMORY_TITLE = "This page was closed to free up memory"
        private const val BANNER_TITLE_JS =
            "Array.prototype.map.call(document.querySelectorAll('.zen-banner .zen-banner-title'),function(e){return e.textContent.trim()}).join('|')"
        private val THEME = InstrumentationRegistry.getArguments().getString("theme").let {
            if (it == "dark") "dark" else "light"
        }
    }
}

/** What the device's WebView offers for the renderer client, for the findings. */
private object WebViewFeatureReport {
    fun rendererClient(): String = runCatching {
        val basic = androidx.webkit.WebViewFeature.isFeatureSupported(androidx.webkit.WebViewFeature.WEB_VIEW_RENDERER_CLIENT_BASIC_USAGE)
        val terminate = androidx.webkit.WebViewFeature.isFeatureSupported(androidx.webkit.WebViewFeature.WEB_VIEW_RENDERER_TERMINATE)
        "basic=$basic terminate=$terminate"
    }.getOrElse { "unknown (${it.javaClass.simpleName})" }
}
