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
import android.os.SystemClock
import android.util.Base64
import android.util.Log
import android.view.InputDevice
import android.view.KeyCharacterMap
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.PixelCopy
import android.view.View
import android.view.ViewOutlineProvider
import android.webkit.ClientCertRequest
import android.webkit.ConsoleMessage
import android.webkit.GeolocationPermissions
import android.webkit.HttpAuthHandler
import android.webkit.JavascriptInterface
import android.webkit.PermissionRequest
import android.webkit.SslErrorHandler
import android.webkit.ValueCallback
import android.webkit.WebBackForwardList
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.ScriptHandler
import androidx.webkit.WebMessageCompat
import androidx.webkit.WebSettingsCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import app.zen.chromium.blocking.BlockingTab
import app.zen.chromium.blocking.Decision
import app.zen.chromium.blocking.SafeBrowsingHit
import app.zen.chromium.privacy.PrivacyFlags
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import kotlin.math.roundToInt

/**
 * One tab's page. Mirrors what Electron's `WebContentsView` gives the core: navigation events,
 * title/favicon, load failures mapped to Chromium net error codes, HTML fullscreen, find-in-page,
 * downloads, permission prompts, popups, the injected Zen page script and the request engine's
 * verdicts (`shouldInterceptRequest`, on WebView's IO threads).
 */
