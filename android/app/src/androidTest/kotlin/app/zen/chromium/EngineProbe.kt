package app.zen.chromium

import android.content.Context
import android.os.Build
import android.util.Base64
import android.util.Log
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Test
import org.junit.runner.RunWith
import java.io.ByteArrayInputStream
import java.io.File
import java.lang.reflect.Modifier
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * Empirical record of what the system WebView is and is not, written to `files/ext-probe/engine-probe.json`
 * for the `android-ext-runtime-demo` workflow to collect:
 *
 *  - the WebView provider package and version (the Chromium build the app runs on);
 *  - every androidx.webkit feature flag and whether this provider supports it;
 *  - a reflection dump of the WebView, WebSettings, WebViewClient, WebChromeClient and
 *    androidx.webkit surfaces, and the (absence of) anything extension-related in them;
 *  - what loading a `chrome-extension://` URL does, and what `chrome` is inside a page;
 *  - what an https origin served purely through `shouldInterceptRequest` can do: subresources,
 *    module scripts, fetch, sync XHR, 302 (subresource and top-level), Range, POST bodies, CORS
 *    between two intercepted origins, WebSocket, service worker registration, storage.
 */
@RunWith(AndroidJUnit4::class)
class EngineProbe {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val app: Context = instrumentation.targetContext
    private val out = File(app.filesDir, "ext-probe")

    @Test
    fun probe() {
        out.deleteRecursively()
        out.mkdirs()
        val result = JSONObject()
        // Every step is independent evidence: one failing must not lose the others.
        val steps = listOf<Pair<String, () -> Any>>(
            "device" to ::device,
            "webViewPackage" to ::webViewPackage,
            "androidxWebkitFeatures" to ::features,
            "providerFeatures" to ::providerFeatures,
            "reflection" to ::reflection,
            "chromeExtensionUrl" to ::chromeExtensionUrl,
            "pageGlobals" to ::pageGlobals,
            "redirectResponse" to ::redirectResponse,
            "isolatedWorld" to ::isolatedWorld,
            "fakeOrigin" to ::fakeOrigin
        )
        for ((name, step) in steps) {
            val value = runCatching(step).getOrElse { JSONObject().put("error", it.toString()) }
            result.put(name, value)
            File(out, "engine-probe.json").writeText(result.toString(2))
        }
        Log.i(TAG, "engine probe: ${result.toString()}")
    }

    /**
     * Can `shouldInterceptRequest` answer with a redirect? `WebResourceResponse` validates its
     * status code in the constructor: 3xx is rejected outright (this is what took the process
     * down in the first prototype run), so redirects have to be emulated by substitution.
     */
    private fun redirectResponse(): JSONObject {
        val result = JSONObject()
        for (status in listOf(301, 302, 303, 307, 308)) {
            val outcome = runCatching {
                WebResourceResponse("text/plain", "utf-8", status, "Redirect", mapOf("Location" to "/x"), ByteArrayInputStream(ByteArray(0)))
                "constructed"
            }.getOrElse { it.toString() }
            result.put(status.toString(), outcome)
        }
        result.put("200", runCatching { WebResourceResponse("text/plain", "utf-8", 200, "OK", emptyMap(), ByteArrayInputStream(ByteArray(0))); "constructed" }.getOrElse { it.toString() })
        result.put("204", runCatching { WebResourceResponse("text/plain", "utf-8", 204, "No Content", emptyMap(), ByteArrayInputStream(ByteArray(0))); "constructed" }.getOrElse { it.toString() })
        return result
    }

