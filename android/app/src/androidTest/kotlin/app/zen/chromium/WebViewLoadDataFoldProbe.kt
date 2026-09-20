package app.zen.chromium

import android.app.Instrumentation
import android.content.Context
import android.os.Build
import android.os.Bundle
import android.util.Log
import android.webkit.WebBackForwardList
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.core.content.pm.PackageInfoCompat
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.After
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.ByteArrayInputStream
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * A probe, not a claim: does the image's WebView fold two adjacent `loadDataWithBaseURL`
 * documents into one history entry? The upstream draft `webview-adjacent-loaddata-fold.md`
 * (W2-11, from PR #217's runs) saw it on WebView 113 through the product's own test view and
 * sketched a minimal repro it never ran. This runs that sketch exactly, on a bare `WebView`
 * with nothing of the product's in it: `about:blank`, then two `loadDataWithBaseURL` documents
 * with distinct base and history URLs, `onPageFinished` waited for between them; then the
 * variant with a web page (served from memory by the client) between the two documents; then,
 * for the record, the variant with a second `about:blank` between them. Each list's size,
 * current index and items (`url`, `originalUrl`, `title`) are written to the log under
 * [TAG] and sent as instrumentation status (`INSTRUMENTATION_STATUS: fold-probe.* = …` in
 * `instrument.txt`), with the exact WebView package and version, the API level and the image.
 * Nothing here asserts the count either way: the numbers are the finding, and they go into the
 * draft. The run fails only when a load never finishes. Listed ahead of `BarHideDemo` in
 * `DEMO_CLASS` of `android-bar-hide-demo.yml` for the harness PR's run.
 */
@RunWith(AndroidJUnit4::class)
class WebViewLoadDataFoldProbe {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val app: Context = instrumentation.targetContext
    private val views = ArrayList<WebView>()

    @After
    fun destroyViews() {
        instrumentation.runOnMainSync {
            for (view in views) view.destroy()
            views.clear()
        }
    }

    @Test
    fun adjacentLoadDataWithBaseUrlDocuments() {
        report("environment", environment())

        // The sketch, exactly: a plain client (this one only listens), about:blank, A, B.
        val sketch = webView()
        load(sketch) { it.loadUrl("about:blank") }
        load(sketch) { it.loadDataWithBaseURL(BASE_A, "<title>A</title>", "text/html", "utf-8", BASE_A) }
        load(sketch) { it.loadDataWithBaseURL(BASE_B, "<title>B</title>", "text/html", "utf-8", BASE_B) }
        report("sketch", describe(sketch))

        // The variant: a web page (served by the client from memory) between the two documents.
        val between = webView()
        load(between) { it.loadUrl("about:blank") }
        load(between) { it.loadDataWithBaseURL(BASE_A, "<title>A</title>", "text/html", "utf-8", BASE_A) }
        load(between) { it.loadUrl(WEB_PAGE) }
        load(between) { it.loadDataWithBaseURL(BASE_B, "<title>B</title>", "text/html", "utf-8", BASE_B) }
        report("web-page-between", describe(between))

        // For the record: about:blank between the two documents instead of a web page.
        val blank = webView()
        load(blank) { it.loadUrl("about:blank") }
        load(blank) { it.loadDataWithBaseURL(BASE_A, "<title>A</title>", "text/html", "utf-8", BASE_A) }
        load(blank) { it.loadUrl("about:blank") }
        load(blank) { it.loadDataWithBaseURL(BASE_B, "<title>B</title>", "text/html", "utf-8", BASE_B) }
        report("about-blank-between", describe(blank))
    }

    /** The WebView package and version, the API level and the image the probe ran on. */
    private fun environment(): String {
        val webview = WebView.getCurrentWebViewPackage()
        val version = webview?.let { "${it.packageName} ${it.versionName} (code ${PackageInfoCompat.getLongVersionCode(it)})" } ?: "no WebView package"
        val agent = onMain { WebSettings.getDefaultUserAgent(app) }
        return "webview $version; user agent $agent; API ${Build.VERSION.SDK_INT} (Android ${Build.VERSION.RELEASE}); " +
            "image ${Build.FINGERPRINT}; model ${Build.MODEL}; abi ${Build.SUPPORTED_ABIS.firstOrNull()}"
    }

    /** The view's list – size, current index, every item's url / originalUrl / title – the commits reported and the pages finished, in order. */
    private fun describe(view: WebView): String {
        val list: WebBackForwardList = onMain { view.copyBackForwardList() }
        val items = (0 until list.size).map { i ->
            val item = list.getItemAtIndex(i)
            "[$i] url=${item.url} originalUrl=${item.originalUrl} title=${item.title}"
        }
        return "size ${list.size}, current ${list.currentIndex}, canGoBack ${onMain { view.canGoBack() }}, view.url ${onMain { view.url }}; " +
            "items ${items.joinToString(" | ")}; " +
            "doUpdateVisitedHistory ${committed[view]?.joinToString(" | ") ?: "(none)"}; " +
            "onPageFinished ${finishedUrls[view]?.joinToString(" | ") ?: "(none)"}"
    }

    /**
     * The finding, under [TAG] in the log and as instrumentation status: `fold-probe.<what>` for a
     * raw-mode reader, and on the runner's stream, which `am instrument -w` prints as it comes
     * (the workflow's `instrument.txt`, echoed into the job's log).
     */
    private fun report(what: String, line: String) {
        Log.i(TAG, "$what: $line")
        val status = Bundle()
        status.putString("fold-probe.$what", line)
        status.putString(Instrumentation.REPORT_KEY_STREAMRESULT, "\nfold-probe $what: $line\n")
        instrumentation.sendStatus(0, status)
    }

    private fun webView(): WebView = onMain {
        WebView(app).also { view ->
            view.settings.javaScriptEnabled = true
            view.webViewClient = client
            views += view
        }
    }

    /** Run `action` on `view` on the main thread and wait for the page finished it brings about. */
    private fun load(view: WebView, action: (WebView) -> Unit) {
        val latch = CountDownLatch(1)
        finished[view] = latch
        onMain { action(view) }
        assertTrue("the page finished loading", latch.await(20, TimeUnit.SECONDS))
    }

    private val finished = ConcurrentHashMap<WebView, CountDownLatch>()
    private val finishedUrls = ConcurrentHashMap<WebView, CopyOnWriteArrayList<String>>()
    private val committed = ConcurrentHashMap<WebView, CopyOnWriteArrayList<String>>()

    /**
     * A listening client: the sketch's `WebViewClient()` plus the callbacks the record needs, and
     * the one web page the variant loads between the documents, served from memory. Every other
     * request is left to the network (the `.example` hosts resolve to nothing).
     */
    private val client = object : WebViewClient() {
        override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
            if (request.url.toString() != WEB_PAGE) return null
            val html = "<!doctype html><title>Web page</title><h1>Web page between the documents</h1>"
            return WebResourceResponse("text/html", "utf-8", ByteArrayInputStream(html.toByteArray()))
        }

        override fun doUpdateVisitedHistory(view: WebView, url: String, isReload: Boolean) {
            committed.getOrPut(view) { CopyOnWriteArrayList() } += if (isReload) "$url (reload)" else url
        }

        override fun onPageFinished(view: WebView, url: String) {
            finishedUrls.getOrPut(view) { CopyOnWriteArrayList() } += url
            finished[view]?.countDown()
        }
    }

    private fun <T> onMain(block: () -> T): T {
        var result: T? = null
        instrumentation.runOnMainSync { result = block() }
        @Suppress("UNCHECKED_CAST")
        return result as T
    }

    private companion object {
        private const val TAG = "FoldProbe"
        private const val BASE_A = "https://a.example/"
        private const val BASE_B = "https://b.example/"
        private const val WEB_PAGE = "https://probe.example/page"
    }
}
