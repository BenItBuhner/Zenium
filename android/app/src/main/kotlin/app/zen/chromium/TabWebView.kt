package app.zen.chromium

import android.annotation.SuppressLint
import android.content.Context
import android.content.res.Resources
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
import android.view.ActionMode
import android.view.InputDevice
import android.view.KeyCharacterMap
import android.view.KeyEvent
import android.view.Menu
import android.view.MenuItem
import android.view.MotionEvent
import android.view.PixelCopy
import android.view.View
import android.view.ViewOutlineProvider
import android.webkit.ClientCertRequest
import android.webkit.ConsoleMessage
import android.webkit.GeolocationPermissions
import android.webkit.HttpAuthHandler
import android.webkit.JavascriptInterface
import android.webkit.JsPromptResult
import android.webkit.JsResult
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
import app.zen.chromium.ext.ExtensionUrls
import app.zen.chromium.ext.NavigationReports
import app.zen.chromium.privacy.PrivacyFlags
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong
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
    /**
     * The document generation the request engine stamps its decisions with (see
     * [BlockingTab.documentGeneration]): advanced on the IO thread by every main-frame request
     * the engine decides, and at commit for a document whose request it never saw (a non-http
     * page, an extension page). [committedGeneration] is the one the last commit reported.
     */
    private val documentGeneration = AtomicLong(0)
    private var committedGeneration = 0L
    private val blockedPending = AtomicInteger(0)
    private val blockedFlushScheduled = AtomicBoolean(false)
    private var lastTouchX = 0f
    private var lastTouchY = 0f
    var radiusPx = 0f
        private set
    /** How far the page sits below the top of its frame during a pull-to-refresh (device px). */
    private var pullOffsetPx = 0f
    /** The bar that hides on scroll: what of the touches and the scroll it hears (see `BarHideGesture`). */
    val barHide = BarHideGesture(this) { phase, payload -> host.barScroll(tabId, phase, payload) }
    /**
     * With the bar hiding off the top edge, the page is laid out tall and slid up by the bar's
     * offset, and the part of it that then pokes past the frame's bottom edge is clipped; the
     * strip a bottom-docked bar has not yet left is clipped the same way (see `TabHost.place`).
     */
    private var barShiftPx = 0f
    private var barClipPx = 0
    private val pull = PullToRefreshGesture(this, { event -> barHide.forward(event) { super.onTouchEvent(it) } }) { event -> onPull(event) }
    /**
     * The edge drag that goes back or forward in 3-button navigation mode (GN-04), ahead of the
     * pull in the touch chain: what it does not take flows on to the pull and the WebView.
     */
    private val historyNav = HistoryNavGesture(this, { event -> pull.onTouchEvent(event) }) { event -> onHistoryNav(event) }
    /** Strips at the top and bottom edges that chrome messages cover (see `ContentCover`). */
    val cover = ContentCover({ resources.displayMetrics.density }) { invalidateOutline() }
    /** The in-page predictive back in flight on this view, if any (see `PredictiveBack.kt`). */
    var backTransition: PageBackTransition? = null
    /** The history entry the page on screen belongs to (updated as navigations commit), and how long the list was. */
    private var committedIndex = -1
    private var committedUrl = ""
    private var committedSize = 0
    private var lastRememberedAt = 0L
    /** The copies of the window in flight for this page, shared between their askers (see [captureBitmap]). */
    private val captureShare = CaptureShare<Bitmap>()
    /**
     * The internal pages in this view's list, by position, to the `zen://` URL each was shown
     * as. Their items all carry one and the same URL (the `data:` header WebView loads a
     * `loadDataWithBaseURL` document under, [NavigationState.isDocumentPlaceholder]), so a name
     * is its position's: set as the entry commits ([onHistoryCommitted], off the URL the commit
     * reports, which for such a document is the base URL the page was loaded with – its own),
     * seeded from the snapshot when a restore rebuilds the list ([restoreFromHostState]), and
     * kept while the position holds a `data:` item ([NavigationState.keptNames]).
     */
    private val internalNames = HashMap<Int, String>()
    /** A restore just rebuilt the list: the commit that follows reports it as built (see [onHistoryCommitted]). */
    private var restoredList = false
    /** The last `historyChanged` payload sent, as text: the same list again is not sent twice. */
    private var lastHistoryText: String? = null
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
    /** The third-party cookie switch as last set on this view (`applyCookiePolicy`); null before the first policy. */
    private var acceptsThirdPartyCookies: Boolean? = null
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
     * The document whose pixels the view shows: the one `onPageCommitVisible` (WebView's word that
     * nothing of the page before is drawn any more) or `onPageFinished` last reported, carried
     * across the in-page commits of that same document. Null until the view has drawn any
     * document at all – a tab restored at boot whose page has not answered yet shows a blank
     * window, and WebView says nothing of a load before the response comes (`onPageStarted`
     * waits for it), so this is the only word that there is a page to picture: the card picture
     * is taken of this document alone ([captureThumbnail], [snapshot]).
     */
    private var paintedDocument: String? = null
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
     * The extension page the runtime answered with an empty document because it does not serve
     * the extension ([refuseExtensionPage], set from the request's thread before the document
     * can start): its `onPageStarted` reports the load as failed, `ERR_BLOCKED_BY_CLIENT`.
     */
    @Volatile private var refusedExtensionPage: String? = null
    /** The URL of the last document `onPageStarted` announced (main thread). */
    private var startedDocument: String? = null
    /**
     * Certificates refused for resources that did not read as the page itself (another site's:
     * most likely a subresource, which Chrome blocks quietly), by URL, with the failure the
     * interstitial would show should the request turn out to be the main frame's after all
     * (`onReceivedError` knows the frame; `onReceivedSslError` does not).
     */
    private val refusedCertificates = HashMap<String, RefusedCertificate>()

    private class RefusedCertificate(val code: Int, val certificate: JSONObject?)
    /**
     * The page's dialog up right now (PUI-27, PUI-28): Zenium's sheet and the `JsResult` of the
     * `alert` / `confirm` / `prompt` the page is blocked in, or of the `beforeunload` objection the
     * WebView holds a navigation for, until the sheet's answer settles it ([showDialog]; [destroy]
     * cancels one left up). One at a time: the renderer waits in the call.
     */
    private var dialog: PageDialogUp? = null
    /** What the page has done with dialogs this visit: Chrome's count and its silencing ([PageDialogVisit]). */
    private val dialogVisit = PageDialogVisit()
    /** The `beforeunload` check in flight, if any (see [confirmUnload]). */
    private var unloadCheck: UnloadCheck? = null
    /** When the core last asked for a reload: a `beforeunload` objection right after it is "Reload site?". */
    private var reloadAskedAt = 0L
    /** What [NavigationReports.attach] registered, to unregister at [destroy]. */
    private var navigationListener: androidx.webkit.NavigationListener? = null
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
        }
        // The page fonts (Settings › Appearance › Customize fonts), and under a profile that never
        // touched them Chrome's typographic defaults rather than WebView's: text a page leaves
        // unstyled is serif (Android maps Chrome's "Times New Roman" to it), and small text is not
        // pushed up to 8 px – Chrome has no floor for absolute sizes and 6 px for relative ones.
        applyFonts()
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
            // A response the engine cannot show ends the navigation here; the core decides whether
            // it is a PDF for the viewer or a file for Downloads (`navigation`).
            host.downloads.start(url, userAgent, contentDisposition, mimetype, contentLength, tabId, navigation = true)
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
        // The navigation listener's reports carry `chrome.webNavigation` on a WebView that has
        // it; the extension runtime infers the family from the client callbacks otherwise.
        if (host.extensions != null) {
            // The unload check's own navigation (see [confirmUnload]) is not the page's news.
            navigationListener = NavigationReports.attach(this) { if (unloadCheck == null) host.viewEvent(tabId, "navigation", it) }
        }
        applyPrivacy()
        // The renderer stopping to answer an input to this page (the unresponsive-page prompt).
        host.watchRenderer(this)
    }

    override fun destroy() {
        // A local document still being read lands nowhere.
        localDocumentSeq++
        // A page gone in one of its dialogs: its sheet goes, the renderer is released from the
        // call (it goes anyway), and a check still waiting on it hears that the page went.
        dialog?.let { up ->
            dialog = null
            up.sheet.dismiss()
            up.result.cancel()
        }
        unloadCheck?.settle(leave = true, destroyView = false)
        NavigationReports.detach(this, navigationListener)
        navigationListener = null
        host.extensions?.detach(this)
        super.destroy()
    }

    // --- page fonts (the document the core pushes; see PageFonts.kt) -------------------------------

    /**
     * Bring this page's `WebSettings` in line with the host's page fonts: at creation, on every
     * `fonts.apply` (the core's start, a Settings row, a sync merge), and when a page made
     * elsewhere is adopted (`TabHost.adopt`). Nothing reloads: WebView restyles the open
     * document as a size changes, and a family changing alone – which Blink's own invalidation
     * does not carry to the text – has the document asked to (`PageFonts.RESTYLE_SCRIPT`): one
     * line of script after the settings, reaching the renderer in that order (both travel the
     * frame's channel). A page with no document yet has nothing to restyle.
     */
    fun applyFonts() {
        val restyle = host.pageFonts.applyTo(settings)
        if (restyle && currentDocument != null) evaluateJavascript(PageFonts.RESTYLE_SCRIPT, null)
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
        applyMixedContentPolicy(flags, currentDocument)
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

    /**
     * Third-party cookies for the document at `documentUrl` (the exception list names top
     * sites), and "block all cookies" for the jar: WebView has no per-site cookie switch, so the
     * profile's jar refuses every cookie under the policy's `blockAll` (the header stage's relay
     * still carries a listed site's document cookies, read and written through the jar's Java
     * API, which the switch does not govern) and the never list is emulated by the relay and the
     * core's deletion of a never-site's data.
     */
    private fun applyCookiePolicy(flags: PrivacyFlags, documentUrl: String?) {
        // The jar of this tab's container: a WebView on another profile is not the default jar's.
        val jar = Profiles.cookieManager(containerId)
        jar.setAcceptCookie(!flags.siteData.blockAll)
        // The switch is this view's own, and set only when its answer changes: a policy the core
        // pushes to every open tab that leaves this container's answer as it was – the private
        // new tab page's third-party cookies choice, which is the private container's alone
        // (INC-03) – asks nothing of a regular tab's WebView.
        val accepts = flags.acceptsThirdPartyCookies(containerId, documentUrl)
        if (accepts != acceptsThirdPartyCookies) {
            acceptsThirdPartyCookies = accepts
            jar.setAcceptThirdPartyCookies(this, accepts)
        }
    }

    /**
     * An extension's own page in this tab (served on `https://<id>.ext.zenium.invalid/`) fetches
     * plaintext URLs freely: in Chrome a `chrome-extension:` document is not a mixed-content
     * restricting origin, only `https:` is, and Stylus's install page reads a usercss off the
     * `http:` site it came from. Every other document follows the HTTPS-only setting.
     */
    private fun applyMixedContentPolicy(flags: PrivacyFlags, documentUrl: String?) {
        settings.mixedContentMode = when {
            documentUrl != null && ExtensionUrls.isExtensionUrl(documentUrl) -> WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
            flags.httpsOnly == "always" -> WebSettings.MIXED_CONTENT_NEVER_ALLOW
            else -> WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE
        }
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
        applyTranslation()
        invalidateOutline()
    }

    // --- the bar that hides on scroll ---------------------------------------------------------------

    /**
     * Slide the page by `shiftPx` (a top-docked bar in motion takes the page's top edge with it)
     * and clip `clipPx` off its bottom edge (the frame's edge where the tall layout runs past it,
     * or the strip a bottom-docked bar has not yet left). Both 0 with the bar at rest.
     */
    fun setBarHideShift(shiftPx: Float, clipPx: Int) {
        if (shiftPx == barShiftPx && clipPx == barClipPx) return
        barShiftPx = shiftPx
        barClipPx = clipPx.coerceAtLeast(0)
        applyTranslation()
        invalidateOutline()
    }

    /** The page sits below its frame's top during a pull and above it behind a hiding top bar. */
    private fun applyTranslation() {
        translationY = pullOffsetPx + barShiftPx
    }

    /**
     * How much further down the page can scroll in its current layout, device px (0 at its end):
     * what the bar that hides on scroll reads before it starts a hide – the page laid out a band
     * taller must still have that band to scroll, or Chromium clamps the scroll back – and by
     * which it tells that clamp from a finger's scroll up (see [BarHideScrollFilter]).
     */
    fun scrollRemaining(): Int =
        (computeVerticalScrollRange() - computeVerticalScrollExtent() - scrollY).coerceAtLeast(0)

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

    // --- overscroll history navigation (GN-04) ------------------------------------------------------

    /**
     * Whether a drag in from `edge` may become a history navigation right now: only with the
     * system's three navigation buttons (in gesture mode the edges are the system's), with no
     * other transition moving the page, and with an entry to go to that way – behind for the
     * left edge (the one [goBack] lands on, [backIndex]), ahead for the right.
     */
    fun historyNavEligible(edge: HistoryNavClassifier.Edge): Boolean {
        if (!host.threeButtonNavigation || backTransition != null) return false
        return when (edge) {
            HistoryNavClassifier.Edge.LEFT -> canGoBack() && backIndex() >= 0
            HistoryNavClassifier.Edge.RIGHT -> canGoForward()
        }
    }

    private fun onHistoryNav(event: HistoryNavClassifier.Nav) {
        val (phase, payload) = when (event) {
            is HistoryNavClassifier.Nav.Start -> "start" to json("edge" to if (event.edge == HistoryNavClassifier.Edge.LEFT) "left" else "right")
            is HistoryNavClassifier.Nav.Move -> "move" to json("travel" to event.travel.toDouble(), "time" to event.time)
            is HistoryNavClassifier.Nav.Release -> "release" to json("time" to event.time)
            is HistoryNavClassifier.Nav.Cancel -> "cancel" to json("time" to event.time)
        }
        if (event !is HistoryNavClassifier.Nav.Move) Log.d(PULL_TAG, "history $phase on $tabId (${url ?: "no url"})")
        host.historyNavEvent(tabId, phase, payload)
    }

    override fun onOverScrolled(scrollX: Int, scrollY: Int, clampedX: Boolean, clampedY: Boolean) {
        super.onOverScrolled(scrollX, scrollY, clampedX, clampedY)
        barHide.onOverScrolled(scrollY, clampedY)
        pull.onOverScrolled(scrollY, clampedY)
        historyNav.onOverScrolled(scrollX, clampedX, (computeHorizontalScrollRange() - computeHorizontalScrollExtent()).coerceAtLeast(0))
    }

    override fun onScrollChanged(l: Int, t: Int, oldl: Int, oldt: Int) {
        super.onScrollChanged(l, t, oldl, oldt)
        barHide.onScrollChanged(t, oldt)
    }

    // --- the covered strips (chrome messages) ---------------------------------------------------

    /**
     * Where the page's visible part starts and ends (device px): inside the covered strips,
     * above the frame's bottom edge while the page sits lower during a pull, and above the strip
     * the bar that hides on scroll still holds (see [setBarHideShift]).
     */
    private fun visibleTop(): Int = cover.topPx.coerceAtMost(height)
    private fun visibleBottom(): Int =
        (height - maxOf(cover.bottomPx.toFloat(), pullOffsetPx, barClipPx.toFloat())).roundToInt().coerceIn(visibleTop(), height)

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
                onPageMessage(message, proxy, isMainFrame)
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
     * the core and this host share) and the host's word on rotate-to-fullscreen – a phone's
     * window's alone ([PageHost.rotateToFullscreen], MED-02) – followed by the page script itself.
     * Re-registered whenever the rules or the view's width change (a screen crossing the tablet
     * line – a fold, a floating window; never a split, whose class stays the display's – resizes
     * the view, so the next document hears the new class; the live one keeps the word it was born
     * with, as Chrome's gate never changes with the window); the live page is told the rules over
     * the message channel too.
     */
    private fun startScriptSource(): String =
        "window.__zenPageRules=" + host.pageRulesJson.toString() + ";window.__zenDeviceWidth=" + deviceWidth() +
            ";window.__zenRotateToFullscreen=" + host.rotateToFullscreen + ";" + host.pageScript

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
        host.viewSized(this, w, h)
    }

    /**
     * While this page's element is fullscreen the engine draws the page in the view it handed
     * the fullscreen layer, and here – the view the core lays over the whole window meanwhile –
     * nothing but the page's background colour (WebView's `NullAwViewMethods`). That flat colour
     * would cover the chrome the layer's reveal uncovers as the chrome's bar slides off (MOT-32,
     * [FullscreenReveal]), so nothing is drawn instead; the host invalidates the view at the
     * fullscreen's two ends, and the page's picture is back with the exit.
     */
    override fun onDraw(canvas: Canvas) {
        if (host.fullscreenTab === this) return
        super.onDraw(canvas)
    }

    /**
     * A message from the page script in one of the tab's frames. The script runs in every frame,
     * but the main document alone speaks for the tab, save for a frame's own fullscreen
     * ([PageMessageRoute.heardFrom]): an embed's video goes fullscreen from its frame's document,
     * the one that knows the video's size. The host weighs a frame's report against the main
     * frame's ([PageHost.fullscreenVideo]). The legacy bridge (no frame on its messages) is
     * taken as the main frame's, as it always was.
     */
    private fun onPageMessage(message: WebMessageCompat, proxy: JavaScriptReplyProxy?, isMainFrame: Boolean = true) {
        val route = routePageMessage(message.data, host.pageToken)
        if (!route.heardFrom(isMainFrame)) return
        when (route) {
            PageMessageRoute.Ignore -> return
            PageMessageRoute.Hello -> {
                replyProxy = proxy
                sendFlags()
            }
            // The settled value of a Promise an evaluate() script returned (see evaluate()).
            is PageMessageRoute.EvalResult -> pendingEvals.remove(route.id)?.invoke(route.value)
            PageMessageRoute.DomReady -> if (domReady.scriptReady()) host.viewEvent(tabId, "domReady", null)
            is PageMessageRoute.Fullscreen ->
                host.fullscreenVideo(this, route.active, route.video, route.videoWidth, route.videoHeight, mainFrame = isMainFrame)
            is PageMessageRoute.Forward ->
                if (route.message.optString("type") == "share") host.preparePageMessage(route.message) { host.viewEvent(tabId, "pageMessage", it) }
                else host.viewEvent(tabId, "pageMessage", route.message)
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

    /**
     * A hardware keyboard's Tab entering this page from the chrome ([FocusHandoff], A11Y-09): the
     * view takes the keyboard, and out of touch mode WebView's own `requestFocus` has Blink land
     * the document's initial focus on its first tabbable as a keyboard focus – the landing that
     * matches `:focus-visible`, which a script's `focus()` after a touch would not (see
     * [Host.onFocusLanding]) – then the page script confirms the first tabbable or moves to the
     * last for a Shift+Tab (`focus` in `pageScript.ts`, `@shared/focusEdge`); in touch mode, where
     * Blink places nothing, the script's landing is the whole of it. `edge` is `first` or `last`.
     */
    fun focusEdge(edge: String) {
        requestFocus()
        postToPage(json("type" to "focus", "edge" to edge).toString())
    }

    /** Deliver a browser → page message (JSON text) over the reply proxy (or the legacy bridge). */
    fun postToPage(payload: String) {
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
        // The bar that hides on scroll hears every touch; the edge drag that navigates history
        // (see HistoryNavGesture) and then the pull decide what of it the WebView sees (see
        // PullToRefreshGesture), and the bar shifts that by what it has taken.
        barHide.onTouch(event)
        return historyNav.onTouchEvent(event)
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

    // --- the text-selection toolbar (see SelectionToolbar.kt) ------------------------------------

    /**
     * The WebView starts the system's floating action mode over selected text with its own
     * callback (Copy, Share, Select all, Web search); wrapped, so Zenium's items from the core
     * join them after Copy. The mode itself – floating type, handles, position – is the system's.
     * Anything else (a primary action mode, another caller's callback) passes through untouched.
     */
    override fun startActionMode(callback: ActionMode.Callback, type: Int): ActionMode? {
        if (type != ActionMode.TYPE_FLOATING || callback !is ActionMode.Callback2) return super.startActionMode(callback, type)
        return super.startActionMode(SelectionActionMode(callback), type)
    }

    /**
     * The WebView's selection callback with Zenium's items added (`SelectionToolbar.plan`). The
     * items come from the core for the text selected, and again on every prepare of a selection
     * menu (`SelectionToolbar.Listing`): the WebView keeps one mode across selection changes – a
     * handle drag, Select all – and invalidates it, so the list is re-read then and the mode
     * invalidated once more when the items change (the system's items show at once; Zenium's
     * join within the toolbar's own entrance). A touch on one reads the selection again, sends
     * `selection.action` to the core and finishes the mode, which clears the selection as the
     * system's items do.
     */
    private inner class SelectionActionMode(private val system: ActionMode.Callback2) : ActionMode.Callback2() {
        private var mode: ActionMode? = null
        private var finished = false
        /** The core's items, kept current with the selection across the mode's life. */
        private val listing = SelectionToolbar.Listing(
            readSelection = { onText -> evaluateJavascript(SelectionToolbar.SELECTION_SCRIPT) { raw -> onText(SelectionToolbar.selectionText(raw)) } },
            listItems = { text, onJson -> host.selectionMenu(tabId, text, onJson) },
            invalidate = { mode?.invalidate() }
        )
        /** Where the selection sits on this view (`onGetContentRect`), for a glance's origin. */
        private val selectionRect = Rect()
        private val strings by lazy { frameworkStrings() }

        override fun onCreateActionMode(mode: ActionMode, menu: Menu): Boolean {
            this.mode = mode
            Log.d(SELECTION_TAG, "selection mode of $tabId created")
            return system.onCreateActionMode(mode, menu)
        }

        override fun onPrepareActionMode(mode: ActionMode, menu: Menu): Boolean {
            val prepared = system.onPrepareActionMode(mode, menu)
            menu.removeGroup(SelectionToolbar.GROUP)
            val systemItems = (0 until menu.size()).map(menu::getItem)
            val plan = SelectionToolbar.plan(
                systemItems.map { SelectionToolbar.SystemItem(it.groupId, it.order, it.title?.toString() ?: "", it.itemId) },
                listing.items,
                strings
            )
            Log.d(SELECTION_TAG, "selection mode of $tabId prepared: anchored ${plan.anchored}, items ${plan.items.map { it.id }}")
            // A menu with Copy is a text selection: ask for the items for the selection as it is
            // now (a Paste toolbar or a password field gets nothing); the menu shows the last
            // answer meanwhile, and a different one invalidates the mode again.
            if (plan.anchored) listing.onPrepare()
            for (index in plan.hidden) systemItems[index].isVisible = false
            plan.items.forEachIndexed { index, item ->
                menu.add(SelectionToolbar.GROUP, SelectionToolbar.FIRST_ITEM_ID + index, plan.order, item.title).apply {
                    setShowAsAction(MenuItem.SHOW_AS_ACTION_ALWAYS or MenuItem.SHOW_AS_ACTION_WITH_TEXT)
                    contentDescription = item.title
                }
            }
            return prepared || !plan.isEmpty
        }

        override fun onActionItemClicked(mode: ActionMode, item: MenuItem): Boolean {
            if (item.groupId != SelectionToolbar.GROUP) return system.onActionItemClicked(mode, item)
            val action = SelectionToolbar.itemAt(listing.items, item.itemId) ?: return true
            val originX = SelectionToolbar.fraction(selectionRect.exactCenterX(), width)
            val originY = SelectionToolbar.fraction(selectionRect.exactCenterY(), height)
            evaluateJavascript(SelectionToolbar.SELECTION_SCRIPT) { raw ->
                val selected = SelectionToolbar.selectionText(raw).ifEmpty { listing.text }
                if (selected.isNotBlank()) host.hostEvent("selection.action", SelectionToolbar.action(tabId, action.id, selected, originX, originY))
                if (!finished) mode.finish()
            }
            return true
        }

        override fun onDestroyActionMode(mode: ActionMode) {
            finished = true
            listing.finish()
            this.mode = null
            Log.d(SELECTION_TAG, "selection mode of $tabId destroyed after ${listing.asks} ask(s)")
            system.onDestroyActionMode(mode)
        }

        override fun onGetContentRect(mode: ActionMode, view: View, outRect: Rect) {
            system.onGetContentRect(mode, view, outRect)
            selectionRect.set(outRect)
        }
    }

    /**
     * What the system's selection items are told by (see `SelectionToolbar.plan`): Copy and Paste
     * are the public `android.R.string.copy` and `android.R.string.paste`; the WebView's Share is
     * its own `select_action_menu_share` id, resolved in the WebView package's resources (loaded
     * into this process as a shared library, so the id is the one its items carry; 0 when the
     * lookup fails); the framework's own Share string (its text fields' item) is not public, so it
     * is looked up by name and may be missing – the title fallback for the id.
     */
    private fun frameworkStrings(): SelectionToolbar.Strings {
        val share = Resources.getSystem().let { system ->
            system.getIdentifier("share", "string", "android").takeIf { it != 0 }?.let { id -> runCatching { system.getString(id) }.getOrNull() }
        }
        val shareItemId = runCatching {
            val webViewPackage = WebView.getCurrentWebViewPackage()?.packageName ?: return@runCatching 0
            resources.getIdentifier(SelectionToolbar.SHARE_ITEM_ID_NAME, "id", webViewPackage)
        }.getOrDefault(0)
        return SelectionToolbar.Strings(
            copy = context.getString(android.R.string.copy),
            share = share,
            paste = context.getString(android.R.string.paste),
            shareItemId = shareItemId
        )
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

    /**
     * The navigation has committed: which entry is on screen now, which snapshots still hold, and
     * which internal pages' names still stand ([internalNames]). `shown` is the URL the commit
     * was reported under (`doUpdateVisitedHistory`'s; for an internal page the `zen://` URL it
     * was loaded with, where its list item is a `data:` placeholder), null when the commit is not
     * a callback's (a restore: the snapshot named the entries, and the commit that follows confirms
     * the current one). `reload` is the callback's word too.
     */
    private fun onHistoryCommitted(shown: String?, reload: Boolean = false) {
        val history = copyBackForwardList()
        val items = (0 until history.size).map { history.getItemAtIndex(it)?.url }
        // The commit of a restored list's current entry reports the list the restore built,
        // unchanged: not a drop, whatever its size.
        val afterRestore = restoredList
        restoredList = false
        if (!afterRestore && NavigationState.listDroppedAnEntry(committedIndex, committedSize, history.currentIndex, history.size, reload)) {
            // The oldest entry went for this one: every position before it moved, and no name is
            // its position's any more (the current one is named again below).
            internalNames.clear()
        }
        committedIndex = history.currentIndex
        committedSize = history.size
        committedUrl = history.currentItem?.url ?: url ?: ""
        val kept = NavigationState.keptNames(internalNames, items)
        if (kept.size != internalNames.size) {
            internalNames.clear()
            internalNames.putAll(kept)
        }
        // The commit decides its own position's name: an internal page (the list holds its
        // document under a `data:` URL, the commit reports the page's URL) is named by it; any
        // other page committing there (a web page; a `data:` page opened as one, whose commit
        // reports the URL itself) takes the name a previous internal page left at the position.
        if (committedIndex >= 0 && shown != null) {
            if (committedUrl.isNotEmpty() && NavigationState.standsInFor(committedUrl, shown)) {
                internalNames[committedIndex] = shown
            } else {
                internalNames.remove(committedIndex)
            }
        }
        host.snapshots.validate(tabId, history)
    }

    // --- the back/forward stack for the core (NavigationSnapshot; see NavigationState.kt) ---------

    /**
     * The list as the core's snapshot: `{ entries: [{ url, title, originalUrl? }], index }`, the
     * internal pages under the URLs they were shown as. Main thread; the `historyChanged` push
     * ([pushHistory]) hands the same object to the chrome, and `Host` keeps the last one for the
     * synchronous `view.navigationEntries`.
     */
    fun navigationEntries(): JSONObject {
        val history = copyBackForwardList()
        val items = (0 until history.size).map { i ->
            val item = history.getItemAtIndex(i)
            NavigationState.Item(item?.url ?: "", item?.title, item?.originalUrl)
        }
        return NavigationState.snapshotJson(items, history.currentIndex, internalNames)
    }

    /**
     * Tell the core the list changed (`historyChanged { entries, index }`): at every commit, when
     * a page finishes and when a title arrives, and only when it reads differently from the last
     * time. `force` sends it anyway (the view was bound to a new tab id). The state behind the
     * list goes to the host's mirror first, every time ([hostState]; the core asks for it as it
     * records the list this push announces, from a thread that cannot ask the WebView).
     */
    fun pushHistory(force: Boolean = false) {
        val snapshot = navigationEntries()
        host.navigationStateChanged(tabId, hostState())
        val text = snapshot.toString()
        if (!force && text == lastHistoryText) return
        lastHistoryText = text
        host.viewEvent(tabId, "historyChanged", snapshot)
    }

    /**
     * The opaque state a fresh view rebuilds this list from (`view.navigationHostState`), or null:
     * for a private tab, an empty list, or a state over the core's bound. Main thread.
     */
    fun hostState(): String? = NavigationState.hostStateOf(this, Profiles.isPrivate(containerId))

    /** Jump to entry `index` of the list (the back list's row): nothing for an index outside it. */
    fun goToIndex(index: Int) {
        val history = copyBackForwardList()
        val steps = NavigationState.stepsTo(index, history.currentIndex, history.size) ?: return
        if (steps == 0) return
        rememberCurrentPage()
        goBackOrForward(steps)
    }

    /**
     * `view.restoreNavigation`: the whole list from `hostState`, when there is one and it is
     * ours ([NavigationState.decodeHostState]), this view is still empty, `restoreState` accepts
     * it and the list it gives back is the one `entries` describes, position for position, the
     * current one at `index` ([NavigationState.restoredMatches]; an internal page's item is a
     * `data:` placeholder where the entry names the `zen://` page) (true). Anything else is false
     * and loads nothing: the core loads the current entry itself then (`loadURL`, which is also
     * what gives an internal page its document), so a load here would be a second one. Main thread.
     */
    fun restoreNavigation(entries: JSONArray, index: Int, hostState: String?): Boolean {
        val restored = restoreFromHostState(entries, index, hostState)
        lastRestore = restored
        return restored
    }

    /** What the last [restoreNavigation] answered, null before one: the demo driver reads it in-process. */
    var lastRestore: Boolean? = null
        private set

    private fun restoreFromHostState(entries: JSONArray, index: Int, hostState: String?): Boolean {
        val wanted = NavigationState.currentUrl(entries, index) ?: return false
        val bytes = NavigationState.decodeHostState(hostState) ?: return false
        // Only into a view with nothing in it: over a list already built, restoreState has
        // "undesirable side-effects" (the platform's words), and the core never asks for that.
        if (copyBackForwardList().size > 0) return false
        val bundle = NavigationState.bundleOf(bytes) ?: return false
        // What a load of the current entry sets up before its first request goes out (see loadUrl).
        if (PageRules.isWebPage(wanted)) {
            currentDocument = wanted
            switchDesktopModeFor(wanted)
            applyCookiePolicy(host.privacy.flags, wanted)
        }
        val restored = try {
            restoreState(bundle)
        } catch (e: Exception) {
            Log.i("ZenTab", "restoreState refused the state of $tabId: ${e.javaClass.simpleName}")
            null
        } ?: return false
        val items = (0 until restored.size).map { restored.getItemAtIndex(it)?.url }
        val names = NavigationState.entryUrls(entries)
        if (!NavigationState.restoredMatches(items, restored.currentIndex, names, index)) {
            Log.i("ZenTab", "the restored list of $tabId is not the one described (${restored.size} entries, current ${restored.currentIndex}; ${names.size} expected, current $index); the core loads the entry")
            return false
        }
        // The internal pages' names, from the snapshot: their items are `data:` placeholders,
        // and the view that saved the list is not this one (see internalNames).
        internalNames.clear()
        internalNames.putAll(NavigationState.internalNamesOf(items, names))
        onHistoryCommitted(shown = null)
        restoredList = true
        pushHistory(force = true)
        Log.i("ZenTab", "restored the list of $tabId: ${restored.size} entries, current ${restored.currentIndex}")
        return true
    }

    /**
     * Downscaled RGB_565 copy of this view's pixels as they are on screen (null when it cannot be
     * copied: hidden, unsized). Shared by the overlay snapshot, the card thumbnail and the
     * history previews – and shared in flight: a request while a copy with at least its pixels
     * is under way gets that copy's bitmap rather than a second PixelCopy of the same frame
     * ([CaptureShare]). The bitmap belongs to everyone who hears it; nobody recycles it.
     */
    private fun captureBitmap(scale: Float, callback: (Bitmap?) -> Unit) {
        if (width <= 0 || height <= 0 || !isShown) {
            callback(null)
            return
        }
        val ticket = captureShare.request(scale, callback) ?: return
        val bitmap = Bitmap.createBitmap((width * scale).toInt().coerceAtLeast(1), (height * scale).toInt().coerceAtLeast(1), Bitmap.Config.RGB_565)
        val location = IntArray(2)
        getLocationInWindow(location)
        val rect = Rect(location[0], location[1], location[0] + width, location[1] + height)
        try {
            PixelCopy.request(host.activity.window, rect, bitmap, { result ->
                captureShare.complete(ticket, if (result == PixelCopy.SUCCESS) bitmap else null)
            }, Handler(Looper.getMainLooper()))
        } catch (e: Exception) {
            // Software fallback (e.g. before the window is attached).
            val drawn = runCatching {
                val canvas = Canvas(bitmap)
                canvas.scale(scale, scale)
                draw(canvas)
            }.isSuccess
            captureShare.complete(ticket, if (drawn) bitmap else null)
        }
    }

    /** The scale the cover and the card picture copy the page at: at most 1400 px wide, else half. */
    private fun coverScale(): Float = if (width > 1400) 1400f / width else 0.5f

    // --- the page's dialogs and its beforeunload (PUI-27, PUI-28) ---------------------------------

    /** A dialog up: the sheet, the WebView's result it answers, and what to do with the answer. */
    private class PageDialogUp(val sheet: PageDialogSheet, val result: JsResult)

    /**
     * Show `spec` as Zenium's sheet over the page ([PageDialogSheet]) and hold `result` for its
     * answer: the page's `alert` dismissed, its `confirm` / `prompt` answered (the prompt's text
     * with an accepted one), its `beforeunload` objection overruled (the navigation goes on) or
     * upheld (the page stays). `then` hears the answer after the result has been settled. Main
     * thread (the `WebChromeClient`'s). A dialog already up – it cannot be, the renderer waits in
     * the call – would be cancelled for this one.
     */
    private fun showDialog(spec: PageDialogSpec, result: JsResult, then: (accepted: Boolean, suppress: Boolean) -> Unit) {
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
            then(accepted, suppress)
        }
        up = PageDialogUp(sheet, result)
        dialog = up
        sheet.show()
    }

    /**
     * The page called `alert`, `confirm` or `prompt` from the frame at `frameUrl` and waits in
     * the call (PUI-27). A page the user is not looking at – a hidden tab's, or the shown tab's
     * under the overview – has its dialog answered as a dismissal at once: the WebView's one
     * renderer waits in the call for every page and for the chrome, so nothing could bring the
     * tab forward for the dialog to wait on, as Chrome's would (`PageDialogSpec`). So is a
     * dialog of a page told to open no more this visit ([PageDialogVisit]); the checkbox that
     * tells it so is offered from its second dialog on.
     */
    private fun pageDialog(kind: PageDialogKind, frameUrl: String, message: String?, defaultValue: String?, result: JsResult) {
        if (!isShown) {
            result.cancel()
            return
        }
        val offer = dialogVisit.request()
        if (offer == null) {
            result.cancel()
            return
        }
        val spec = PageDialogSpec.page(kind, frameUrl, currentDocument ?: url ?: "", message ?: "", defaultValue ?: "", offer)
        showDialog(spec, result) { _, suppress -> dialogVisit.answered(suppress) }
    }

    /**
     * The user stayed on the page that objected to the core's own navigation. [loadUrl] wrote
     * the destination into the document mirror as the load was asked for (the requests of the
     * page that is coming are its own from the first); with the navigation cancelled before it
     * started, the document is the one that stayed – the WebView's word, the committed page's URL.
     */
    private fun stayedOnPage() {
        val stayed = url?.takeIf(PageRules::isWebPage) ?: return
        currentDocument = stayed
        switchDesktopModeFor(stayed)
        val flags = host.privacy.flags
        applyMixedContentPolicy(flags, stayed)
        applyCookiePolicy(flags, stayed)
    }

    /**
     * Whether the page may be unloaded (the core's `TabView.confirmUnload`, ahead of a tab close,
     * the app's exit): its `beforeunload` handlers run, and one that objects has the core ask
     * "Leave site?". `reply` hears true once the page may go – no objection, the user chose to
     * leave, the page gone or silent for [UNLOAD_CHECK_TIMEOUT_MS] (a hung renderer holds no
     * close up, as in Chrome) – and false when the user chose to stay, the page intact.
     *
     * The WebView runs the handlers for a navigation only, so the check is one: a load of
     * `about:blank` the page may object to, started past this view's own [loadUrl] (nothing of
     * it is the page's news: the callbacks it raises are dropped while the check is up, its
     * navigation report too). An objection comes as `onJsBeforeUnload` with the navigation held,
     * and the answer either lets it go on or cancels it, the page as it was. A page that does
     * not object commits the blank document, and the view is destroyed at once (Electron's
     * `close({ waitForBeforeUnload })` does the same): the core hears `destroyed` and closes
     * the tab, or keeps it unloaded with its stack when the check was the app's exit. Its card
     * picture is taken before any of it, so an undo shows the page as it was left.
     *
     * A page with no handlers to run has nothing to check: an internal page (`zen://`, the PDF
     * viewer), the blank document, an error page, a view with no document yet.
     */
    fun confirmUnload(reply: (Boolean) -> Unit) {
        unloadCheck?.let { running ->
            // A second check joins the first (a Close Others sweeping a tab a Close asked already).
            running.replies.add(reply)
            return
        }
        val document = currentDocument
        if (document == null || document == "about:blank" || !PageRules.isWebPage(document) || failedUrl != null || interstitial || pdfPage != null) {
            reply(true)
            return
        }
        captureThumbnail()
        val check = UnloadCheck(reply)
        unloadCheck = check
        postDelayed(check.timeout, UNLOAD_CHECK_TIMEOUT_MS)
        super.loadUrl("about:blank")
    }

    /**
     * A `beforeunload` check in flight (see [confirmUnload]): what it answers to, the id of the
     * objection the page raised under it (if it did), and whether its blank document started.
     */
    private inner class UnloadCheck(reply: (Boolean) -> Unit) {
        val replies = arrayListOf(reply)
        /** The page objected under the check: its "Leave site?" is up (its answer settles the check). */
        var asked = false
        /** The check's blank document has started: the page did not object, and is on its way out. */
        var navigated = false
        val timeout = Runnable { settle(leave = true, destroyView = false) }

        /**
         * The check is over: every asker hears `leave`, and with `destroyView` the view goes
         * (posted: never from inside the WebView's own callback), the core hearing `destroyed`.
         * A "Leave site?" still up (the page went another way) goes with the check, its
         * navigation let go or held as `leave` says.
         */
        fun settle(leave: Boolean, destroyView: Boolean) {
            if (unloadCheck !== this) return
            removeCallbacks(timeout)
            if (asked) dialog?.let { up ->
                dialog = null
                up.sheet.dismiss()
                if (leave) up.result.confirm() else up.result.cancel()
            }
            val askers = replies.toList()
            replies.clear()
            if (destroyView) {
                navigated = true
                post {
                    // The view goes with the check still up: the picture TabHost.destroy takes
                    // of a shown view would be of the blank document (captureThumbnail leaves
                    // it, the page's own picture taken as the check began), and destroy() ends
                    // the check. The askers hear once the core has heard `destroyed`.
                    if (host.tabs.get(tabId) === this@TabWebView) host.tabs.destroy(tabId)
                    unloadCheck = null
                    for (asker in askers) asker(true)
                }
                return
            }
            unloadCheck = null
            for (asker in askers) asker(leave)
        }
    }

    /**
     * Whether a `WebViewClient` / `WebChromeClient` word about `url` is the unload check's blank
     * document ([confirmUnload]) rather than the page's: dropped by the callbacks.
     */
    private fun isUnloadCheckDocument(url: String): Boolean {
        val check = unloadCheck ?: return false
        return url == "about:blank" || check.navigated
    }

    // --- card thumbnails (the pictures of the tab overview's cards, `Thumbnails.kt`) --------------

    /**
     * Take the card picture of this page now, if there is anything to take: the page is on
     * screen, not mid navigation (a copy would be of the page it is leaving, under the URL it is
     * going to) or mid back gesture, and its last picture is not fresh ([Thumbnails.FRESH_MS]:
     * the cover a sheet just captured, the copy a hide a frame ago made). Called on the page's
     * way off the screen ([Host.setTabVisible]'s hide), as the app leaves the foreground
     * ([Host.onPause]) and before a shown tab's view goes ([TabHost.destroy], for an undo).
     */
    fun captureThumbnail() {
        val thumbnails = host.thumbnails ?: return
        if (backTransition != null || awaitingCommit) return
        // Under an unload check the view may be on the check's blank document already
        // ([confirmUnload] took the page's picture before it began).
        if (unloadCheck != null) return
        if (width <= 0 || height <= 0 || !isShown) return
        if (thumbnails.fresh(tabId, SystemClock.uptimeMillis())) return
        // A view with no document yet shows nothing worth a picture; its card has its placeholder.
        val document = currentDocument ?: return
        if (document == "about:blank") return
        // Nor is a document the view has not drawn yet: a tab restored at boot whose page is still
        // on its way shows a blank window, and a copy of it would take the place of the picture
        // on disk – the very one the card is to show until the page paints (BH-33).
        if (document != paintedDocument) return
        val asked = SystemClock.uptimeMillis()
        captureBitmap(coverScale()) { bitmap ->
            if (bitmap != null) publishThumbnail(bitmap, document, SystemClock.uptimeMillis() - asked)
        }
    }

    /**
     * The card picture from a copy of the page: scaled to the card's width and encoded on the
     * pictures' own thread ([Thumbnails.disk] – never the cover's `zen-encode`, whose work the
     * chrome waits for), written to disk ([Thumbnails.save]) and handed to the chrome
     * (`thumbnail.captured`). `document` is the one the copy shows (the caller's word: it was
     * [paintedDocument] when the copy was asked for). Not of a page that navigated since – checked
     * on the main thread before anything is written, and again before the chrome hears of it, so
     * a picture of the page before is never on disk under the new page's tab (BH-14, across a
     * kill too) – and not twice for one frame: a cover and a hide that shared the copy publish
     * once between them. A private tab's picture goes to the chrome alone: nothing of it is
     * written (the private profile leaves no file to wipe). `copyMs` is what the copy took when
     * this call asked for it (-1: the copy was the cover's); the debug log line carries it with
     * the encode and save times, for the cost of a picture per switch.
     */
    private fun publishThumbnail(bitmap: Bitmap, document: String, copyMs: Long = -1L) {
        val thumbnails = host.thumbnails ?: return
        val now = SystemClock.uptimeMillis()
        if (document != currentDocument || thumbnails.fresh(tabId, now)) return
        thumbnails.taken(tabId, now)
        val id = tabId
        val cardWidth = thumbnails.width
        val persisted = containerId != Profiles.PRIVATE_CONTAINER
        val target = host
        val main = Handler(Looper.getMainLooper())
        fun captured(picture: Thumbnails.Picture) =
            target.hostEvent("thumbnail.captured", json("tabId" to id, "data" to picture.dataUrl, "width" to picture.width, "height" to picture.height))
        thumbnails.disk.execute {
            val started = SystemClock.uptimeMillis()
            val picture = Thumbnails.encode(bitmap, cardWidth)
            val encodeMs = SystemClock.uptimeMillis() - started
            main.post {
                // The page navigated while the picture was encoded: it is of the page before, and
                // the card must not show it – nothing is written. Nor does a picture that could
                // not be encoded count as taken.
                if (picture == null || document != currentDocument) {
                    thumbnails.stale(id)
                    return@post
                }
                if (!persisted) {
                    captured(picture)
                    return@post
                }
                thumbnails.disk.execute {
                    val writing = SystemClock.uptimeMillis()
                    val saved = thumbnails.save(id, picture.jpeg, document)
                    if (BuildConfig.DEBUG) {
                        Log.d(
                            "ZenTab",
                            "thumbnail of $id: ${picture.width}x${picture.height} ${picture.jpeg.size} bytes, " +
                                "copy ${if (copyMs < 0) "shared" else "$copyMs ms"}, encode $encodeMs ms, save ${SystemClock.uptimeMillis() - writing} ms"
                        )
                    }
                    main.post {
                        // Navigated during the write: the file names the page before
                        // ([Thumbnails.stamp]), so no read shows it, and the chrome's own drop
                        // for the navigation is behind the write on the same thread.
                        if (!saved || document != currentDocument) {
                            thumbnails.stale(id)
                            return@post
                        }
                        captured(picture)
                    }
                }
            }
        }
    }

    // --- operations used by the core -------------------------------------------------------------

    /**
     * A `zen://` page of the core's, rendered straight into the view under its own address. The
     * PDF viewer page comes with a base URL of its own and the file it shows (`PdfViewer`): the
     * document runs under that URL – the PDF's own, as Chrome's viewer presents its tab, so an
     * extension's content script matching it runs there; the viewer's origin for a PDF with no
     * address – and fetches pdf.js and the bytes from the viewer's origin, while the history
     * entry – what [getUrl] and the navigation events show – stays `url`.
     */
    fun loadHtml(url: String, html: String, baseUrl: String? = null, document: PdfViewer.Document? = null) {
        rememberCurrentPage()
        pdfPage = if (baseUrl != null && document != null) PdfViewer.Page(url, baseUrl, document) else null
        loadDataWithBaseURL(baseUrl ?: url, html, "text/html", "utf-8", url)
    }

    /** The viewer page this view shows, while it does (see [loadHtml]); read on the network thread too. */
    @Volatile private var pdfPage: PdfViewer.Page? = null

    /**
     * The address a navigation callback's URL stands for: the viewer page's `zen://pdf` address
     * for its document's URL (WebView may report either the base or the history URL of a
     * `loadDataWithBaseURL` document; the base is the PDF's own address or the viewer's origin),
     * the URL itself otherwise.
     */
    private fun pageUrlFor(url: String): String {
        val page = pdfPage ?: return url
        return if (PdfViewer.isDocumentUrl(url, page)) page.url else url
    }

    /**
     * The URL the viewer page's document reports as its own (`location.href`: the base URL it
     * runs under), when the view shows one; null otherwise. The extension layer keeps the
     * endpoints of a document that said hello under it (`Extensions.onDocumentGone`).
     */
    private fun pdfDocumentUrl(): String? = pdfPage?.baseUrl

    // A load the core asked for: the user agent follows the rules for the URL before it leaves.
    override fun loadUrl(requested: String) {
        // A local document still being read for this view lands nowhere: the tab has moved on
        // (the read's own guard reads the sequence; a second local load bumps it itself).
        localDocumentSeq++
        // The core spells an extension page's URL as Chrome does; the WebView loads the served origin.
        val url = ExtensionUrls.toServed(requested)
        rememberCurrentPage()
        // A load supersedes a reload asked just before: an objection now is to leaving.
        reloadAskedAt = 0L
        if (LocalDocuments.isLocal(url)) {
            loadLocalDocument(url)
            return
        }
        if (url.startsWith("http", ignoreCase = true)) currentDocument = url
        switchDesktopModeFor(url)
        if (url.startsWith("http", ignoreCase = true)) {
            val flags = host.privacy.flags
            applyMixedContentPolicy(flags, url)
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

    override fun loadUrl(requested: String, additionalHttpHeaders: MutableMap<String, String>) {
        localDocumentSeq++
        val url = ExtensionUrls.toServed(requested)
        rememberCurrentPage()
        reloadAskedAt = 0L
        switchDesktopModeFor(url)
        if (url.startsWith("http", ignoreCase = true)) applyMixedContentPolicy(host.privacy.flags, url)
        super.loadUrl(url, additionalHttpHeaders)
    }

    /** Local documents read for this view: a read that ends after the tab moved on lands nowhere. */
    private var localDocumentSeq = 0

    /**
     * A `content:` or `file:` document another app handed the browser (LocalDocuments; the
     * WebView loads neither scheme itself, see the settings above). A PDF goes the way of one
     * the tab navigates to: a download the core's viewer opens in this tab once complete (the
     * DownloadListener's `navigation`). A page or an SVG is read off the main thread and put in
     * the view under its own address, its entry and [getUrl] the address itself. A document that
     * is not one of the kinds, is refused (the app's own files) or cannot be read fails the load
     * as WebView fails a missing file, and the core's error page stands in.
     */
    private fun loadLocalDocument(url: String) {
        val seq = ++localDocumentSeq
        val resolver = context.contentResolver
        val uri = Uri.parse(url)
        val refused = LocalDocuments.refused(url, LocalDocuments.privateDirs(context))
        val userAgent = settings.userAgentString
        Thread({
            val name = if (refused) "" else LocalDocuments.nameOf(resolver, uri)
            val kind = if (refused) null else LocalDocuments.kindOf(runCatching { resolver.getType(uri) }.getOrNull(), name)
            val outcome: () -> Unit = when (kind) {
                null -> ({ failLocalDocument(url) })
                LocalDocuments.Kind.PDF -> {
                    val size = LocalDocuments.sizeOf(resolver, uri)
                    val disposition = "inline; filename=\"${name.replace('"', '\'')}\""
                    ({ host.downloads.start(url, userAgent, disposition, kind.mimeType, size, tabId, navigation = true) })
                }
                else -> {
                    val bytes = runCatching {
                        resolver.openInputStream(uri)?.use { readUpTo(it, LocalDocuments.MAX_TEXT_BYTES) }
                    }.getOrNull()
                    if (bytes == null) ({ failLocalDocument(url) })
                    else ({ loadDataWithBaseURL(url, LocalDocuments.decode(bytes), kind.mimeType, "utf-8", url) })
                }
            }
            post { if (seq == localDocumentSeq) outcome() }
        }, "zen-local-document").start()
    }

    /** The load of a local document failed before the view saw a byte: the core hears as of a missing file. */
    private fun failLocalDocument(url: String) {
        loading = false
        val code = NetErrors.FILE_NOT_FOUND
        host.viewEvent(tabId, "failLoad", json("code" to code, "description" to (NetErrors.name(code) ?: "ERR_FILE_NOT_FOUND"), "url" to url))
    }

    /** The stream's bytes, or null past `max` (a document too large to show from memory). */
    private fun readUpTo(input: java.io.InputStream, max: Long): ByteArray? {
        val out = java.io.ByteArrayOutputStream()
        val buffer = ByteArray(64 * 1024)
        while (true) {
            val n = input.read(buffer)
            if (n < 0) return out.toByteArray()
            if (out.size() + n > max) return null
            out.write(buffer, 0, n)
        }
    }

    /**
     * The runtime answered the main-frame request for `url`, an extension page it does not serve
     * (the extension is not enabled, not installed, or not allowed in this private tab), with an
     * empty document (`Extensions.intercept`, any thread): the page fails as Chrome fails such a
     * page, `ERR_BLOCKED_BY_CLIENT`, as its document starts, the way a load WebView fails is
     * reported right after its `onPageStarted`. The empty document then stands under the URL
     * like WebView's own error page under a failed load's (see [failedUrl]).
     */
    fun refuseExtensionPage(url: String) {
        refusedExtensionPage = url
    }

    /**
     * The extension page on `url`, held on an empty document while its extension was about to
     * be configured (`Extensions.releaseHeld` reloads the ones that came up), belongs to an
     * extension that is not coming: it fails now, as [refuseExtensionPage] fails a page. Main
     * thread; nothing when the tab has moved on since the request.
     */
    fun failExtensionPage(url: String) {
        if (currentDocument != url) return
        if (startedDocument != url) {
            // The empty document has not started yet: it fails as it starts.
            refusedExtensionPage = url
            return
        }
        failStartedExtensionPage(url)
    }

    /**
     * The empty document under `url` has started ([onPageStarted]): the failure goes to the core,
     * whose `zen://error` page replaces the document, and the document's entry is stepped over on
     * the way back ([interstitialUrl]) whether its commit is still to come (then through
     * [failedUrl], as for a load WebView failed) or has happened.
     */
    private fun failStartedExtensionPage(url: String) {
        if (awaitingCommit) failedUrl = url
        else {
            interstitial = true
            interstitialUrl = url
        }
        loading = false
        host.viewEvent(
            tabId,
            "failLoad",
            json("code" to NetErrors.BLOCKED_BY_CLIENT, "description" to "ERR_BLOCKED_BY_CLIENT", "url" to ExtensionUrls.present(url))
        )
        host.backChanged()
    }

    override fun reload() {
        rememberCurrentPage()
        reloadAskedAt = SystemClock.uptimeMillis()
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
        reloadAskedAt = 0L
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
        reloadAskedAt = 0L
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

    /**
     * Downscaled JPEG of what is on screen right now, for the dimmed preview behind overlays.
     * The tab's card picture comes out of the same copy ([publishThumbnail]): the page under a
     * sheet or the overview is never copied a second time for its card. The cover's own encode
     * is queued first and runs on its own thread; the card's work never stands in front of it.
     */
    fun snapshot(callback: (String?) -> Unit) {
        if (backTransition != null) {
            callback(null)
            return
        }
        // The chrome asks just before it hides the page (menu, URL bar, overview): the copy is the
        // last chance to remember this history entry before a load from within that UI replaces it.
        val index = committedIndex
        val url = committedUrl
        // The card picture comes out of this copy only when the pixels are the document's own
        // ([paintedDocument]): the cover of a window whose page has not painted is a cover of
        // white, which is what the sheet is to stand over – not what the card is to keep.
        val painted = currentDocument?.takeIf { it == paintedDocument }
        captureBitmap(coverScale()) { bitmap ->
            if (bitmap == null) {
                callback(null)
                return@captureBitmap
            }
            if (index >= 0 && url.isNotEmpty() && url == (copyBackForwardList().currentItem?.url ?: "")) remember(index, url, bitmap)
            // The cover first: the chrome mounts its sheet on this data URL (#168).
            encoder.execute {
                val out = ByteArrayOutputStream()
                bitmap.compress(Bitmap.CompressFormat.JPEG, 62, out)
                val data = "data:image/jpeg;base64," + Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP)
                Handler(Looper.getMainLooper()).post { callback(data) }
            }
            if (painted != null && !awaitingCommit) publishThumbnail(bitmap, painted)
        }
    }

    /**
     * Full-resolution PNG bytes of the page, or null: the visible area, or with `fullPage` the
     * whole document – the page scrolled in viewport-sized steps and the strips stitched
     * (`PageCapture`, the agents' full-page path; a WebView never paints what is off screen), cut
     * at the capture's height limit. A document the stitcher cannot read (no page script yet)
     * comes back as the visible area, as it does for the agents.
     */
    fun screenshot(fullPage: Boolean = false, callback: (ByteArray?) -> Unit) {
        if (width <= 0 || height <= 0 || !isShown) {
            callback(null)
            return
        }
        if (fullPage) {
            capture(CapturePlan.MODE_FULL_PAGE, null, "png", 100) { result ->
                val data = result?.optString("data")
                val bytes = if (data.isNullOrEmpty()) null else runCatching { Base64.decode(data, Base64.DEFAULT) }.getOrNull()
                if (bytes != null) callback(bytes) else screenshot(false, callback)
            }
            return
        }
        copyViewport { bitmap ->
            if (bitmap == null) {
                callback(null)
                return@copyViewport
            }
            encoder.execute {
                val out = ByteArrayOutputStream()
                bitmap.compress(Bitmap.CompressFormat.PNG, 100, out)
                bitmap.recycle()
                Handler(Looper.getMainLooper()).post { callback(out.toByteArray()) }
            }
        }
    }

    /**
     * The visible area's pixels at full resolution (the caller's to recycle), or null when the
     * window refuses: Take Screenshot's picture (SH-07), before the flash so it is not in it.
     */
    fun copyViewport(callback: (Bitmap?) -> Unit) {
        if (width <= 0 || height <= 0 || !isShown) {
            callback(null)
            return
        }
        val bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
        val location = IntArray(2)
        getLocationInWindow(location)
        val rect = Rect(location[0], location[1], location[0] + width, location[1] + height)
        try {
            PixelCopy.request(host.activity.window, rect, bitmap, { result ->
                if (result == PixelCopy.SUCCESS) callback(bitmap) else {
                    bitmap.recycle()
                    callback(null)
                }
            }, Handler(Looper.getMainLooper()))
        } catch (e: Exception) {
            bitmap.recycle()
            callback(null)
        }
    }

    /**
     * The long screenshot's capture (SH-08): the page from the viewport's top down to Chrome's
     * ~10 screens, stitched by [PageCapture] as a bitmap the caller crops and writes. The strips
     * are copies of the window where the page is, so the page must be on screen and alone in its
     * frame throughout: the chrome mounts the editor only once the picture is in its hands (the
     * chrome lies under the pages; a sheet over the page would hide it), and the card whose
     * Capture more asked is on its way out as this is called – its strip along the frame's
     * bottom edge is the chrome's, not the page's ([cover]), and the copies wait for the strip
     * to close over the page again. A strip that stays – a banner at rest above the page
     * (default browser, add to home screen) – is not waited on: past the deadline the cover is
     * held at 0 for the capture, so the page draws over the banner and every copy of the frame
     * is the page alone, and released with the result ([ContentCover.hold]).
     */
    fun captureLong(callback: (PageCapture.Capture?) -> Unit) {
        val radius = radiusPx
        val square = { on: Boolean ->
            radiusPx = if (on) 0f else radius
            invalidateOutline()
        }
        val capture = PageCapture(this, host.activity.window, encoder, square, ::evaluate)
        val deadline = SystemClock.uptimeMillis() + COVER_CLEAR_WAIT_MS
        fun whenUncovered() {
            if (!cover.active) {
                capture.runBitmap(CapturePlan.MODE_LONG, null, callback)
            } else if (SystemClock.uptimeMillis() >= deadline) {
                cover.hold()
                capture.runBitmap(CapturePlan.MODE_LONG, null) { result ->
                    cover.release()
                    callback(result)
                }
            } else {
                postOnAnimation { whenUncovered() }
            }
        }
        whenUncovered()
    }

    /**
     * Agent screenshot (and `chrome.tabs.captureVisibleTab`): `mode` is `viewport`, `fullPage` or
     * `region` (with `region` in CSS page px), `format` `jpeg` or `png`, `quality` the JPEG quality
     * 0..100 (anything else: the default). Answers `{ data, mimeType, width, height }` or null.
     */
    fun capture(mode: String, region: JSONObject?, format: String, quality: Int, callback: (JSONObject?) -> Unit) {
        val radius = radiusPx
        val square = { on: Boolean ->
            radiusPx = if (on) 0f else radius
            invalidateOutline()
        }
        PageCapture(this, host.activity.window, encoder, square, ::evaluate).run(mode, PageCapture.parseRegion(region), format, quality, callback)
    }

    /**
     * The page's geometry for the chrome's capture overlay (`page.viewport`): the metrics the
     * stitcher plans with, in the chrome's terms ([CapturePlan.viewportJson]). Null when the page
     * cannot answer (no document yet, a crashed renderer).
     */
    fun viewport(callback: (JSONObject?) -> Unit) {
        evaluateJavascript(PageCapture.METRICS_SCRIPT) { result ->
            val metrics = runCatching { JSONObject(result ?: "") }.getOrNull()?.let { PageCapture.parseMetrics(it) }
            callback(metrics?.let { CapturePlan.viewportJson(it, width, resources.displayMetrics.density.toDouble()) })
        }
    }

    /**
     * What the core hears as the tab's URL. An extension page loaded from its served origin is
     * reported as Chrome spells it (`chrome-extension://<id>/...`, [ExtensionUrls.present]): that
     * is the tab's canonical URL for the core's model, the URL bar and the extension APIs, and
     * [loadUrl] takes it back to the served origin. The PDF viewer page, loaded on its own origin
     * the same way, is reported under its `zen://pdf` address ([pageUrlFor]).
     */
    fun navState(): JSONObject = json(
        "url" to ExtensionUrls.present(pageUrlFor(url ?: "")),
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

    override fun documentGeneration(newDocument: Boolean): Long =
        if (newDocument) documentGeneration.incrementAndGet() else documentGeneration.get()

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
                "chrome-extension" -> {
                    // An extension's own page, spelled as Chrome spells it (a link or a
                    // `location` assignment in an extension page): the served origin is loaded
                    // in its place. A frame cannot be sent there from here; it fails as WebView
                    // fails any unknown scheme.
                    if (request.isForMainFrame) loadUrl(ExtensionUrls.toServed(url.toString()))
                    true
                }
                DeepLinks.INTERNAL_SCHEME, DeepLinks.PAGE_SCHEME -> {
                    // The browser's own pages are the user's to open (typed, a menu, a deep link
                    // from another app), never a web page's: Chrome's rule for chrome://. Only
                    // one of Zenium's own documents may link to a page, and that goes the way a
                    // deep link does – a VIEW intent to the browser window, which a custom tab
                    // has no chrome to draw it in either. Nothing under these schemes is ever
                    // loaded from here.
                    val target = url.toString()
                    if (DeepLinks.refusedFromDocument(currentDocument, target)) {
                        Log.i("ZenTab", "refused a navigation from web content to an internal page in $tabId")
                    } else if (request.isForMainFrame) {
                        host.openExternal(DeepLinks.aliasOf(target))
                    }
                    true
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
         * page may go. Safe Browsing speaks first, then the rule sets.
         */
        private fun interceptNavigation(request: WebResourceRequest): Boolean {
            if (!request.isForMainFrame) return false
            val target = request.url.toString()
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
                // The page may go; a `modifyHeaders` document's edits are the relay's, reached
                // when its request comes through `shouldInterceptRequest` (Blocking.intercept).
                Decision.Action.ALLOW, Decision.Action.MODIFY_HEADERS -> {}
            }
            // A link (or script) is about to take the page elsewhere: the last moment it is whole
            // on screen, and the best one for its back preview.
            if (!request.isRedirect) rememberCurrentPage()
            applyCookiePolicy(host.privacy.flags, target)
            currentDocument = target
            return false
        }

        /**
         * Network thread. The extension layer answers first: it serves the extension origins and
         * the CORS proxy of extension pages; anything it leaves alone goes to the request engine,
         * whose rule sets include the extensions' declarativeNetRequest rules.
         */
        override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
            PdfViewer.intercept(context, request, pdfPage)
                ?: host.extensions?.intercept(request, this@TabWebView, null)
                ?: host.blocking.intercept(this@TabWebView, request)

        override fun onPageStarted(view: WebView, rawUrl: String, favicon: Bitmap?) {
            val url = pageUrlFor(rawUrl)
            unloadCheck?.let { check ->
                // The check's blank document started: the page did not object (or the user chose
                // to leave) and is on its way out; the view goes with it (see confirmUnload).
                // Nothing of the blank document is the tab's.
                if (isUnloadCheckDocument(url)) {
                    if (!check.navigated) check.settle(leave = true, destroyView = true)
                    return
                }
            }
            // Another document is on its way: the page's dialog visit is over (its count and its
            // silencing, PageDialogVisit), and the viewer page's file is not to be served for it.
            dialogVisit.reset()
            if (pdfPage != null && url != pdfPage?.url) pdfPage = null
            // Navigations with no link click ahead of them (forms, history.back(), redirects).
            rememberCurrentPage()
            backTransition?.onNavigation(PageBackTransition.NavigationEvent.STARTED)
            awaitingCommit = true
            // The core's error page is the answer to the failure, and WebView's own error page
            // for the failed load may commit only after this (see failedUrl).
            if (!url.startsWith(ERROR_PAGE_PREFIX)) failedUrl = null
            currentDocument = url
            startedDocument = url
            applyMixedContentPolicy(host.privacy.flags, url)
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
            host.extensions?.onDocumentGone(this@TabWebView, url, pdfDocumentUrl())
            host.viewEvent(tabId, "startLoading", null)
            if (muted) setMuted(true)
            // An extension page the runtime refused: the empty document it answered with is
            // starting, and the load fails here, as one WebView failed does right after its start.
            // (Any other document starting means the refused one was given up: a later load of
            // the same URL, once the extension is enabled, is not to fail on the stale word.)
            val refused = refusedExtensionPage
            refusedExtensionPage = null
            if (url == refused) failStartedExtensionPage(url)
        }

        /**
         * A navigation committed – the moment Electron's `did-navigate` reports to the core, and
         * the first at which the load's outcome is known: WebView fires `onPageStarted` for a
         * failed load too (right before `onReceivedError`), so reporting from there would record
         * a visit to a page that never loaded.
         */
        override fun doUpdateVisitedHistory(view: WebView, rawUrl: String, isReload: Boolean) {
            val url = pageUrlFor(rawUrl)
            // The unload check's blank document is not the tab's (see confirmUnload).
            if (isUnloadCheckDocument(url)) return
            onHistoryCommitted(shown = url, reload = isReload)
            backTransition?.onNavigation(PageBackTransition.NavigationEvent.HISTORY_UPDATED)
            if (failedUrl != null && url == failedUrl) {
                // WebView's own error page, committing under the failed URL while the core's
                // `zen://error` page is on its way or already loading (see failedUrl). The
                // `onPageStarted` it may follow belongs to the core's page, whose commit is next.
                failedUrl = null
                interstitial = true
                interstitialUrl = url
                host.backChanged()
                pushHistory()
                return
            }
            // pushState / hash navigations have no onPageStarted of their own.
            val inPage = !awaitingCommit
            awaitingCommit = false
            // The document on screen took a new URL in place: the pixels are still its own. (Not
            // when the one drawn is another: its own commit-visible is the word for that.)
            if (inPage && paintedDocument != null && paintedDocument == currentDocument) paintedDocument = url
            currentDocument = url
            // Whatever card picture there was is of the page before – the chrome drops it on the
            // URL change – and the next hide takes a new one, however fresh the last (BH-14).
            host.thumbnails?.stale(tabId)
            // Another page committed: the failed load's own error page is not coming any more.
            failedUrl = null
            interstitial = false
            refusedCertificateUrl = null
            if (!inPage) {
                // A document whose main-frame request the engine never decided (non-http, an
                // extension page) opens its generation here; one it did has opened it already.
                if (documentGeneration.get() == committedGeneration) documentGeneration.incrementAndGet()
                committedGeneration = documentGeneration.get()
            }
            // Before `navigated`: the core records the tab's stack as it handles that event, and
            // reads it from the list pushed here (the view's copy, or `Host`'s for the sync call).
            pushHistory()
            // The committed URL as the core spells a tab's URL: an extension page's in Chrome's
            // form (`chrome-extension://<id>/...`, as [navState] and the list's entries have it),
            // not the served origin the WebView reported the commit under.
            host.viewEvent(tabId, "navigated", navState().put("url", ExtensionUrls.present(url)).put("inPage", inPage).put("document", committedGeneration))
            host.backChanged()
        }

        override fun onPageCommitVisible(view: WebView, url: String) {
            if (isUnloadCheckDocument(url)) return
            // WebView's word that nothing of the page before is drawn any more: from here the
            // pixels are this document's, and so may its card picture be.
            paintedDocument = url
            backTransition?.onNavigation(PageBackTransition.NavigationEvent.COMMIT_VISIBLE)
        }

        override fun onPageFinished(view: WebView, url: String) {
            if (isUnloadCheckDocument(url)) return
            loading = false
            // A document that finished has drawn (the word for one whose commit-visible never came).
            paintedDocument = url
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
            pushHistory()
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
            val didCrash = detail.didCrash()
            val priority = detail.rendererPriorityAtExit()
            Log.w("ZenTab", "renderer of $tabId gone (${if (didCrash) "crashed" else "killed"}, priority at exit $priority)")
            // Every WebView shares the one renderer: the host classifies the exit for the pages
            // on screen first (it outlives the chrome, which lost the renderer too and is
            // rebuilt around a fresh one; the word reaches the rebooted core as it loads the
            // page again). The host drops this view for that rebuild – before or after this
            // call – and only a view that was really swapped tells the chrome its page crashed.
            val word = host.rendererGone(this@TabWebView, didCrash, priority)
            if (host.tabs.replaceCrashed(this@TabWebView)) {
                host.viewEvent(tabId, "crashed", word ?: json("reason" to if (didCrash) "crashed" else "killed"))
            }
            return true
        }
    }

    // --- WebChromeClient ----------------------------------------------------------------------

    private inner class Chrome : WebChromeClient() {
        // --- the page's dialogs: Zenium's sheet (PUI-27, PUI-28), Chrome's own wording --------------

        /**
         * `alert` / `confirm` / `prompt`: on a host with a chrome the page waits in its call, as in
         * Chrome, for Zenium's sheet ([pageDialog]); a host without one (a custom tab) keeps the
         * WebView's own dialogs. `url` is the calling frame's: the dialog is titled after its
         * site, an embedded frame's told from the page's by the document's URL.
         */
        override fun onJsAlert(view: WebView, url: String, message: String?, result: JsResult): Boolean {
            if (!host.pageDialogs) return false
            pageDialog(PageDialogKind.ALERT, url, message, null, result)
            return true
        }

        override fun onJsConfirm(view: WebView, url: String, message: String?, result: JsResult): Boolean {
            if (!host.pageDialogs) return false
            pageDialog(PageDialogKind.CONFIRM, url, message, null, result)
            return true
        }

        override fun onJsPrompt(view: WebView, url: String, message: String?, defaultValue: String?, result: JsPromptResult): Boolean {
            if (!host.pageDialogs) return false
            pageDialog(PageDialogKind.PROMPT, url, message, defaultValue, result)
            return true
        }

        /**
         * The page's `beforeunload` handler objects to the navigation the WebView is about to
         * run – the core's own (address bar, back, reload), the page's, or the unload check's
         * blank document ([confirmUnload]) – and holds it in `result` (PUI-28). The sheet asks
         * "Leave site?" ("Reload site?" right after the core asked for a reload, never under a
         * check, as Electron's host tells them apart; the WebView raises the question only for a
         * page the user has touched, as Chrome), and its answer lets the navigation go on or
         * cancels it, the page as it was ([stayedOnPage]). A check waits as long as the question
         * is up: its silence timer stops here, and the answer settles it.
         */
        override fun onJsBeforeUnload(view: WebView, url: String, message: String?, result: JsResult): Boolean {
            if (!host.pageDialogs) return false
            val check = unloadCheck
            if (check != null) {
                removeCallbacks(check.timeout)
                check.asked = true
            }
            val reload = check == null && SystemClock.uptimeMillis() - reloadAskedAt < RELOAD_ASK_WINDOW_MS
            showDialog(PageDialogSpec.beforeUnload(reload), result) { leave, _ ->
                if (check != null) check.settle(leave = leave, destroyView = leave)
                else if (!leave) stayedOnPage()
            }
            return true
        }

        override fun onReceivedTitle(view: WebView, title: String?) {
            // The unload check's blank document has no title for the tab (see confirmUnload).
            if (unloadCheck != null) return
            // "Webpage not available" is the built-in error page's, not the tab's (see failedUrl).
            if (failedUrl != null || interstitial) return
            host.viewEvent(tabId, "title", json("title" to (title ?: "")))
            // The entry's title in the list follows the page's.
            pushHistory()
        }

        /**
         * The page's load progress for the host's bar (the chrome's on the frame edge, a custom
         * tab's under its toolbar). WebView reports it in bursts (a dozen steps within a few
         * milliseconds on a fast page); a bar springs towards each target anyway, so one report
         * per hundred milliseconds carries all it can show – except 100, which always goes
         * through so the bar fills before it fades.
         */
        override fun onProgressChanged(view: WebView, newProgress: Int) {
            if (!loading || unloadCheck != null) return
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
        ): Boolean = host.activity.showFileChooser(host, filePathCallback, fileChooserParams)

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
            // Blink asks only for a window a script may close (one it opened, or a tab still on its
            // first document, `history.length` 1): Chrome closes the tab, and an extension page
            // opened with `tabs.create` counts on it (Tampermonkey's install page closes itself once
            // its background lets the request go). The view goes the way of a page-initiated close:
            // the core hears `destroyed` and closes the tab.
            if (window !== this@TabWebView) return
            post { host.tabs.destroy(tabId) }
        }
    }

    companion object {
        private const val PULL_TAG = "ZenPull"
        /** The text-selection action mode's life, for the emulator driver's record (`SelectionDemo`). */
        const val SELECTION_TAG = "ZenSelection"
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

        /**
         * The most [captureLong] waits for the message strip at the frame's edge to close over
         * the page (the card's exit and the strip's spring take a fraction of it); a strip still
         * there at the end of it stays for good, and is held out of the capture instead.
         */
        private const val COVER_CLEAR_WAIT_MS = 1_500L

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

        /** A `beforeunload` check whose page neither goes nor objects by then may go (Electron's, `UNLOAD_CHECK_TIMEOUT_MS`). */
        private const val UNLOAD_CHECK_TIMEOUT_MS = 5_000L

        /** A `beforeunload` objection this soon after the core asked for a reload is "Reload site?". */
        private const val RELOAD_ASK_WINDOW_MS = 2_000L

        /** Where the visual viewport sits in the layout viewport (non-zero only while pinch-zoomed). */
        private const val VISUAL_OFFSET_SCRIPT =
            "(function(){var v=window.visualViewport;return v?[v.offsetLeft,v.offsetTop]:[0,0]})()"
    }
}
