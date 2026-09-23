package app.zen.chromium

import android.os.SystemClock
import android.util.Log
import android.webkit.WebSettings
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.webkit.WebViewCompat
import org.json.JSONObject
import org.json.JSONTokener
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.TreeMap
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

/**
 * Proves `declarativeNetRequest` `modifyHeaders` on the phone: a fixture rule set shaped like the
 * session rule User-Agent Switcher registers (`requestHeaders: [{ header: 'user-agent',
 * operation: 'set' }]`, every resource type, no URL condition; the extension program's compat
 * round 9, row 23) is seeded into the profile's `blocking/` folder before the boot, and a
 * loopback fixture server inside this process records the headers of every request it receives.
 *
 * What the run shows, on the page and in `<shotPrefix>-notes.txt`:
 * 1. a document navigation carries the `User-Agent` the rule sets (the header-stage relay built
 *    and sent the request), the `X-Requested-With` WebView adds is gone (`remove`) and a header
 *    the rule adds arrived (`set`);
 * 2. an `allow` of higher priority for `/plain` caps the edits: that document goes out as WebView
 *    sends it (contract 1.2 rule 4);
 * 3. a `responseHeaders` `set` of `content-type` retypes `/as-text`: the same HTML is shown as
 *    plain text (the relay serves the edited response);
 * 4. the recorded limits, visible: the page's own `fetch('/echo.json')` – a subresource WebView
 *    loads itself – carries the tab's own `User-Agent` (documents only on Android), and
 *    `navigator.userAgent` is unchanged (`WebSettings.userAgentString`, not a header edit).
 *
 * The run fails when the document's request did not carry the rule's `User-Agent`: a proof that
 * passes without the edit is none. See [DemoHarness] for the plumbing; the set is a `builtin` of
 * its own id, as [BlockingDemo] seeds one, so neither the core's `syncSets` nor the extension
 * runtime's owner reconciliation (for `ext:` sets) drops it at boot.
 */
@RunWith(AndroidJUnit4::class)
class ModifyHeadersDemo : DemoHarness("modify-headers-demo-state.json", "services-dnr-modify-headers-android", "modify-headers-demo") {
    override val tag = "ModifyHeadersDemo"
    private lateinit var server: EchoServer
    private lateinit var notes: File

    /** Lines noted before the handshake directory (and the notes file) exists; written out in [warmUp]. */
    private val early = ArrayList<String>()

    @Test
    fun record() {
        server = EchoServer(PORT).also { it.start() }
        try {
            runDemo()
        } finally {
            server.close()
        }
    }

    // --- the profile: the fixture set under blocking/sets/ ------------------------------------

    /**
     * Before the boot: a `version: 2` index naming one set, its rules in its own document under
     * `blocking/sets/`, as the core's `RuleSetStore` writes them (`fileNameFor`, `tagOf`). The set
     * sits in the `dnr` band (2000 + slot), where the translator puts an extension's session
     * rules, so its relation to the site exceptions (900) and the global switch (1000) is the
     * extension's.
     */
    override fun seedMore(zen: File) {
        val dir = File(zen, "blocking").apply { mkdirs() }
        val sets = File(dir, "sets").apply { mkdirs() }
        sets.listFiles()?.forEach { it.delete() }
        val text = FIXTURE_DOCUMENT
        val document = File(sets, fileNameFor(SET_ID))
        document.writeText(text)
        val summary = "{\"id\":\"$SET_ID\",\"source\":\"builtin\",\"priority\":$SET_PRIORITY,\"enabled\":true," +
            "\"ruleCount\":3,\"document\":\"sets/${document.name}\",\"tag\":\"${tagOf(text)}\"," +
            "\"hasFilterText\":false,\"filterCount\":0}"
        File(dir, "index.json").writeText("{\"version\":2,\"sets\":[$summary]}")
        noteEarly("profile: $SET_ID seeded at priority $SET_PRIORITY, 3 rules in blocking/sets/${document.name} (tag ${tagOf(text)})")
        noteEarly("  rule 1 modifyHeaders (every type, no URL condition): user-agent set, x-requested-with remove, x-zenium-demo set")
        noteEarly("  rule 2 modifyHeaders ($ORIGIN/as-text, main_frame): response content-type set text/plain")
        noteEarly("  rule 3 allow, priority 2 ($ORIGIN/plain, main_frame): caps rule 1's edits")
    }