    /**
     * Real isolated worlds (androidx.webkit 1.17 `JS_INJECTION_IN_FRAME_AND_WORLD`): when the
     * provider has them, inject a document-start script into a named world of a page that defines
     * a page global, and record what each side can see of the other.
     */
    private fun isolatedWorld(): JSONObject {
        val result = JSONObject()
        val supported = WebViewFeature.isFeatureSupported(WebViewFeature.JS_INJECTION_IN_FRAME_AND_WORLD)
        result.put("featureSupported", supported)
        if (!supported) return result
        val fromWorld = JSONArray()
        val latch = CountDownLatch(1)
        lateinit var view: WebView
        instrumentation.runOnMainSync {
            view = WebView(app)
            view.settings.javaScriptEnabled = true
            val world = WebViewCompat.getExecutionWorld(view, "zenium-probe")
            WebViewCompat.addWebMessageListener(view, "probeBridge", setOf("*"), world) { _, message, _, _, _ ->
                synchronized(fromWorld) { fromWorld.put(message.data) }
            }
            WebViewCompat.addJavaScriptOnEvent(
                view,
                """
                window.__worldVar = 'isolated';
                var report = function (phase) {
                  probeBridge.postMessage(JSON.stringify({
                    phase: phase, chrome: typeof chrome, pageVar: typeof window.pageVar, bareBridge: typeof probeBridge,
                    sameDocument: document === window.document, title: document.title, readyState: document.readyState,
                    arrayIsPageArray: Array === window.Array, worldVar: window.__worldVar
                  }));
                };
                report('document_start');
                document.addEventListener('DOMContentLoaded', function () { report('document_end'); });
                """.trimIndent(),
                WebViewCompat.INJECTION_EVENT_DOCUMENT_START,
                setOf("*"),
                world
            )
            view.webViewClient = object : WebViewClient() {
                override fun shouldInterceptRequest(v: WebView, request: WebResourceRequest): WebResourceResponse? =
                    if (request.url.host == "world$ORIGIN_SUFFIX")
                        text("text/html", "<title>world-probe</title><script>window.pageVar = 42; window.__pageSeesWorld = typeof window.__worldVar; window.__pageSeesBridge = typeof probeBridge;</script><p>hi</p>")
                    else null

                override fun onPageFinished(v: WebView, url: String) { latch.countDown() }
            }
            view.loadUrl("https://world$ORIGIN_SUFFIX/")
        }
        result.put("pageFinished", latch.await(15, TimeUnit.SECONDS))
        Thread.sleep(500)
        result.put("mainWorld", runCatching { JSONObject(evaluate(view, "JSON.stringify({ pageVar: typeof window.pageVar, worldVar: typeof window.__worldVar, pageSawWorldVar: window.__pageSeesWorld, pageSawBridge: window.__pageSeesBridge, bridge: typeof probeBridge })")) }.getOrElse { JSONObject().put("error", it.toString()) })
        synchronized(fromWorld) { result.put("isolatedWorld", JSONArray(fromWorld.toString())) }
        instrumentation.runOnMainSync { view.destroy() }
        return result
    }

    private fun device(): JSONObject = JSONObject()
        .put("release", Build.VERSION.RELEASE)
        .put("sdk", Build.VERSION.SDK_INT)
        .put("model", Build.MODEL)
        .put("abi", Build.SUPPORTED_ABIS.joinToString(","))

    private fun webViewPackage(): JSONObject {
        val info = WebViewCompat.getCurrentWebViewPackage(app)
        val platform = if (Build.VERSION.SDK_INT >= 26) WebView.getCurrentWebViewPackage() else null
        return JSONObject()
            .put("packageName", info?.packageName)
            .put("versionName", info?.versionName)
            .put("versionCode", info?.let { if (Build.VERSION.SDK_INT >= 28) it.longVersionCode else it.versionCode.toLong() })
            .put("platformApi", JSONObject().put("packageName", platform?.packageName).put("versionName", platform?.versionName))
    }

    /** Every `WebViewFeature` string constant and whether the installed provider supports it. */
    private fun features(): JSONObject {
        val features = JSONObject()
        for (field in WebViewFeature::class.java.declaredFields) {
            if (!Modifier.isStatic(field.modifiers) || field.type != String::class.java) continue
            val name = field.name
            val value = field.get(null) as? String ?: continue
            val supported = runCatching { WebViewFeature.isFeatureSupported(value) }.getOrElse { "error: ${it.message}" }
            features.put(name, supported)
        }
        return features
    }

