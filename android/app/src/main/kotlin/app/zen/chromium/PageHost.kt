package app.zen.chromium

import android.view.View
import android.webkit.WebChromeClient
import app.zen.chromium.blocking.Blocking
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
    val keys: Keys
    val downloads: Downloads
    val permissions: Permissions
    /** Links that leave the web (`mailto:`, `intent://`, a site's own app). */
    val externalProtocols: ExternalProtocols
    /** HTTP sign-in and client-certificate requests. */
    val security: Security
    val snapshots: HistorySnapshots
    val tabs: TabHost
    val fullscreenTab: TabWebView?
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

    /** Something happened to one page: `navigated`, `title`, `startLoading`, … (see [TabWebView]). */
    fun viewEvent(tabId: String, name: String, payload: Any?)

    /** Something happened outside any one page: a download, a permission request, a popup. */
    fun hostEvent(name: String, payload: Any?)

    /** Load progress of a page's main document, 0…100. */
    fun progress(tabId: String, percent: Int) {}

    /** A pull-to-refresh on a page moved on: `start`, `move`, `release` or `cancel` (see `lib/pull.ts`). */
    fun pullEvent(tabId: String, phase: String, payload: JSONObject?) {}

    /** A physical key the shortcut table matched (`tabId` null: typed into the chrome). */
    fun onKey(tabId: String?, input: JSONObject)

    fun enterFullscreen(tab: TabWebView, view: View, callback: WebChromeClient.CustomViewCallback)
    fun exitFullscreen(tab: TabWebView)
    fun openExternal(url: String)

    /** A page's history or fullscreen state changed: whoever handles back re-decides its target. */
    fun backChanged()
    fun onPageTransitionEnded(transition: PageBackTransition)
}
