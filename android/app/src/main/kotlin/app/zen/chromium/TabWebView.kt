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
import android.webkit.CookieManager
import android.webkit.GeolocationPermissions
import android.webkit.HttpAuthHandler
import android.webkit.JavascriptInterface
import android.webkit.PermissionRequest
import android.webkit.SslErrorHandler
import android.webkit.ValueCallback
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
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import app.zen.chromium.blocking.BlockingTab
import app.zen.chromium.blocking.Decision
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
    /** The in-page predictive back in flight on this view, if any (see `PredictiveBack.kt`). */
    var backTransition: PageBackTransition? = null
    /** The history entry the page on screen belongs to (updated as navigations commit). */
    private var committedIndex = -1
    private var committedUrl = ""
    private var lastRememberedAt = 0L
    private var replyProxy: JavaScriptReplyProxy? = null
    /** Whether the bridge object the page script posts through is registered on this view. */
    private var bridgeInstalled = false
    /** The document-start registration of the current host's script (null without the feature). */
    private var documentScript: ScriptHandler? = null
    private var currentFlags: JSONObject = json("glanceEnabled" to true, "glanceTrigger" to "alt", "thirdParty" to null)
    private var pendingFlags = false
    private var zoomFactor = 1.0
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
            // The pop-up blocker: window.open needs a gesture unless the core allowed the site
            // (setPopupsAllowed); a blocked call is reported by the page script and listed.
            javaScriptCanOpenWindowsAutomatically = false
            mediaPlaybackRequiresUserGesture = true
            mixedContentMode = WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE
            if (WebViewFeature.isFeatureSupported(WebViewFeature.SAFE_BROWSING_ENABLE)) safeBrowsingEnabled = true
            // Chrome's typographic defaults rather than WebView's: text a page leaves unstyled is
            // serif (Android maps Chrome's "Times New Roman" to it), and small text is not pushed
            // up to 8 px – Chrome has no floor for absolute sizes and 6 px for relative ones.
            standardFontFamily = "serif"
            minimumFontSize = 1
            minimumLogicalFontSize = 6
        }
        // Present as the browser it is, not as an app's embedded view (see UserAgent).
        UserAgent.apply(settings, BuildConfig.VERSION_NAME)
        applyTextZoom()
        CookieManager.getInstance().setAcceptThirdPartyCookies(this, true)
        setBackgroundColor(Color.WHITE)
        clipToOutline = true
        outlineProvider = object : ViewOutlineProvider() {
            override fun getOutline(view: View, outline: Outline) {
                // Pulled down, the page is clipped at the frame's bottom edge, not its own: the
                // chrome below the frame stays uncovered.
                val bottom = (view.height - pullOffsetPx).roundToInt().coerceIn(0, view.height)
                outline.setRoundRect(0, 0, view.width, bottom, radiusPx)
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
        val script = host.pageScript
        // A host without the core (a custom tab) has nothing to talk to the page about.
        if (script.isEmpty()) return
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
            documentScript = WebViewCompat.addDocumentStartJavaScript(this, script, setOf("*"))
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

    private fun onPageMessage(message: WebMessageCompat, proxy: JavaScriptReplyProxy?) {
        val data = message.data ?: return
        val obj = runCatching { JSONObject(data) }.getOrNull() ?: return
        if (obj.str("token") != host.pageToken) return
        when (obj.str("type")) {
            "hello" -> {
                replyProxy = proxy
                sendFlags()
                return
            }
            "evalResult" -> {
                // The settled value of a Promise an evaluate() script returned (see evaluate()).
                pendingEvals.remove(obj.optInt("id"))?.invoke(obj.strOrNull("value"))
                return
            }
        }
        obj.remove("token")
        host.viewEvent(tabId, "pageMessage", obj)
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
        host.chrome.viewEvent(tabId, "activation", null)
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
        pageStarted = false
        loadDataWithBaseURL(url, html, "text/html", "utf-8", url)
    }

    override fun loadUrl(url: String) {
        rememberCurrentPage()
        if (url.startsWith("http", ignoreCase = true)) currentDocument = url
        super.loadUrl(url)
    }

    override fun loadUrl(url: String, additionalHttpHeaders: MutableMap<String, String>) {
        rememberCurrentPage()
        super.loadUrl(url, additionalHttpHeaders)
    }

    override fun reload() {
        rememberCurrentPage()
        super.reload()
    }

    override fun goBack() {
        rememberCurrentPage()
        super.goBack()
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

    /** Zenium's per-tab zoom; WebView has no page zoom, so it scales the text. */
    fun setZoom(factor: Double) {
        zoomFactor = factor
        applyTextZoom()
    }

    /**
     * Text at the size the page asked for, times Zenium's zoom. WebView would start every tab at the
     * system font scale (a phone set to large text got every page 130% larger), which Chrome does
     * not do: its pages ignore the system font size and offer page zoom instead, as Zenium does.
     */
    private fun applyTextZoom() {
        settings.textZoom = (zoomFactor * 100).roundToInt().coerceIn(25, 500)
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
        "title" to (title ?: ""),
        "canGoBack" to canGoBack(),
        "canGoForward" to canGoForward()
    )

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

    // --- WebViewClient ------------------------------------------------------------------------

    private inner class Client : WebViewClient() {
        /**
         * Web schemes load here; anything else is a request to leave for another app, gated by
         * the core (a gesture, then the shared prompt).
         */
        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
            // mailto:, tel:, intent://, a custom scheme: the core holds it for a gesture and the
            // shared prompt, and says so with true.
            if (host.external.onNavigation(this@TabWebView, request)) return true
            val url = request.url
            return when (url.scheme?.lowercase()) {
                "http", "https" -> {
                    if (interceptNavigation(request)) return true
                    // A tap on another site whose app is installed may open the app instead.
                    host.externalProtocols.appLink(this@TabWebView, request)
                }
                else -> {
                    if (interceptNavigation(request)) return true
                    false
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
         * (onto the Zenium blocked page, or to the redirect target), false when the page may go.
         */
        private fun interceptNavigation(request: WebResourceRequest): Boolean {
            if (!request.isForMainFrame) return false
            val target = request.url.toString()
            val decision = host.blocking.decideNavigation(this@TabWebView, target)
            when (decision.action) {
                Decision.Action.BLOCK -> {
                    onDocumentBlocked(target)
                    return true
                }
                Decision.Action.REDIRECT, Decision.Action.UPGRADE -> {
                    decision.redirectUrl?.let { loadUrl(it) }
                    return true
                }
                Decision.Action.ALLOW -> {}
            }
            // A link (or script) is about to take the page elsewhere: the last moment it is whole
            // on screen, and the best one for its back preview.
            if (!request.isRedirect) rememberCurrentPage()
            currentDocument = target
            return false
        }

        override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
            host.blocking.intercept(this@TabWebView, request)

        override fun onPageStarted(view: WebView, url: String, favicon: Bitmap?) {
            // Navigations with no link click ahead of them (forms, history.back(), redirects).
            rememberCurrentPage()
            backTransition?.onNavigation(PageBackTransition.NavigationEvent.STARTED)
            currentDocument = url
            pageStarted = true
            loading = true
            failPendingEvals("the page navigated away before the script finished")
            host.viewEvent(tabId, "startLoading", null)
            host.viewEvent(tabId, "navigated", navState().put("url", url).put("inPage", false))
            if (muted) setMuted(true)
        }

        override fun doUpdateVisitedHistory(view: WebView, url: String, isReload: Boolean) {
            currentDocument = url
            onHistoryCommitted()
            backTransition?.onNavigation(PageBackTransition.NavigationEvent.HISTORY_UPDATED)
            if (!loading) {
                // pushState / hash navigation after the page finished loading.
                host.viewEvent(tabId, "navigated", navState().put("url", url).put("inPage", true))
            }
            host.backChanged()
        }

        override fun onPageCommitVisible(view: WebView, url: String) {
            backTransition?.onNavigation(PageBackTransition.NavigationEvent.COMMIT_VISIBLE)
        }

        override fun onPageFinished(view: WebView, url: String) {
            loading = false
            pageStarted = false
            if (pendingFlags && host.pageScript.isNotEmpty()) {
                evaluateJavascript(host.pageScript, null)
            }
            backTransition?.onNavigation(PageBackTransition.NavigationEvent.FINISHED)
            host.viewEvent(tabId, "stopLoading", navState())
            if (muted) setMuted(true)
            host.backChanged()
        }

        override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
            host.blocking.onRequestError(this@TabWebView, request, error.errorCode)
            if (!request.isForMainFrame) return
            loading = false
            host.viewEvent(
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
            host.viewEvent(tabId, "failLoad", json("code" to code, "description" to "ERR_CERT_INVALID", "url" to error.url))
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
            host.viewEvent(tabId, "title", json("title" to (title ?: "")))
        }

        override fun onProgressChanged(view: WebView, newProgress: Int) {
            host.progress(tabId, newProgress)
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
        /** The object the page script posts to (and the wrappers in [evaluate] and [postToPage] name). */
        private const val PAGE_BRIDGE = "__zenPageBridge"
        private val encoder = Executors.newSingleThreadExecutor { r -> Thread(r, "zen-encode") }

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

        /** Where the visual viewport sits in the layout viewport (non-zero only while pinch-zoomed). */
        private const val VISUAL_OFFSET_SCRIPT =
            "(function(){var v=window.visualViewport;return v?[v.offsetLeft,v.offsetTop]:[0,0]})()"

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
