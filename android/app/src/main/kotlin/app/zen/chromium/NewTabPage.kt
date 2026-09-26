package app.zen.chromium

/**
 * The served new tab page (NTP-35): `zen://newtab`, the core's document a tablet's new tab shows
 * in its own page view. What a view can tell about it, pure so the JVM tests can pin it: whether
 * a document is the page (the view's [TabWebView.servesNewTabPage] flag, the hold that is the
 * page's own – [LinkHits.holdIsThePages]), and which of the page's requests are its tiles' icons.
 */
object NewTabPage {
    /** The served page, as the core spells it (`NEW_TAB_URL` in `shared/url.ts`). */
    const val URL = "zen://newtab"

    /**
     * The tiles' icon addresses (`core/favicons.ts` `resolve`): `zen://favicon/<hash>`, the hash
     * naming the cached icon's document – the same store the chrome's `/zen-favicon/<hash>` route
     * reads ([BootHandoff.favicon]).
     */
    const val FAVICON_PREFIX = "zen://favicon/"

    /** Whether [document] is the served page: `zen://newtab` itself, or a path or query under it. */
    fun isDocument(document: String?): Boolean =
        document != null && (document == URL || document.startsWith("$URL/") || document.startsWith("$URL?"))

    /**
     * The hash a request of the served page names an icon by, or null for any other request –
     * the request then goes on down the intercept chain untouched. A `zen://favicon/` address
     * with no hash or a malformed one (anything but 32 hex digits) is the page's own request for
     * an icon that cannot exist: it is answered 404 like a missing one ([BootHandoff.favicon]
     * refuses the name), and the tile shows its letter.
     */
    fun faviconHash(url: String): String? =
        if (url.startsWith(FAVICON_PREFIX)) url.substring(FAVICON_PREFIX.length) else null
}
