package app.zen.chromium.ext

import android.annotation.SuppressLint
import android.graphics.Color
import android.webkit.ConsoleMessage
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import app.zen.chromium.Host

/**
 * A WebView on an extension's origin: the hidden background page (`context = "background"`) or a
 * popup / options page (`context = "popup"` / `"options"`). It serves every file of the extension
 * directory plus the generated background page from `shouldInterceptRequest`, injects the page
 * bootstrap at document start and speaks the same `__zenExtBridge` protocol as tab frames.
 * Navigations off the origin open as tabs (a popup linking to a website, say); the view itself
 * never leaves the extension.
 */
@SuppressLint("SetJavaScriptEnabled")
class ExtensionWebView(
    private val host: Host,
    private val extensions: Extensions,
    val served: Extensions.Served,
    val context: String
) : WebView(host.activity) {
    private val origin = "https://${served.id}${Extensions.ORIGIN_SUFFIX}"
    /** Console lines of the page, for the probe and the demo (background pages have no visible UI). */
    val console = ArrayDeque<String>()

    init {
        settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = false
            allowContentAccess = false
            mediaPlaybackRequiresUserGesture = false
        }
        // Chrome paints popups white until the document says otherwise; the hidden background view has nothing to paint.
        setBackgroundColor(if (context == "background") Color.TRANSPARENT else Color.WHITE)
        webViewClient = Client()
        webChromeClient = Chrome()
        if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            WebViewCompat.addWebMessageListener(this, Extensions.BRIDGE, setOf(origin)) { view, message, source, isMainFrame, proxy ->
                extensions.onBridgeMessageFromPage(view, message.data, source, isMainFrame, proxy)
            }
        }
        if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
            WebViewCompat.addDocumentStartJavaScript(this, extensions.pageScript(served, context), setOf(origin))
        }
    }

    override fun destroy() {
        extensions.onWebViewDestroyed(this)
        super.destroy()
    }

    private inner class Client : WebViewClient() {
        override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
            extensions.intercept(request, null, served)

        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
            val url = request.url.toString()
            if (url.startsWith("$origin/")) return false
            if (url.startsWith("http:") || url.startsWith("https:")) {
                host.chrome.openUrl(url)
                if (context == "popup") extensions.closePopup()
            } else {
                host.openExternal(url)
            }
            return true
        }

        override fun onPageStarted(view: WebView, url: String, favicon: android.graphics.Bitmap?) {
            extensions.onDocumentGone(view, url)
        }

        override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
            val reason = if (detail.didCrash()) "crashed" else "killed"
            android.util.Log.w(Extensions.TAG, "renderer of the ${served.id.take(8)}/$context view gone ($reason)")
            extensions.onRendererGone(this@ExtensionWebView)
            return true
        }
    }

    private inner class Chrome : WebChromeClient() {
        override fun onConsoleMessage(message: ConsoleMessage): Boolean {
            val line = "${message.messageLevel()} ${message.sourceId()}:${message.lineNumber()} ${message.message()}"
            synchronized(console) {
                console.addLast(line)
                while (console.size > 200) console.removeFirst()
            }
            android.util.Log.d(Extensions.TAG, "[${served.id.take(8)}/$context] $line")
            return true
        }
    }
}