    override fun warmUp() {
        notes = File(out, "services-dnr-modify-headers-android-notes.txt")
        notes.writeText("Zenium Android declarativeNetRequest modifyHeaders demo\n\n")
        for (line in early) note(line)
        early.clear()
        note("fixture server: ${server.selfCheck()}")
        val webView = WebViewCompat.getCurrentWebViewPackage(app)
        note("WebView: ${webView?.packageName ?: "?"} ${webView?.versionName ?: "?"}; default UA: ${WebSettings.getDefaultUserAgent(app)}")
        note("tab UA (UserAgent.apply): ${tabUserAgent()}")
        // The Kotlin engine follows the index; the core installs the bundled lists after boot and
        // every change rebuilds the snapshot. Wait for the fixture's edits to be in it, and stay.
        val blocking = engine
        val deadline = SystemClock.uptimeMillis() + 120_000
        var stable = 0
        var lastReport = 0L
        while (SystemClock.uptimeMillis() < deadline && stable < 3) {
            val snap = blocking.snapshot
            if (snap.modifyHeadersRuleCount >= 2) stable++ else stable = 0
            if (SystemClock.uptimeMillis() - lastReport > 10_000) {
                lastReport = SystemClock.uptimeMillis()
                note("waiting: ${describeKotlin()}")
            }
            SystemClock.sleep(1_000)
        }
        note("kotlin engine: ${describeKotlin()}")
        if (blocking.snapshot.modifyHeadersRuleCount < 2) error("the Kotlin engine never carried the fixture's modifyHeaders rules: ${describeKotlin()}")
        // The seeded tab may have loaded before the engine had the set: load the page again.
        val before = server.hits("/")
        invoke("tab.reload", """{"tabId":"tab_demo","skipCache":true}""")
        awaitHit("/", before)
        waitForTitle("echo ready", 20_000)
        Log.i(tag, "warm-up done")
    }