    /**
     * The feature strings the installed WebView provider itself advertises (what androidx.webkit
     * consults in `isFeatureSupported`), independent of the androidx.webkit version this app is
     * compiled against: newer Chromium features show up here before the library knows them.
     */
    private fun providerFeatures(): JSONArray = runCatching {
        val communicator = Class.forName("androidx.webkit.internal.WebViewGlueCommunicator")
        val factory = communicator.getMethod("getFactory").invoke(null) ?: error("no provider factory")
        val features = factory.javaClass.getMethod("getWebViewFeatures").invoke(factory) as Array<*>
        JSONArray(features.map { it.toString() }.sorted())
    }.getOrElse { JSONArray().put("error: $it") }

    private fun reflection(): JSONObject {
        val classes = listOf(
            "android.webkit.WebView", "android.webkit.WebSettings", "android.webkit.WebViewClient",
            "android.webkit.WebChromeClient", "android.webkit.ServiceWorkerController", "android.webkit.WebStorage",
            "androidx.webkit.WebViewCompat", "androidx.webkit.WebSettingsCompat", "androidx.webkit.WebViewClientCompat",
            "androidx.webkit.ServiceWorkerControllerCompat", "androidx.webkit.WebViewFeature", "androidx.webkit.ProfileStore",
            "androidx.webkit.Profile", "androidx.webkit.WebViewMediaIntegrityApiStatusConfig"
        )
        val pattern = Regex("(?i)extension|addon|crx|isolated|world|userscript")
        val dump = JSONObject()
        for (name in classes) {
            val cls = runCatching { Class.forName(name) }.getOrNull()
            if (cls == null) {
                dump.put(name, JSONObject().put("present", false))
                continue
            }
            val methods = cls.declaredMethods.map { it.name }.distinct().sorted()
            val fields = cls.declaredFields.filter { Modifier.isStatic(it.modifiers) }.map { it.name }.sorted()
            val suspicious = (methods + fields).filter { pattern.containsMatchIn(it) }
            dump.put(
                name,
                JSONObject()
                    .put("present", true)
                    .put("methods", methods.size)
                    .put("staticFields", fields.size)
                    .put("extensionLikeMembers", JSONArray(suspicious))
                    .put("methodNames", JSONArray(methods))
            )
        }
        return dump
    }

    /** Load `chrome-extension://…/` and record how the WebView fails it. */
    private fun chromeExtensionUrl(): JSONObject {
        val result = JSONObject().put("url", CHROME_EXTENSION_URL)
        val latch = CountDownLatch(1)
        var view: WebView? = null
        instrumentation.runOnMainSync {
            val w = WebView(app)
            w.settings.javaScriptEnabled = true
            w.webViewClient = object : WebViewClient() {
                override fun shouldOverrideUrlLoading(v: WebView, request: WebResourceRequest): Boolean {
                    result.put("shouldOverrideUrlLoadingCalled", true)
                    return false
                }

                override fun onReceivedError(v: WebView, request: WebResourceRequest, error: WebResourceError) {
                    if (request.isForMainFrame) {
                        result.put("errorCode", error.errorCode)
                        result.put("description", error.description.toString())
                        latch.countDown()
                    }
                }

                override fun onPageFinished(v: WebView, url: String) {
                    result.put("finishedUrl", url)
                    latch.countDown()
                }
            }
            view = w
            w.loadUrl(CHROME_EXTENSION_URL)
        }
        result.put("completed", latch.await(10, TimeUnit.SECONDS))
        instrumentation.runOnMainSync {
            result.put("finalUrl", view?.url)
            view?.destroy()
        }
        return result
    }

