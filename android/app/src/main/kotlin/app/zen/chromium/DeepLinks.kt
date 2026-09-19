package app.zen.chromium

/**
 * What a `VIEW` intent aimed at the browser window may bring in: a web link, or one of Zenium's
 * own pages under its user-facing scheme (`zenium://settings/privacy`, the manifest's `zenium`
 * filter on MainActivity). The core decides what the address means (`src/shared/internalPages.ts`
 * turns the alias into the `zen://` page it stores and reuses the page's tab); this only keeps
 * `file:`, `content:` and the like from ever reaching `openUrl`.
 *
 * The page addresses are the user's to open – typed, from a menu, shared in, or sent by another
 * app through the intent (its filter carries `DEFAULT` and not `BROWSABLE`, so no web page can
 * launch it) – and never a web page's: a document that navigates itself or a frame to a page
 * address is refused ([refusedFromDocument]), as Chrome refuses web content `chrome://settings`.
 * Only the browser's own `zen://` documents may link to its pages. Pure, so it has a JVM test.
 */
object DeepLinks {
    /** The user-facing scheme of Zenium's internal pages (`INTERNAL_ALIAS_SCHEME` in the core). */
    const val PAGE_SCHEME = "zenium"

    /** The scheme the core stores its documents and pages under (`INTERNAL_SCHEME`). */
    const val INTERNAL_SCHEME = "zen"

    private val SCHEMES = setOf("http", "https", PAGE_SCHEME)

    fun accepts(url: String?): Boolean {
        if (url.isNullOrBlank()) return false
        val scheme = schemeOf(url) ?: return false
        return scheme in SCHEMES && url.length > scheme.length + 1
    }

    /** Whether `url` names one of the browser's own documents or pages, under either scheme. */
    fun namesInternal(url: String?): Boolean {
        val scheme = schemeOf(url) ?: return false
        return scheme == INTERNAL_SCHEME || scheme == PAGE_SCHEME
    }

    /**
     * The user-facing form of an internal address (`zen://settings/look` → `zenium://settings/look`),
     * the one a `VIEW` intent carries and [accepts] takes; anything else comes back unchanged.
     */
    fun aliasOf(url: String): String =
        if (schemeOf(url) == INTERNAL_SCHEME) PAGE_SCHEME + url.substring(INTERNAL_SCHEME.length) else url

    /**
     * Whether a navigation the document at [document] started (a link, a script, a frame) to
     * [target] is refused: the target is an internal address and the document is not one of the
     * browser's own `zen://` documents. A web page, a `data:` or `about:blank` document, and a
     * page with no document yet are all refused; the core's own documents (the error page, the
     * new tab page) may link to its pages.
     */
    fun refusedFromDocument(document: String?, target: String?): Boolean {
        if (!namesInternal(target)) return false
        return schemeOf(document) != INTERNAL_SCHEME
    }

    private fun schemeOf(url: String?): String? {
        if (url.isNullOrBlank()) return null
        val colon = url.indexOf(':')
        if (colon <= 0) return null
        val scheme = url.substring(0, colon)
        if (!scheme[0].isLetter() || !scheme.all { it.isLetterOrDigit() || it == '+' || it == '-' || it == '.' }) return null
        return scheme.lowercase()
    }
}
