package app.zen.chromium

import android.os.SystemClock
import android.util.Base64
import android.util.Log
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.zen.chromium.blocking.Blocking
import app.zen.chromium.blocking.Decision
import app.zen.chromium.blocking.Request
import app.zen.chromium.blocking.ResourceType
import app.zen.chromium.privacy.Privacy
import org.json.JSONObject
import org.json.JSONTokener
import org.junit.Test
import org.junit.runner.RunWith
import java.io.BufferedInputStream
import java.io.ByteArrayOutputStream
import java.io.File
import java.net.ServerSocket
import java.net.Socket
import java.security.MessageDigest
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * Records the privacy engine on the phone: HTTPS-only mode's warning page when the upgrade of a
 * plaintext site fails (continue for the session, always allow, off), Safe Browsing's warning
 * page for a listed host (details, back to safety, proceed anyway), third-party cookies blocked
 * and allowed by the exception list and blocked in a private tab, and the GPC / DNT signals on
 * the request and on `navigator`. Secure DNS has no scene: Android resolves through the system.
 *
 * The pages come from a loopback HTTP server inside this process, answering as several sites:
 * every `127.0.0.x` address is its own site to the WebView, so the demo needs no DNS. The
 * server answers a TLS handshake with plain HTTP, which is how the upgrade of a plaintext site
 * fails here. Safe Browsing's hit on `127.0.0.5` comes from a feed document seeded next to the
 * bundled ones (the Kotlin guard loads every document under `safebrowsing/`; the core ignores
 * ids it does not know), `malware.zenium.test` from the reserved test hosts. Notes go to
 * `<shotPrefix>-notes.txt` next to the screenshots. See [DemoHarness] for the plumbing.
 */
@RunWith(AndroidJUnit4::class)
class SafeBrowsingDemo : DemoHarness("safebrowsing-demo-state.json", "services-safebrowsing-android", "safebrowsing-demo") {
    override val tag = "SafeBrowsingDemo"
    private lateinit var server: PrivacyDemoServer
    private lateinit var notes: File

    @Test
    fun record() {
        server = PrivacyDemoServer(PORT).also { it.start() }
        try {
            runDemo()
        } finally {
            server.close()
        }
    }

    override fun seedMore(zen: File) {
        val dir = File(zen, "safebrowsing").apply { mkdirs() }
        File(dir, "demo-phishing.json").writeText(feedDocument("demo-phishing", "phishing", listOf(PHISHING_HOST)))
    }

