package app.zen.chromium

import android.view.View
import android.webkit.WebChromeClient
import app.zen.chromium.ext.Extensions
import app.zen.chromium.blocking.Blocking
import app.zen.chromium.privacy.Privacy
import org.json.JSONObject

/**
 * What a page WebView, and the services it reports into, need from whatever hosts it. The
 * browser window's [Host] forwards everything to the chrome WebView, where the core runs; a
 * custom tab ([CustomTabHost]) has no chrome and answers natively. Either way the page behaves
 * identically: the same [TabWebView], the same downloads, permission prompts, file chooser,
 * fullscreen and in-page predictive back.
 */
interface PageHost {
    val activity: BrowserActivity
    /** The page script injected into every document (empty: no script). */
    val pageScript: String
    val pageToken: String
    /** The request engine every page's requests run through (`shouldInterceptRequest`). */
    val blocking: Blocking
    /** The page-controls policy pages are laid out by (desktop site, dark theme for sites, zoom); none by default. */
    val pageRules: PageRules get() = PageRules.NONE
    /** The same rules as the core sent them, handed to every page's document-start script. */
    val pageRulesJson: JSONObject get() = JSONObject()
    /** The privacy policy the pages apply (cookies, signals, Safe Browsing's word ahead of the engine). */
    val privacy: Privacy
    val keys: Keys
    val downloads: Downloads
    val permissions: Permissions
    /** Links that leave the web (`mailto:`, `intent://`, a site's own app). */
    val externalProtocols: ExternalProtocols
    /** HTTP sign-in and client-certificate requests. */
    val security: Security
    val snapshots: HistorySnapshots
    /** The tab cards' pictures on disk ([Thumbnails]); a host without cards (a custom tab) keeps none. */
    val thumbnails: Thumbnails? get() = null
    val tabs: TabHost
    val fullscreenTab: TabWebView?
    /** Whether the host is in its own fullscreen (Menu > Fullscreen: the bars hidden, no element fullscreen). */
    val immersive: Boolean get() = false
    /**
     * The view drawn under the pages that a touch on a covered strip (a message card's, see
     * [ContentCover]) is handed to: the browser window's chrome WebView. A custom tab has none.
     */
    val underlay: View? get() = null
    /** The colour scheme and scrim of the surrounding chrome, for what is drawn natively. */
    val themeDark: Boolean
    val themeScrim: Int
    /** Whether `window.open` popups become tabs of their own (false: they navigate the one page). */
    val popupsAsTabs: Boolean get() = true
    /**
     * Whether a drag down from the top of a page may become a pull-to-refresh (the browser's
     * Look and Feel setting; the chrome draws the disc, so a host without one leaves it off).
     */
    val pullToRefresh: Boolean get() = false
    /**
     * The extension runtime's Kotlin half, when the host runs one: the browser window does; a
     * custom tab has no core to run the backgrounds against, so its pages get no content scripts.
     */
    val extensions: Extensions? get() = null
    /**
     * Whether the forms script in the pages reports fields and submits (the core's autofill; off
     * when a system autofill service owns the pages). Sent with the flags to every new document.
     */
    val formsEnabled: Boolean get() = true
    /** The autofill provider of the pages: `zenium` takes the WebViews out of the system framework. */
    val autofillProvider: String get() = SystemAutofill.PROVIDER_SYSTEM

    /** Something happened to one page: `navigated`, `title`, `startLoading`, … (see [TabWebView]). */
    fun viewEvent(tabId: String, name: String, payload: Any?)

    /** Something happened outside any one page: a download, a permission request, a popup. */
    fun hostEvent(name: String, payload: Any?)

    /** The set of pages in [tabs], or which of them show, changed (the window's secure flag follows private ones). */
    fun onViewsChanged() {}

    /** Load progress of a page's main document, 0…100 (at most one report per 100 ms, and 100 always). */
    fun progress(tabId: String, percent: Int) {}

    /** A pull-to-refresh on a page moved on: `start`, `move`, `release` or `cancel` (see `lib/pull.ts`). */
    fun pullEvent(tabId: String, phase: String, payload: JSONObject?) {}

    /**
     * Zenium's items for the floating toolbar over `text` selected in a page (`Menus.selectionToolbar`
     * in the core): `reply` gets the JSON text of `[{ id, title }]` in order, or null for none. A
     * host without a core (a custom tab) has none; the system's toolbar stands as it is.
     */
    fun selectionMenu(tabId: String, text: String, reply: (String?) -> Unit) = reply(null)

    /** A physical key the shortcut table matched (`tabId` null: typed into the chrome). */
    fun onKey(tabId: String?, input: JSONObject)

    fun enterFullscreen(tab: TabWebView, view: View, callback: WebChromeClient.CustomViewCallback)
    fun exitFullscreen(tab: TabWebView)
    /** Leave the host's own fullscreen (a back while [immersive]); a host without one has nothing to do. */
    fun leaveImmersive() {}
    fun openExternal(url: String)

    /** A page's history or fullscreen state changed: whoever handles back re-decides its target. */
    fun backChanged()
    fun onPageTransitionEnded(transition: PageBackTransition)
}