@SuppressLint("SetJavaScriptEnabled", "ClickableViewAccessibility")
class TabWebView(
    context: Context,
    override var tabId: String,
    override val containerId: String,
    host: PageHost
) : WebView(context), BlockingTab {
    /** Reassigned once, when a custom tab's page moves into the browser window (`TabHost.adopt`). */
    var host: PageHost = host
        internal set
    private var loading = false
    /** The document the page's requests belong to; written on the main thread, read on IO threads. */
    @Volatile
    private var currentDocument: String? = null
    private val blockedPending = AtomicInteger(0)
    private val blockedFlushScheduled = AtomicBoolean(false)
    private var lastTouchX = 0f
    private var lastTouchY = 0f
    var radiusPx = 0f
        private set
    /** How far the page sits below the top of its frame during a pull-to-refresh (device px). */
    private var pullOffsetPx = 0f
    private val pull = PullToRefreshGesture(this, { super.onTouchEvent(it) }) { event -> onPull(event) }
    /** Strips at the top and bottom edges that chrome messages cover (see `ContentCover`). */
    val cover = ContentCover({ resources.displayMetrics.density }) { invalidateOutline() }
    /** The in-page predictive back in flight on this view, if any (see `PredictiveBack.kt`). */
    var backTransition: PageBackTransition? = null
    /** The history entry the page on screen belongs to (updated as navigations commit). */
    private var committedIndex = -1
    private var committedUrl = ""
    private var lastRememberedAt = 0L
    private var replyProxy: JavaScriptReplyProxy? = null
    /** Whether the bridge object the page script posts through is registered on this view. */
    private var bridgeInstalled = false
    /**
     * The document-start registration of the current host's script, page-controls rules ahead of
     * it (null without the feature).
     */
    private var documentScript: ScriptHandler? = null
    /** The privacy signals' document-start script (`navigator.globalPrivacyControl`, `doNotTrack`) and its registration. */
    private var signalScript: String? = null
    private var signalScriptHandler: ScriptHandler? = null
    private var currentFlags: JSONObject = json("glanceEnabled" to true, "glanceTrigger" to "alt", "thirdParty" to null)
    private var pendingFlags = false
    private var zoomFactor = 1.0
    /** The WebView's own user agent, the truth both the mobile and the desktop shape derive from. */
    private val defaultUserAgent: String = settings.userAgentString
    /** Desktop site: the user agent and client hints this tab currently presents. */
    var desktopMode = false
        private set
    /** The user agent changed after the current page was requested (see `reload`). */
    private var userAgentStale = false
    private var darkening = false
    private var lastDeviceWidth = 0
    var muted = false
        private set
    /**
     * The main-frame URL as last reported by the WebViewClient; readable from any thread
     * (`shouldInterceptRequest` runs on a network thread where `getUrl()` must not be called).
     */
    val currentUrl: String? get() = currentDocument

    /** The last console warnings and errors of the page (extension diagnostics). */
    val console = ArrayDeque<String>()
    /** The `domReady` view event, once per document (see `DomReadyGate`). */
    private val domReady = DomReadyGate()
    /** `onPageStarted` fired for a document whose commit `doUpdateVisitedHistory` has not reported yet. */
    private var awaitingCommit = false
    /**
     * The main-frame URL whose load failed last. WebView has already committed its own error page
     * under that URL (or is about to, and reports the commit through `doUpdateVisitedHistory` and
     * the page's title, "Webpage not available", through `onReceivedTitle`) by the time the core
     * hears of the failure and replaces it with `zen://error`. Neither is the page the user asked
     * for: the commit is not reported as a navigation and the title is dropped, so nothing of the
     * interstitial reaches history. The core is quick to answer, and its `zen://error` page can
     * start before WebView's own has committed (it still commits first: Chromium does not cancel
     * a commit already under way for a later load), so the start of the core's error page keeps
     * this; the next commit of any page, or the start of any other load, clears it.
     */
    private var failedUrl: String? = null
    /** WebView's built-in error page is the committed document, until another commit replaces it. */
    private var interstitial = false
    /**
     * The URL WebView's built-in error page last committed under. The entry stays in the
     * back-forward list behind the core's `zen://error` page, and going back onto it would run
     * the failed load again: [goBack] steps over it.
     */
    private var interstitialUrl: String? = null
    /** A certificate `onReceivedSslError` refused; the request's own failure follows and is the same news. */
    private var refusedCertificateUrl: String? = null
    /**
     * Certificates refused for resources that did not read as the page itself (another site's:
     * most likely a subresource, which Chrome blocks quietly), by URL, with the failure the
     * interstitial would show should the request turn out to be the main frame's after all
     * (`onReceivedError` knows the frame; `onReceivedSslError` does not).
     */
    private val refusedCertificates = HashMap<String, RefusedCertificate>()

    private class RefusedCertificate(val code: Int, val certificate: JSONObject?)
    private var lastProgressAt = 0L

    init {
        Profiles.apply(this, containerId)
        // The container's profile carries the GPC / DNT request headers (a new container's profile
        // was just created; the default one has them from the last policy push).
        Profiles.profile(containerId)?.let(host.privacy::applySignalHeaders)
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
            // The pop-up blocker: window.open needs a gesture unless the core allowed the site
            // (setPopupsAllowed); a blocked call is reported by the page script and listed.
            javaScriptCanOpenWindowsAutomatically = false
            mediaPlaybackRequiresUserGesture = true
            // Chrome's typographic defaults rather than WebView's: text a page leaves unstyled is
            // serif (Android maps Chrome's "Times New Roman" to it), and small text is not pushed
            // up to 8 px – Chrome has no floor for absolute sizes and 6 px for relative ones.
            standardFontFamily = "serif"
            minimumFontSize = 1
            minimumLogicalFontSize = 6
        }
        // Present as the browser it is, not as an app's embedded view (see UserAgent).
        UserAgent.apply(settings, BuildConfig.VERSION_NAME, desktopMode, defaultUserAgent)
        applyTextZoom()
        // Dark theme for sites: only ever while the app itself is dark (WebView ties algorithmic
        // darkening to the theme), and never for pages that bring a dark scheme of their own.
        setDarkening(host.pageRules.darkenDefault)
        applyWebAuthn()
        applyAutofillProvider()
        setBackgroundColor(Color.WHITE)
        clipToOutline = true
        outlineProvider = object : ViewOutlineProvider() {
            override fun getOutline(view: View, outline: Outline) {
                // Chrome messages along the edges show through the strips they cover, and pulled
                // down, the page is clipped at the frame's bottom edge, not its own: the chrome
                // below the frame stays uncovered.
                outline.setRoundRect(0, visibleTop(), view.width, visibleBottom(), radiusPx)
            }
        }
        applyPullToRefreshMode()
        isFocusableInTouchMode = true
        webViewClient = Client()
        webChromeClient = Chrome()
        setDownloadListener { url, userAgent, contentDisposition, mimetype, contentLength ->
            host.downloads.start(url, userAgent, contentDisposition, mimetype, contentLength, tabId)
        }
        setFindListener { activeMatchOrdinal, numberOfMatches, isDoneCounting ->
            host.viewEvent(
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
        host.extensions?.attach(this)
        applyPrivacy()
    }

    override fun destroy() {
        host.extensions?.detach(this)
        super.destroy()
    }

    // --- privacy (the policy the core pushes; see privacy/Privacy.kt) -----------------------------

    /**
     * Bring this page in line with the privacy policy: at creation, whenever the core pushes a
     * new policy (`privacy.apply`), and – for the cookie switch, which depends on the top site –
     * as the document changes. WebView's own Safe Browsing (Google's lists, its interstitial)
     * follows the same switch as Zenium's feeds; `always` mode, whose subresource upgrades
     * WebView cannot perform, blocks plaintext subresources of secure pages instead.
     */
    fun applyPrivacy() {
        val flags = host.privacy.flags
        if (WebViewFeature.isFeatureSupported(WebViewFeature.SAFE_BROWSING_ENABLE)) settings.safeBrowsingEnabled = flags.safeBrowsing
        settings.mixedContentMode =
            if (flags.httpsOnly == "always") WebSettings.MIXED_CONTENT_NEVER_ALLOW else WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE
        applyCookiePolicy(flags, currentDocument)
        val script = flags.navigatorScript()
        if (script != signalScript) {
            signalScriptHandler?.remove()
            signalScriptHandler = null
            signalScript = script
            if (script != null && WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
                signalScriptHandler = WebViewCompat.addDocumentStartJavaScript(this, script, setOf("*"))
            }
        }
    }

    /** Third-party cookies for the document at `documentUrl` (the exception list names top sites). */
    private fun applyCookiePolicy(flags: PrivacyFlags, documentUrl: String?) {
        // The jar of this tab's container: a WebView on another profile is not the default jar's.
        Profiles.cookieManager(containerId).setAcceptThirdPartyCookies(this, flags.acceptsThirdPartyCookies(containerId, documentUrl))
    }

    // --- placement ------------------------------------------------------------------------------

    fun setRadius(px: Float) {
        radiusPx = px
        invalidateOutline()
    }

    // --- pull-to-refresh --------------------------------------------------------------------------

    /**
     * The chrome's pull machine (`lib/pull.ts`) worked out how far down the page sits: move it
     * there. The page slides as one piece below the frame's top edge, where the chrome – under
     * this view – draws the indicator in the band that opens up.
     */
    fun setPullOffset(offsetCss: Double) {
        val px = (offsetCss * resources.displayMetrics.density).toFloat().coerceAtLeast(0f)
        pull.offsetApplied(px / resources.displayMetrics.density)
        if (px == pullOffsetPx) return
        pullOffsetPx = px
        translationY = px
        invalidateOutline()
    }

    /** Whether a drag down from the top of this page may become a pull-to-refresh right now. */
    fun pullToRefreshEligible(): Boolean =
        host.pullToRefresh && backTransition == null && PullGestureClassifier.refreshable(url)

    /**
     * With the pull on, the top edge's effect is the pull itself, so the WebView's own glow – which
     * would flash before the pull takes the finger – stays off; off, the stock edge glow returns.
     */
    fun applyPullToRefreshMode() {
        overScrollMode = if (host.pullToRefresh) View.OVER_SCROLL_NEVER else View.OVER_SCROLL_IF_CONTENT_SCROLLS
    }

    private fun onPull(event: PullGestureClassifier.Pull) {
        val (phase, payload) = when (event) {
            PullGestureClassifier.Pull.Start -> "start" to null
            is PullGestureClassifier.Pull.Move -> "move" to json("travel" to event.travel.toDouble(), "time" to event.time)
            is PullGestureClassifier.Pull.Release -> "release" to json("time" to event.time)
            is PullGestureClassifier.Pull.Cancel -> "cancel" to json("time" to event.time)
        }
        if (event !is PullGestureClassifier.Pull.Move) Log.d(PULL_TAG, "$phase on $tabId (${url ?: "no url"})")
        host.pullEvent(tabId, phase, payload)
    }

    override fun onOverScrolled(scrollX: Int, scrollY: Int, clampedX: Boolean, clampedY: Boolean) {
        super.onOverScrolled(scrollX, scrollY, clampedX, clampedY)
        pull.onOverScrolled(scrollY, clampedY)
    }

    // --- the covered strips (chrome messages) ---------------------------------------------------

    /**
     * Where the page's visible part starts and ends (device px): inside the covered strips, and
     * above the frame's bottom edge while the page sits lower during a pull.
     */
    private fun visibleTop(): Int = cover.topPx.coerceAtMost(height)
    private fun visibleBottom(): Int =
        (height - maxOf(cover.bottomPx.toFloat(), pullOffsetPx)).roundToInt().coerceIn(visibleTop(), height)

    /**
     * A touch landing on a covered strip is the chrome's: the message card drawn there wants it.
     * The card's whole gesture (down, moves, up) is handed to the view under the page (the chrome
     * WebView, [PageHost.underlay]) in its own coordinates; the page never sees it. A host with
     * nothing under the page (a custom tab) covers nothing, so its pages keep every touch.
     */
    override fun dispatchTouchEvent(event: MotionEvent): Boolean {
        val chrome = host.underlay
        if (event.actionMasked == MotionEvent.ACTION_DOWN) {
            coverTouch = chrome != null && cover.active && (event.y < visibleTop() || event.y >= visibleBottom())
        }
        if (!coverTouch || chrome == null) return super.dispatchTouchEvent(event)
        val copy = MotionEvent.obtain(event)
        copy.offsetLocation((left - chrome.left).toFloat(), (top - chrome.top).toFloat())
        val handled = chrome.dispatchTouchEvent(copy)
        copy.recycle()
        if (event.actionMasked == MotionEvent.ACTION_UP || event.actionMasked == MotionEvent.ACTION_CANCEL) {
            coverTouch = false
        }
        return handled
    }

    /** The gesture in progress began on a covered strip and belongs to the chrome. */
    private var coverTouch = false

    // --- page script (Glance, third-party links, media tracking) -------------------------------

    /**
     * Install the current host's page script and the bridge it talks through. Runs at creation
     * and again when the view changes hosts (`TabHost.adopt`): whatever an earlier host installed
     * comes down first – its script carries that host's token – and evaluations still waiting on
     * that bridge are failed rather than left to time out. A document already loaded gets the new
     * script on its next navigation.
     */
    internal fun installPageScript() {
        if (bridgeInstalled || documentScript != null) uninstallPageScript()
        // A host without the core (a custom tab) has nothing to talk to the page about.
        if (host.pageScript.isEmpty()) return
        if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            WebViewCompat.addWebMessageListener(this, PAGE_BRIDGE, setOf("*")) { _, message, _, isMainFrame, proxy ->
                if (!isMainFrame) return@addWebMessageListener
                onPageMessage(message, proxy)
            }
        } else {
            addJavascriptInterface(LegacyPageBridge(), PAGE_BRIDGE)
        }
        bridgeInstalled = true
        if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
            registerStartScript()
        } else {
            pendingFlags = true // inject on page finished instead (see Client)
        }
    }

    private fun uninstallPageScript() {
        documentScript?.remove()
        documentScript = null
        if (bridgeInstalled) {
            if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
                WebViewCompat.removeWebMessageListener(this, PAGE_BRIDGE)
            } else {
                removeJavascriptInterface(PAGE_BRIDGE)
            }
            bridgeInstalled = false
        }
        replyProxy = null
        failPendingEvals("the page changed hosts")
    }

    /**
     * The document-start script: the page-controls rules this tab lays pages out by (viewport
     * rewriting for zoom, desktop layout and force-zoom happens in the page, from the same rules
     * the core and this host share) followed by the page script itself. Re-registered whenever
     * the rules or the view's width change; the live page is told over the message channel too.
     */
    private fun startScriptSource(): String =
        "window.__zenPageRules=" + host.pageRulesJson.toString() + ";window.__zenDeviceWidth=" + deviceWidth() + ";" + host.pageScript

    private fun registerStartScript() {
        documentScript?.remove()
        documentScript = WebViewCompat.addDocumentStartJavaScript(this, startScriptSource(), setOf("*"))
    }

    /** The view's width in CSS px at scale 1 – what `width=device-width` means to a page in it. */
    private fun deviceWidth(): Int {
        val d = resources.displayMetrics.density
        return if (width > 0) (width / d).roundToInt() else 0
    }

    /** The core's page-controls policy changed (or the view was resized): pages follow at once. */
    fun onPageRulesChanged() {
        // A host without a page script (a custom tab) has no rules to lay pages out by either.
        if (host.pageScript.isEmpty()) return
        if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) registerStartScript()
        postToPage(json("type" to "pageRules", "rules" to host.pageRulesJson, "deviceWidth" to deviceWidth()).toString())
        setDarkening(host.pageRules.darken(url ?: ""))
    }

    override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
        super.onSizeChanged(w, h, oldw, oldh)
        val css = deviceWidth()
        if (css != lastDeviceWidth) {
            lastDeviceWidth = css
            onPageRulesChanged()
        }
    }

    private fun onPageMessage(message: WebMessageCompat, proxy: JavaScriptReplyProxy?) {
        when (val route = routePageMessage(message.data, host.pageToken)) {
            PageMessageRoute.Ignore -> return
            PageMessageRoute.Hello -> {
                replyProxy = proxy
                sendFlags()
            }
            // The settled value of a Promise an evaluate() script returned (see evaluate()).
            is PageMessageRoute.EvalResult -> pendingEvals.remove(route.id)?.invoke(route.value)
            PageMessageRoute.DomReady -> if (domReady.scriptReady()) host.viewEvent(tabId, "domReady", null)
            is PageMessageRoute.Forward -> host.viewEvent(tabId, "pageMessage", route.message)
        }
    }

    // --- script evaluation for the core (async-aware) --------------------------------------------

    private val pendingEvals = HashMap<Int, (String?) -> Unit>()
    private var evalSeq = 0

    /**
     * Run `code` in the page and answer with the JSON text of its value, like Electron's
     * `executeJavaScript`: a returned Promise is awaited (WebView's `evaluateJavascript` would
     * hand back `{}` for it at once), and a thrown or rejected error comes back as
     * `{"__zenError": message}` so the bridge can reject the call. The async path reports through
     * the page bridge, so the token the page script already carries is embedded in the wrapper.
     */
    fun evaluate(code: String, callback: (String?) -> Unit) {
        val id = ++evalSeq
        pendingEvals[id] = callback
        val post = "window.__zenPageBridge&&__zenPageBridge.postMessage(JSON.stringify({token:${JSONObject.quote(host.pageToken)},type:'evalResult',id:$id,value:__s}))"
        val wrapped = "(function(){var __e=function(e){return {__zenError:String((e&&e.message)||e)}};try{var __r=(" + code + "\n);" +
            "if(__r&&typeof __r.then==='function'){__r.then(function(v){var __s;try{__s=JSON.stringify(v===undefined?null:v)}catch(x){__s=JSON.stringify(String(v))}$post}," +
            "function(e){var __s=JSON.stringify(__e(e));$post});return '__zen_pending__'}return __r}catch(e){return __e(e)}})()"
        evaluateJavascript(wrapped) { result ->
            if (result == "\"__zen_pending__\"") {
                // Settled later through onPageMessage; never leave the core hanging past its own budget.
                Handler(Looper.getMainLooper()).postDelayed({
                    pendingEvals.remove(id)?.invoke("{\"__zenError\":\"the script's promise did not settle in time\"}")
                }, EVAL_TIMEOUT_MS)
                return@evaluateJavascript
            }
            pendingEvals.remove(id)?.invoke(result)
        }
    }

    /** A new document unloads whatever scripts were still pending. */
    private fun failPendingEvals(reason: String) {
        if (pendingEvals.isEmpty()) return
        val waiting = pendingEvals.values.toList()
        pendingEvals.clear()
        for (cb in waiting) cb("{\"__zenError\":${JSONObject.quote(reason)}}")
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
        postToPage(formsConfig())
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

    /** The core's "always allow pop-ups on this site": window.open may open windows on its own. */
    fun setPopupsAllowed(allowed: Boolean) {
        settings.javaScriptCanOpenWindowsAutomatically = allowed
    }

    // --- autofill and passkeys -----------------------------------------------------------------------

    /**
     * A fill for the page's forms script, or its configuration (`{type:'config', enabled}`); the
     * host keeps the configuration and [sendFlags] repeats it to every new document.
     */
    fun sendForms(command: JSONObject) {
        postToPage(json("type" to "forms", "command" to command).toString())
    }

    private fun formsConfig(): String =
        json("type" to "forms", "command" to json("type" to "config", "enabled" to host.formsEnabled)).toString()

    /**
     * Whose autofill the page gets (see [SystemAutofill]): under the system provider the WebView
     * stays a client of the framework, under Zenium's it and every field in it step out of it.
     */
    fun applyAutofillProvider() {
        importantForAutofill = SystemAutofill.importance(host.autofillProvider)
    }

    /**
     * Passkeys (WebAuthn) through Android's Credential Manager, at the level a non-privileged app
     * gets: `navigator.credentials` works for origins whose Digital Asset Links statement lists
     * this app (Zenium's own sites). Any origin at all needs `WEB_AUTHENTICATION_SUPPORT_FOR_BROWSER`,
     * which Android grants only to the browsers on Google's privileged-browser allowlist; those
     * requests are refused by the platform, not by Zenium. Without the WebView feature (an old
     * WebView) the calls fail as they always did.
     */
    private fun applyWebAuthn() {
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_AUTHENTICATION)) return
        runCatching {
            WebSettingsCompat.setWebAuthenticationSupport(settings, WebSettingsCompat.WEB_AUTHENTICATION_SUPPORT_FOR_APP)
        }.onFailure { Log.w("ZenTab", "WebAuthn support could not be enabled: ${it.message}") }
    }

    // --- input ---------------------------------------------------------------------------------

    override fun onTouchEvent(event: MotionEvent): Boolean {
        lastTouchX = event.x
        lastTouchY = event.y
        if (event.actionMasked == MotionEvent.ACTION_UP) reportActivation()
        // The pull decides what of the touch the WebView sees (see PullToRefreshGesture).
        return pull.onTouchEvent(event)
    }

    /**
     * A trusted tap or key reached the page: the core's user-activation model (pop-ups, app
     * launches) runs on it. Rate-limited so scrolling does not flood the bridge.
     */
    private fun reportActivation() {
        val now = SystemClock.uptimeMillis()
        if (now - lastActivationAt < ACTIVATION_REPORT_INTERVAL_MS) return
        lastActivationAt = now
        host.viewEvent(tabId, "activation", null)
    }

    private var lastActivationAt = 0L

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
                    host.viewEvent(
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
                host.viewEvent(
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
            reportActivation()
            val isEscape = event.keyCode == KeyEvent.KEYCODE_ESCAPE
            if (host.keys.matches(event) || isEscape) {
                host.keys.toInput(event)?.let { host.onKey(tabId, it) }
                if (!isEscape) return true
            }
        }
        return super.dispatchKeyEvent(event)
    }

    // --- AI agent input (trusted MotionEvent / KeyEvent synthesis) -------------------------------

    /**
     * Deliver a synthetic-but-trusted input event from an AI agent. Coordinates arrive in CSS
     * pixels relative to the layout viewport (what `getBoundingClientRect` reports); on screen
     * they are offset by the visual viewport (pinch pan) and scaled by the page scale × density –
     * a desktop-layout page shown zoomed out has far fewer device pixels per CSS pixel than the
     * density alone would suggest. `done` runs once the event has been dispatched.
     */
    fun sendAgentInput(event: JSONObject, done: () -> Unit) {
        when (event.str("type")) {
            "click" -> pageToView(event.num("x"), event.num("y")) { x, y ->
                agentTap(x, y, event.num("clickCount", 1.0).toInt())
                done()
            }
            "mouseMove" -> pageToView(event.num("x"), event.num("y")) { x, y ->
                agentHover(x, y)
                done()
            }
            "key" -> {
                agentKey(event.str("key"))
                done()
            }
            else -> done()
        }
    }

    /** CSS px in the layout viewport → device px on this view. */
    private fun pageToView(cssX: Double, cssY: Double, then: (Float, Float) -> Unit) {
        @Suppress("DEPRECATION")
        val scale = scale.toDouble() // device px per CSS px: density × current page scale
        evaluateJavascript(VISUAL_OFFSET_SCRIPT) { result ->
            val offset = runCatching { JSONArray(result ?: "") }.getOrNull()
            val ox = offset?.optDouble(0, 0.0) ?: 0.0
            val oy = offset?.optDouble(1, 0.0) ?: 0.0
            then(((cssX - ox) * scale).toFloat(), ((cssY - oy) * scale).toFloat())
        }
    }

    private fun agentTap(x: Float, y: Float, count: Int) {
        repeat(count.coerceAtLeast(1)) {
            val down = SystemClock.uptimeMillis()
            dispatchTouchEvent(pointerEvent(down, down, MotionEvent.ACTION_DOWN, x, y, MotionEvent.TOOL_TYPE_FINGER, InputDevice.SOURCE_TOUCHSCREEN))
            dispatchTouchEvent(pointerEvent(down, down + 20, MotionEvent.ACTION_UP, x, y, MotionEvent.TOOL_TYPE_FINGER, InputDevice.SOURCE_TOUCHSCREEN))
        }
    }

    /** A mouse hover: only pointer events from a mouse source reach the page as mouse moves. */
    private fun agentHover(x: Float, y: Float) {
        val now = SystemClock.uptimeMillis()
        dispatchGenericMotionEvent(pointerEvent(now, now, MotionEvent.ACTION_HOVER_ENTER, x, y, MotionEvent.TOOL_TYPE_MOUSE, InputDevice.SOURCE_MOUSE))
        dispatchGenericMotionEvent(pointerEvent(now, now + 1, MotionEvent.ACTION_HOVER_MOVE, x, y, MotionEvent.TOOL_TYPE_MOUSE, InputDevice.SOURCE_MOUSE))
    }

    private fun pointerEvent(down: Long, time: Long, action: Int, x: Float, y: Float, toolType: Int, source: Int): MotionEvent {
        val properties = MotionEvent.PointerProperties().apply {
            id = 0
            this.toolType = toolType
        }
        val coords = MotionEvent.PointerCoords().apply {
            this.x = x
            this.y = y
            pressure = if (toolType == MotionEvent.TOOL_TYPE_MOUSE) 0f else 1f
            size = if (toolType == MotionEvent.TOOL_TYPE_MOUSE) 0f else 1f
        }
        return MotionEvent.obtain(down, time, action, 1, arrayOf(properties), arrayOf(coords), 0, 0, 1f, 1f, 0, 0, source, 0)
    }

    private fun agentKey(key: String) {
        val code = when (key) {
            "Enter" -> KeyEvent.KEYCODE_ENTER
            "Tab" -> KeyEvent.KEYCODE_TAB
            "Escape" -> KeyEvent.KEYCODE_ESCAPE
            "Backspace" -> KeyEvent.KEYCODE_DEL
            "Delete" -> KeyEvent.KEYCODE_FORWARD_DEL
            "ArrowUp" -> KeyEvent.KEYCODE_DPAD_UP
            "ArrowDown" -> KeyEvent.KEYCODE_DPAD_DOWN
            "ArrowLeft" -> KeyEvent.KEYCODE_DPAD_LEFT
            "ArrowRight" -> KeyEvent.KEYCODE_DPAD_RIGHT
            " " -> KeyEvent.KEYCODE_SPACE
            else -> null
        }
        if (code != null) {
            dispatchKeyEvent(KeyEvent(KeyEvent.ACTION_DOWN, code))
            dispatchKeyEvent(KeyEvent(KeyEvent.ACTION_UP, code))
        } else if (key.length == 1) {
            val chars = key.toCharArray()
            val events = KeyCharacterMap.load(KeyCharacterMap.VIRTUAL_KEYBOARD).getEvents(chars)
            events?.forEach { dispatchKeyEvent(it) }
        }
    }

    // --- history snapshots (the previews behind predictive back) ----------------------------------

    /**
     * Remember what the page on screen looks like, keyed to the history entry it belongs to, for
     * the back preview that will one day slide it in again. Called on the way out of a page –
     * before a link click, a URL bar load or a history traversal moves the view on – while the
     * page is still the one painted. Cheap to call liberally: it copies the window at most every
     * few hundred milliseconds and never while the view is hidden or mid back-gesture (the copy
     * would be of the preview, not of the page).
     */
    fun rememberCurrentPage(force: Boolean = false) {
        if (backTransition != null) return
        val now = SystemClock.uptimeMillis()
        if (!force && now - lastRememberedAt < REMEMBER_THROTTLE_MS) return
        if (width <= 0 || height <= 0 || !isShown) return
        val index = committedIndex
        val url = committedUrl
        if (index < 0 || url.isEmpty() || url == "about:blank") return
        // The entry must still be the one on screen: a commit that already replaced it is the
        // new page, and a copy of the window now would be of the old one under the new name.
        val history = copyBackForwardList()
        if (history.currentIndex != index || history.getItemAtIndex(index)?.url != url) return
        lastRememberedAt = now
        captureBitmap(minOf(1f, HistorySnapshots.MAX_WIDTH.toFloat() / width)) { bitmap ->
            if (bitmap != null) remember(index, url, bitmap)
        }
    }

    private fun remember(index: Int, url: String, bitmap: Bitmap) {
        val pageTitle = title ?: ""
        host.snapshots.remember(HistorySnapshots.Entry(tabId, index, url, pageTitle, favicon, bitmap))
    }

    /** The navigation has committed: which entry is on screen now, and which snapshots still hold. */
    private fun onHistoryCommitted() {
        val history = copyBackForwardList()
        committedIndex = history.currentIndex
        committedUrl = history.currentItem?.url ?: url ?: ""
        host.snapshots.validate(tabId, history)
    }

    /**
     * Downscaled RGB_565 copy of this view's pixels as they are on screen (null when it cannot be
     * copied: hidden, unsized). Shared by the overlay snapshot and the history previews.
     */
    private fun captureBitmap(scale: Float, callback: (Bitmap?) -> Unit) {
        if (width <= 0 || height <= 0 || !isShown) {
            callback(null)
            return
        }
        val bitmap = Bitmap.createBitmap((width * scale).toInt().coerceAtLeast(1), (height * scale).toInt().coerceAtLeast(1), Bitmap.Config.RGB_565)
        val location = IntArray(2)
        getLocationInWindow(location)
        val rect = Rect(location[0], location[1], location[0] + width, location[1] + height)
        try {
            PixelCopy.request(host.activity.window, rect, bitmap, { result ->
                callback(if (result == PixelCopy.SUCCESS) bitmap else null)
            }, Handler(Looper.getMainLooper()))
        } catch (e: Exception) {
            // Software fallback (e.g. before the window is attached).
            runCatching {
                val canvas = Canvas(bitmap)
                canvas.scale(scale, scale)
                draw(canvas)
            }.onSuccess { callback(bitmap) }.onFailure { callback(null) }
        }
    }

    // --- operations used by the core -------------------------------------------------------------

    fun loadHtml(url: String, html: String) {
        rememberCurrentPage()
        loadDataWithBaseURL(url, html, "text/html", "utf-8", url)
    }

    // A load the core asked for: the user agent follows the rules for the URL before it leaves.
    override fun loadUrl(url: String) {
        rememberCurrentPage()
        if (url.startsWith("http", ignoreCase = true)) currentDocument = url
        switchDesktopModeFor(url)
        if (url.startsWith("http", ignoreCase = true)) {
            val flags = host.privacy.flags
            applyCookiePolicy(flags, url)
            if (retriesFailedEntry(url)) {
                // The address the core's error page stands in for, asked for again (Proceed past
                // the certificate interstitial, or a retry): from WebView's own entry for the
                // failed load, right behind, which a history navigation runs afresh. The page
                // then takes the failed load's place rather than stacking behind the warning, as
                // on the desktop, where the interstitial lives in the failed entry itself.
                super.goBack()
                return
            }
            // A WebView that cannot attach the GPC / DNT headers to every request gets them on
            // the navigations the browser starts, at least.
            if (!host.privacy.headersSupported) {
                val headers = flags.signalHeaders()
                if (headers.isNotEmpty()) {
                    super.loadUrl(url, HashMap(headers))
                    return
                }
            }
        }
        super.loadUrl(url)
    }

    override fun loadUrl(url: String, additionalHttpHeaders: MutableMap<String, String>) {
        rememberCurrentPage()
        switchDesktopModeFor(url)
        super.loadUrl(url, additionalHttpHeaders)
    }

    override fun reload() {
        rememberCurrentPage()
        url?.let(::switchDesktopModeFor)
        if (userAgentStale) {
            // Like Chrome, a reload under a changed user agent asks again from the URL the entry
            // was requested with rather than the one it ended on: a site that sent the mobile
            // browser to its m. domain gets to answer the desktop one from the top (and back).
            val original: String? = copyBackForwardList().currentItem?.originalUrl
            if (original != null && original != url && PageRules.isWebPage(original)) {
                super.loadUrl(original)
                return
            }
        }
        super.reload()
    }

    /**
     * The entry [goBack] lands on, or -1 when there is none: the one behind, except from the
     * core's error page when that is WebView's own error page for the load the core's page stands
     * in for (see [interstitialUrl]) – then the one before it, as on the desktop, where the failed
     * load never made an entry. The core's page is told by the view's URL: the entry's own is the
     * `data:` URL `loadHtml` gave it, the history URL is what [getUrl] shows.
     */
    fun backIndex(history: WebBackForwardList = copyBackForwardList()): Int = backIndexOf(
        history.currentIndex,
        { history.getItemAtIndex(it)?.url },
        onErrorPage = url?.startsWith(ERROR_PAGE_PREFIX) == true,
        skipped = interstitialUrl
    )

    override fun goBack() {
        rememberCurrentPage()
        val history = copyBackForwardList()
        val steps = backIndex(history) - history.currentIndex
        if (steps == -1) super.goBack() else if (steps < 0) super.goBackOrForward(steps)
    }

    /** Whether a load of `target` from the core's error page is best run from the entry right behind (see [loadUrl]). */
    private fun retriesFailedEntry(target: String): Boolean {
        val history = copyBackForwardList()
        val behind = history.currentIndex - 1
        return retriesFailedEntryOf(
            onErrorPage = url?.startsWith(ERROR_PAGE_PREFIX) == true,
            target = target,
            behindUrl = if (behind >= 0) history.getItemAtIndex(behind)?.url else null,
            skipped = interstitialUrl
        )
    }

    override fun goForward() {
        rememberCurrentPage()
        super.goForward()
    }

    fun setMuted(muted: Boolean) {
        this.muted = muted
        // WebView has no audio mute; mute the page's media elements (kept in sync by the page).
        evaluateJavascript(
            "(function(m){window.__zenMuted=m;document.querySelectorAll('audio,video').forEach(function(e){e.muted=m});})($muted)",
            null
        )
    }

    /**
     * The core's effective zoom for this tab's page. The page script lays the page out by the same
     * rules (see `startScriptSource`), so this is only remembered; nothing here scales text.
     */
    fun setZoom(factor: Double) {
        zoomFactor = factor
    }

    /**
     * Text at the size the page asked for. WebView would start every tab at the system font scale
     * (a phone set to large text got every page 130% larger), which Chrome does not do: its pages
     * ignore the system font size and offer page zoom instead. Zenium's page zoom reflows the
     * layout from the page script; when the user wants the system font size in it, the core
     * multiplies it into the default zoom ("Include the system font size" in Accessibility).
     */
    private fun applyTextZoom() {
        settings.textZoom = 100
    }

    /**
     * Desktop site: Chrome-on-Linux user agent and client hints from the next load on; the page
     * script lays the page out at the desktop width. The core reloads the tab when the user asks.
     */
    fun setDesktopMode(on: Boolean) {
        if (desktopMode == on) return
        desktopMode = on
        userAgentStale = true
        UserAgent.apply(settings, BuildConfig.VERSION_NAME, on, defaultUserAgent)
    }

    /** Switch the user agent to what the rules say for `url`; true when it changed. */
    private fun switchDesktopModeFor(url: String): Boolean {
        if (!PageRules.isWebPage(url)) return false
        val wanted = host.pageRules.desktop(url)
        if (wanted == desktopMode) return false
        setDesktopMode(wanted)
        return true
    }

    /**
     * Dark theme for sites: WebView's algorithmic darkening, which only acts while the app's
     * theme is dark (Zenium's own colour scheme sets the night mode, see `Host.applyTheme`) and
     * leaves pages that declare `color-scheme: dark` to their own dark style. Before the feature
     * existed (older WebViews) there is nothing safe to do; force-dark is a no-op at this target.
     */
    fun setDarkening(on: Boolean) {
        darkening = on
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.ALGORITHMIC_DARKENING)) return
        runCatching { WebSettingsCompat.setAlgorithmicDarkeningAllowed(settings, on) }
    }

    fun find(text: String, forward: Boolean, newSession: Boolean) {
        if (newSession) findAllAsync(text) else findNext(forward)
    }

    fun stopFind() {
        clearMatches()
    }

    /** Downscaled JPEG of what is on screen right now, for the dimmed preview behind overlays. */
    fun snapshot(callback: (String?) -> Unit) {
        if (backTransition != null) {
            callback(null)
            return
        }
        val scale = if (width > 1400) 1400f / width else 0.5f
        // The chrome asks just before it hides the page (menu, URL bar, overview): the copy is the
        // last chance to remember this history entry before a load from within that UI replaces it.
        val index = committedIndex
        val url = committedUrl
        captureBitmap(scale) { bitmap ->
            if (bitmap == null) {
                callback(null)
                return@captureBitmap
            }
            if (index >= 0 && url.isNotEmpty() && url == (copyBackForwardList().currentItem?.url ?: "")) remember(index, url, bitmap)
            encoder.execute {
                val out = ByteArrayOutputStream()
                bitmap.compress(Bitmap.CompressFormat.JPEG, 62, out)
                val data = "data:image/jpeg;base64," + Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP)
                Handler(Looper.getMainLooper()).post { callback(data) }
            }
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

    /**
     * Agent screenshot: `mode` is `viewport`, `fullPage` or `region` (with `region` in CSS page
     * px), `format` `jpeg` or `png`. Answers `{ data, mimeType, width, height }` or null.
     */
    fun capture(mode: String, region: JSONObject?, format: String, callback: (JSONObject?) -> Unit) {
        val radius = radiusPx
        val square = { on: Boolean ->
            radiusPx = if (on) 0f else radius
            invalidateOutline()
        }
        PageCapture(this, host.activity.window, encoder, square, ::evaluate).run(mode, PageCapture.parseRegion(region), format, callback)
    }

    fun navState(): JSONObject = json(
        "url" to (url ?: ""),
        "title" to reportableTitle(),
        "canGoBack" to canGoBack(),
        "canGoForward" to canGoForward()
    )

    /** The page's title – but not the built-in error page's, which stands in for a failed load (see [failedUrl]). */
    private fun reportableTitle(): String = if (failedUrl != null || interstitial) "" else title ?: ""

    /** The main frame's certificate for the site-information sheet, or null on an insecure page. */
    fun certificateInfo(): JSONObject? {
        val cert = certificate ?: return null
        val subject = cert.issuedTo
        val issuer = cert.issuedBy
        return json(
            "subject" to (subject?.cName?.ifEmpty { null } ?: subject?.oName ?: ""),
            "issuer" to (issuer?.oName?.ifEmpty { null } ?: issuer?.cName ?: ""),
            "validFrom" to cert.validNotBeforeDate?.time,
            "validTo" to cert.validNotAfterDate?.time,
            "protocol" to null
        )
    }

    // --- request blocking (BlockingTab) -------------------------------------------------------

    override val documentUrl: String?
        get() = currentDocument

    /** Coalesce the IO threads' counts into one `blocked` event per beat for the chrome. */
    override fun onRequestsBlocked(count: Int) {
        blockedPending.addAndGet(count)
        if (blockedFlushScheduled.compareAndSet(false, true)) {
            Handler(Looper.getMainLooper()).postDelayed({
                blockedFlushScheduled.set(false)
                val n = blockedPending.getAndSet(0)
                if (n > 0) host.viewEvent(tabId, "blocked", json("count" to n))
            }, BLOCKED_FLUSH_MS)
        }
    }

    /** The engine stopped a navigation: the core shows the Zenium blocked page for `url`. */
    override fun onDocumentBlocked(url: String) {
        Handler(Looper.getMainLooper()).post {
            loading = false
            host.viewEvent(
                tabId, "failLoad",
                json("code" to BLOCKED_BY_CLIENT, "description" to "ERR_BLOCKED_BY_CLIENT", "url" to url)
            )
        }
    }

    override fun onDocumentRedirected(url: String) {
        Handler(Looper.getMainLooper()).post { loadUrl(url) }
    }

    /**
     * Safe Browsing stopped a navigation: the core hears why first (`unsafe`), then the failed
     * load it keys its warning page on, in that order on the one bridge.
     */
    override fun onDocumentUnsafe(url: String, hit: SafeBrowsingHit) {
        Handler(Looper.getMainLooper()).post {
            loading = false
            host.viewEvent(tabId, "unsafe", json("url" to url, "hit" to hit.toJson()))
            host.viewEvent(
                tabId, "failLoad",
                json("code" to BLOCKED_BY_CLIENT, "description" to "ERR_BLOCKED_BY_CLIENT", "url" to url)
            )
        }
    }

    /** HTTPS-only mode upgraded a navigation: the core remembers `from` for the fallback, then `to` loads. */
    override fun onDocumentUpgraded(from: String, to: String) {
        Handler(Looper.getMainLooper()).post {
            host.viewEvent(tabId, "upgraded", json("from" to from, "to" to to))
            loadUrl(to)
        }
    }

    // --- WebViewClient ------------------------------------------------------------------------

    private inner class Client : WebViewClient() {
        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
            val url = request.url
            return when (url.scheme?.lowercase()) {
                "http", "https" -> {
                    if (interceptNavigation(request)) return true
                    // A tap on another site whose app is installed may open the app instead.
                    if (host.externalProtocols.appLink(this@TabWebView, request)) return true
                    // A link into a site with the other desktop-site setting: switch the user
                    // agent first and issue the load again, so the site's first request already
                    // carries it (the core's own decision would arrive a round trip too late).
                    if (request.isForMainFrame && !request.isRedirect && switchDesktopModeFor(url.toString())) {
                        view.loadUrl(url.toString())
                        return true
                    }
                    false
                }
                "about", "data", "blob", "javascript" -> {
                    if (interceptNavigation(request)) return true
                    false
                }
                else -> {
                    // mailto:, tel:, intent://, a custom scheme: held until the core (and the user) agree.
                    host.externalProtocols.request(this@TabWebView, url.toString(), request.hasGesture())
                    true
                }
            }
        }

        override fun onReceivedHttpAuthRequest(view: WebView, handler: HttpAuthHandler, host: String, realm: String) {
            this@TabWebView.host.security.onHttpAuth(this@TabWebView, handler, host, realm)
        }

        override fun onReceivedClientCertRequest(view: WebView, request: ClientCertRequest) {
            host.security.onClientCertRequest(request)
        }

        /**
         * The engine's word on a main-frame navigation: true when it took the navigation over
         * (onto the Zenium blocked or warning page, or to the redirect target), false when the
         * page may go. An extension's web-auth flow running in this tab ends on its way back
         * first: that navigation is the flow's result and is never loaded. Then Safe Browsing
         * speaks, then the rule sets.
         */
        private fun interceptNavigation(request: WebResourceRequest): Boolean {
            if (!request.isForMainFrame) return false
            val target = request.url.toString()
            if (host.extensions?.interceptNavigation(this@TabWebView, target) == true) return true
            host.blocking.guardNavigation(target)?.let { hit ->
                onDocumentUnsafe(target, hit)
                return true
            }
            val decision = host.blocking.decideNavigation(this@TabWebView, target)
            when (decision.action) {
                Decision.Action.BLOCK -> {
                    onDocumentBlocked(target)
                    return true
                }
                Decision.Action.REDIRECT -> {
                    decision.redirectUrl?.let { loadUrl(it) }
                    return true
                }
                Decision.Action.UPGRADE -> if (host.blocking.applyUpgrade(this@TabWebView, target, decision)) return true
                Decision.Action.ALLOW -> {}
            }
            // A link (or script) is about to take the page elsewhere: the last moment it is whole
            // on screen, and the best one for its back preview.
            if (!request.isRedirect) rememberCurrentPage()
            applyCookiePolicy(host.privacy.flags, target)
            currentDocument = target
            return false
        }

        /**
         * Network thread. The extension layer answers first: it serves the extension origins and,
         * until W2-3 moves declarativeNetRequest onto the request engine, decides its rules; anything
         * it leaves alone goes to the request engine.
         */
        override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
            host.extensions?.intercept(request, this@TabWebView, null) ?: host.blocking.intercept(this@TabWebView, request)

        override fun onPageStarted(view: WebView, url: String, favicon: Bitmap?) {
            // Navigations with no link click ahead of them (forms, history.back(), redirects).
            rememberCurrentPage()
            backTransition?.onNavigation(PageBackTransition.NavigationEvent.STARTED)
            awaitingCommit = true
            // The core's error page is the answer to the failure, and WebView's own error page
            // for the failed load may commit only after this (see failedUrl).
            if (!url.startsWith(ERROR_PAGE_PREFIX)) failedUrl = null
            currentDocument = url
            applyCookiePolicy(host.privacy.flags, url)
            // Without document-start scripts the signals arrive late, but they arrive.
            if (!WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) signalScript?.let { evaluateJavascript(it, null) }
            loading = true
            domReady.documentStarted()
            // Whatever the user agent is now, this page was requested with it.
            userAgentStale = false
            // Darkening for the page that is coming, before its first paint; the core confirms.
            if (PageRules.isWebPage(url)) setDarkening(host.pageRules.darken(url))
            lastProgressAt = 0L
            failPendingEvals("the page navigated away before the script finished")
            host.extensions?.onDocumentGone(this@TabWebView, url)
            host.viewEvent(tabId, "startLoading", null)
            if (muted) setMuted(true)
        }

        /**
         * A navigation committed – the moment Electron's `did-navigate` reports to the core, and
         * the first at which the load's outcome is known: WebView fires `onPageStarted` for a
         * failed load too (right before `onReceivedError`), so reporting from there would record
         * a visit to a page that never loaded.
         */
        override fun doUpdateVisitedHistory(view: WebView, url: String, isReload: Boolean) {
            onHistoryCommitted()
            backTransition?.onNavigation(PageBackTransition.NavigationEvent.HISTORY_UPDATED)
            if (failedUrl != null && url == failedUrl) {
                // WebView's own error page, committing under the failed URL while the core's
                // `zen://error` page is on its way or already loading (see failedUrl). The
                // `onPageStarted` it may follow belongs to the core's page, whose commit is next.
                failedUrl = null
                interstitial = true
                interstitialUrl = url
                host.backChanged()
                return
            }
            currentDocument = url
            // pushState / hash navigations have no onPageStarted of their own.
            val inPage = !awaitingCommit
            awaitingCommit = false
            // Another page committed: the failed load's own error page is not coming any more.
            failedUrl = null
            interstitial = false
            refusedCertificateUrl = null
            host.viewEvent(tabId, "navigated", navState().put("url", url).put("inPage", inPage))
            host.backChanged()
        }

        override fun onPageCommitVisible(view: WebView, url: String) {
            backTransition?.onNavigation(PageBackTransition.NavigationEvent.COMMIT_VISIBLE)
        }

        override fun onPageFinished(view: WebView, url: String) {
            loading = false
            if (pendingFlags && host.pageScript.isNotEmpty()) {
                evaluateJavascript(startScriptSource(), null)
            }
            backTransition?.onNavigation(PageBackTransition.NavigationEvent.FINISHED)
            // A document the page script never reported ready (it did not run there, or it only
            // runs at page finished) is ready now, before it has stopped loading, as in Electron.
            if (domReady.pageFinished()) host.viewEvent(tabId, "domReady", null)
            host.viewEvent(tabId, "stopLoading", navState())
            if (muted) setMuted(true)
            host.backChanged()
        }

        override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
            host.blocking.onRequestError(this@TabWebView, request, error.errorCode)
            val url = request.url.toString()
            if (!request.isForMainFrame) {
                refusedCertificates.remove(url)
                return
            }
            failedUrl = url
            loading = false
            // The request behind a refused certificate fails in turn; onReceivedSslError said it all.
            if (url == refusedCertificateUrl) return
            // Unless the refusal did not read as the page's own: it was, so it is the news now.
            refusedCertificates.remove(url)?.let { refused ->
                refusedCertificateUrl = url
                failLoad(refused.code, NetErrors.name(refused.code) ?: "ERR_CERT_INVALID", url, refused.certificate)
                return
            }
            val failure = NetErrors.failure(error.errorCode, error.description, NetErrors.offline(context))
            failLoad(failure.code, failure.name ?: error.description.toString(), url)
        }

        /**
         * A certificate that failed verification. The load goes ahead when the user proceeded past
         * the interstitial for the site and certificate this session (`Security.certificateExceptions`,
         * the core's decision mirrored here); otherwise it is refused, like Chrome does, and the
         * page becomes the certificate interstitial: the failure with the certificate goes to the
         * core, which renders `zen://error` with it and the offer to proceed. A resource of another
         * site than the page's is most likely a subresource, blocked quietly (Chrome too); should
         * the request prove to be the main frame's, `onReceivedError` renders the interstitial.
         */
        override fun onReceivedSslError(view: WebView, handler: SslErrorHandler, error: SslError) {
            val url = error.url
            val certificate = error.certificate
            if (host.security.certificateAllowed(containerId, url, Security.fingerprintOf(certificate))) {
                handler.proceed()
                return
            }
            handler.cancel()
            val code = NetErrors.sslCode(error.primaryError)
            val details = Security.describeCertificate(certificate)
            if (!readsAsPage(url)) {
                refusedCertificates[url] = RefusedCertificate(code, details)
                return
            }
            failedUrl = url
            refusedCertificateUrl = url
            loading = false
            failLoad(code, NetErrors.name(code) ?: "ERR_CERT_INVALID", url, details)
        }

        /** Whether a failed resource is the document being loaded: same site as it, or no document to compare with. */
        private fun readsAsPage(resourceUrl: String): Boolean {
            val document = currentDocument ?: return true
            val documentSite = CertificateExceptions.siteOf(document) ?: return true
            return CertificateExceptions.siteOf(resourceUrl) == documentSite
        }

        /**
         * Tell the core, in Chromium's terms: the `net::` code and the `ERR_…` name (or reason) the
         * page prints, and for a refused certificate what the interstitial shows of it.
         */
        private fun failLoad(code: Int, description: String, url: String, certificate: JSONObject? = null) {
            val event = json("code" to code, "description" to description, "url" to url)
            if (certificate != null) event.put("certificate", certificate)
            host.viewEvent(tabId, "failLoad", event)
        }

        override fun onRenderProcessGone(view: WebView, detail: android.webkit.RenderProcessGoneDetail): Boolean {
            val reason = if (detail.didCrash()) "crashed" else "killed"
            Log.w("ZenTab", "renderer of $tabId gone ($reason, priority at exit ${detail.rendererPriorityAtExit()})")
            // Every WebView shares the one renderer. When the chrome lost it too, the host drops
            // this view – before or after this call – and the rebooted core recreates the tab
            // itself; only a view that was really swapped tells the chrome its page crashed.
            if (host.tabs.replaceCrashed(this@TabWebView)) {
                host.viewEvent(tabId, "crashed", json("reason" to reason))
            }
            return true
        }
    }

    // --- WebChromeClient ----------------------------------------------------------------------

    private inner class Chrome : WebChromeClient() {
        override fun onReceivedTitle(view: WebView, title: String?) {
            // "Webpage not available" is the built-in error page's, not the tab's (see failedUrl).
            if (failedUrl != null || interstitial) return
            host.viewEvent(tabId, "title", json("title" to (title ?: "")))
        }

        /**
         * The page's load progress for the host's bar (the chrome's on the frame edge, a custom
         * tab's under its toolbar). WebView reports it in bursts (a dozen steps within a few
         * milliseconds on a fast page); a bar springs towards each target anyway, so one report
         * per hundred milliseconds carries all it can show – except 100, which always goes
         * through so the bar fills before it fades.
         */
        override fun onProgressChanged(view: WebView, newProgress: Int) {
            if (!loading) return
            val now = SystemClock.uptimeMillis()
            if (newProgress < 100 && now - lastProgressAt < PROGRESS_THROTTLE_MS) return
            lastProgressAt = now
            host.progress(tabId, newProgress)
        }

        /** Warnings and errors only, for the extension layer's diagnostics (pages log a lot). */
        override fun onConsoleMessage(message: ConsoleMessage): Boolean {
            if (message.messageLevel() == ConsoleMessage.MessageLevel.ERROR || message.messageLevel() == ConsoleMessage.MessageLevel.WARNING) {
                synchronized(console) {
                    console.addLast("${message.messageLevel()} ${message.sourceId()}:${message.lineNumber()} ${message.message()}")
                    while (console.size > 100) console.removeFirst()
                }
            }
            return false
        }

        override fun onReceivedIcon(view: WebView, icon: Bitmap) {
            encoder.execute {
                val size = 32
                val scaled = if (icon.width > size) Bitmap.createScaledBitmap(icon, size, size, true) else icon
                val out = ByteArrayOutputStream()
                scaled.compress(Bitmap.CompressFormat.PNG, 100, out)
                val data = "data:image/png;base64," + Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP)
                Handler(Looper.getMainLooper()).post { host.viewEvent(tabId, "favicon", json("url" to data)) }
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
            // The WebView only asks without a gesture when the site may open windows on its own.
            if (!isUserGesture && !settings.javaScriptCanOpenWindowsAutomatically) return false
            if (!host.popupsAsTabs) {
                // A custom tab has one page: a popup the user asked for (target=_blank, window.open
                // from a tap) navigates it; a popup no tap asked for is blocked, as Chrome does.
                if (!isUserGesture) return false
                val probe = WebView(view.context)
                probe.webViewClient = object : WebViewClient() {
                    override fun shouldOverrideUrlLoading(v: WebView, request: WebResourceRequest): Boolean {
                        this@TabWebView.loadUrl(request.url.toString())
                        Handler(Looper.getMainLooper()).post { probe.destroy() }
                        return true
                    }
                }
                (resultMsg.obj as WebViewTransport).webView = probe
                resultMsg.sendToTarget()
                return true
            }
            // Hand the popup a real WebView so `window.opener` keeps working, then adopt it as a tab.
            val popup = host.tabs.createPopup(containerId)
            (resultMsg.obj as WebViewTransport).webView = popup
            resultMsg.sendToTarget()
            host.hostEvent("view.adopt", json("viewId" to popup.tabId, "parentTabId" to tabId, "active" to isUserGesture))
            return true
        }

        override fun onCloseWindow(window: WebView) {
            // Pages closing themselves are rare enough that leaving the tab open is fine.
        }
    }

    companion object {
        private const val PULL_TAG = "ZenPull"
        /** The core's error pages and interstitials (`ERROR_URL_PREFIX` in `src/shared/url.ts`). */
        private const val ERROR_PAGE_PREFIX = "zen://error"
        /** The object the page script posts to (and the wrappers in [evaluate] and [postToPage] name). */
        private const val PAGE_BRIDGE = "__zenPageBridge"
        private val encoder = Executors.newSingleThreadExecutor { r -> Thread(r, "zen-encode") }

        /**
         * The pure half of [backIndex]: the entry behind `currentIndex` (`entryUrlAt` reads the
         * list's actual URLs), or the one before it when the view is on the core's error page and
         * that entry is WebView's own error page for the failed load (`skipped`). -1 with nothing behind.
         */
        fun backIndexOf(currentIndex: Int, entryUrlAt: (Int) -> String?, onErrorPage: Boolean, skipped: String?): Int {
            val behind = currentIndex - 1
            if (behind < 0) return -1
            if (onErrorPage && behind >= 1 && skipped != null && entryUrlAt(behind) == skipped) return behind - 1
            return behind
        }

        /**
         * The pure half of the retry in [loadUrl]: from the core's error page, a load of the very
         * address WebView's own error page committed under (`skipped`), when that entry is the one
         * right behind (`behindUrl`), goes back onto it instead of making a new entry.
         */
        fun retriesFailedEntryOf(onErrorPage: Boolean, target: String, behindUrl: String?, skipped: String?): Boolean =
            onErrorPage && skipped != null && target == skipped && behindUrl == skipped

        /** Longer than any tool budget (browser_wait_for allows 30 s) but shorter than the socket's. */
        private const val EVAL_TIMEOUT_MS = 45_000L

        /** A redirect chain or a burst of pushStates must not copy the window once per hop. */
        private const val REMEMBER_THROTTLE_MS = 300L

        /** Blocked-request counts reach the chrome at most this often per tab. */
        private const val BLOCKED_FLUSH_MS = 150L

        /** `net::ERR_BLOCKED_BY_CLIENT`, what the core's blocked page is keyed on. */
        private const val BLOCKED_BY_CLIENT = -20

        /** Well inside the core's 5 s activation window, so a tap is never missed for long. */
        private const val ACTIVATION_REPORT_INTERVAL_MS = 400L

        /** Progress reports between the first and the last (see `Chrome.onProgressChanged`). */
        private const val PROGRESS_THROTTLE_MS = 100L

        /** Where the visual viewport sits in the layout viewport (non-zero only while pinch-zoomed). */
        private const val VISUAL_OFFSET_SCRIPT =
            "(function(){var v=window.visualViewport;return v?[v.offsetLeft,v.offsetTop]:[0,0]})()"
    }
}
