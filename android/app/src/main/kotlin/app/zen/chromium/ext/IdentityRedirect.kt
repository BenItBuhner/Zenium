package app.zen.chromium.ext

/**
 * Chrome's redirect host for `identity.launchWebAuthFlow`, `https://<id>.chromiumapp.org`, which
 * the OAuth providers have registered. A flow ends on the first top-frame navigation of its tab
 * to any https URL on that host, whatever the path (`getRedirectURL(path)` is a hint for the
 * provider): the same match as the core's `isRedirectBack` (`core/extensions/api/identity.ts`),
 * done here so the load is cancelled before a request goes out, without a round trip.
 */
object IdentityRedirect {
    private const val SCHEME = "https://"

    fun host(extensionId: String): String = "$extensionId.chromiumapp.org"

    fun isRedirectBack(extensionId: String, url: String): Boolean {
        if (!url.regionMatches(0, SCHEME, 0, SCHEME.length, ignoreCase = true)) return false
        var end = SCHEME.length
        while (end < url.length && url[end] != '/' && url[end] != '?' && url[end] != '#') end++
        // Like the URL standard's `host`: credentials dropped, a port kept (and so another host).
        val authority = url.substring(SCHEME.length, end).substringAfterLast('@')
        return authority.equals(host(extensionId), ignoreCase = true)
    }
}
