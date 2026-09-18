package app.zen.chromium.ext

import android.webkit.WebView
import androidx.webkit.Navigation
import androidx.webkit.NavigationListener
import androidx.webkit.Page
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import app.zen.chromium.NetErrors
import app.zen.chromium.json
import org.json.JSONObject

/**
 * A tab's main-frame navigations as the WebView's navigation listener reports them (androidx.webkit
 * `NAVIGATION_LISTENER`, Chromium 137+), posted as `navigation` view events for the extension
 * runtime's `webNavigation` derivation (`src/android/extensionWebNavigation.ts`): the phases
 * `started`, `redirected`, `completed` (with whether the navigation committed, or which `net::`
 * error it failed with) and the page's `dom` / `load` events. Nothing here runs on a WebView
 * without the feature; the runtime infers the family from the client callbacks instead.
 */
object NavigationReports {
    val supported: Boolean
        get() = featureSupported(WebViewFeature.NAVIGATION_LISTENER)

    /**
     * `WebViewFeature.isFeatureSupported` throws `RuntimeException("Unknown feature …")` for a
     * public constant the library's internal feature table does not carry (androidx.webkit 1.17.0
     * declares `PAGE_GET_URL` and has no entry for it; measured as a crash of the app on WebView
     * 156 the first time a page reached DOMContentLoaded). Every feature read goes through here.
     */
    private fun featureSupported(feature: String): Boolean =
        runCatching { WebViewFeature.isFeatureSupported(feature) }.getOrDefault(false)

    /** Attach to `view`; every report goes to `post`. Returns what to pass to [detach], or null when unsupported. */
    fun attach(view: WebView, post: (JSONObject) -> Unit): NavigationListener? {
        if (!supported) return null
        val listener = object : NavigationListener {
            override fun onNavigationStarted(navigation: Navigation) = post(report("started", navigation))
            override fun onNavigationRedirected(navigation: Navigation) = post(report("redirected", navigation))
            override fun onNavigationCompleted(navigation: Navigation) = post(report("completed", navigation))
            override fun onPageDomContentLoadedEvent(page: Page) = post(json("phase" to "dom", "url" to pageUrl(page, view)))
            override fun onPageLoadEvent(page: Page) = post(json("phase" to "load", "url" to pageUrl(page, view)))
        }
        return runCatching {
            WebViewCompat.addNavigationListener(view, listener)
            listener
        }.getOrNull()
    }

    fun detach(view: WebView, listener: NavigationListener?) {
        if (listener == null) return
        runCatching { WebViewCompat.removeNavigationListener(view, listener) }
    }

    /** The report of one phase; the flags are read defensively (each is its own WebView feature). */
    fun report(phase: String, navigation: Navigation): JSONObject {
        val o = json("phase" to phase, "url" to (runCatching { navigation.url }.getOrNull() ?: ""))
        if (runCatching { navigation.isSameDocument }.getOrDefault(false)) o.put("sameDocument", true)
        if (runCatching { navigation.isReload }.getOrDefault(false)) o.put("reload", true)
        if (runCatching { navigation.isHistory }.getOrDefault(false)) o.put("history", true)
        if (runCatching { navigation.wasInitiatedByPage() }.getOrDefault(false)) o.put("byPage", true)
        if (phase == "completed") {
            val committed = runCatching { navigation.didCommit() }.getOrDefault(true)
            o.put("committed", committed)
            val errorPage = runCatching { navigation.didCommitErrorPage() }.getOrDefault(false)
            if (errorPage) o.put("errorPage", true)
            val status = runCatching { navigation.statusCode }.getOrDefault(0)
            if (status > 0) o.put("statusCode", status)
            if (!committed || errorPage) {
                val error = if (featureSupported(WebViewFeature.NAVIGATION_GET_WEB_RESOURCE_ERROR)) {
                    runCatching { navigation.webResourceError }.getOrNull()
                } else null
                errorName(error?.errorCode, error?.description?.toString(), status)?.let { o.put("error", it) }
            }
        }
        return o
    }

    /**
     * Chrome's `onErrorOccurred.error`: the `net::ERR_…` name of the WebView error code when
     * there is one, an HTTP failure's `net::ERR_HTTP_RESPONSE_CODE_FAILURE`, else the code's own
     * description, and nothing when nothing is known (the runtime picks the default then).
     */
    fun errorName(webViewCode: Int?, description: String?, status: Int): String? {
        if (webViewCode != null) {
            val failure = NetErrors.failure(webViewCode, description ?: "", offline = false)
            val name = failure.name ?: description
            if (!name.isNullOrBlank()) return if (name.startsWith("net::")) name else "net::$name"
        }
        if (status >= 400) return "net::ERR_HTTP_RESPONSE_CODE_FAILURE"
        return null
    }

    /**
     * The page's own URL when the WebView answers `Page.getUrl` (the library forwards the call to
     * the WebView unguarded; an older WebView throws `UnsupportedOperationException`), else the
     * view's current URL, which is the page's for the main frame the listener reports on.
     */
    private fun pageUrl(page: Page, view: WebView): String =
        runCatching { page.url }.getOrNull() ?: view.url ?: ""
}
