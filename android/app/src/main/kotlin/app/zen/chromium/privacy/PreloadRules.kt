package app.zen.chromium.privacy

import app.zen.chromium.PageRules

/**
 * Preload pages "No preloading" (PS-43) at the request engine, the half `TabWebView`'s
 * `applySpeculativeLoading` cannot reach: `SPECULATIVE_LOADING_DISABLED` governs Prerender2 alone
 * (`AwSettings::IsPrerender2Allowed`), while a `<link rel=prefetch>` and a speculation-rules
 * prefetch are Blink resource fetches that still leave. Chromium marks exactly those requests –
 * and no page can forge the mark (the `Sec-` prefix) – with `Sec-Purpose: prefetch`, or
 * `prefetch;prerender` on the fetch a prerender starts with; the legacy `Purpose: prefetch` is
 * read too, as the desktop reads it. The twin of `isPreloadRequest` in
 * `src/core/protection/policy.ts`, token for token, and of the desktop's `PreloadHandler`
 * (`src/main/platform/privacy.ts`), which cancels every such request under `none`.
 *
 * Pure, so the JVM tests pin it; read per request on WebView's network threads, at the level the
 * core last pushed ([PrivacyFlags.preloadPages], live on every `privacy.apply`).
 */
object PreloadRules {
    /** The level under which every prefetch is refused (`PreloadPagesLevel` `none` in `src/shared/privacy.ts`). */
    const val LEVEL_NONE = "none"

    private const val PREFETCH_TOKEN = "prefetch"

    /**
     * Whether `headers` mark a speculative load: the token `prefetch` among the `;`-separated
     * values of a `Sec-Purpose` or `Purpose` header, header names in any case, the token in any
     * case, whole (`prefetching` or `unprefetch` is not it). Null or empty headers mark nothing.
     */
    fun isPreloadRequest(headers: Map<String, String>?): Boolean {
        headers ?: return false
        for ((name, value) in headers) {
            if (!name.equals("Sec-Purpose", ignoreCase = true) && !name.equals("Purpose", ignoreCase = true)) continue
            if (value.split(';').any { it.trim().equals(PREFETCH_TOKEN, ignoreCase = true) }) return true
        }
        return false
    }

    /**
     * Whether the request engine answers this request empty under `flags`: Preload pages is
     * `none`, the URL is a web address (http or https; nothing else is prefetched, and the
     * desktop refuses the same two schemes) and the headers carry the prefetch mark
     * ([isPreloadRequest]). Under `standard` and `extended` nothing is refused.
     */
    fun refuses(flags: PrivacyFlags, url: String, headers: Map<String, String>?): Boolean =
        flags.preloadPages == LEVEL_NONE && PageRules.isWebPage(url) && isPreloadRequest(headers)
}