    /** `chrome`, `browser` and the user agent as a plain page sees them. */
    private fun pageGlobals(): JSONObject {
        val (view, _) = loadAndWait("about:blank", null, 10)
        val json = evaluate(
            view,
            """JSON.stringify({
                chrome: typeof chrome,
                chromeKeys: typeof chrome === 'object' && chrome !== null ? Object.keys(chrome) : null,
                chromeRuntime: typeof chrome === 'object' && chrome !== null ? typeof chrome.runtime : 'n/a',
                browser: typeof browser,
                userAgent: navigator.userAgent,
                userAgentData: navigator.userAgentData ? navigator.userAgentData.brands : null
            })"""
        )
        instrumentation.runOnMainSync { view.destroy() }
        return runCatching { JSONObject(json) }.getOrElse { JSONObject().put("raw", json) }
    }

    /** An https origin that exists only in `shouldInterceptRequest`. */
    private fun fakeOrigin(): JSONObject {
        val seen = JSONArray()
        val interceptor: (WebResourceRequest) -> WebResourceResponse? = { request -> serveFakeOrigin(request, seen) }
        // A top-level 302 first: does a redirecting WebResourceResponse move the main frame?
        val (view, finished) = loadAndWait("https://probe$ORIGIN_SUFFIX/go", interceptor, 20)
        val result = JSONObject().put("topLevelRedirect", JSONObject().put("loaded", "https://probe$ORIGIN_SUFFIX/go").put("finishedUrl", finished))
        val deadline = System.currentTimeMillis() + 25_000
        var page = "null"
        while (System.currentTimeMillis() < deadline) {
            page = evaluate(view, "JSON.stringify(window.__r || null)")
            if (page != "null" && page.contains("\"done\":true")) break
            Thread.sleep(400)
        }
        result.put("page", runCatching { JSONObject(page) }.getOrElse { JSONObject().put("raw", page) })
        result.put("requestsSeenByInterceptor", seen)
        instrumentation.runOnMainSync { result.put("finalUrl", view.url); view.destroy() }
        return result
    }

    private fun serveFakeOrigin(request: WebResourceRequest, seen: JSONArray): WebResourceResponse? {
        val url = request.url
        if (url.host?.endsWith(ORIGIN_SUFFIX) != true) return null
        val range = request.requestHeaders?.get("Range")
        synchronized(seen) {
            seen.put(
                JSONObject().put("method", request.method).put("url", url.toString()).put("mainFrame", request.isForMainFrame)
                    .put("range", range).put("accept", request.requestHeaders?.get("Accept"))
            )
        }
        val path = url.path ?: "/"
        val other = url.host == "other$ORIGIN_SUFFIX"
        return when {
            other && path == "/cors.json" -> text("application/json", """{"ok":"cors"}""")
            other -> notFound()
            path == "/go" -> redirect("/index.html")
            path == "/" || path == "/index.html" -> text("text/html", INDEX_HTML)
            path == "/style.css" -> text("text/css", "html{--served:yes}")
            path == "/classic.js" -> text("text/javascript", "var classicLoaded = true;")
            path == "/module.mjs" -> text("text/javascript", "window.__moduleLoaded = 'module'; export {};")
            path == "/dynamic.mjs" -> text("text/javascript", "export const value = 'dynamic';")
            path == "/data.json" -> text("application/json", """{"ok":true}""")
            path == "/redirect" -> redirect("/redirected.txt")
            path == "/redirected.txt" -> text("text/plain", "landed")
            path == "/post" -> text("text/plain", "method=${request.method};bodyVisible=false")
            path == "/frame.html" -> text("text/html", "<script>parent.postMessage('frame-ok', '*')</script>")
            path == "/sw.js" -> text("text/javascript", "self.addEventListener('fetch', function () {});")
            path == "/img.png" -> bytes("image/png", Base64.decode(PIXEL_PNG, Base64.DEFAULT))
            path == "/big.bin" -> {
                val body = ByteArray(100) { it.toByte() }
                val match = range?.let { Regex("bytes=(\\d+)-(\\d+)").find(it) }
                if (match != null) {
                    val from = match.groupValues[1].toInt()
                    val to = match.groupValues[2].toInt()
                    WebResourceResponse(
                        "application/octet-stream", null, 206, "Partial Content",
                        mapOf("Content-Range" to "bytes $from-$to/100", "X-Range-Seen" to range, "Access-Control-Allow-Origin" to "*"),
                        ByteArrayInputStream(body.copyOfRange(from, to + 1))
                    )
                } else bytes("application/octet-stream", body)
            }
            else -> notFound()
        }
    }