    override fun warmUp() {
        notes = File(out, "services-safebrowsing-android-notes.txt")
        notes.writeText("Zenium Android privacy demo (Safe Browsing, HTTPS-only, cookies, GPC / DNT)\n\n")
        note("demo server: ${server.selfCheck()}")
        val privacy = Privacy.shared(app)
        val blocking = Blocking.shared(app)

        // The core seeds the bundled feeds after boot and the Kotlin guard follows the files;
        // the engine rebuilds its snapshot from the rule index the core writes. Wait for both.
        val deadline = SystemClock.uptimeMillis() + 120_000
        var lastReport = 0L
        while (SystemClock.uptimeMillis() < deadline) {
            val status = runCatching { state().getJSONObject("privacy").getJSONObject("safeBrowsing") }.getOrNull()
            val coreReady = status?.optBoolean("ready") == true && status.optInt("entries") > 0
            val guardReady = privacy.safeBrowsing.tables.lookup(PHISHING_HOST) != null
            val upgrade = upgradeDecision("http://$DEMO_HOST:$PORT/")
            val engineReady = upgrade.action == Decision.Action.UPGRADE && upgrade.matchedSet == Blocking.HTTPS_ONLY_SET
            if (coreReady && guardReady && engineReady) break
            if (SystemClock.uptimeMillis() - lastReport > 10_000) {
                lastReport = SystemClock.uptimeMillis()
                note(
                    "waiting: core ready=${status?.optBoolean("ready")} entries=${status?.optInt("entries")} | " +
                        "guard tables=${privacy.safeBrowsing.tables.entries} feeds=${privacy.safeBrowsing.tables.feeds.size} " +
                        "demo hit=$guardReady | engine ${upgrade.action}/${upgrade.matchedSet} sets=${blocking.snapshot.setCount}"
                )
            }
            SystemClock.sleep(1_000)
        }
        val status = state().getJSONObject("privacy")
        note("core: safeBrowsing=${describeSafeBrowsing(status.getJSONObject("safeBrowsing"))}")
        note("core: secureDns=${status.getJSONObject("secureDns")} (Android has no host resolver of its own)")
        note("guard: ${privacy.safeBrowsing.tables.entries} prefixes from ${privacy.safeBrowsing.tables.feeds.size} feeds " +
            "[${privacy.safeBrowsing.tables.feeds.joinToString(", ") { "${it.id}(${it.threat}, ${it.table.size})" }}] " +
            "in ${privacy.safeBrowsing.lastLoadMs} ms")
        note("guard: flags=${privacy.flags.toJson()} signalHeadersByProfile=${privacy.headersSupported}")
        val upgrade = upgradeDecision("http://$DEMO_HOST:$PORT/")
        note("engine: http://$DEMO_HOST:$PORT/ -> ${upgrade.action} by ${upgrade.matchedSet} to ${upgrade.redirectUrl}; " +
            "${blocking.snapshot.setCount} sets, ${blocking.snapshot.filterCount} filters")
        note("settings.privacy=${state().getJSONObject("settings").getJSONObject("privacy")}")
        // The seeded tab is on the exempt loopback name: it loads over http without a question.
        invoke("tab.reload", """{"tabId":"tab_demo","skipCache":true}""")
        waitForTitle("Demo site", 20_000)
        Log.i(tag, "warm-up done")
    }

