package app.zen.chromium

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Bitmap
import android.graphics.Color
import android.net.Uri
import android.util.Log
import android.webkit.ConsoleMessage
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.webkit.WebViewAssetLoader
import app.zen.chromium.ext.ExtensionStore
import org.json.JSONObject
import java.io.File

/**
 * The WebView that renders Zen's chrome (sidebar, bottom bar, overlays) and runs the browser core.
 * It sits at the bottom of the view stack; tab WebViews are positioned above it wherever the chrome
 * reports the content area to be – the same arrangement as the Electron window.
 */
@SuppressLint("SetJavaScriptEnabled")
class ChromeWebView(context: Context, private val host: Host) : WebView(context) {
    private val loader = WebViewAssetLoader.Builder()
        .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(context))
        // The extension store's package files (downloads and picked documents) and the installed
        // extensions' files, streamed to the core without a trip through the JS bridge
        // (ext/ExtensionStore.kt, src/android/extensionStoreIo.ts).
        .addPathHandler(PACKAGES_PATH, WebViewAssetLoader.InternalStoragePathHandler(context, File(context.cacheDir, ExtensionStore.PACKAGES_DIR)))
        .addPathHandler(EXTENSION_FILES_PATH, WebViewAssetLoader.InternalStoragePathHandler(context, File(context.filesDir, ExtensionStore.ROOT_DIR)))
        // Downloaded translation models (`Translate.kt`), read by the engine worker of the chrome.
        .addPathHandler("/translate/", WebViewAssetLoader.InternalStoragePathHandler(context, Translate.modelsDir(context)))
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
            // The chrome places focus itself (the address field, a dialog's first field). With a
            // keyboard attached the device is out of touch mode, and requestFocus() would otherwise
            // hand focus to the first focusable node in the document instead.
            setNeedInitialFocus(false)
        }
        setBackgroundColor(Color.TRANSPARENT)
        overScrollMode = OVER_SCROLL_NEVER
        isVerticalScrollBarEnabled = false
        isHorizontalScrollBarEnabled = false
        addJavascriptInterface(JsBridge(host), "__zenNative")
        webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
                handoffResponse(request.url) ?: loader.shouldInterceptRequest(request.url)

            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                // The chrome never navigates; anything that tries is an external link.
                val url = request.url.toString()
                if (url.startsWith(APP_ORIGIN) || url.startsWith(BuildConfig.DEV_SERVER_URL.ifEmpty { "\u0000" })) return false
                host.openExternal(url)
                return true
            }

            override fun onPageStarted(view: WebView, url: String, favicon: Bitmap?) {
                // A document after the first: the chrome reloaded itself (its error screen offers
                // that). Everything queued was for the core in the old document; the host drops the
                // tab views that core owned, and the new one recreates them.
                if (!ready) return
                ready = false
                whenReady.clear()
                Log.w("ZenChrome", "the chrome document is being replaced ($url); dropping the old core's tab views")
                host.onChromeDocumentReplaced()
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
                whenReady.clear()
                Log.e(
                    "ZenChrome",
                    "chrome renderer gone (${if (detail.didCrash()) "crashed" else "killed"}, priority at exit " +
                        "${detail.rendererPriorityAtExit()}); rebuilding the chrome"
                )
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

            /** The chrome's own file inputs (the new tab page's wallpaper) use the system picker too. */
            override fun onShowFileChooser(
                webView: WebView,
                filePathCallback: ValueCallback<Array<Uri>>,
                fileChooserParams: FileChooserParams
            ): Boolean = host.activity.showFileChooser(filePathCallback, fileChooserParams)
        }
    }

    fun load() {
        val dev = BuildConfig.DEV_SERVER_URL
        loadUrl(if (dev.isNotEmpty()) dev else "$APP_ORIGIN/assets/www/index.html")
    }

    /**
     * The file-backed handoffs (`BootHandoff.kt`) on the app origin: the core's big boot documents
     * under `/zen-docs/<name>` and the spilled `net.fetch` bodies under `/zen-net/<token>`, streamed
     * from their files on WebView's IO thread. Null for every other URL (the asset loader's turn).
     * `Cache-Control: no-store` keeps the renderer from answering a later boot with a stale copy;
     * the `ETag` is the version tag the boot manifest named, for the chrome to compare.
     */
    private fun handoffResponse(url: Uri): WebResourceResponse? {
        if (url.host != APP_HOST) return null
        val path = url.path ?: return null
        val answer = when {
            path.startsWith(BootHandoff.DOCS_PATH) -> host.handoff.document(path.removePrefix(BootHandoff.DOCS_PATH))
            path.startsWith(BootHandoff.NET_PATH) -> host.handoff.spilled(path.removePrefix(BootHandoff.NET_PATH))
            else -> return null
        }
        if (!answer.ok) return WebResourceResponse("text/plain", "utf-8", 404, "Not Found", emptyMap(), null)
        val headers = HashMap<String, String>()
        headers["Cache-Control"] = "no-store"
        headers["Content-Length"] = answer.length.toString()
        answer.etag?.let { headers["ETag"] = "\"$it\"" }
        return WebResourceResponse(answer.mimeType, "utf-8", 200, "OK", headers, answer.stream)
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

    /**
     * A back gesture aimed at the chrome: `start` (with the swipe edge), `progress` (0…1) and
     * `cancel` are fire-and-forget; the topmost chrome surface moves with them (see the chrome's
     * `lib/back.ts`).
     */
    fun backEvent(phase: String, payload: JSONObject?) {
        js("window.__zenHost&&__zenHost.backEvent(${JSONObject.quote(phase)},${JSONObject.quote(encodeResult(payload))})")
    }

    /**
     * A pull-to-refresh on a tab's page as the WebView recognises it: `start`, `move` (with the
     * finger's travel in CSS px) and `release` or `cancel`; the chrome's `lib/pull.ts` moves the
     * page and reloads it (see `PullToRefreshGesture.kt`).
     */
    fun pullEvent(tabId: String, phase: String, payload: JSONObject?) {
        js("window.__zenHost&&__zenHost.pullEvent(${JSONObject.quote(tabId)},${JSONObject.quote(phase)},${JSONObject.quote(encodeResult(payload))})")
    }

    /** Commit the gesture; answers whether the chrome had anything to dismiss or navigate. */
    fun backCommit(callback: (Boolean) -> Unit) {
        evaluateJavascript("window.__zenHost?__zenHost.backEvent('commit',null):false") { result -> callback(result == "true") }
    }

    fun openUrl(url: String) {
        onReady { js("window.__zenHost&&__zenHost.openUrl(${JSONObject.quote(url)})") }
    }

    private fun js(code: String) {
        if (ready) evaluateJavascript(code, null) else whenReady.add { evaluateJavascript(code, null) }
    }

    companion object {
        const val APP_HOST = "appassets.androidplatform.net"
        const val APP_ORIGIN = "https://$APP_HOST"
        /** Package files by token (`extensionStoreIo.ts` PACKAGES_PATH). */
        const val PACKAGES_PATH = "/ext-packages/"
        /** Installed extension files, `<id>/<version>/<path>` (`extensionStoreIo.ts` FILES_PATH). */
        const val EXTENSION_FILES_PATH = "/ext-files/"
    }
}