    private fun text(mime: String, body: String) = bytes(mime, body.toByteArray())

    private fun bytes(mime: String, body: ByteArray) = WebResourceResponse(
        mime, if (mime.startsWith("text/") || mime.contains("json")) "utf-8" else null, 200, "OK",
        mapOf("Access-Control-Allow-Origin" to "*", "Cache-Control" to "no-cache"), ByteArrayInputStream(body)
    )

    /**
     * A 302 cannot be returned (see `redirectResponse`); the fake origin substitutes the target's
     * body and marks the response, so the page-side step records `redirected: false` and the
     * original URL, which is exactly the limitation the emulation layer must live with.
     */
    private fun redirect(location: String): WebResourceResponse {
        val attempted = runCatching {
            WebResourceResponse("text/plain", "utf-8", 302, "Found", mapOf("Location" to location), ByteArrayInputStream(ByteArray(0)))
        }
        val body = when (location) {
            "/index.html" -> INDEX_HTML
            "/redirected.txt" -> "landed"
            else -> ""
        }
        val mime = if (location.endsWith(".html")) "text/html" else "text/plain"
        return WebResourceResponse(
            mime, "utf-8", 200, "OK",
            mapOf(
                "Access-Control-Allow-Origin" to "*",
                "X-Substituted-For" to location,
                "X-302-Attempt" to (attempted.exceptionOrNull()?.toString() ?: "constructed")
            ),
            ByteArrayInputStream(body.toByteArray())
        )
    }

    private fun notFound() = WebResourceResponse("text/plain", "utf-8", 404, "Not Found", emptyMap(), ByteArrayInputStream(ByteArray(0)))

    /** Create a WebView on the main thread, load `url`, wait for `onPageFinished` (returns the finished URL). */
    private fun loadAndWait(url: String, interceptor: ((WebResourceRequest) -> WebResourceResponse?)?, seconds: Long): Pair<WebView, String?> {
        val latch = CountDownLatch(1)
        var finished: String? = null
        lateinit var view: WebView
        instrumentation.runOnMainSync {
            view = WebView(app)
            view.settings.javaScriptEnabled = true
            view.settings.domStorageEnabled = true
            view.webViewClient = object : WebViewClient() {
                override fun shouldInterceptRequest(v: WebView, request: WebResourceRequest): WebResourceResponse? =
                    interceptor?.invoke(request)

                override fun onPageFinished(v: WebView, u: String) {
                    finished = u
                    latch.countDown()
                }
            }
            view.loadUrl(url)
        }
        latch.await(seconds, TimeUnit.SECONDS)
        return view to finished
    }

    private fun evaluate(view: WebView, script: String): String {
        val latch = CountDownLatch(1)
        var value = "null"
        instrumentation.runOnMainSync {
            view.evaluateJavascript(script) { raw ->
                value = raw?.let { if (it.startsWith("\"")) JSONObject("{\"v\":$it}").getString("v") else it } ?: "null"
                latch.countDown()
            }
        }
        latch.await(10, TimeUnit.SECONDS)
        return value
    }

