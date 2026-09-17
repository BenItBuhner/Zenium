package app.zen.chromium

import android.view.View
import android.webkit.WebChromeClient
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
    val keys: Keys
    val downloads: Downloads
    val permissions: Permissions
    /** Links that leave the web (`mailto:`, `intent://`, a site's own app). */
    val externalProtocols: ExternalProtocols
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
