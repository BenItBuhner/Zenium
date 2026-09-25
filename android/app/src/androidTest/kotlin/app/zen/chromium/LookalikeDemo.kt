package app.zen.chromium

import android.graphics.Rect
import android.os.Bundle
import android.os.SystemClock
import android.util.Log
import android.view.Choreographer
import android.view.KeyEvent
import android.view.accessibility.AccessibilityNodeInfo
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.webkit.ProxyConfig
import androidx.webkit.ProxyController
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import org.json.JSONArray
import org.json.JSONObject
import org.json.JSONTokener
import org.junit.Test
import org.junit.runner.RunWith
import java.io.BufferedInputStream
import java.io.ByteArrayOutputStream
import java.io.File
import java.net.ServerSocket
import java.net.Socket
import java.net.URLDecoder
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * Records the lookalike-domain question (PS-18) on the phone, on the hosts' two paths.
 *
 * The typed path: `gogle.com` entered in the URL bar goes to `Tabs.navigate`, which on Android
 * (no pre-request engine hold, `HostCapabilities.lookalikeHolds` false) puts the question page in
 * the address's place before any request goes out – the loopback server that answers as
 * `gogle.com` sees nothing while the question stands. Continue writes the `lookalike` allow to
 * `permissions.json` and loads the site; a second typed visit goes straight through; the phone's
 * Back (the page has no Back row of its own) from a fresh question returns to the page before
 * it. The link / redirect path: a link on a loopback page to `paypa1.com`, and a 302 to
 * `amazom.com`, are navigations the core never saw ahead of the request – the WebView commits
 * them and the core replaces the committed page with the question at `onNavigated`. From that
 * question the committed lookalike entry sits behind the question in the WebView's list, and
 * the phone's Back steps over it (`TabWebView.loadHtml` marks the entry the question stands in
 * for, as WebView's own error page is marked for a failed load): Back lands on the page before
 * the link, with no second document request and no second question. Continue from the same
 * question goes back onto the committed lookalike entry (`TabWebView.loadUrl`'s retry through
 * history) rather than stacking a fourth entry behind the question; the allow lets the page
 * through `onNavigated`. The gap between the commit and the question is measured here, from
 * three instruments on the one device clock:
 * the chrome's view events as the core receives them (`__zenHost.viewEvent`, wrapped to
 * timestamp `navigated` / `startLoading` / `stopLoading`, and the bridge's `view.loadHtml` for
 * the question page, wrapped at `MessagePort.prototype.postMessage`); the page WebView's own
 * word on what it painted (`TabWebView.paintedDocument`, set at `onPageCommitVisible`, sampled
 * once per vsync through a Choreographer frame callback on the main thread, so the samples are
 * ordered with the WebView's callbacks); and the served lookalike page's beacons (its first two
 * animation frames and its `paint` performance entries, sent to the loopback server, which
 * timestamps their receipt). The question page's own stills are taken light and dark through
 * the core's colour-scheme setting, as the focus-ring demo switches.
 *
 * THE HOST MAPPING. The engine's verdict is on the registrable domain, so the sites must be
 * named `gogle.com`, `paypa1.com` and `amazom.com` – no loopback or `nip.io` name will do – and
 * the WebView must reach the loopback server under those names. The WebView's proxy override
 * (`ProxyController`, androidx.webkit; WebView 68+) does that from inside the process: every
 * `http://` request of the app's WebViews goes to the loopback server as a proxy request
 * (`GET http://gogle.com/`, `Host: gogle.com` – no name is resolved), `https://` stays direct, the
 * loopback address is bypassed. So the driver needs nothing from the runner and runs where any
 * demo runs (the nightly's shared script). The warm-up checks it (a fetch of `http://gogle.com/probe`
 * from the loopback page, seen by the server) and records PROXY_NOT_IN_EFFECT when it is not,
 * so the scene fails for that reason rather than on the site never loading. HTTPS-only mode is
 * turned off for the run: the omnibox spells a bare host `https://`, the loopback server speaks
 * plain HTTP only, and the upgrade's failure page would otherwise stand where the site should
 * load (the Continue leg is typed with its scheme, `http://gogle.com`, for the same reason).
 *
 * Findings go to `services-pass-8-android-lookalike-findings.txt` beside the stills; a claim that
 * did not hold fails the run once the stills are down. See [DemoHarness] for the plumbing and
 * [SafeBrowsingDemo] for the loopback server pattern this one follows.
 */
@RunWith(AndroidJUnit4::class)
class LookalikeDemo : DemoHarness("safebrowsing-demo-state.json", "services-pass-8-android-lookalike", "lookalike-demo") {
    override val tag = "LookalikeDemo"
    private lateinit var server: LookalikeDemoServer
    private lateinit var findings: File
    private val failures = ArrayList<String>()
    private var shotIndex = 0

    @Test
    fun record() {
        server = LookalikeDemoServer(PORT).also { it.start() }
        try {
            runDemo()
        } finally {
            clearProxy()
            server.close()
        }
        if (failures.isNotEmpty()) throw AssertionError("${failures.size} claim(s) did not hold:\n" + failures.joinToString("\n"))
    }

    override fun warmUp() {
        findings = File(out, FINDINGS_FILE)
        findings.writeText("Zenium Android – the lookalike-domain question (PS-18) on the device\n\n")
        finding("device: API ${android.os.Build.VERSION.SDK_INT}, ${android.os.Build.MODEL}; WebView ${webViewVersion()}")
        finding("demo server: ${server.selfCheck()}")
        finding("proxy override: ${installProxy()}")

        // HTTPS-only off for the run (see the header); Safe Browsing on, which the check sits under.
        val privacy = coreState().getJSONObject("settings").getJSONObject("privacy")
        privacy.put("httpsOnly", "off")
        coreInvoke("settings.update", JSONObject().put("privacy", privacy).toString())
        SystemClock.sleep(600)
        finding("settings.privacy: ${coreState().getJSONObject("settings").getJSONObject("privacy")}")

        // The tables' log line: the core says when they landed (ZenChrome carries the chrome's console).
        val tablesLine = awaitTablesLine(90_000)
        finding("core log: ${tablesLine ?: "(no 'lookalikes: tables loaded' line within 90 s)"}")
        if (tablesLine == null) failures += "warm-up: the lookalike tables' log line never came"

        // The seeded tab is the loopback site; from it, the mapping probe.
        coreInvoke("tab.navigate", """{"tabId":"tab_demo","input":${JSONObject.quote("http://$LOOPBACK:$PORT/")}}""")
        waitForTitle("Demo site", 25_000)
        val probe = mappingProbe()
        finding("host mapping: $probe")
        if (!probe.startsWith("ok")) failures += "warm-up: PROXY_NOT_IN_EFFECT – $probe"
        server.mark()
        Log.i(tag, "warm-up done")
    }

    override fun demo() {
        val f = Finger()

        // (1) Typed gogle.com: held before any request; (3) Back returns to the page before.
        finding("\n(1) TYPED gogle.com (URL bar) is HELD before any request")
        val hitsBefore = server.hits(GOGLE).size
        watchChrome()
        enter("gogle.com")
        var tab = waitForUrl(ERROR_PREFIX, 25_000)
        var url = tab.getJSONObject("tabs").getJSONObject(TAB).optString("url")
        finding("  ${describeTab(tab)}")
        finding("  page title: ${pageTitle()}")
        expect("the question page stands: zen://error?kind=lookalike", url.startsWith(ERROR_PREFIX) && param(url, "kind") == "lookalike", "1-page")
        expect("its target is google.com", param(url, "target") == "google.com", "1-target")
        expect("the tab is titled \"Did you mean google.com?\"", tab.getJSONObject("tabs").getJSONObject(TAB).optString("title") == "Did you mean google.com?", "1-title")
        SystemClock.sleep(1_500)
        val hitsAfter = server.hits(GOGLE).size
        expect("the loopback server saw no request for gogle.com while the question stood (hits before $hitsBefore, after $hitsAfter)", hitsAfter == hitsBefore, "1-hits")
        finding("  chrome events: ${chromeTimeline()}")
        still("question-light")
        beat()
        if (tapPage(f, "Details", 8_000)) SystemClock.sleep(1_500) else finding("  (no Details node in the page)")
        still("question-details-light")
        beat()

        // The page has no Back row of its own: the phone's Back is the way back (the system's
        // back action, which the chrome routes to the tab's history).
        finding("\n(3) BACK (the phone's Back key) from a fresh question returns to the page before")
        expect("the page offers no Back of its own (no node labelled Back inside the page)", findNodes("Back").none { inPage(it) }, "3-no-back-row")
        pressPhoneBack()
        tab = waitForTitle("Demo site", 25_000)
        finding("  ${describeTab(tab)}")
        expect("the tab is back on http://$LOOPBACK:$PORT/", tab.getJSONObject("tabs").getJSONObject(TAB).optString("url") == "http://$LOOPBACK:$PORT/", "3-back")
        still("back-to-previous")
        beat()

        // (5) The twins for the design lead: the same question in the dark scheme.
        finding("\n(5) STILLS: the question page in the dark scheme (the core's colour-scheme setting)")
        val dark = theme("dark")
        expect("the chrome took the dark scheme", dark, "5-dark")
        enter("gogle.com")
        tab = waitForUrl(ERROR_PREFIX, 25_000)
        finding("  ${describeTab(tab)}")
        SystemClock.sleep(1_200)
        still("question-dark")
        beat()
        if (tapPage(f, "Details", 8_000)) SystemClock.sleep(1_500) else finding("  (no Details node in the page)")
        still("question-details-dark")
        beat()
        pressPhoneBack()
        waitForTitle("Demo site", 25_000)
        theme("light")

        // (2) Continue: the site loads, the allow is written, a second typed visit goes straight through.
        finding("\n(2) CONTINUE → the site loads; permissions.json carries the allow; a second typed visit goes straight through")
        server.mark()
        enter("http://gogle.com")
        tab = waitForUrl(ERROR_PREFIX, 25_000)
        url = tab.getJSONObject("tabs").getJSONObject(TAB).optString("url")
        finding("  ${describeTab(tab)}")
        expect("http://gogle.com typed is held too (hits since mark: ${server.hitsSinceMark(GOGLE).size})", url.startsWith(ERROR_PREFIX) && server.hitsSinceMark(GOGLE).isEmpty(), "2-held")
        pressInterstitial(f, "Continue to gogle.com", "proceed", "http://gogle.com/")
        tab = waitForTitle(GOGLE, 25_000)
        finding("  ${describeTab(tab)}")
        val h1 = tabJs("(document.querySelector('h1')||{}).textContent||''")
        finding("  h1: \"$h1\"; server hits for gogle.com since the mark: ${server.hitsSinceMark(GOGLE).map { it.path }}")
        expect("the site loaded from the loopback server (h1 \"$GOGLE\")", h1 == GOGLE, "2-h1")
        expect("the server saw the document request GET / for gogle.com", server.hitsSinceMark(GOGLE).any { it.path == "/" }, "2-request")
        still("continued-site-loads")
        val permission = awaitPermission("https://$GOGLE|lookalike", 8_000)
        finding("  permissions.json: ${permission ?: "(no lookalike decision for https://$GOGLE within 8 s)"}")
        expect("permissions.json carries https://$GOGLE|lookalike: allow", permission == "allow", "2-permission")
        beat()
        server.mark()
        watchChrome()
        enter("http://gogle.com")
        // The tab is already on gogle.com, so the title cannot be waited for: the server's document
        // request is the navigation's proof, then the load's end.
        val requested = awaitHit(GOGLE, "/", 15_000)
        tab = waitForTitle(GOGLE, 25_000)
        finding("  ${describeTab(tab)}")
        finding("  chrome events: ${chromeTimeline()}")
        val straight = tab.getJSONObject("tabs").getJSONObject(TAB).optString("url") == "http://$GOGLE/" && requested &&
            chromeEvents().let { events -> (0 until events.length()).none { events.getJSONObject(it).optString("url").startsWith(ERROR_PREFIX) } }
        expect("the second typed visit went straight through (no question; ${server.hitsSinceMark(GOGLE).size} request(s))", straight, "2-second")
        still("second-visit-straight-through")
        beat()

        // (4) The link path and the redirect path: commit, then the question, and the gap between.
        finding("\n(4) LINK / REDIRECT: the navigation commits and is replaced at onNavigated – the gap, measured; from the link's question, Back steps over the committed entry and Continue reuses it")
        linkScene(f)
        redirectScene()
    }

    // --- the link / redirect scenes ------------------------------------------------------------

    private fun linkScene(f: Finger) {
        finding("  a. a link on the loopback page to http://$PAYPAL/")
        enter("$LOOPBACK:$PORT/link")
        waitForTitle("Demo site", 25_000)
        SystemClock.sleep(1_000)
        server.mark()
        watchChrome()
        val sampler = FrameSampler().also { it.start() }
        val tapped = tapPage(f, PAYPAL, 8_000)
        if (!tapped) {
            finding("  (no link node '$PAYPAL' in the page; clicking it from the document)")
            lastInputAt = System.currentTimeMillis()
            tabJs("document.getElementById('lk').click();'clicked'")
        }
        val tab = waitForUrl(ERROR_PREFIX, 25_000)
        SystemClock.sleep(1_500)
        sampler.stop()
        val url = tab.getJSONObject("tabs").getJSONObject(TAB).optString("url")
        finding("  ${describeTab(tab)}")
        expect("the question stands for the linked lookalike (target paypal.com)", url.startsWith(ERROR_PREFIX) && param(url, "target") == "paypal.com" && param(url, "url") == "http://$PAYPAL/", "4a-question")
        expect("the server served GET / for $PAYPAL – the navigation committed", server.hitsSinceMark(PAYPAL).any { it.path == "/" }, "4a-committed")
        report("link", PAYPAL, lastInputAt, sampler)
        still("link-replaced")
        beat()
        if (tapPage(f, "Details", 8_000)) SystemClock.sleep(1_000)

        // The phone's Back from the question that replaced the committed lookalike: the committed
        // entry sits behind the question in the WebView's list, and is the entry the question
        // stands in for (TabWebView.loadHtml marks it; goBack steps over it) – Back lands on the
        // page before the link, with no second document request and no second question.
        finding("  the WebView's list before Back: ${historyList()}")
        val requestsBeforeBack = server.hitsSinceMark(PAYPAL).count { it.path == "/" }
        watchChrome()
        pressPhoneBack()
        val after = waitForTitle("Demo site", 25_000)
        val afterUrl = after.getJSONObject("tabs").getJSONObject(TAB).optString("url")
        val requestsAfterBack = server.hitsSinceMark(PAYPAL).count { it.path == "/" }
        val reasked = chromeEvents().let { events ->
            (0 until events.length()).any { i -> events.getJSONObject(i).let { e -> e.optString("name") == "core.loadHtml" || e.optString("url").startsWith(ERROR_PREFIX) } }
        }
        finding("  the phone's Back from the link-path question: ${describeTab(after)}")
        finding("  chrome events: ${chromeTimeline()}")
        finding("  the WebView's list after Back: ${historyList()}")
        expect("Back landed on the page before the link, http://$LOOPBACK:$PORT/link (the committed lookalike entry was stepped over)", afterUrl == "http://$LOOPBACK:$PORT/link", "4a-back")
        expect("no second question after Back: no view.loadHtml of a lookalike page, no zen://error navigation; document requests for $PAYPAL since the mark $requestsBeforeBack before Back, $requestsAfterBack after", !reasked && requestsAfterBack == requestsBeforeBack, "4a-no-reask")
        still("link-back-to-previous")
        beat()

        // c. Continue from the link-path question: the load of the lookalike the question stands
        // in for goes back onto its committed entry (TabWebView.loadUrl, retriesFailedEntry), the
        // way Proceed past a certificate interstitial retries the failed entry, rather than
        // stacking a fourth entry behind the question; the allow lets it through onNavigated.
        finding("  c. CONTINUE from the link-path question goes back onto the committed lookalike entry")
        server.mark()
        if (!tapPage(f, PAYPAL, 8_000)) {
            finding("  (no link node '$PAYPAL' in the page; clicking it from the document)")
            lastInputAt = System.currentTimeMillis()
            tabJs("document.getElementById('lk').click();'clicked'")
        }
        val again = waitForUrl(ERROR_PREFIX, 25_000)
        val againUrl = again.getJSONObject("tabs").getJSONObject(TAB).optString("url")
        finding("  ${describeTab(again)}")
        expect("the question stands again for the linked lookalike", againUrl.startsWith(ERROR_PREFIX) && param(againUrl, "url") == "http://$PAYPAL/", "4c-question")
        val listBefore = historyEntries()
        finding("  the WebView's list before Continue: ${historyList(listBefore)}")
        watchChrome()
        pressInterstitial(f, "Continue to $PAYPAL", "proceed", "http://$PAYPAL/")
        val continued = waitForTitle(PAYPAL, 25_000)
        finding("  ${describeTab(continued)}")
        val h1 = tabJs("(document.querySelector('h1')||{}).textContent||''")
        finding("  h1: \"$h1\"; server hits for $PAYPAL since the mark: ${server.hitsSinceMark(PAYPAL).map { it.path }}")
        finding("  chrome events: ${chromeTimeline()}")
        val listAfter = historyEntries()
        finding("  the WebView's list after Continue: ${historyList(listAfter)}")
        expect("the site loaded (h1 \"$PAYPAL\")", h1 == PAYPAL && continued.getJSONObject("tabs").getJSONObject(TAB).optString("url") == "http://$PAYPAL/", "4c-h1")
        val permission = awaitPermission("https://$PAYPAL|lookalike", 8_000)
        finding("  permissions.json: ${permission ?: "(no lookalike decision for https://$PAYPAL within 8 s)"}")
        expect("permissions.json carries https://$PAYPAL|lookalike: allow", permission == "allow", "4c-permission")
        val linkIndex = listAfter.entries.indexOfLast { it == "http://$LOOPBACK:$PORT/link" }
        val current = listAfter.entries.getOrNull(listAfter.current)
        val behind = listAfter.entries.getOrNull(listAfter.current - 1)
        expect(
            "the committed lookalike entry was reused: the current entry is http://$PAYPAL/ right after the link page's (index ${listAfter.current}, the link page at $linkIndex), " +
                "with no zen://error entry behind it and the list no longer than before Continue (${listBefore.entries.size} → ${listAfter.entries.size})",
            current == "http://$PAYPAL/" && behind == "http://$LOOPBACK:$PORT/link" && listAfter.current == linkIndex + 1 && listAfter.entries.size <= listBefore.entries.size,
            "4c-entry"
        )
        still("link-continued-site-loads")
        beat()
    }

    private class HistoryEntries(val entries: List<String>, val current: Int, val backIndex: Int, val canGoBack: Boolean)

    /** The tab WebView's back-forward list (the entries' URLs), read on the main thread, with where its own Back would land. */
    private fun historyEntries(): HistoryEntries {
        val tab = tabView() ?: return HistoryEntries(emptyList(), -1, -1, false)
        var read = HistoryEntries(emptyList(), -1, -1, false)
        instrumentation.runOnMainSync {
            val list = tab.copyBackForwardList()
            read = HistoryEntries((0 until list.size).map { list.getItemAtIndex(it)?.url ?: "" }, list.currentIndex, tab.backIndex(list), tab.canGoBack())
        }
        return read
    }

    private fun historyList(read: HistoryEntries = historyEntries()): String =
        read.entries.mapIndexed { i, url -> (if (i == read.current) "*" else "") + url.take(70) }.joinToString(" | ") +
            " (current ${read.current}, back would land on ${read.backIndex}, canGoBack ${read.canGoBack})"

    private fun redirectScene() {
        finding("  b. a 302 from the loopback page to http://$AMAZON/")
        server.mark()
        watchChrome()
        val sampler = FrameSampler().also { it.start() }
        enter("$LOOPBACK:$PORT/redirect")
        val tab = waitForUrl(ERROR_PREFIX, 25_000)
        SystemClock.sleep(1_500)
        sampler.stop()
        val url = tab.getJSONObject("tabs").getJSONObject(TAB).optString("url")
        finding("  ${describeTab(tab)}")
        expect("the question stands for the redirect's lookalike (target amazon.com)", url.startsWith(ERROR_PREFIX) && param(url, "target") == "amazon.com" && param(url, "url") == "http://$AMAZON/", "4b-question")
        expect("the server answered /redirect and served GET / for $AMAZON – the redirect committed", server.hitsSinceMark(AMAZON).any { it.path == "/" }, "4b-committed")
        report("redirect", AMAZON, lastInputAt, sampler)
        still("redirect-replaced")
        beat()
    }

    /**
     * The gap's record for one scene, every instrument on the device's wall clock, relative to
     * the commit as the core received it (the `navigated` view event for the lookalike).
     */
    private fun report(kind: String, host: String, enteredAt: Long, sampler: FrameSampler) {
        val events = chromeEvents()
        val lookalike = "http://$host/"
        fun at(predicate: (JSONObject) -> Boolean): Long? =
            (0 until events.length()).map { events.getJSONObject(it) }.firstOrNull(predicate)?.optLong("t")
        val commit = at { it.optString("name") == "navigated" && it.optString("url") == lookalike }
        val decision = commit?.let { c -> at { it.optString("name") == "core.loadHtml" && it.optLong("t") >= c } }
        val questionStarted = commit?.let { c -> at { it.optString("name") == "startLoading" && it.optLong("t") >= c } }
        // The question's commit: the next navigated event for the zen://error page – or, should the
        // host's navigated carry another spelling of it, the next navigated to anything but the lookalike.
        val questionCommitted = commit?.let { c ->
            at { it.optString("name") == "navigated" && it.optString("url").startsWith(ERROR_PREFIX) && it.optLong("t") >= c }
                ?: at { it.optString("name") == "navigated" && it.optString("url") != lookalike && it.optLong("t") > c }
        }
        val questionLoaded = questionCommitted?.let { q -> at { it.optString("name") == "stopLoading" && it.optLong("t") >= q } }
        val request = server.hitsSinceMark(host).firstOrNull { it.path == "/" }?.at
        val beacons = server.beacons(host)
        fun rel(t: Long?): String = if (t == null || commit == null) "n/a" else "%+d ms".format(t - commit)
        finding("  $kind: commit of $lookalike (the core's navigated event) at wall clock $commit; everything below is relative to it")
        finding("    entered / tapped ${rel(enteredAt)}; server GET / for $host ${rel(request)}")
        finding("    core issued view.loadHtml for the question ${rel(decision)}; question page started ${rel(questionStarted)}, committed ${rel(questionCommitted)}, loaded ${rel(questionLoaded)}")
        val gapCommitted = if (commit != null && questionCommitted != null) questionCommitted - commit else null
        val gapLoaded = if (commit != null && questionLoaded != null) questionLoaded - commit else null
        finding("    GAP commit → question committed: ${gapCommitted?.let { "$it ms (${frames(it)} frames at 60 Hz)" } ?: "n/a"}; commit → question loaded: ${gapLoaded?.let { "$it ms (${frames(it)} frames at 60 Hz)" } ?: "n/a"}")
        val painted = sampler.framesWith(lookalike)
        finding("    WebView's word (paintedDocument, sampled per vsync): the lookalike's pixels were on screen for $painted frame(s); ${sampler.transitions.size} state change(s):")
        for (line in sampler.describe(commit)) finding("      $line")
        if (beacons.isEmpty()) finding("    page beacons from $lookalike: none arrived (its script never ran to a frame before the replacement)")
        else finding("    page beacons from $lookalike (page clock → server receipt): " + beacons.joinToString("; ") { "${it.kind} ${rel(it.pageAt)}" + (it.extra?.let { e -> " [$e]" } ?: "") + " → ${rel(it.at)}" })
        val fcp = beacons.firstOrNull { it.kind == "first-contentful-paint" || it.kind == "first-paint" }
        finding("    a frame of the lookalike painted: ${if (painted > 0 || fcp != null) "YES" else "no evidence"} (WebView commit-visible frames $painted; paint entry ${fcp?.kind ?: "none"})")
        expect("the gap was measured (commit and the question's commit both on record)", gapCommitted != null, "4-$kind-measured")
        finding("    events: ${(0 until events.length()).joinToString(" ") { i -> val e = events.getJSONObject(i); "${e.optString("name")}${e.optString("url").takeIf { it.isNotEmpty() }?.let { "(${it.take(60)})" } ?: ""}${rel(e.optLong("t"))}" }}")
    }

    private fun frames(ms: Long): String = "%.1f".format(ms / (1000.0 / 60))

    // --- the URL bar -----------------------------------------------------------------------------

    /**
     * Open the URL bar from the pill, type `text` and press Enter (the way [ErrorPagesDemo]
     * enters an address): a real typed navigation, the omnibox's own `tab.navigate`.
     */
    private fun enter(text: String) {
        ensureForeground()
        Finger().tap(pillCenterX, pillY)
        if (waitFor(CLEAR_LABEL, 6_000) == null && addressField() == null) finding("  (the URL bar did not open for '$text')")
        SystemClock.sleep(1_500)
        instrumentation.sendStringSync(text)
        SystemClock.sleep(900)
        val field = addressField()
        val typed = field?.text?.toString()
        if (field != null && typed != text) {
            finding("  (the URL bar reads '$typed' after typing '$text'; setting it)")
            val arguments = Bundle().apply { putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, text) }
            field.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, arguments)
            SystemClock.sleep(900)
        }
        lastInputAt = System.currentTimeMillis()
        instrumentation.sendKeyDownUpSync(KeyEvent.KEYCODE_ENTER)
        SystemClock.sleep(800)
    }

    /** The wall clock at the last Enter or page tap, for the scenes' relative timings. */
    private var lastInputAt = 0L

    /** The server saw `path` for `host` since its mark, within `timeoutMs`. */
    private fun awaitHit(host: String, path: String, timeoutMs: Long): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            if (server.hitsSinceMark(host).any { it.path == path }) return true
            SystemClock.sleep(200)
        }
        return false
    }

    private fun addressField(): AccessibilityNodeInfo? {
        val root = ui.rootInActiveWindow ?: return null
        val queue = ArrayDeque<AccessibilityNodeInfo>()
        queue.add(root)
        var visited = 0
        var editable: AccessibilityNodeInfo? = null
        while (queue.isNotEmpty() && visited < 6_000) {
            val node = queue.removeFirst()
            visited++
            if (node.isEditable) {
                if (node.isFocused) return node
                editable = editable ?: node
            }
            for (i in 0 until node.childCount) node.getChild(i)?.let(queue::add)
        }
        return editable
    }

    // --- the page's controls ---------------------------------------------------------------------

    /** The page WebView's place on screen (the bar's own Back button is outside it). */
    private fun pageRect(): Rect? {
        val tab = tabView() ?: return null
        var rect: Rect? = null
        instrumentation.runOnMainSync {
            val at = IntArray(2).also { tab.getLocationOnScreen(it) }
            rect = Rect(at[0], at[1], at[0] + tab.width, at[1] + tab.height)
        }
        return rect
    }

    /** Whether `node` sits inside the page WebView (not the chrome's bar, which carries a Back of its own). */
    private fun inPage(node: AccessibilityNodeInfo, page: Rect? = pageRect()): Boolean {
        val bounds = Rect().also { node.getBoundsInScreen(it) }
        return page == null || (bounds.centerX() in page.left..page.right && bounds.centerY() in page.top..page.bottom)
    }

    /** The phone's Back key (the system's back action; [DemoHarness.back]), timestamped for the scenes' timings. */
    private fun pressPhoneBack() {
        lastInputAt = System.currentTimeMillis()
        back()
        SystemClock.sleep(600)
    }

    /** Tap the node labelled `label` inside the page, with a real finger; false when none showed in time. */
    private fun tapPage(f: Finger, label: String, timeoutMs: Long): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            val page = pageRect()
            val node = findNodes(label).firstOrNull { node -> inPage(node, page) }
            if (node != null) {
                val bounds = Rect().also { node.getBoundsInScreen(it) }
                lastInputAt = System.currentTimeMillis()
                f.tap(bounds.exactCenterX(), bounds.exactCenterY())
                return true
            }
            SystemClock.sleep(250)
        }
        return false
    }

    /**
     * As [SafeBrowsingDemo.pressInterstitial]: a real touch, the tree's click, then the page's
     * own message. The tree's click is skipped for "Back", which the chrome's bar also carries.
     */
    private fun pressInterstitial(f: Finger, label: String, action: String, url: String) {
        val warning = coreState().getJSONObject("tabs").optJSONObject(TAB)?.optString("url") ?: ""
        val tapped = tapPage(f, label, 8_000)
        if (!tapped) finding("  (no node labelled '$label' in the page; clicking through the tree)")
        if (!tapped && (label == "Back" || !clickByLabel(label))) {
            finding("  (no clickable '$label'; posting the page's message)")
            postInterstitial(action, url)
            return
        }
        val deadline = SystemClock.uptimeMillis() + 8_000
        while (SystemClock.uptimeMillis() < deadline) {
            val current = coreState().getJSONObject("tabs").optJSONObject(TAB)?.optString("url") ?: ""
            if (current != warning) return
            SystemClock.sleep(300)
        }
        finding("  (the tab stayed on the question after '$label'; posting the page's message)")
        postInterstitial(action, url)
    }

    private fun postInterstitial(action: String, url: String) {
        tabJs("window.postMessage({zeniumInterstitial:{action:${JSONObject.quote(action)},url:${JSONObject.quote(url)}}},'*');'posted'")
    }

    // --- the colour scheme -------------------------------------------------------------------------

    /** Switch the chrome's colour scheme through the core and wait for the root to carry it ([FocusRingDemo]'s switch). */
    private fun theme(scheme: String): Boolean {
        if (themeAttribute() == scheme) return true
        coreInvoke("settings.update", JSONObject().put("colorScheme", scheme).toString())
        val deadline = SystemClock.uptimeMillis() + 6_000
        var took = false
        while (SystemClock.uptimeMillis() < deadline && !took) {
            took = themeAttribute() == scheme
            if (!took) SystemClock.sleep(200)
        }
        SystemClock.sleep(900)
        if (!took) finding("  (the scheme did not flip to $scheme: theme attribute '${themeAttribute()}')")
        return took
    }

    private fun themeAttribute(): String = chromeValue("document.documentElement.getAttribute('data-theme')||''")

    // --- the instruments -------------------------------------------------------------------------

    /**
     * Timestamp the view events as the core receives them, and the bridge's `view.loadHtml` for
     * a lookalike question, into `window.__lkEvents` (wall clock `t`, `performance.now()` `p`).
     * Each call clears the record.
     */
    private fun watchChrome() {
        val result = chromeJs(
            "(function(){window.__lkEvents=[];" +
                "var push=function(name,url,tab){window.__lkEvents.push({t:Date.now(),p:performance.now(),name:name,url:url||'',tab:tab||''})};" +
                "if(!window.__lkHooked){var h=window.__zenHost;if(!h||typeof h.viewEvent!=='function')return 'no host';" +
                "var orig=h.viewEvent;h.viewEvent=function(tabId,name,json){var url='';" +
                "try{var p=JSON.parse(json);url=(p&&p.url)||''}catch(e){}push(name,url,tabId);return orig.apply(this,arguments)};" +
                "var pm=MessagePort.prototype.postMessage;MessagePort.prototype.postMessage=function(m){" +
                "try{if(typeof m==='string'&&m.indexOf('\"view.loadHtml\"')>=0&&m.indexOf('lookalike')>=0){var u='';" +
                "try{var e=JSON.parse(m);u=(e&&e.args&&e.args.url)||''}catch(x){}push('core.loadHtml',u)}}catch(e){}" +
                "return pm.apply(this,arguments)};window.__lkHooked=true}" +
                "return window.__zenHost.viewEvent.length!==undefined?'hooked':'hooked?'})()"
        )
        if (!result.contains("hooked")) finding("  (the chrome hook did not install: $result)")
    }

    private fun chromeEvents(): JSONArray =
        runCatching { JSONArray(chromeValue("JSON.stringify(window.__lkEvents||[])")) }.getOrDefault(JSONArray())

    /** The view events since [watchChrome], relative to the first, one line. */
    private fun chromeTimeline(): String {
        val events = chromeEvents()
        if (events.length() == 0) return "(none)"
        val first = events.getJSONObject(0).optLong("t")
        return (0 until events.length()).joinToString(" ") { i ->
            val e = events.getJSONObject(i)
            val url = e.optString("url").takeIf { it.isNotEmpty() }?.let { "(${it.take(60)})" } ?: ""
            "${e.optString("name")}$url+${e.optLong("t") - first}"
        }
    }

    /**
     * WebView's own word on the page's pixels, once per vsync: `TabWebView.currentDocument`
     * (`onPageStarted`), `paintedDocument` (`onPageCommitVisible` / `onPageFinished`) and the
     * WebView's URL, read on the main thread inside a Choreographer frame callback – so every
     * sample is ordered with the WebView's callbacks – and kept as transitions with the frame
     * index they came at.
     */
    private inner class FrameSampler : Choreographer.FrameCallback {
        private val tab = tabView()
        private val fields = listOf("currentDocument", "paintedDocument", "loading").associateWith { name ->
            runCatching { TabWebView::class.java.getDeclaredField(name).apply { isAccessible = true } }.getOrNull()
        }
        val transitions = ArrayList<Transition>()
        private var frame = 0
        private var last: String? = null
        @Volatile private var running = false

        fun start() {
            running = true
            instrumentation.runOnMainSync { Choreographer.getInstance().postFrameCallback(this) }
        }

        fun stop() {
            running = false
        }

        override fun doFrame(frameTimeNanos: Long) {
            if (!running) return
            frame++
            val painted = read("paintedDocument")
            val key = "started=${read("currentDocument")} painted=$painted loading=${read("loading")} webview=${tab?.url}"
            if (key != last) {
                transitions += Transition(System.currentTimeMillis(), frame, painted, key)
                last = key
            }
            Choreographer.getInstance().postFrameCallback(this)
        }

        private fun read(name: String): String {
            val target = tab ?: return "(no tab)"
            val field = fields[name] ?: return "(no field $name)"
            return runCatching { field.get(target)?.toString() ?: "null" }.getOrElse { "?" }
        }

        /** How many sampled frames found `url` as the painted document. */
        fun framesWith(url: String): Int {
            var count = 0
            for ((i, t) in transitions.withIndex()) {
                if (t.painted != url) continue
                val end = transitions.getOrNull(i + 1)?.frame ?: frame
                count += end - t.frame
            }
            return count
        }

        fun describe(commit: Long?): List<String> = transitions.map { t ->
            val rel = if (commit == null) "t=${t.at}" else "%+d ms".format(t.at - commit)
            "frame ${t.frame} $rel: ${t.state}"
        }
    }

    private class Transition(val at: Long, val frame: Int, val painted: String, val state: String)

    private fun tabView(): TabWebView? = (activity as? MainActivity)?.host?.tabs?.get(TAB)

    // --- the core, the page, the profile -------------------------------------------------------------

    private fun webViewVersion(): String =
        runCatching { WebViewCompat.getCurrentWebViewPackage(app)?.let { "${it.packageName} ${it.versionName}" } }.getOrNull() ?: "(unknown)"

    /**
     * Route the app's `http://` traffic to the loopback server as a proxy (the header's host
     * mapping): `https://` stays direct, the loopback address itself is bypassed. Waits for the
     * WebView to say the override is in force before any page is loaded under it.
     */
    private fun installProxy(): String {
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.PROXY_OVERRIDE)) return "not available: this WebView lacks PROXY_OVERRIDE"
        val config = ProxyConfig.Builder()
            .addProxyRule("$LOOPBACK:$PORT", ProxyConfig.MATCH_HTTP)
            .addBypassRule(LOOPBACK)
            .build()
        val applied = CountDownLatch(1)
        instrumentation.runOnMainSync {
            ProxyController.getInstance().setProxyOverride(config, { it.run() }, { applied.countDown() })
        }
        return if (applied.await(10, TimeUnit.SECONDS)) "http:// → $LOOPBACK:$PORT (https:// direct, $LOOPBACK bypassed); in force"
        else "http:// → $LOOPBACK:$PORT asked for, but the WebView did not confirm it within 10 s"
    }

    private fun clearProxy() {
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.PROXY_OVERRIDE)) return
        val cleared = CountDownLatch(1)
        runCatching {
            instrumentation.runOnMainSync {
                ProxyController.getInstance().clearProxyOverride({ it.run() }, { cleared.countDown() })
            }
            cleared.await(5, TimeUnit.SECONDS)
        }
    }

    /** The tables' one log line, off the chrome's console in logcat (`ZenChrome`, the chrome's `console.info`). */
    private fun awaitTablesLine(timeoutMs: Long): String? {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            val line = shellCommand("logcat -d -s ZenChrome:D").lines().lastOrNull { it.contains("lookalikes: tables loaded") }
            // `threadtime` spells the tag `D ZenChrome: …`, `brief` spells it `D/ZenChrome( pid): …`.
            if (line != null) return line.substringAfter("ZenChrome").replaceFirst(Regex("^\\(\\s*\\d+\\)"), "").trimStart(':', ' ')
            SystemClock.sleep(1_000)
        }
        return null
    }

    /** A fetch of `http://gogle.com/probe` from the loopback page: seen by the server when the proxy override is in force. */
    private fun mappingProbe(): String {
        val before = server.hits(GOGLE).size
        tabJs("window.__probe='';fetch('http://$GOGLE/probe',{mode:'no-cors',cache:'no-store'}).then(function(r){window.__probe='ok:'+r.type},function(e){window.__probe='err:'+e});'started'")
        val deadline = SystemClock.uptimeMillis() + 10_000
        var answer = ""
        while (SystemClock.uptimeMillis() < deadline) {
            answer = tabJs("window.__probe||''")
            if (answer.isNotEmpty() && answer != "(no answer)") break
            SystemClock.sleep(200)
        }
        val seen = server.hits(GOGLE).drop(before)
        return if (seen.any { it.path == "/probe" }) "ok – the server saw GET /probe with Host $GOGLE (fetch said '$answer')"
        else "not mapped – the server saw ${seen.size} request(s) for $GOGLE, fetch said '${answer.ifEmpty { "(nothing)" }}'"
    }

    /** The decision `permissions.json` holds under `key`, once the store's debounce has written it. */
    private fun awaitPermission(key: String, timeoutMs: Long): String? {
        val file = File(app.filesDir, "zen/permissions.json")
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            val decision = runCatching { JSONObject(file.readText()).optJSONObject("decisions")?.optString(key, "") }.getOrNull()
            if (!decision.isNullOrEmpty()) return decision
            SystemClock.sleep(500)
        }
        return null
    }

    private fun param(url: String, name: String): String? =
        runCatching {
            url.substringAfter('?', "").split('&').map { it.split('=', limit = 2) }
                .firstOrNull { URLDecoder.decode(it[0], "UTF-8") == name }?.getOrNull(1)?.let { URLDecoder.decode(it, "UTF-8") }
        }.getOrNull()

    private fun pageTitle(): String = tabJs("document.title")

    /** Evaluate in the tab's WebView (the page, not the chrome); the value as text. */
    private fun tabJs(code: String): String {
        val tab = tabView() ?: return "(no WebView for $TAB)"
        var result = "(no answer)"
        val latch = CountDownLatch(1)
        instrumentation.runOnMainSync {
            tab.evaluateJavascript(code) { value ->
                result = value ?: "(null)"
                latch.countDown()
            }
        }
        latch.await(5, TimeUnit.SECONDS)
        return runCatching { (JSONTokener(result).nextValue() as? String) ?: result }.getOrDefault(result)
    }

    private fun chromeValue(code: String): String =
        runCatching { JSONTokener(chromeJs(code)).nextValue() }.getOrNull()?.takeIf { it != JSONObject.NULL }?.toString() ?: ""

    private fun describeTab(s: JSONObject): String {
        val tab = s.getJSONObject("tabs").optJSONObject(TAB) ?: return "tab $TAB gone"
        return "tab url=${tab.optString("url")} title=\"${tab.optString("title")}\" errorCode=${tab.opt("errorCode")} loading=${tab.optBoolean("loading")}"
    }

    private fun waitForTitle(prefix: String, timeoutMs: Long): JSONObject {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        var s = coreState()
        while (SystemClock.uptimeMillis() < deadline) {
            val tab = s.getJSONObject("tabs").optJSONObject(TAB)
            if (tab != null && tab.optString("title").startsWith(prefix) && !tab.optBoolean("loading")) {
                SystemClock.sleep(1_000)
                return coreState()
            }
            SystemClock.sleep(400)
            s = coreState()
        }
        finding("  (title '$prefix' never showed up; ${describeTab(s)})")
        return s
    }

    private fun waitForUrl(prefix: String, timeoutMs: Long): JSONObject {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        var s = coreState()
        while (SystemClock.uptimeMillis() < deadline) {
            val tab = s.getJSONObject("tabs").optJSONObject(TAB)
            if (tab != null && tab.optString("url").startsWith(prefix) && !tab.optBoolean("loading")) {
                SystemClock.sleep(1_000)
                return coreState()
            }
            SystemClock.sleep(400)
            s = coreState()
        }
        finding("  (url '$prefix' never showed up; ${describeTab(s)})")
        return s
    }

    // --- findings ----------------------------------------------------------------------------------

    private fun still(name: String) {
        shotIndex++
        shot("%02d-%s".format(shotIndex, name))
    }

    private fun expect(claim: String, held: Boolean, id: String) {
        finding("  $claim: ${if (held) "PASS" else "FAIL"}")
        if (!held) failures += "$id: $claim"
    }

    private fun finding(line: String) {
        Log.i(tag, line.trim())
        findings.appendText(line + "\n")
    }

    override fun noteLine(line: String) {
        Log.i(tag, line.trim())
        if (this::findings.isInitialized) findings.appendText("  $line\n")
    }

    // --- the sites' server -------------------------------------------------------------------------

    /**
     * Serves every site of the scene by `Host`: `/` the site's page (its h1 is the host; the
     * page beacons its first two animation frames and its `paint` entries to `/beacon`), `/link`
     * a page with a link to `http://paypa1.com/`, `/redirect` a 302 to `http://amazom.com/`,
     * `/probe` and `/beacon` empty answers. Every request is on record with its receipt time.
     */
    internal class LookalikeDemoServer(private val port: Int) : Thread("lookalike-demo-server") {
        class Hit(val host: String, val path: String, val query: String, val at: Long)
        class Beacon(val host: String, val kind: String, val pageAt: Long?, val extra: String?, val at: Long)

        private val socket = ServerSocket(port, 16)
        private val log = ArrayList<Hit>()
        private val beaconLog = ArrayList<Beacon>()
        private var marked = 0
        @Volatile private var closed = false

        fun selfCheck(): String = runCatching {
            Socket("127.0.0.1", port).use { s ->
                s.soTimeout = 5_000
                s.getOutputStream().write("GET / HTTP/1.1\r\nHost: 127.0.0.1:$port\r\n\r\n".toByteArray())
                s.getOutputStream().flush()
                val status = s.getInputStream().bufferedReader().readLine()
                "listening on ${socket.localSocketAddress}, GET / -> $status"
            }
        }.getOrElse { e -> "listening on ${socket.localSocketAddress}, GET / failed: $e" }

        @Synchronized fun hits(host: String): List<Hit> = log.filter { it.host.substringBefore(':') == host }
        @Synchronized fun mark() { marked = log.size }
        @Synchronized fun hitsSinceMark(host: String): List<Hit> = log.drop(marked).filter { it.host.substringBefore(':') == host }
        @Synchronized fun beacons(host: String): List<Beacon> = beaconLog.filter { it.host == host }.sortedBy { it.at }
        @Synchronized private fun record(hit: Hit) { log += hit }
        @Synchronized private fun record(beacon: Beacon) { beaconLog += beacon }

        override fun run() {
            while (!closed) {
                val client = try {
                    socket.accept()
                } catch (_: Exception) {
                    if (closed) return else continue
                }
                Thread { runCatching { serve(client) } }.start()
            }
        }

        private fun serve(client: Socket) {
            client.use {
                it.soTimeout = 10_000
                val input = BufferedInputStream(it.getInputStream())
                input.mark(1)
                val first = input.read()
                if (first == -1) return
                input.reset()
                val out = it.getOutputStream()
                if (first == TLS_HANDSHAKE) {
                    out.write("HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".toByteArray())
                    out.flush()
                    return
                }
                val requestLine = readLine(input) ?: return
                val headers = HashMap<String, String>()
                while (true) {
                    val line = readLine(input)
                    if (line.isNullOrEmpty()) break
                    val colon = line.indexOf(':')
                    if (colon > 0) headers[line.substring(0, colon).trim().lowercase()] = line.substring(colon + 1).trim()
                }
                // A proxy request names the whole URL (`GET http://gogle.com/ HTTP/1.1`); the path is what matters.
                val target = (requestLine.split(' ').getOrNull(1) ?: "/").let { raw ->
                    if (!raw.startsWith("http://") && !raw.startsWith("https://")) raw
                    else raw.substringAfter("://").let { rest -> rest.indexOf('/').let { i -> if (i >= 0) rest.substring(i) else "/" } }
                }
                val path = target.substringBefore('?')
                val query = target.substringAfter('?', "")
                val host = headers["host"] ?: "127.0.0.1:$port"
                val site = host.substringBefore(':')
                val now = System.currentTimeMillis()
                record(Hit(host, path, query, now))
                when (path) {
                    "/beacon" -> {
                        val q = query.split('&').mapNotNull { p -> p.split('=', limit = 2).takeIf { it.size == 2 }?.let { it[0] to URLDecoder.decode(it[1], "UTF-8") } }.toMap()
                        record(Beacon(q["host"] ?: site, q["kind"] ?: "?", q["t"]?.toLongOrNull(), q["extra"], now))
                        empty(out, "204 No Content")
                    }
                    "/probe" -> empty(out, "204 No Content")
                    "/redirect" -> {
                        out.write("HTTP/1.1 302 Found\r\nLocation: http://$AMAZON/\r\nContent-Length: 0\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n".toByteArray())
                        out.flush()
                    }
                    "/link" -> html(out, page("Demo site", "<h1>Demo site</h1><p>A page of the loopback site with a link to a lookalike.</p>" +
                        "<p><a id=\"lk\" href=\"http://$PAYPAL/\" style=\"display:block;padding:18px;font-size:22px;background:#eef;border-radius:8px;text-align:center\">$PAYPAL</a></p>"))
                    "/favicon.ico" -> empty(out, "404 Not Found")
                    else -> {
                        // The loopback root is the seeded tab's "Demo site"; every mapped host is its own name.
                        val name = if (site == LOOPBACK) "Demo site" else site
                        html(out, page(name, "<h1>${esc(name)}</h1><p>A page of the demo site, served by the loopback server as <code>${esc(host)}</code>.</p>$BEACONS"))
                    }
                }
            }
        }

        private fun empty(out: java.io.OutputStream, status: String) {
            out.write("HTTP/1.1 $status\r\nContent-Length: 0\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n".toByteArray())
            out.flush()
        }

        private fun html(out: java.io.OutputStream, body: String) {
            val bytes = body.toByteArray()
            out.write(("HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: ${bytes.size}\r\n" +
                "Cache-Control: no-store\r\nConnection: close\r\n\r\n").toByteArray())
            out.write(bytes)
            out.flush()
        }

        private fun readLine(input: BufferedInputStream): String? {
            val buffer = ByteArrayOutputStream()
            while (true) {
                val b = input.read()
                if (b == -1) return if (buffer.size() == 0) null else buffer.toString("ISO-8859-1")
                if (b == '\n'.code) break
                if (b != '\r'.code) buffer.write(b)
                if (buffer.size() > 8_192) break
            }
            return buffer.toString("ISO-8859-1")
        }

        private fun esc(s: String): String =
            s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace("\"", "&quot;")

        private fun page(title: String, body: String): String =
            "<!doctype html><html><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">" +
                "<title>${esc(title)}</title><style>$STYLE</style></head><body>$body</body></html>"

        fun close() {
            closed = true
            runCatching { socket.close() }
        }

        companion object {
            private const val TLS_HANDSHAKE = 0x16
            private const val STYLE =
                "body{font:16px/1.5 system-ui,sans-serif;margin:0;padding:20px 16px;background:#fff;color:#1f1f1f}" +
                    "h1{font-size:22px;margin:0 0 12px}code{background:#f1f1f1;padding:1px 6px;border-radius:3px}a{color:#1a5fb4}"
            /**
             * The served lookalike page's beacons: its script's start, its first and second
             * animation frame, its `paint` performance entries and its load event, each with the
             * page's wall clock (`t`) – `sendBeacon` survives the document's replacement.
             */
            private const val BEACONS =
                "<script>(function(){var h=location.hostname;function b(k,x){try{navigator.sendBeacon('/beacon?host='+h+'&kind='+k+'&t='+Date.now()+(x?'&extra='+encodeURIComponent(x):''))}catch(e){}}" +
                    "b('script');requestAnimationFrame(function(){b('raf1');requestAnimationFrame(function(){b('raf2')})});" +
                    "try{new PerformanceObserver(function(l){l.getEntries().forEach(function(e){b(e.name,'start '+e.startTime.toFixed(1)+' ms after the page\\'s time origin')})}).observe({type:'paint',buffered:true})}catch(e){}" +
                    "addEventListener('load',function(){b('load')})})()</script>"
        }
    }

    companion object {
        private const val PORT = 18124
        private const val TAB = "tab_demo"
        private const val LOOPBACK = "127.0.0.1"
        /** The sites, each a lookalike of a top domain to the engine (`gogle.com` → google.com by edit distance, `paypa1.com` → paypal.com by skeleton, `amazom.com` → amazon.com by edit distance). */
        private const val GOGLE = "gogle.com"
        private const val PAYPAL = "paypa1.com"
        private const val AMAZON = "amazom.com"
        private const val ERROR_PREFIX = "zen://error"
        private const val CLEAR_LABEL = "Clear"
        private const val FINDINGS_FILE = "services-pass-8-android-lookalike-findings.txt"
    }
}