    override fun demo() {
        val f = Finger()

        // 1. HTTPS-only mode (ask, the default): the upgrade of a plaintext-only site fails and
        //    Zenium asks before loading it over http.
        note("\n1. HTTPS-only mode (ask): a site https cannot reach")
        navigate("http://$DEMO_HOST:$PORT/")
        var tab = waitForUrl("zen://error", 25_000)
        note("  ${describeTab(tab)}")
        shot("01-https-only-warning")
        beat()

        // 1b. Back to safety: the page before the failed upgrade (WebView's own entry for the
        //     failed https load sits in between and is stepped over).
        note("\n1b. Back to safety from the warning")
        pressInterstitial(f, "Back to safety", "back", "http://$DEMO_HOST:$PORT/")
        tab = waitForTitle("Demo site", 25_000)
        note("  ${describeTab(tab)}")
        shot("01b-https-only-back-to-safety")
        beat()

        // 2. The warning again, then continue to the HTTP site: allowed for this session, the
        //    page loads over http.
        note("\n2. Continue to HTTP site")
        navigate("http://$DEMO_HOST:$PORT/")
        tab = waitForUrl("zen://error", 25_000)
        note("  ${describeTab(tab)}")
        pressInterstitial(f, "Continue to HTTP site", "continue", "http://$DEMO_HOST:$PORT/")
        tab = waitForTitle("Demo site", 25_000)
        note("  ${describeTab(tab)}")
        note("  ${describeHttpsOnly()}")
        shot("02-https-only-continued")
        beat()

        // 3. The same site again: no question for the rest of the session.
        note("\n3. the same site, another page: no question")
        navigate("http://$DEMO_HOST:$PORT/headers")
        tab = waitForTitle("Request headers", 25_000)
        note("  ${describeTab(tab)}")
        note("  page: ${pageText().replace('\n', '|')}")
        beat()

        // 4. Always: another plaintext site, allowed for good from the warning page.
        note("\n4. HTTPS-only mode (always): allow a site for good")
        setPrivacy("""{"httpsOnly":"always"}""")
        navigate("http://$LEGACY_HOST:$PORT/")
        tab = waitForUrl("zen://error", 25_000)
        note("  ${describeTab(tab)}")
        shot("03-https-only-always-warning")
        pressInterstitial(f, "Always allow for this site", "continue-always", "http://$LEGACY_HOST:$PORT/")
        tab = waitForTitle("Demo site", 25_000)
        note("  ${describeTab(tab)}")
        note("  ${describeHttpsOnly()}")
        shot("04-https-only-always-allowed")
        beat()

        // 5. Off: plaintext loads as it is.
        note("\n5. HTTPS-only mode off")
        setPrivacy("""{"httpsOnly":"off"}""")
        navigate("http://$PLAIN_HOST:$PORT/")
        tab = waitForTitle("Demo site", 25_000)
        note("  ${describeTab(tab)}")
        shot("05-https-only-off")
        beat()

        // 6. Safe Browsing: a reserved test host the guard always stops.
        note("\n6. Safe Browsing: malware.zenium.test (reserved test host)")
        navigate("http://malware.zenium.test/")
        tab = waitForUrl("zen://error", 25_000)
        note("  ${describeTab(tab)}")
        shot("06-safebrowsing-malware-warning")
        beat()
        if (tapLabel(f, "Details", 6_000)) SystemClock.sleep(1_500) else note("  (no Details node)")
        shot("07-safebrowsing-details")
        beat()

        // 7. Back to safety: the page before.
        note("\n7. Back to safety")
        pressInterstitial(f, "Back to safety", "back", "http://malware.zenium.test/")
        tab = waitForTitle("Demo site", 25_000)
        note("  ${describeTab(tab)}")
        shot("08-safebrowsing-back-to-safety")
        beat()

        // 8. A host of the seeded phishing feed: warning, details, proceed anyway.
        note("\n8. Safe Browsing: a host of the demo's phishing feed, proceed anyway")
        navigate("http://$PHISHING_HOST:$PORT/")
        tab = waitForUrl("zen://error", 25_000)
        note("  ${describeTab(tab)}")
        shot("09-safebrowsing-phishing-warning")
        beat()
        if (tapLabel(f, "Details", 6_000)) SystemClock.sleep(1_500) else note("  (no Details node)")
        pressInterstitial(f, "Proceed anyway (unsafe)", "proceed", "http://$PHISHING_HOST:$PORT/")
        tab = waitForTitle("Demo site", 25_000)
        note("  ${describeTab(tab)}")
        note("  guard flags after the bypass: ${Privacy.shared(app).flags.toJson()}")
        note("  guard unsafe(http://$PHISHING_HOST:$PORT/) = ${Privacy.shared(app).unsafe("http://$PHISHING_HOST:$PORT/")?.toJson()}")
        shot("10-safebrowsing-proceeded")
        beat()

        // 9. Third-party cookies: block in private (the default) leaves a normal tab's frame its cookie.
        note("\n9. third-party cookies: block-private (default), normal tab")
        navigate("http://$DEMO_HOST:$PORT/cookies")
        tab = waitForTitle("Cookies", 25_000)
        note("  ${describeTab(tab)}")
        note("  frame: ${frameReport()}")
        shot("11-cookies-allowed-normal-tab")
        beat()

        // 10. Block all: the frame's cookie is neither sent nor readable.
        note("\n10. third-party cookies: block")
        setPrivacy("""{"thirdPartyCookies":"block"}""")
        navigate("http://$DEMO_HOST:$PORT/cookies?block")
        tab = waitForTitle("Cookies", 25_000)
        note("  ${describeTab(tab)}")
        note("  frame: ${frameReport()}")
        shot("12-cookies-blocked")
        beat()

        // 11. The exception list names the site the user is on: its embedded sites get their cookies.
        note("\n11. third-party cookies: block, with $DEMO_HOST on the exception list")
        setPrivacy("""{"thirdPartyCookies":"block","thirdPartyCookieExceptions":["$DEMO_HOST"]}""")
        navigate("http://$DEMO_HOST:$PORT/cookies?exception")
        tab = waitForTitle("Cookies", 25_000)
        note("  ${describeTab(tab)}")
        note("  frame: ${frameReport()}")
        shot("13-cookies-exception")
        beat()

        // 12. Back to the default and a private tab: blocked there, by default.
        note("\n12. third-party cookies: block-private, private tab")
        setPrivacy("""{"thirdPartyCookies":"block-private","thirdPartyCookieExceptions":[]}""")
        val privateId = runCatching {
            invoke("tab.create", """{"url":"http://$DEMO_HOST:$PORT/cookies?private","active":true,"containerId":"$PRIVATE_CONTAINER"}""").trim('"')
        }.getOrElse { e ->
            note("  tab.create failed: ${e.message}")
            null
        }
        if (privateId != null) {
            tab = waitForTitle("Cookies", 30_000, privateId)
            note("  ${describeTab(tab, privateId)}")
            note("  frame: ${frameReport(privateId)}")
            shot("14-cookies-private-tab")
            beat()
            runCatching { invoke("tab.close", """{"tabId":"$privateId"}""") }
            runCatching { invoke("tab.activate", """{"tabId":"tab_demo"}""") }
            SystemClock.sleep(1_500)
        }

        // 13. GPC and DNT: off, then on; the request headers and what the page sees.
        note("\n13. GPC / DNT off")
        navigate("http://$DEMO_HOST:$PORT/headers?off")
        tab = waitForTitle("Request headers", 25_000)
        note("  ${describeTab(tab)}")
        note("  page: ${pageText().replace('\n', '|')}")
        shot("15-signals-off")
        beat()
        note("\n14. GPC / DNT on")
        setPrivacy("""{"gpc":true,"dnt":true}""")
        navigate("http://$DEMO_HOST:$PORT/headers?on")
        tab = waitForTitle("Request headers", 25_000)
        note("  ${describeTab(tab)}")
        note("  page: ${pageText().replace('\n', '|')}")
        note("  guard flags: ${Privacy.shared(app).flags.toJson()}")
        shot("16-signals-on")
        beat()

        note("\nend: ${describeSafeBrowsing(state().getJSONObject("privacy").getJSONObject("safeBrowsing"))}")
        note("done")
    }

    // --- the interstitials ----------------------------------------------------------------------

    /**
     * Press a button of the warning page: a real touch on its label first; when the tab is still
     * on the page after that, the page's own message (what the button posts), through the tab's
     * WebView, so a label the accessibility tree does not carry cannot end the demo. Notes say
     * which way it went.
     */
    private fun pressInterstitial(f: Finger, label: String, action: String, url: String) {
        val warning = state().getJSONObject("tabs").optJSONObject("tab_demo")?.optString("url") ?: ""
        val tapped = tapLabel(f, label, 8_000)
        if (!tapped) note("  (no node labelled '$label'; clicking through the tree)")
        if (!tapped && !clickByLabel(label)) {
            note("  (no clickable '$label'; posting the page's message)")
            postInterstitial(action, url)
            return
        }
        // Left the warning page: for any other page, another error page of the core's included
        // (a plain one for the same site would mean back landed on the failed load itself).
        val deadline = SystemClock.uptimeMillis() + 8_000
        while (SystemClock.uptimeMillis() < deadline) {
            val current = state().getJSONObject("tabs").optJSONObject("tab_demo")?.optString("url") ?: ""
            if (current != warning) return
            SystemClock.sleep(300)
        }
        note("  (the tab stayed on the warning page after '$label'; posting the page's message)")
        postInterstitial(action, url)
    }

    /** What the button's onclick does: `window.postMessage` of the interstitial action, in the page. */
    private fun postInterstitial(action: String, url: String) {
        tabJs("window.postMessage({zeniumInterstitial:{action:${JSONObject.quote(action)},url:${JSONObject.quote(url)}}},'*');'posted'")
    }

    // --- the chrome's bridge (the harness's coreInvoke / coreState, under the driver's short names) ---

    private fun invoke(name: String, args: String = "null"): String = coreInvoke(name, args)

    private fun state(): JSONObject = coreState()

    private fun navigate(url: String, tabId: String = "tab_demo") {
        invoke("tab.navigate", """{"tabId":"$tabId","input":${JSONObject.quote(url)}}""")
    }

    /** Patch the privacy settings the way the settings panel does (the whole object, merged). */
    private fun setPrivacy(patch: String) {
        val privacy = state().getJSONObject("settings").getJSONObject("privacy")
        val p = JSONObject(patch)
        for (key in p.keys()) privacy.put(key, p.get(key))
        invoke("settings.update", JSONObject().put("privacy", privacy).toString())
        SystemClock.sleep(600)
        note("  settings.privacy <- $patch")
    }

    /** Evaluate in the tab's WebView (the page, not the chrome); the value as text. */
    private fun tabJs(code: String, tabId: String = "tab_demo"): String {
        val tab = (activity as MainActivity).host.tabs.get(tabId) ?: return "(no WebView for $tabId)"
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

    private fun pageText(tabId: String = "tab_demo"): String = tabJs("(document.body&&document.body.innerText||'').slice(0,600)", tabId)

    /** What the third-party frame reported to its parent (see the server's `/frame`), waited for. */
    private fun frameReport(tabId: String = "tab_demo"): String {
        val deadline = SystemClock.uptimeMillis() + 8_000
        while (SystemClock.uptimeMillis() < deadline) {
            val report = tabJs("window.__frame||''", tabId)
            if (report.isNotEmpty() && report != "(no answer)") return report
            SystemClock.sleep(300)
        }
        return "(the frame never reported; page: ${pageText(tabId).replace('\n', '|')})"
    }

    private fun upgradeDecision(url: String): Decision =
        Blocking.shared(app).snapshot.decide(Request(url, ResourceType.MAIN_FRAME, null, "GET"))

    private fun describeSafeBrowsing(s: JSONObject): String {
        val feeds = s.getJSONArray("feeds")
        val parts = (0 until feeds.length()).map {
            val feed = feeds.getJSONObject(it)
            "${feed.getString("id")}(${feed.optInt("entries")}${if (feed.optBoolean("bundled")) ", bundled" else ""})"
        }
        return "ready=${s.optBoolean("ready")} enabled=${s.optBoolean("enabled")} entries=${s.optInt("entries")} " +
            "updating=${s.optBoolean("updating")} lastUpdatedAt=${s.opt("lastUpdatedAt")} feeds=[${parts.joinToString(", ")}]"
    }

    private fun describeHttpsOnly(): String {
        val p = state().getJSONObject("privacy")
        return "httpsOnly session=${p.getJSONArray("httpsOnlySessionExceptions")} stored=${p.getJSONArray("httpsOnlyExceptions")}"
    }

    /** The tab's url, title and error code. */
    private fun describeTab(s: JSONObject, tabId: String = "tab_demo"): String {
        val tab = s.getJSONObject("tabs").optJSONObject(tabId) ?: return "tab $tabId gone"
        return "tab $tabId url=${tab.optString("url")} title=\"${tab.optString("title")}\" errorCode=${tab.opt("errorCode")}"
    }

    /** Poll the tab's title and hand back the state then. */
    private fun waitForTitle(prefix: String, timeoutMs: Long = 20_000, tabId: String = "tab_demo"): JSONObject {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        var s = state()
        while (SystemClock.uptimeMillis() < deadline) {
            val tab = s.getJSONObject("tabs").optJSONObject(tabId)
            if (tab != null && tab.optString("title").startsWith(prefix) && !tab.optBoolean("loading")) {
                SystemClock.sleep(1_200)
                return state()
            }
            SystemClock.sleep(500)
            s = state()
        }
        Log.w(tag, "title '$prefix' never showed up on $tabId")
        note("  (title '$prefix' never showed up; ${describeTab(s, tabId)})")
        return s
    }

    /** Poll the tab's URL for `prefix` (an internal page that carries no title of its own). */
    private fun waitForUrl(prefix: String, timeoutMs: Long, tabId: String = "tab_demo"): JSONObject {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        var s = state()
        while (SystemClock.uptimeMillis() < deadline) {
            val tab = s.getJSONObject("tabs").optJSONObject(tabId)
            if (tab != null && tab.optString("url").startsWith(prefix) && !tab.optBoolean("loading")) {
                SystemClock.sleep(1_500)
                return state()
            }
            SystemClock.sleep(500)
            s = state()
        }
        Log.w(tag, "url '$prefix' never showed up on $tabId")
        note("  (url '$prefix' never showed up; ${describeTab(s, tabId)})")
        return s
    }

    private fun note(line: String) {
        Log.i(tag, line)
        notes.appendText(line + "\n")
    }

    // --- the page's server ----------------------------------------------------------------------

    /**
     * Serves the demo pages on every loopback address: `/` a page of the site, `/headers` what
     * the request carried (GPC, DNT, cookies) and what `navigator` says, `/cookies` a page with a
     * first-party cookie embedding a frame of another site, `/frame` that frame, which sets a
     * cross-site cookie and reports what it got back to its parent. A TLS handshake gets a
     * plain-HTTP answer, so an https upgrade of any of these sites fails at once.
     */
    private class PrivacyDemoServer(private val port: Int) : Thread("safebrowsing-demo-server") {
        private val socket = ServerSocket(port, 16)
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
                    // A ClientHello on a plain port: answer in HTTP and hang up (Node does the same),
                    // which the client reports as a protocol error, not a wait.
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
                val target = requestLine.split(' ').getOrNull(1) ?: "/"
                val path = target.substringBefore('?')
                val host = headers["host"] ?: "127.0.0.1:$port"
                val extra = StringBuilder()
                val body = when (path) {
                    "/frame" -> {
                        extra.append("Set-Cookie: tp=1; SameSite=None; Secure; Path=/\r\n")
                        frame(host, headers)
                    }
                    "/headers" -> page("Request headers", headersBody(host, headers))
                    "/cookies" -> {
                        extra.append("Set-Cookie: first=1; Path=/\r\n")
                        page("Cookies", cookiesBody(host, headers))
                    }
                    else -> page("Demo site", siteBody(host, path, headers))
                }.toByteArray()
                out.write(
                    ("HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: ${body.size}\r\n" +
                        "Cache-Control: no-store\r\n${extra}Connection: close\r\n\r\n").toByteArray()
                )
                out.write(body)
                out.flush()
            }
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

        private fun none(v: String?): String = if (v.isNullOrEmpty()) "(not sent)" else v

        private fun esc(s: String): String =
            s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace("\"", "&quot;")

        private fun rows(vararg pairs: Pair<String, String>): String =
            "<table>" + pairs.joinToString("") { "<tr><td>${esc(it.first)}</td><td><code>${esc(it.second)}</code></td></tr>" } + "</table>"

        private fun page(title: String, body: String): String =
            "<!doctype html><html><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">" +
                "<title>$title</title><style>$STYLE</style></head><body>$body</body></html>"

        private fun siteBody(host: String, path: String, h: Map<String, String>): String =
            "<h1>${esc(host)}</h1><p>A page of the demo site, loaded over <strong>http</strong>.</p>" +
                rows("Host" to host, "Path" to path, "Sec-GPC" to none(h["sec-gpc"]), "DNT" to none(h["dnt"])) +
                "<p><a href=\"/headers\">Request headers</a> &middot; <a href=\"/cookies\">Cookies</a></p>"

        private fun headersBody(host: String, h: Map<String, String>): String =
            "<h1>What ${esc(host)} received</h1>" +
                rows("Sec-GPC" to none(h["sec-gpc"]), "DNT" to none(h["dnt"]), "Cookie" to none(h["cookie"]), "Scheme" to "http") +
                "<h1>What the page sees</h1><table><tr><td>navigator.globalPrivacyControl</td><td><code id=\"gpc\"></code></td></tr>" +
                "<tr><td>navigator.doNotTrack</td><td><code id=\"dnt\"></code></td></tr></table>" +
                "<script>document.getElementById('gpc').textContent=String(navigator.globalPrivacyControl);" +
                "document.getElementById('dnt').textContent=String(navigator.doNotTrack)</script>"

        private fun cookiesBody(host: String, h: Map<String, String>): String =
            "<h1>${esc(host)} with an embedded tracker</h1>" +
                rows("First-party Cookie header" to none(h["cookie"])) +
                "<p class=\"note\">Below, a frame from another site ($TRACKER_HOST) that tries to set and read its own cookie.</p>" +
                "<iframe src=\"http://$TRACKER_HOST:$PORT/frame?t=${System.currentTimeMillis()}\"></iframe>" +
                "<p class=\"note\">The frame reports: <code id=\"report\">(waiting)</code></p>" +
                "<script>addEventListener('message',function(e){if(typeof e.data==='string'){window.__frame=e.data;" +
                "document.getElementById('report').textContent=e.data}})</script>"

        private fun frame(host: String, h: Map<String, String>): String =
            "<!doctype html><meta charset=\"utf-8\"><style>body{font:15px/1.5 system-ui,sans-serif;margin:0;padding:12px;" +
                "background:#fff7ed;color:#1f1f1f}code{background:#fde8cc;padding:1px 5px;border-radius:3px}</style>" +
                "<div><strong>${esc(host.substringBefore(':'))}</strong> (third-party frame)</div>" +
                "<div>Cookie header received: <code>${esc(none(h["cookie"]))}</code></div>" +
                "<div>Set-Cookie sent: <code>tp=1; SameSite=None; Secure</code></div>" +
                "<div>document.cookie: <code id=\"dc\"></code></div>" +
                "<script>var dc=document.cookie||'(empty)';document.getElementById('dc').textContent=dc;" +
                "parent.postMessage('Cookie header received: ${esc(none(h["cookie"]))}; document.cookie: '+dc,'*')</script>"

        fun close() {
            closed = true
            runCatching { socket.close() }
        }

        companion object {
            private const val TLS_HANDSHAKE = 0x16
            private const val STYLE =
                "body{font:16px/1.5 system-ui,sans-serif;margin:0;padding:20px 16px;background:#fff;color:#1f1f1f}" +
                    "h1{font-size:20px;margin:0 0 12px}table{border-collapse:collapse;margin:0 0 16px}td{padding:4px 12px 4px 0;vertical-align:top}" +
                    "code{background:#f1f1f1;padding:1px 6px;border-radius:3px;word-break:break-all}" +
                    "iframe{width:100%;height:150px;border:1px solid #e5c9a5;border-radius:6px}.note{color:#555;font-size:14px}a{color:#1a5fb4}"
        }
    }

    companion object {
        private const val PORT = 18124
        /** The site of most scenes; every `127.0.0.x` is a site of its own to the WebView. */
        private const val DEMO_HOST = "127.0.0.2"
        private const val TRACKER_HOST = "127.0.0.3"
        private const val LEGACY_HOST = "127.0.0.4"
        /** Listed by the phishing feed the demo seeds (see [seedMore]). */
        private const val PHISHING_HOST = "127.0.0.5"
        private const val PLAIN_HOST = "127.0.0.6"
        private const val PRIVATE_CONTAINER = "private"

        /**
         * A feed document as the core persists them (`FeedDocument` in `src/core/safebrowsing/document.ts`):
         * the 8-byte SHA-256 prefixes of the hosts, base64. Any order; the guard sorts.
         */
        fun feedDocument(id: String, threat: String, hosts: List<String>): String {
            val prefixes = ByteArrayOutputStream()
            for (host in hosts) prefixes.write(MessageDigest.getInstance("SHA-256").digest(host.toByteArray(Charsets.UTF_8)), 0, 8)
            return JSONObject()
                .put("version", 1)
                .put("id", id)
                .put("threat", threat)
                .put("entries", hosts.size)
                .put("updatedAt", System.currentTimeMillis())
                .put("etag", JSONObject.NULL)
                .put("lastModified", JSONObject.NULL)
                .put("bundled", false)
                .put("prefixes", Base64.encodeToString(prefixes.toByteArray(), Base64.NO_WRAP))
                .toString()
        }
    }
}
