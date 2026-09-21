package app.zen.chromium

import java.net.URI

/**
 * The test hook behind `Host.netOriginOverride` (debug builds only): a core fetch (`net.fetch`)
 * sent to another origin with its path and query kept, and the origin it meant in an
 * `x-zen-origin` header – the desktop's `ZEN_NET_ORIGIN` (`redirectedOrigin` in
 * `src/main/platform/index.ts`), so one harness answers both hosts deterministically (a demo's
 * page server standing in for the Pwned Passwords range API, say). A URL or an override that
 * does not parse to a scheme and a host leaves the request as it was.
 */
object NetOrigin {
    class Redirected(
        /** Where the request goes. */
        val url: String,
        /** The origin the core meant (`https://api.pwnedpasswords.com`), null when nothing was redirected. */
        val origin: String?
    )

    fun redirect(url: String, override: String?): Redirected {
        if (override.isNullOrBlank()) return Redirected(url, null)
        val original = parse(url) ?: return Redirected(url, null)
        val target = parse(override) ?: return Redirected(url, null)
        val path = original.rawPath?.takeIf { it.isNotEmpty() } ?: "/"
        val query = original.rawQuery?.let { "?$it" } ?: ""
        return Redirected(
            url = "${target.scheme}://${target.rawAuthority}$path$query",
            origin = "${original.scheme}://${original.rawAuthority}"
        )
    }

    /** An absolute http(s) URI with a host, else null. */
    private fun parse(text: String): URI? {
        val uri = runCatching { URI(text) }.getOrNull() ?: return null
        val scheme = uri.scheme?.lowercase() ?: return null
        if (scheme != "http" && scheme != "https") return null
        if (uri.rawAuthority.isNullOrEmpty() || uri.host.isNullOrEmpty()) return null
        return uri
    }
}
