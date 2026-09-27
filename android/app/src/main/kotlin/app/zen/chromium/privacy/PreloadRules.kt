package app.zen.chromium.privacy

import app.zen.chromium.PageRules

/**
 * Preload pages "No preloading" (PS-43) at the request engine, the half `TabWebView`'s
 * `applySpeculativeLoading` cannot reach: `SPECULATIVE_LOADING_DISABLED` governs Prerender2 alone
 * (`AwSettings::IsPrerender2Allowed`), while a speculation-rules prefetch still leaves. Chromium
 * marks a speculative request – and no page can forge the mark (the `Sec-` prefix) – with
 * `Sec-Purpose: prefetch`, or `prefetch;prerender` on the fetch a prerender starts with; the
 * legacy `Purpose: prefetch` is read too, as the desktop reads it. The twin of `isPreloadRequest`
 * in `src/core/protection/policy.ts`, token for token, and of the desktop's `PreloadHandler`
 * (`src/main/platform/privacy.ts`), which cancels every such request under `none`.
 *
 * What reaches `shouldInterceptRequest` marked is refused; what reaches it unmarked cannot be.
 * Measured on WebView 113 (run 36244937529): a speculation-rules prefetch arrives with
 * `Sec-Purpose: prefetch` and `Purpose: prefetch` – the browser process puts both into the
 * request's headers – and is refused; a `<link rel=prefetch>` arrives as a plain fetch (`Accept`,
 * `Referer`, `User-Agent`). Blink does mark it `Purpose: prefetch`, but carries that header in
 * the request's `cors_exempt_headers`, which WebView's `AwWebResourceRequest` omits; the network
 * service merges it into the URLRequest, where the desktop's `onBeforeSendHeaders` reads it and
 * this hook cannot. WebView 124 carries it the same way – the phone's remaining limit under
 * `none` on both. From Chromium 138 (`SecPurposePrefetchHeaderRelPrefetch` on by default) the
 * link prefetch carries `Sec-Purpose: prefetch` as a real header, and this rule refuses it
 * unchanged.
 *
 * The same refusal is Chrome Android's answer to the system's Data Saver and Battery Saver
 * (OS-21): `prefetch::IsSomePreloadingEnabled` holds every preload under either mode at every
 * Preload-pages level ([SaverModes]), and so does [refuses], from the same mark.
 *
 * Pure, so the JVM tests pin it; read per request on WebView's network threads, at the level the
 * core last pushed ([PrivacyFlags.preloadPages], live on every `privacy.apply`) and the saver
 * state as of the last second ([SaverModes.state]).
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
     * Whether the request engine answers this request empty: the URL is a web address (http or
     * https; nothing else is prefetched, and the desktop refuses the same two schemes), the
     * headers carry the prefetch mark ([isPreloadRequest]), and either Preload pages is `none`
     * or the system's Data Saver or Battery Saver is on (`saver`, OS-21) – Chrome Android's
     * `IsSomePreloadingEnabled`, in its order: the level first, the saver modes after it, at
     * every level (`preloading_prefs.cc:60-76`). Under `standard` and `extended` with neither
     * mode on nothing is refused. `saver` is asked last and only for a marked web request the
     * level alone does not refuse: a page's own requests never read the system.
     */
    fun refuses(flags: PrivacyFlags, url: String, headers: Map<String, String>?, saver: () -> SaverState = { SaverState.NONE }): Boolean =
        PageRules.isWebPage(url) && isPreloadRequest(headers) && (flags.preloadPages == LEVEL_NONE || saver().refusesPreloading)
}
