package app.zen.chromium.ext

import android.annotation.SuppressLint
import android.graphics.Canvas
import android.graphics.Color
import android.webkit.ConsoleMessage
import android.webkit.JsPromptResult
import android.webkit.JsResult
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import app.zen.chromium.BuildConfig
import app.zen.chromium.Host
import app.zen.chromium.PageDialogKind
import app.zen.chromium.PageDialogSheet
import app.zen.chromium.PageDialogSpec
import app.zen.chromium.PageDialogVisit
import app.zen.chromium.UserAgent

/**
 * A WebView on an extension's origin: the hidden background page (`context = "background"`), the
 * hidden offscreen document of `chrome.offscreen` (`"offscreen"`) or a popup / options / side
 * panel page in the sheet (`context = "popup"` / `"options"` / `"sidePanel"`). It serves every file of the extension
 * directory plus the generated background page from `shouldInterceptRequest`, injects the page
 * bootstrap at document start and speaks the same `__zenExtBridge` protocol as tab frames.
 * Navigations off the origin open as tabs (a popup linking to a website, say); the view itself
 * never leaves the extension. The page's own dialogs are the host's sheet, titled with the
 * extension's name as Chrome titles them ([ExtensionPageDialogs], [pageDialog]).
 */
@SuppressLint("SetJavaScriptEnabled")
class ExtensionWebView(
    private val host: Host,
    private val extensions: Extensions,
    val served: Extensions.Served,
    val context: String,
    /** The extension's name, the title line of the page's dialogs (Chrome's); the id when the caller has none (a hidden view shows no dialog). */
    private val name: String = served.id
) : NestedScrollWebView(host.activity) {
    private val origin = "https://${served.id}${Extensions.ORIGIN_SUFFIX}"
    /** Console lines of the page, for the probe and the demo (background pages have no visible UI). */
    val console = ArrayDeque<String>()
    /** The page's dialog up: the sheet and the WebView's result it answers. */
    private class PageDialogUp(val sheet: PageDialogSheet, val result: JsResult)
    private var dialog: PageDialogUp? = null
    /** Chrome's per-visit count of the page's dialogs, for the "create no more dialogs" check row from its second on. */
    private val dialogVisit = PageDialogVisit()

    init {
        settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = false
            allowContentAccess = false
            mediaPlaybackRequiresUserGesture = false
            // Chrome's extension pages are not subject to mixed-content blocking (their scheme
            // is `chrome-extension:`, not `https:`), so an extension with `host_permissions` for
            // an `http://` host may fetch it. Ours live on the emulated https origin, where the
            // renderer would refuse the fetch before it reached the CORS proxy; what the page may
            // reach is gated by the extension's host permissions in the proxy either way.
            mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
        }
        // Extension pages present as Zenium, as tab pages do; the CORS proxy sends the same string.
        UserAgent.apply(settings, BuildConfig.VERSION_NAME)
        extensions.userAgent = settings.userAgentString
        // Chrome paints popups white until the document says otherwise; the hidden views (the background, an offscreen document) have nothing to paint.
        setBackgroundColor(if (context == "background" || context == "offscreen") Color.TRANSPARENT else Color.WHITE)
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

    /** The background page and the offscreen document: in the window (`Host.attachHidden`), never on the screen. */
    val hidden: Boolean get() = context == "background" || context == "offscreen"

    /**
     * A hidden view records no draw. It sits in the window at one pixel so the renderer holds its
     * page visible (a detached or invisible view's page gets the background timer throttling a
     * background page must not), but a WebView in the window is otherwise part of every frame the
     * chrome draws: HWUI syncs its functor – a round trip to the renderer's compositor for this
     * view's frame – and issues its draw, per hidden view, per frame of a scroll. The extension
     * runtime frame budget (compat round 6) read that at 450-500 ms a live background view on the
     * slow recipe's software GPU, the term that put the six-extension scroll over the gate, with
     * the renderer main thread idle and the bridge silent. Nothing of the page's depends on the
     * draw: its timers and messages run on a visible page whatever the window paints, and a hidden
     * page never runs `requestAnimationFrame` in Chrome either (the worker page has none).
     */
    override fun onDraw(canvas: Canvas) {
        if (hidden) return
        super.onDraw(canvas)
    }

    override fun destroy() {
        // The page goes with its dialog: the sheet down, the WebView's result cancelled so the renderer's call returns.
        dialog?.let { up ->
            dialog = null
            up.sheet.dismiss()
            up.result.cancel()
        }
        extensions.onWebViewDestroyed(this)
        super.destroy()
    }

    /**
     * The page called `alert`, `confirm` or `prompt` from the frame at `frameUrl` – or objected
     * to its unload – and waits in the call, the renderer every WebView of the app shares with
     * it: answered at once as a dismissal for a hidden view (the worker page, an offscreen
     * document: Chrome's service worker has no dialogs) and for a page told to create no more
     * this visit, with a console line saying so; the host's sheet otherwise
     * ([PageDialogSheet], as a tab page's: Chrome's words, the extension's name as the title
     * line – [ExtensionPageDialogs.spec]), one at a time. Left to the WebView, the dialog is its
     * stock one, `The page at "https://<id>.ext.zenium.invalid" says:` – compat round 22's 156
     * lane met it on Popup Blocker (strict)'s popup, the emulated origin shown and the renderer
     * parked for the sweep's whole wait.
     */
    private fun pageDialog(kind: PageDialogKind, frameUrl: String, message: String?, defaultValue: String?, result: JsResult) {
        val offer = if (ExtensionPageDialogs.shows(context)) dialogVisit.request() else null
        if (offer == null) {
            result.cancel()
            val why = ExtensionPageDialogs.silence(context, kind, dialogVisit.suppressed) ?: return
            val line = "WARNING $frameUrl:0 $why"
            synchronized(console) {
                console.addLast(line)
                while (console.size > 200) console.removeFirst()
            }
            android.util.Log.w(Extensions.TAG, "[${served.id.take(8)}/$context] $line")
            return
        }
        val spec = if (kind == PageDialogKind.LEAVE) PageDialogSpec.beforeUnload(reload = false)
        else ExtensionPageDialogs.spec(kind, frameUrl, origin, name, message ?: "", defaultValue ?: "", offer)
        // A dialog already up – it cannot be, the renderer waits in the call – would be cancelled for this one.
        dialog?.let { up ->
            dialog = null
            up.sheet.dismiss()
            up.result.cancel()
        }
        lateinit var up: PageDialogUp
        val sheet = PageDialogSheet(host, spec) { accepted, value, suppress ->
            if (dialog !== up) return@PageDialogSheet
            dialog = null
            when {
                !accepted -> result.cancel()
                result is JsPromptResult -> result.confirm(value ?: "")
                else -> result.confirm()
            }
            dialogVisit.answered(suppress)
        }
        up = PageDialogUp(sheet, result)
        dialog = up
        sheet.show()
    }

    private inner class Client : WebViewClient() {
        override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
            extensions.intercept(request, null, served, backgroundDocument = context == "background")

        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
            val url = request.url.toString()
            when (val decision = ExtensionPageNavigation.decide(origin, url, request.isForMainFrame)) {
                ExtensionPageNavigation.Decision.Proceed -> return false
                is ExtensionPageNavigation.Decision.Load -> view.loadUrl(decision.url)
                is ExtensionPageNavigation.Decision.OpenTab -> {
                    host.chrome.openUrl(decision.url)
                    if (context == "popup") extensions.closePopup()
                }
                ExtensionPageNavigation.Decision.Drop ->
                    android.util.Log.d(Extensions.TAG, "a frame of the ${served.id.take(8)}/$context view asked for ${url.take(120)}: dropped, its element's served src loads instead")
                is ExtensionPageNavigation.Decision.External -> host.openExternal(decision.url)
            }
            return true
        }

        override fun onPageStarted(view: WebView, url: String, favicon: android.graphics.Bitmap?) {
            // Another document: the dialogs' visit is over, its count and its silencing with it.
            dialogVisit.reset()
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
        override fun onJsAlert(view: WebView, url: String, message: String?, result: JsResult): Boolean {
            pageDialog(PageDialogKind.ALERT, url, message, null, result)
            return true
        }

        override fun onJsConfirm(view: WebView, url: String, message: String?, result: JsResult): Boolean {
            pageDialog(PageDialogKind.CONFIRM, url, message, null, result)
            return true
        }

        override fun onJsPrompt(view: WebView, url: String, message: String?, defaultValue: String?, result: JsPromptResult): Boolean {
            pageDialog(PageDialogKind.PROMPT, url, message, defaultValue, result)
            return true
        }

        override fun onJsBeforeUnload(view: WebView, url: String, message: String?, result: JsResult): Boolean {
            pageDialog(PageDialogKind.LEAVE, url, null, null, result)
            return true
        }

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
