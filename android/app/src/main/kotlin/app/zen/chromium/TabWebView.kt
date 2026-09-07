package app.zen.chromium

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Outline
import android.graphics.Rect
import android.net.Uri
import android.net.http.SslError
import android.os.Handler
import android.os.Looper
import android.os.Message
import android.util.Base64
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.PixelCopy
import android.view.View
import android.view.ViewOutlineProvider
import android.webkit.CookieManager
import android.webkit.GeolocationPermissions
import android.webkit.JavascriptInterface
import android.webkit.PermissionRequest
import android.webkit.SslErrorHandler
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.WebMessageCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.util.concurrent.Executors

/**
 * One tab's page. Mirrors what Electron's `WebContentsView` gives the core: navigation events,
 * title/favicon, load failures mapped to Chromium net error codes, HTML fullscreen, find-in-page,
 * downloads, permission prompts, popups and the injected Zen page script.
 */
@SuppressLint("SetJavaScriptEnabled", "ClickableViewAccessibility")
class TabWebView(
    context: Context,
    var tabId: String,
    val containerId: String,
    private val host: Host
) : WebView(context) {
    private var loading = false
    private var lastTouchX = 0f
    private var lastTouchY = 0f
    private var radiusPx = 0f
    private var replyProxy: JavaScriptReplyProxy? = null
    private var currentFlags: JSONObject = json("glanceEnabled" to true, "glanceTrigger" to "alt", "thirdParty" to null)
    private var pendingFlags = false
    var muted = false
        private set
    /** True while `onPageStarted` has fired and `onPageFinished` has not. */
    private var pageStarted = false

    init {
        Profiles.apply(this, containerId)
        settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = false
            allowContentAccess = false
            loadWithOverviewMode = true
            useWideViewPort = true
            setSupportZoom(true)
            builtInZoomControls = true
            displayZoomControls = false
            setSupportMultipleWindows(true)
            javaScriptCanOpenWindowsAutomatically = true
            mediaPlaybackRequiresUserGesture = true
            mixedContentMode = WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE
            if (WebViewFeature.isFeatureSupported(WebViewFeature.SAFE_BROWSING_ENABLE)) safeBrowsingEnabled = true
            // Sites treat the "; wv" token as an embedded view and serve degraded pages.
            userAgentString = userAgentString.replace("; wv", "").replace(Regex("Version/\\d+\\.\\d+ "), "")
        }
        CookieManager.getInstance().setAcceptThirdPartyCookies(this, true)
        setBackgroundColor(Color.WHITE)
        clipToOutline = true
        outlineProvider = object : ViewOutlineProvider() {
            override fun getOutline(view: View, outline: Outline) {
                outline.setRoundRect(0, 0, view.width, view.height, radiusPx)
            }
        }
        isFocusableInTouchMode = true
        webViewClient = Client()
        webChromeClient = Chrome()
        setDownloadListener { url, userAgent, contentDisposition, mimetype, contentLength ->
            host.downloads.start(url, userAgent, contentDisposition, mimetype, contentLength, tabId)
        }
        setFindListener { activeMatchOrdinal, numberOfMatches, isDoneCounting ->
            host.chrome.viewEvent(
                tabId, "found",
                json(
                    "activeMatchOrdinal" to (if (numberOfMatches == 0) 0 else activeMatchOrdinal + 1),
                    "matches" to numberOfMatches,
                    "finalUpdate" to isDoneCounting
                )
            )
        }
        setOnLongClickListener { onLongPress() }
        // Mouse right-click / stylus button (DeX, tablets) opens the same menu as a long-press.
        setOnContextClickListener { onLongPress() }
        installPageScript()
    }

    // --- placement ------------------------------------------------------------------------------

    fun setRadius(px: Float) {
        radiusPx = px
        invalidateOutline()
    }

    // --- page script (Glance, third-party links, media tracking) -------------------------------

    private fun installPageScript() {
        val script = host.pageScript
        if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            WebViewCompat.addWebMessageListener(this, "__zenPageBridge", setOf("*")) { _, message, _, isMainFrame, proxy ->
                if (!isMainFrame) return@addWebMessageListener
                onPageMessage(message, proxy)
            }
        } else {
            addJavascriptInterface(LegacyPageBridge(), "__zenPageBridge")
        }
        if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
            WebViewCompat.addDocumentStartJavaScript(this, script, setOf("*"))
        } else {
            pendingFlags = true // inject on page finished instead (see Client)
        }
    }

    private fun onPageMessage(message: WebMessageCompat, proxy: JavaScriptReplyProxy?) {
        val data = message.data ?: return
        val obj = runCatching { JSONObject(data) }.getOrNull() ?: return
        if (obj.str("token") != host.pageToken) return
        if (obj.str("type") == "hello") {
            replyProxy = proxy
            sendFlags()
            return
        }
        obj.remove("token")
        host.chrome.viewEvent(tabId, "pageMessage", obj)
    }

    private inner class LegacyPageBridge {
        @JavascriptInterface
        fun postMessage(data: String) {
            Handler(Looper.getMainLooper()).post {
                onPageMessage(WebMessageCompat(data), null)
            }
        }
    }

    fun setFlags(flags: JSONObject) {
        currentFlags = flags
        sendFlags()
    }

    /** Boost "zap element" picker on/off (handled by the injected page script). */
    fun setZap(on: Boolean) {
        postToPage(json("type" to "zap", "on" to on).toString())
    }

    private fun sendFlags() {
        postToPage(json("type" to "flags", "flags" to currentFlags).toString())
    }

    /** Deliver a browser → page message over the reply proxy (or the legacy bridge). */
    private fun postToPage(payload: String) {
        val proxy = replyProxy
        if (proxy != null) {
            runCatching { proxy.postMessage(payload) }
        } else if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            evaluateJavascript(
                "window.__zenPageBridge&&__zenPageBridge.onmessage&&__zenPageBridge.onmessage({data:${JSONObject.quote(payload)}})",
                null
            )
        }
    }

    // --- input ---------------------------------------------------------------------------------

    override fun onTouchEvent(event: MotionEvent): Boolean {
        lastTouchX = event.x
        lastTouchY = event.y
        return super.onTouchEvent(event)
    }

    /** Long-press on links/images opens Zen's page menu; text selection stays native. */
    private fun onLongPress(): Boolean {
        val result = hitTestResult
        val density = resources.displayMetrics.density
        val anchorX = (left + lastTouchX) / density
        val anchorY = (top + lastTouchY) / density
        when (result.type) {
            HitTestResult.SRC_ANCHOR_TYPE, HitTestResult.SRC_IMAGE_ANCHOR_TYPE -> {
                val msg = Message.obtain(Handler(Looper.getMainLooper()) { m ->
                    val href = m.data.getString("url") ?: result.extra ?: ""
                    val src = m.data.getString("src") ?: ""
                    host.chrome.viewEvent(
                        tabId, "contextMenu",
                        json(
                            "linkURL" to href,
                            "srcURL" to src,
                            "mediaType" to if (src.isNotEmpty()) "image" else "none",
                            "x" to anchorX, "y" to anchorY
                        )
                    )
                    true
                })
                requestFocusNodeHref(msg)
                return true
            }
            HitTestResult.IMAGE_TYPE -> {
                host.chrome.viewEvent(
                    tabId, "contextMenu",
                    json("linkURL" to "", "srcURL" to (result.extra ?: ""), "mediaType" to "image", "x" to anchorX, "y" to anchorY)
                )
                return true
            }
        }
        return false
    }

    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        if (event.action == KeyEvent.ACTION_DOWN) {
            val isEscape = event.keyCode == KeyEvent.KEYCODE_ESCAPE
            if (host.keys.matches(event) || isEscape) {
                host.keys.toInput(event)?.let { host.chrome.onKey(tabId, it) }
                if (!isEscape) return true
            }
        }
        return super.dispatchKeyEvent(event)
    }

    // --- operations used by the core -------------------------------------------------------------

    fun loadHtml(url: String, html: String) {
        pageStarted = false
        loadDataWithBaseURL(url, html, "text/html", "utf-8", url)
    }

    fun setMuted(muted: Boolean) {
        this.muted = muted
        // WebView has no audio mute; mute the page's media elements (kept in sync by the page).
        evaluateJavascript(
            "(function(m){window.__zenMuted=m;document.querySelectorAll('audio,video').forEach(function(e){e.muted=m});})($muted)",
            null
        )
    }

    fun setZoom(factor: Double) {
        settings.textZoom = (factor * 100).toInt().coerceIn(25, 500)
    }

    fun find(text: String, forward: Boolean, newSession: Boolean) {
        if (newSession) findAllAsync(text) else findNext(forward)
    }

    fun stopFind() {
        clearMatches()
    }

    /** Downscaled JPEG of what is on screen right now, for the dimmed preview behind overlays. */
    fun snapshot(callback: (String?) -> Unit) {
        val window = host.activity.window
        if (width <= 0 || height <= 0 || !isShown) {
            callback(null)
            return
        }
        val scale = if (width > 1400) 1400f / width else 0.5f
        val bitmap = Bitmap.createBitmap((width * scale).toInt().coerceAtLeast(1), (height * scale).toInt().coerceAtLeast(1), Bitmap.Config.RGB_565)
        val location = IntArray(2)
        getLocationInWindow(location)
        val rect = Rect(location[0], location[1], location[0] + width, location[1] + height)
        val finish: (Boolean) -> Unit = { ok ->
            if (!ok) {
                callback(null)
            } else {
                encoder.execute {
                    val out = ByteArrayOutputStream()
                    bitmap.compress(Bitmap.CompressFormat.JPEG, 62, out)
                    bitmap.recycle()
                    val data = "data:image/jpeg;base64," + Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP)
                    Handler(Looper.getMainLooper()).post { callback(data) }
                }
            }
        }
        try {
            PixelCopy.request(window, rect, bitmap, { result -> finish(result == PixelCopy.SUCCESS) }, Handler(Looper.getMainLooper()))
        } catch (e: Exception) {
            // Software fallback (e.g. before the window is attached).
            runCatching {
                val canvas = Canvas(bitmap)
                canvas.scale(scale, scale)
                draw(canvas)
            }.onSuccess { finish(true) }.onFailure { finish(false) }
        }
    }

    /** Full-resolution PNG bytes of the page, or null. */
    fun screenshot(callback: (ByteArray?) -> Unit) {
        if (width <= 0 || height <= 0 || !isShown) {
            callback(null)
            return
        }
        val bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
        val location = IntArray(2)
        getLocationInWindow(location)
        val rect = Rect(location[0], location[1], location[0] + width, location[1] + height)
        val encode = {
            encoder.execute {
                val out = ByteArrayOutputStream()
                bitmap.compress(Bitmap.CompressFormat.PNG, 100, out)
                bitmap.recycle()
                Handler(Looper.getMainLooper()).post { callback(out.toByteArray()) }
            }
        }
        try {
            PixelCopy.request(host.activity.window, rect, bitmap, { result ->
                if (result == PixelCopy.SUCCESS) encode() else callback(null)
            }, Handler(Looper.getMainLooper()))
        } catch (e: Exception) {
            callback(null)
        }
    }

    fun navState(): JSONObject = json(
        "url" to (url ?: ""),
        "title" to (title ?: ""),
        "canGoBack" to canGoBack(),
        "canGoForward" to canGoForward()
    )

    // --- WebViewClient ------------------------------------------------------------------------

    private inner class Client : WebViewClient() {
        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
            val url = request.url
            return when (url.scheme?.lowercase()) {
                "http", "https", "about", "data", "blob", "javascript" -> false
                else -> {
                    host.openExternal(url.toString())
                    true
                }
            }
        }

        override fun onPageStarted(view: WebView, url: String, favicon: Bitmap?) {
            pageStarted = true
            loading = true
            host.chrome.viewEvent(tabId, "startLoading", null)
            host.chrome.viewEvent(tabId, "navigated", navState().put("url", url).put("inPage", false))
            if (muted) setMuted(true)
        }

        override fun doUpdateVisitedHistory(view: WebView, url: String, isReload: Boolean) {
            if (!loading) {
                // pushState / hash navigation after the page finished loading.
                host.chrome.viewEvent(tabId, "navigated", navState().put("url", url).put("inPage", true))
            }
        }

        override fun onPageFinished(view: WebView, url: String) {
            loading = false
            pageStarted = false
            if (pendingFlags) {
                evaluateJavascript(host.pageScript, null)
            }
            host.chrome.viewEvent(tabId, "stopLoading", navState())
            if (muted) setMuted(true)
        }

        override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
            if (!request.isForMainFrame) return
            loading = false
            host.chrome.viewEvent(
                tabId, "failLoad",
                json(
                    "code" to netErrorCode(error.errorCode),
                    "description" to error.description.toString(),
                    "url" to request.url.toString()
                )
            )
        }

        override fun onReceivedSslError(view: WebView, handler: SslErrorHandler, error: SslError) {
            // Like Chrome, never proceed with a broken certificate; the error page explains why.
            handler.cancel()
            val code = when (error.primaryError) {
                SslError.SSL_EXPIRED, SslError.SSL_NOTYETVALID -> -201
                SslError.SSL_UNTRUSTED, SslError.SSL_IDMISMATCH -> -200
                else -> -202
            }
            loading = false
            host.chrome.viewEvent(tabId, "failLoad", json("code" to code, "description" to "ERR_CERT_INVALID", "url" to error.url))
        }

        override fun onRenderProcessGone(view: WebView, detail: android.webkit.RenderProcessGoneDetail): Boolean {
            val reason = if (detail.didCrash()) "crashed" else "killed"
            host.tabs.replaceCrashed(this@TabWebView)
            host.chrome.viewEvent(tabId, "crashed", json("reason" to reason))
            return true
        }
    }

    // --- WebChromeClient ----------------------------------------------------------------------

    private inner class Chrome : WebChromeClient() {
        override fun onReceivedTitle(view: WebView, title: String?) {
            host.chrome.viewEvent(tabId, "title", json("title" to (title ?: "")))
        }

        override fun onReceivedIcon(view: WebView, icon: Bitmap) {
            encoder.execute {
                val size = 32
                val scaled = if (icon.width > size) Bitmap.createScaledBitmap(icon, size, size, true) else icon
                val out = ByteArrayOutputStream()
                scaled.compress(Bitmap.CompressFormat.PNG, 100, out)
                val data = "data:image/png;base64," + Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP)
                Handler(Looper.getMainLooper()).post { host.chrome.viewEvent(tabId, "favicon", json("url" to data)) }
            }
        }

        override fun onShowCustomView(view: View, callback: CustomViewCallback) {
            host.enterFullscreen(this@TabWebView, view, callback)
        }

        override fun onHideCustomView() {
            host.exitFullscreen(this@TabWebView)
        }

        override fun onPermissionRequest(request: PermissionRequest) {
            host.permissions.onPermissionRequest(this@TabWebView, request)
        }

        override fun onGeolocationPermissionsShowPrompt(origin: String, callback: GeolocationPermissions.Callback) {
            host.permissions.onGeolocation(this@TabWebView, origin, callback)
        }

        override fun onShowFileChooser(
            webView: WebView,
            filePathCallback: ValueCallback<Array<Uri>>,
            fileChooserParams: FileChooserParams
        ): Boolean = host.activity.showFileChooser(filePathCallback, fileChooserParams)

        override fun onCreateWindow(view: WebView, isDialog: Boolean, isUserGesture: Boolean, resultMsg: Message): Boolean {
            // Hand the popup a real WebView so `window.opener` keeps working, then adopt it as a tab.
            val popup = host.tabs.createPopup(containerId)
            (resultMsg.obj as WebViewTransport).webView = popup
            resultMsg.sendToTarget()
            host.chrome.hostEvent("view.adopt", json("viewId" to popup.tabId, "parentTabId" to tabId, "active" to isUserGesture))
            return true
        }

        override fun onCloseWindow(window: WebView) {
            // Pages closing themselves are rare enough that leaving the tab open is fine.
        }
    }

    companion object {
        private val encoder = Executors.newSingleThreadExecutor { r -> Thread(r, "zen-encode") }

        /** WebViewClient error codes → Chromium `net::` codes the core (and error page) understand. */
        fun netErrorCode(code: Int): Int = when (code) {
            WebViewClient.ERROR_HOST_LOOKUP -> -105
            WebViewClient.ERROR_CONNECT -> -102
            WebViewClient.ERROR_TIMEOUT -> -118
            WebViewClient.ERROR_IO -> -100
            WebViewClient.ERROR_REDIRECT_LOOP -> -310
            WebViewClient.ERROR_UNSUPPORTED_SCHEME, WebViewClient.ERROR_BAD_URL -> -300
            WebViewClient.ERROR_FAILED_SSL_HANDSHAKE -> -200
            WebViewClient.ERROR_FILE, WebViewClient.ERROR_FILE_NOT_FOUND -> -6
            WebViewClient.ERROR_UNSAFE_RESOURCE -> -20
            WebViewClient.ERROR_TOO_MANY_REQUESTS -> -100
            WebViewClient.ERROR_AUTHENTICATION, WebViewClient.ERROR_PROXY_AUTHENTICATION,
            WebViewClient.ERROR_UNSUPPORTED_AUTH_SCHEME -> -100
            else -> -2
        }
    }
}
