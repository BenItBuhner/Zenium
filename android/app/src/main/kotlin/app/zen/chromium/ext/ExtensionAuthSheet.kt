package app.zen.chromium.ext

import android.annotation.SuppressLint
import android.graphics.Bitmap
import android.graphics.Color
import android.view.View
import android.view.ViewGroup
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import app.zen.chromium.BuildConfig
import app.zen.chromium.Host
import app.zen.chromium.Profiles
import app.zen.chromium.UserAgent
import java.io.ByteArrayInputStream

/**
 * The view of one `identity.launchWebAuthFlow` on a phone: the provider's pages in a WebView on
 * the regular profile (a session the user already has with the provider counts, as in Chrome's
 * auth window), inside the v2 sheet ([ExtensionSheet]) once the flow asks to [show] it. Until
 * then the WebView loads detached, laid out at the size it will have in the sheet so the page
 * settles on its final viewport; a silent flow never shows it at all.
 *
 * The sheet reports what the shared flow (`core/extensions/api/webAuthFlow.ts`) decides on, as
 * `ext.authView { viewId, event, url }`: every top-frame navigation (`navigating`; one back to
 * `https://<id>.chromiumapp.org/…` is cancelled here before a request goes out, and one that
 * committed anyway after a POST lands on [LANDING] and is reported from `onPageStarted`), a
 * page loaded, a main-frame failure, and the user's dismissal (`closed`). The flow's own [close]
 * reports nothing back.
 */
@SuppressLint("SetJavaScriptEnabled")
class ExtensionAuthSheet(
    private val host: Host,
    val viewId: Int,
    val extensionId: String,
    private val title: String,
    private val report: (event: String, url: String?) -> Unit
) {
    private val activity = host.activity
    val webView = NestedScrollWebView(activity)
    private var sheet: ExtensionSheet? = null
    private var closed = false

    init {
        Profiles.apply(webView, Profiles.DEFAULT_CONTAINER)
        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = false
            allowContentAccess = false
            loadWithOverviewMode = true
            useWideViewPort = true
        }
        UserAgent.apply(webView.settings, BuildConfig.VERSION_NAME)
        webView.setBackgroundColor(Color.WHITE)
        webView.importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
        webView.webViewClient = Client()
        // The size the body will have in the sheet, so the page lays out for it before it is seen.
        val width = activity.resources.displayMetrics.widthPixels
        val height = bodyHeight()
        webView.layoutParams = FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, height)
        webView.measure(
            View.MeasureSpec.makeMeasureSpec(width, View.MeasureSpec.EXACTLY),
            View.MeasureSpec.makeMeasureSpec(height, View.MeasureSpec.EXACTLY)
        )
        webView.layout(0, 0, width, height)
        webView.setOnScrollChangeListener { _, _, scrollY, _, _ -> sheet?.setScrolled(scrollY > 0) }
    }

    fun load(url: String) {
        if (!closed) webView.loadUrl(url)
    }

    /** Bring the sheet up (an interactive flow's first page loaded, or a silent one needs the user after all). */
    fun show() {
        if (closed || sheet != null) return
        val s = ExtensionSheet(host, currentTitle(), webView) {
            if (closed) return@ExtensionSheet
            closed = true
            teardown()
            report(EVENT_CLOSED, null)
        }
        sheet = s
        s.show()
    }

    /** The flow is over: down without a word. */
    fun close() {
        if (closed) return
        closed = true
        val s = sheet
        sheet = null
        s?.dismiss()
        teardown()
    }

    private fun teardown() {
        webView.stopLoading()
        (webView.parent as? ViewGroup)?.removeView(webView)
        webView.destroy()
    }

    /** The screen minus the sheet's grip and header and the margin above it (see [ExtensionSheet.maxBodyHeight]). */
    private fun bodyHeight(): Int {
        val density = activity.resources.displayMetrics.density
        val chrome = ((ExtensionSheet.GRIP_DP + ExtensionSheet.HEADER_DP) * density + 0.5f).toInt()
        return (activity.resources.displayMetrics.heightPixels * 0.85f).toInt() - chrome
    }

    /** The header names where the user is: the page's host once there is one, the extension before. */
    private fun currentTitle(): String = webView.url?.let(::hostOf) ?: title

    private inner class Client : WebViewClient() {
        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
            if (!request.isForMainFrame) return false
            val url = request.url.toString()
            if (IdentityRedirect.isRedirectBack(extensionId, url)) {
                report(EVENT_NAVIGATING, url)
                return true
            }
            // The sheet shows web pages only; a custom scheme (an app link) is not followed.
            return !(url.startsWith("http:", true) || url.startsWith("https:", true))
        }

        override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
            if (request.isForMainFrame && IdentityRedirect.isRedirectBack(extensionId, request.url.toString())) {
                return WebResourceResponse("text/html", "utf-8", 200, "OK", emptyMap(), ByteArrayInputStream(LANDING))
            }
            return null
        }

        override fun onPageStarted(view: WebView, url: String, favicon: Bitmap?) {
            sheet?.setTitle(hostOf(url) ?: title)
            report(EVENT_NAVIGATING, url)
        }

        override fun onPageFinished(view: WebView, url: String) {
            report(EVENT_LOADED, url)
        }

        override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
            // The WebView never reports its own cancellations (ERR_ABORTED), so every one here is a real failure.
            if (request.isForMainFrame) report(EVENT_FAILED, request.url.toString())
        }
    }

    companion object {
        const val EVENT_NAVIGATING = "navigating"
        const val EVENT_LOADED = "loaded"
        const val EVENT_FAILED = "failed"
        const val EVENT_CLOSED = "closed"
        /** What a redirect back that committed anyway shows for the instant before the flow closes the sheet. */
        val LANDING: ByteArray = "<!doctype html><meta charset=\"utf-8\"><title>Signing in…</title>".toByteArray()

        /** The host of an http(s) URL, for the header (credentials and port dropped); null for anything else. */
        fun hostOf(url: String): String? {
            val schemeEnd = url.indexOf("://")
            if (schemeEnd <= 0) return null
            val scheme = url.substring(0, schemeEnd)
            if (!scheme.equals("http", true) && !scheme.equals("https", true)) return null
            var end = schemeEnd + 3
            while (end < url.length && url[end] != '/' && url[end] != '?' && url[end] != '#') end++
            val authority = url.substring(schemeEnd + 3, end).substringAfterLast('@')
            val host = if (authority.startsWith("[")) authority.substringBefore(']') + "]" else authority.substringBefore(':')
            return host.ifEmpty { null }?.lowercase()
        }
    }
}
