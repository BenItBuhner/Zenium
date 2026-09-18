package app.zen.chromium

/**
 * What a `VIEW` intent aimed at the browser window may bring in: a web link, or one of Zenium's
 * own pages under its user-facing scheme (`zenium://settings/privacy`, the manifest's `zenium`
 * filter on MainActivity). The core decides what the address means (`src/shared/internalPages.ts`
 * turns the alias into the `zen://` page it stores and reuses the page's tab); this only keeps
 * `file:`, `content:` and the like from ever reaching `openUrl`. Pure, so it has a JVM test.
 */
object DeepLinks {
    /** The user-facing scheme of Zenium's internal pages (`INTERNAL_ALIAS_SCHEME` in the core). */
    const val PAGE_SCHEME = "zenium"

    private val SCHEMES = setOf("http", "https", PAGE_SCHEME)

    fun accepts(url: String?): Boolean {
        if (url.isNullOrBlank()) return false
        val colon = url.indexOf(':')
        if (colon <= 0) return false
        return url.substring(0, colon).lowercase() in SCHEMES && url.length > colon + 1
    }
}
