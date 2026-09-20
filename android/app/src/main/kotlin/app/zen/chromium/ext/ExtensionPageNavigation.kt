package app.zen.chromium.ext

/**
 * What an extension's own WebView (a popup, an options page, the background page, an offscreen
 * document: [ExtensionWebView]) does with a navigation its document asked for
 * (`shouldOverrideUrlLoading`). The view never leaves its extension's origin: a link into the
 * web opens as a tab. A `chrome-extension://<id>/...` URL, Chrome's spelling of an extension
 * page, which the WebView has no scheme for, resolves through the runtime's own mapping
 * ([ExtensionUrls.toServed]): the extension's own page loads in the view, another extension's
 * opens as a tab (its files reach a foreign page from its `web_accessible_resources` only,
 * [Extensions.intercept], as in Chrome). A sub-frame sent to that spelling is dropped here,
 * since WebView offers no way to send a frame elsewhere from this callback; the page script gave
 * the frame's element the served spelling as it was written (`extensionFrameUrls.ts`), and that
 * load is the one that lands. The OS is never handed an extension URL; any other scheme
 * (mailto:, intent:) is its, as before.
 */
object ExtensionPageNavigation {
    sealed class Decision {
        /** The WebView proceeds with the navigation as asked (the extension's own served origin). */
        object Proceed : Decision()

        /** The view loads [url] in place of what was asked (the served spelling of the extension's own page). */
        data class Load(val url: String) : Decision()

        /** [url] opens as a tab (the web, another extension's page); a popup closes over it. */
        data class OpenTab(val url: String) : Decision()

        /** Nothing loads: a sub-frame's navigation to Chrome's spelling, which its element's served src replaces. */
        object Drop : Decision()

        /** Another scheme, the OS's to resolve. */
        data class External(val url: String) : Decision()
    }

    /**
     * The decision for [url], asked from a view on the served [origin] (`https://<id>.ext.zenium.invalid`,
     * no trailing slash), in its main frame or a sub-frame.
     */
    fun decide(origin: String, url: String, mainFrame: Boolean): Decision {
        if (url.startsWith("$origin/")) return Decision.Proceed
        val served = ExtensionUrls.toServed(url)
        return when {
            served != url && !mainFrame -> Decision.Drop
            served != url && served.startsWith("$origin/") -> Decision.Load(served)
            served.startsWith("http:") || served.startsWith("https:") -> Decision.OpenTab(served)
            else -> Decision.External(url)
        }
    }
}