    companion object {
        private const val TAG = "EngineProbe"
        private const val ORIGIN_SUFFIX = ".ext.zenium.invalid"
        private const val CHROME_EXTENSION_URL = "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/manifest.json"
        private const val PIXEL_PNG =
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4v5/hPwAHqAOaHEfGcwAAAABJRU5ErkJggg=="
        private val INDEX_HTML = """
            <!doctype html><html><head><meta charset="utf-8">
            <link rel="stylesheet" href="/style.css">
            <script src="/classic.js"></script>
            <script type="module" src="/module.mjs"></script>
            </head><body>
            <img id="img" src="/img.png" width="1" height="1">
            <iframe src="/frame.html" width="1" height="1"></iframe>
            <script>
            var r = window.__r = {
              origin: location.origin, isSecureContext: isSecureContext,
              classicScript: typeof classicLoaded, cssApplied: getComputedStyle(document.documentElement).getPropertyValue('--served').trim(),
              steps: {}
            };
            try { localStorage.setItem('k', 'v'); r.localStorage = localStorage.getItem('k'); } catch (e) { r.localStorage = 'error: ' + e.message; }
            document.cookie = 'probe=1; path=/'; r.cookie = document.cookie;
            var x = new XMLHttpRequest(); x.open('GET', '/data.json', false);
            try { x.send(); r.steps.syncXhr = x.status + ':' + x.responseText; } catch (e) { r.steps.syncXhr = 'error: ' + e.message; }
            function note(step) { return function (v) { r.steps[step] = v; }; }
            function bad(step) { return function (e) { r.steps[step] = 'error: ' + (e && e.name ? e.name + ': ' : '') + (e && e.message ? e.message : String(e)); }; }
            var frame = new Promise(function (res) { window.addEventListener('message', function (e) { res(e.data); }); setTimeout(function () { res('timeout'); }, 5000); });
            var steps = [
              fetch('/data.json').then(function (q) { return q.json(); }).then(function (j) { r.steps.fetchJson = j.ok; }).catch(bad('fetchJson')),
              fetch('/redirect').then(function (q) { return q.text().then(function (t) { r.steps.redirect302 = { status: q.status, redirected: q.redirected, url: q.url, body: t, substitutedFor: q.headers.get('X-Substituted-For'), attempt302: q.headers.get('X-302-Attempt') }; }); }).catch(bad('redirect302')),
              fetch('/big.bin', { headers: { Range: 'bytes=10-19' } }).then(function (q) { return q.arrayBuffer().then(function (b) { r.steps.range = { status: q.status, bytes: b.byteLength, contentRange: q.headers.get('Content-Range'), rangeSeen: q.headers.get('X-Range-Seen') }; }); }).catch(bad('range')),
              import('/dynamic.mjs').then(function (m) { r.steps.dynamicImport = m.value; }).catch(bad('dynamicImport')),
              fetch('https://other.ext.zenium.invalid/cors.json').then(function (q) { return q.json(); }).then(function (j) { r.steps.corsBetweenOrigins = j.ok; }).catch(bad('corsBetweenOrigins')),
              fetch('/post', { method: 'POST', body: 'hello' }).then(function (q) { return q.text(); }).then(note('postEcho')).catch(bad('postEcho')),
              frame.then(note('iframe')),
              new Promise(function (res) { var img = document.getElementById('img'); img.onload = function () { res(r.steps.image = 'loaded'); }; img.onerror = function () { res(r.steps.image = 'error'); }; if (img.complete && img.naturalWidth) res(r.steps.image = 'loaded'); }),
              new Promise(function (res) { try { var ws = new WebSocket('wss://probe.ext.zenium.invalid/ws'); ws.onopen = function () { res(r.steps.webSocket = 'open'); }; ws.onerror = function () { res(r.steps.webSocket = 'error'); }; setTimeout(function () { res(r.steps.webSocket = r.steps.webSocket || 'timeout'); }, 4000); } catch (e) { res(r.steps.webSocket = 'exception: ' + e.message); } }),
              ('serviceWorker' in navigator)
                ? navigator.serviceWorker.register('/sw.js').then(function (reg) { r.steps.serviceWorker = 'registered:' + (reg.active ? 'active' : reg.installing ? 'installing' : 'waiting'); }).catch(bad('serviceWorker'))
                : Promise.resolve(r.steps.serviceWorker = 'navigator.serviceWorker unavailable')
            ];
            Promise.allSettled(steps).then(function () { r.moduleScript = window.__moduleLoaded || 'not run'; r.done = true; });
            </script></body></html>
        """.trimIndent()
    }
}