    override fun demo() {
        // 1. The document goes out through the relay with the rule's User-Agent.
        note("\n1. a document navigation carries the User-Agent the rule sets")
        val document = server.last("/") ?: error("the fixture server saw no GET /")
        val sub = server.last("/echo.json")
        note("  server saw GET /: ${describe(document)}")
        note("  server saw GET /echo.json (the page's fetch, a subresource): ${sub?.let { describe(it) } ?: "not yet"}")
        note("  page: ${pageValues()}")
        shot("01-document-carries-the-rules-ua")
        beat()
        val ownUa = tabUserAgent()
        if (document.header("user-agent") != RULE_UA) {
            error("the document request did not carry the rule's User-Agent: got '${document.header("user-agent")}', wanted '$RULE_UA'")
        }
        if (document.header("x-zenium-demo") != "modifyHeaders") error("the rule's set header did not arrive: ${describe(document)}")
        if (document.header("x-requested-with") != null) error("the rule's remove did not take: ${describe(document)}")
        note("  PASS: the document's User-Agent is the rule's; x-zenium-demo set; x-requested-with removed")

        // 2. The limits: a subresource WebView loads itself is not edited; navigator.userAgent is WebView's.
        note("\n2. the recorded limits")
        if (sub != null) {
            note("  subresource /echo.json User-Agent: ${sub.header("user-agent")} (${if (sub.header("user-agent") == ownUa) "the tab's own: documents only on Android" else "NOT the tab's own UA"})")
            note("  subresource /echo.json X-Requested-With: ${sub.header("x-requested-with") ?: "(none)"}")
        }
        val nav = tabJs("navigator.userAgent")
        note("  navigator.userAgent: $nav (${if (nav == ownUa) "unchanged: WebSettings.userAgentString is not a header edit" else "differs from the tab's own UA"})")

        // 3. An allow of higher priority caps the edits: /plain goes out as WebView sends it.
        note("\n3. /plain – an allow of higher priority caps the edits (contract 1.2 rule 4)")
        val beforePlain = server.hits("/plain")
        invoke("tab.navigate", """{"tabId":"tab_demo","input":"$ORIGIN/plain"}""")
        awaitHit("/plain", beforePlain)
        waitForTitle("echo ready", 20_000)
        val plain = server.last("/plain") ?: error("the fixture server saw no GET /plain")
        note("  server saw GET /plain: ${describe(plain)}")
        note("  page: ${pageValues()}")
        shot("02-allow-caps-the-edit")
        beat()
        if (plain.header("user-agent") != ownUa) error("/plain should carry the tab's own User-Agent, got '${plain.header("user-agent")}'")
        if (plain.header("x-zenium-demo") != null) error("/plain should not carry the rule's header: ${describe(plain)}")
        note("  PASS: /plain carried the tab's own User-Agent and none of the rule's edits")

        // 4. A response edit: content-type set to text/plain; the HTML is shown as text.
        note("\n4. /as-text – the response's content-type is set by a rule, the document is served retyped")
        val beforeText = server.hits("/as-text")
        invoke("tab.navigate", """{"tabId":"tab_demo","input":"$ORIGIN/as-text"}""")
        awaitHit("/as-text", beforeText)
        waitForLoaded(20_000)
        SystemClock.sleep(1_500)
        val asText = server.last("/as-text") ?: error("the fixture server saw no GET /as-text")
        val contentType = tabJs("document.contentType")
        note("  server saw GET /as-text: ${describe(asText)}")
        note("  server sent Content-Type: text/html; charset=utf-8; the document's contentType now: $contentType")
        shot("03-response-edit-retypes-the-document")
        beat()
        if (asText.header("user-agent") != RULE_UA) error("/as-text should carry the rule's User-Agent too (both rules stack), got '${asText.header("user-agent")}'")
        if (contentType != "text/plain") error("/as-text should have been served as text/plain, WebView says '$contentType'")
        note("  PASS: /as-text served as text/plain with the rule's User-Agent on its request")

        note("\nkotlin engine at the end: ${describeKotlin()}")
        note("done")
    }

    // --- what the run reads ----------------------------------------------------------------------

    private val engine: app.zen.chromium.blocking.Blocking get() = (activity as MainActivity).host.blocking

    private fun describeKotlin(): String {
        val snap = engine.snapshot
        return "${snap.setCount} sets, ${snap.ruleCount} structured rules (${snap.modifyHeadersRuleCount} modifyHeaders, " +
            "${snap.headerRuleCount} header-conditioned), ${snap.filterCount} network filters, last build ${engine.lastBuildMs} ms (${engine.builds} builds)"
    }

    private fun describe(seen: Seen): String =
        "User-Agent=${seen.header("user-agent") ?: "(none)"} | X-Requested-With=${seen.header("x-requested-with") ?: "(none)"} | " +
            "X-Zenium-Demo=${seen.header("x-zenium-demo") ?: "(none)"} | Accept-Language=${seen.header("accept-language") ?: "(none)"} | " +
            "Cookie=${if (seen.header("cookie") != null) "present" else "(none)"}"

    /** The tab's own User-Agent (`UserAgent.apply`), read on the main thread. */
    private fun tabUserAgent(): String {
        var ua = ""
        instrumentation.runOnMainSync {
            ua = (activity as MainActivity).host.tabs.get("tab_demo")?.settings?.userAgentString ?: ""
        }
        return ua
    }

    /** The echo page's rows, as shown. */
    private fun pageValues(): String = tabJs(
        "['ua','xrw','demo','sub','nav'].map(id=>id+'='+((document.getElementById(id)||{}).textContent||'')).join(' | ')"
    )

    /** Evaluate in the tab's WebView; the decoded string result. */
    private fun tabJs(code: String): String {
        val tab = (activity as MainActivity).host.tabs.get("tab_demo") ?: return "(no WebView for tab_demo)"
        var result = "(no answer)"
        val latch = CountDownLatch(1)
        instrumentation.runOnMainSync {
            tab.evaluateJavascript("String($code)") { value ->
                result = (runCatching { JSONTokener(value ?: "null").nextValue() as? String }.getOrNull()) ?: (value ?: "(null)")
                latch.countDown()
            }
        }
        latch.await(5, TimeUnit.SECONDS)
        return result
    }

    private fun awaitHit(path: String, previous: Int, timeoutMs: Long = 20_000) {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline && server.hits(path) <= previous) SystemClock.sleep(100)
        if (server.hits(path) <= previous) Log.w(tag, "the fixture server saw no new GET $path")
    }

