package app.zen.chromium

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Color
import android.util.Log
import android.webkit.ConsoleMessage
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.webkit.WebViewAssetLoader
import org.json.JSONObject

/**
 * The WebView that renders Zen's chrome (sidebar, bottom bar, overlays) and runs the browser core.
 * It sits at the bottom of the view stack; tab WebViews are positioned above it wherever the chrome
 * reports the content area to be – the same arrangement as the Electron window.
 */
@SuppressLint("SetJavaScriptEnabled")
class ChromeWebView(context: Context, private val host: Host) : WebView(context) {
    private val loader = WebViewAssetLoader.Builder()
        .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(context))
        .build()
    var ready = false
        private set
    private val whenReady = ArrayList<() -> Unit>()

    init {
        settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = false
            allowContentAccess = false
            mediaPlaybackRequiresUserGesture = false
            setSupportZoom(false)
            builtInZoomControls = false
            displayZoomControls = false
            // The chrome is designed in CSS pixels; system font scaling would break its layout.
            textZoom = 100
            cacheMode = android.webkit.WebSettings.LOAD_DEFAULT
        }
        setBackgroundColor(Color.TRANSPARENT)
        overScrollMode = OVER_SCROLL_NEVER
        isVerticalScrollBarEnabled = false
        isHorizontalScrollBarEnabled = false
        addJavascriptInterface(JsBridge(host), "__zenNative")
        webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
                loader.shouldInterceptRequest(request.url)

            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                // The chrome never navigates; anything that tries is an external link.
                val url = request.url.toString()
                if (url.startsWith(APP_ORIGIN) || url.startsWith(BuildConfig.DEV_SERVER_URL.ifEmpty { "\u0000" })) return false
                host.openExternal(url)
                return true
            }

            override fun onPageFinished(view: WebView, url: String) {
                ready = true
                whenReady.forEach { it() }
                whenReady.clear()
            }

            /**
             * The chrome's renderer died (OOM, system pressure). Returning false here would take the
             * whole app down; instead the host rebuilds the chrome, which reboots the core from its
             * persisted state.
             */
            override fun onRenderProcessGone(view: WebView, detail: android.webkit.RenderProcessGoneDetail): Boolean {
                ready = false
                Log.e("ZenChrome", "chrome renderer gone (crashed=${detail.didCrash()}); rebuilding the chrome")
                host.onChromeGone(this@ChromeWebView)
                return true
            }
        }
        webChromeClient = object : WebChromeClient() {
            override fun onConsoleMessage(message: ConsoleMessage): Boolean {
                val level = when (message.messageLevel()) {
                    ConsoleMessage.MessageLevel.ERROR -> Log.ERROR
                    ConsoleMessage.MessageLevel.WARNING -> Log.WARN
                    else -> Log.DEBUG
                }
                Log.println(level, "ZenChrome", "${message.message()} (${message.sourceId()}:${message.lineNumber()})")
                return true
            }
        }
    }

    fun load() {
        val dev = BuildConfig.DEV_SERVER_URL
        loadUrl(if (dev.isNotEmpty()) dev else "$APP_ORIGIN/assets/www/index.html")
    }

    /** Run once the chrome document has loaded (queued before that). */
    fun onReady(block: () -> Unit) {
        if (ready) block() else whenReady.add(block)
    }

    // --- Kotlin → JS -----------------------------------------------------------------------

    fun resolve(id: Int, result: Any?) {
        js("window.__zenHost&&__zenHost.resolve($id,${JSONObject.quote(encodeResult(result))})")
    }

    fun reject(id: Int, message: String) {
        js("window.__zenHost&&__zenHost.reject($id,${JSONObject.quote(message)})")
    }

    fun viewEvent(tabId: String, name: String, payload: Any?) {
        js("window.__zenHost&&__zenHost.viewEvent(${JSONObject.quote(tabId)},${JSONObject.quote(name)},${JSONObject.quote(encodeResult(payload))})")
    }

    fun hostEvent(name: String, payload: Any?) {
        js("window.__zenHost&&__zenHost.hostEvent(${JSONObject.quote(name)},${JSONObject.quote(encodeResult(payload))})")
    }

    /** Forward a physical key; the promise-free path relies on Kotlin having matched it already. */
    fun onKey(tabId: String?, input: JSONObject) {
        val tab = if (tabId == null) "null" else JSONObject.quote(tabId)
        js("window.__zenHost&&__zenHost.onKey($tab,${JSONObject.quote(input.toString())})")
    }

    fun onBack(callback: (Boolean) -> Unit) {
        evaluateJavascript("window.__zenHost?__zenHost.onBack():false") { result -> callback(result == "true") }
    }

    fun openUrl(url: String) {
        onReady { js("window.__zenHost&&__zenHost.openUrl(${JSONObject.quote(url)})") }
    }

    private fun js(code: String) {
        if (ready) evaluateJavascript(code, null) else whenReady.add { evaluateJavascript(code, null) }
    }

    companion object {
        const val APP_ORIGIN = "https://appassets.androidplatform.net"
    }
}