    /** Poll the tab's title (the page sets it once its fetch is answered) and the loading flag. */
    private fun waitForTitle(title: String, timeoutMs: Long) {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            val tab = state().getJSONObject("tabs").optJSONObject("tab_demo")
            if (tab != null && tab.optString("title") == title && !tab.optBoolean("loading")) {
                SystemClock.sleep(800)
                return
            }
            SystemClock.sleep(400)
        }
        Log.w(tag, "title '$title' never showed up on tab_demo")
    }

    private fun waitForLoaded(timeoutMs: Long) {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        SystemClock.sleep(500)
        while (SystemClock.uptimeMillis() < deadline) {
            val tab = state().getJSONObject("tabs").optJSONObject("tab_demo")
            if (tab != null && !tab.optBoolean("loading")) return
            SystemClock.sleep(400)
        }
    }

    // --- the chrome's bridge --------------------------------------------------------------------

    private fun js(code: String): String {
        var result = ""
        val latch = CountDownLatch(1)
        instrumentation.runOnMainSync {
            (activity as MainActivity).host.chrome.evaluateJavascript(code) { value ->
                result = value ?: ""
                latch.countDown()
            }
        }
        latch.await(10, TimeUnit.SECONDS)
        return result
    }

    /** Run a core command through `window.zen.invoke` and wait for its promise; the result as JSON. */
    private fun invoke(name: String, args: String = "null"): String {
        js(
            "window.__demo=undefined;window.zen.invoke(${JSONObject.quote(name)},$args)" +
                ".then(r=>{window.__demo=JSON.stringify(r===undefined?null:r)},e=>{window.__demo='ERR:'+(e&&e.message||e)})"
        )
        val deadline = SystemClock.uptimeMillis() + 15_000
        while (SystemClock.uptimeMillis() < deadline) {
            val raw = js("window.__demo===undefined?'':window.__demo")
            val value = (JSONTokener(raw).nextValue() as? String).orEmpty()
            if (value.startsWith("ERR:")) error("$name failed: ${value.removePrefix("ERR:")}")
            if (value.isNotEmpty()) return value
            SystemClock.sleep(100)
        }
        error("$name timed out")
    }

    private fun state(): JSONObject = JSONObject(invoke("app.getState"))

    private fun noteEarly(line: String) {
        Log.i(tag, line)
        early.add(line)
    }

    private fun note(line: String) {
        Log.i(tag, line)
        notes.appendText(line + "\n")
    }

    // --- the seeded set's document, as the core writes one ----------------------------------------

    /** `fileNameFor` of `src/core/blocking/store.ts`: safe characters kept, the rest `_`, an FNV-1a hash of the id when anything was replaced. */
    private fun fileNameFor(id: String): String {
        val safe = id.replace(Regex("[^A-Za-z0-9._-]"), "_")
        if (safe == id) return "$id.json"
        var h = FNV_OFFSET
        for (c in id) h = (h xor c.code) * FNV_PRIME
        return "$safe-${hex(h)}.json"
    }

    /** `tagOf` of `src/core/blocking/store.ts`: the text's length and its FNV-1a and djb2 hashes, one pass, in hex. */
    private fun tagOf(text: String): String {
        var a = FNV_OFFSET
        var b = 5381
        for (c in text) {
            a = (a xor c.code) * FNV_PRIME
            b = (b * 33) xor c.code
        }
        return "${Integer.toHexString(text.length)}-${hex(a)}${hex(b)}"
    }

    private fun hex(n: Int): String = Integer.toHexString(n).padStart(8, '0')

    // --- the fixture server -----------------------------------------------------------------------

    /** One request the server answered: its path and headers, by lowercase name. */
    class Seen(val method: String, val path: String, private val headers: TreeMap<String, String>) {
        fun header(name: String): String? = headers[name.lowercase()]
    }

    /**
     * Serves the echo page on the loopback interface and remembers every request's headers. `/`,
     * `/plain` and `/as-text` are the same HTML page showing the `User-Agent`, `X-Requested-With`
     * and `X-Zenium-Demo` the request carried (every one `text/html`; a rule retypes the third);
     * `/echo.json` answers the page's own fetch with the same three fields.
     */
    class EchoServer(private val port: Int) : Thread("modify-headers-demo-server") {
        // Android's InetAddress.getLoopbackAddress() is ::1; a socket bound to it alone refuses
        // the 127.0.0.1 the page's URL names, so bind the IPv4 loopback explicitly.
        private val socket = ServerSocket(port, 16, InetAddress.getByAddress(byteArrayOf(127, 0, 0, 1)))
        @Volatile private var closed = false
        private val requests = ConcurrentHashMap<String, AtomicInteger>()
        private val seen = CopyOnWriteArrayList<Seen>()

        fun hits(path: String): Int = requests[path]?.get() ?: 0

        /** The newest request to `path`, or null. */
        fun last(path: String): Seen? = seen.lastOrNull { it.path == path }

        fun selfCheck(): String = runCatching {
            Socket("127.0.0.1", port).use { s ->
                s.soTimeout = 5_000
                s.getOutputStream().write("GET /echo.json HTTP/1.1\r\nHost: 127.0.0.1:$port\r\nUser-Agent: self-check\r\n\r\n".toByteArray())
                s.getOutputStream().flush()
                val status = s.getInputStream().bufferedReader().readLine()
                "listening on ${socket.localSocketAddress}, GET /echo.json -> $status"
            }
        }.getOrElse { e -> "listening on ${socket.localSocketAddress}, GET /echo.json failed: $e" }

        override fun run() {
            while (!closed) {
                val client = try {
                    socket.accept()
                } catch (_: Exception) {
                    if (closed) return else continue
                }
                Thread { serve(client) }.start()
            }
        }

        private fun serve(client: Socket) {
            client.use {
                val reader = it.getInputStream().bufferedReader()
                val line = reader.readLine() ?: return
                val headers = TreeMap<String, String>()
                while (true) {
                    val header = reader.readLine()
                    if (header.isNullOrEmpty()) break
                    val colon = header.indexOf(':')
                    if (colon > 0) headers[header.substring(0, colon).trim().lowercase()] = header.substring(colon + 1).trim()
                }
                val parts = line.split(' ')
                val method = parts.getOrNull(0) ?: "GET"
                val path = (parts.getOrNull(1) ?: "/").substringBefore('?')
                requests.getOrPut(path) { AtomicInteger() }.incrementAndGet()
                val record = Seen(method, path, headers)
                // The self-check is not a WebView request; keep it out of the record.
                if (headers["user-agent"] != "self-check") seen.add(record)
                val (status, type, body) = when (path) {
                    "/", "/plain", "/as-text" -> Triple("200 OK", "text/html; charset=utf-8", page(record).toByteArray())
                    "/echo.json" -> Triple("200 OK", "application/json", json(record).toByteArray())
                    else -> Triple("404 Not Found", "text/plain; charset=utf-8", "not here\n".toByteArray())
                }
                val out = it.getOutputStream()
                out.write(
                    ("HTTP/1.1 $status\r\nContent-Type: $type\r\nContent-Length: ${body.size}\r\n" +
                        "Cache-Control: no-store\r\nConnection: close\r\n\r\n").toByteArray()
                )
                out.write(body)
                out.flush()
            }
        }

        private fun json(seen: Seen): String = JSONObject()
            .put("ua", seen.header("user-agent") ?: JSONObject.NULL)
            .put("xrw", seen.header("x-requested-with") ?: JSONObject.NULL)
            .put("demo", seen.header("x-zenium-demo") ?: JSONObject.NULL)
            .toString()

        private fun page(seen: Seen): String {
            fun esc(s: String?): String = (s ?: "(none)").replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace("\"", "&quot;")
            return """<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Zenium header edits</title>
<style>
body{font:16px/1.4 system-ui,sans-serif;margin:20px;color:#1d1d1f;background:#fff}
h1{font-size:20px;margin:0 0 4px}p.sub{margin:0 0 16px;color:#6e6e73;font-size:14px}
dt{font-weight:600;margin-top:14px}dd{margin:4px 0 0}
code{display:block;word-break:break-all;background:#f2f2f7;padding:8px 10px;border-radius:8px;font:14px ui-monospace,monospace}
</style></head><body>
<h1>What the server received</h1>
<p class="sub">${esc(seen.method)} ${esc(seen.path)} on the Zenium fixture server</p>
<dl>
<dt>Document User-Agent</dt><dd><code id="ua">${esc(seen.header("user-agent"))}</code></dd>
<dt>Document X-Requested-With</dt><dd><code id="xrw">${esc(seen.header("x-requested-with"))}</code></dd>
<dt>Document X-Zenium-Demo</dt><dd><code id="demo">${esc(seen.header("x-zenium-demo"))}</code></dd>
<dt>Subresource User-Agent (the page's fetch of /echo.json)</dt><dd><code id="sub">…</code></dd>
<dt>navigator.userAgent</dt><dd><code id="nav">…</code></dd>
</dl>
<script>
document.getElementById('nav').textContent = navigator.userAgent;
fetch('/echo.json', {cache: 'no-store'}).then(r => r.json()).then(j => {
  document.getElementById('sub').textContent = j.ua || '(none)';
  document.title = 'echo ready';
}).catch(e => {
  document.getElementById('sub').textContent = 'failed: ' + e;
  document.title = 'echo failed';
});
</script></body></html>
"""
        }

        fun close() {
            closed = true
            runCatching { socket.close() }
        }
    }

    companion object {
        private const val PORT = 18173
        private const val ORIGIN = "http://127.0.0.1:$PORT"
        /** A builtin of its own id in the `dnr` band, where the translator puts an extension's session set. */
        private const val SET_ID = "builtin:demo-user-agent-switcher"
        private const val SET_PRIORITY = 2001
        /** User-Agent Switcher's "Internet Explorer 10" string, the one the sweep's row taps. */
        private const val RULE_UA = "Mozilla/5.0 (compatible; MSIE 10.0; Windows NT 6.1; Trident/6.0)"
        /** FNV-1a's 32-bit offset basis (2166136261 as the signed int `Math.imul` in `store.ts` works on) and prime. */
        private const val FNV_OFFSET = -2128831035
        private const val FNV_PRIME = 16777619

        /** The set's document, compact JSON in the key order the core's `documentText` writes. */
        private val FIXTURE_DOCUMENT = "{\"id\":\"$SET_ID\",\"rules\":[" +
            "{\"id\":1,\"priority\":1,\"action\":{\"type\":\"modifyHeaders\",\"requestHeaders\":[" +
            "{\"header\":\"user-agent\",\"operation\":\"set\",\"value\":\"$RULE_UA\"}," +
            "{\"header\":\"x-requested-with\",\"operation\":\"remove\"}," +
            "{\"header\":\"x-zenium-demo\",\"operation\":\"set\",\"value\":\"modifyHeaders\"}]},\"condition\":{}}," +
            "{\"id\":2,\"priority\":1,\"action\":{\"type\":\"modifyHeaders\",\"responseHeaders\":[" +
            "{\"header\":\"content-type\",\"operation\":\"set\",\"value\":\"text/plain; charset=utf-8\"}]}," +
            "\"condition\":{\"urlFilter\":\"|$ORIGIN/as-text\",\"resourceTypes\":[\"main_frame\"]}}," +
            "{\"id\":3,\"priority\":2,\"action\":{\"type\":\"allow\"}," +
            "\"condition\":{\"urlFilter\":\"|$ORIGIN/plain\",\"resourceTypes\":[\"main_frame\"]}}" +
            "]}"
    }
}
