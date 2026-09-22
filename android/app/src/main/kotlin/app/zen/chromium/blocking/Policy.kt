package app.zen.chromium.blocking

import org.json.JSONObject

/** Why Safe Browsing stopped a URL (the core's `SafeBrowsingHit`): which feed lists it, as what, under which expression. */
class SafeBrowsingHit(val feedId: String, val threat: String, val expression: String) {
    fun toJson(): JSONObject = JSONObject()
        .put("feedId", feedId)
        .put("threat", threat)
        .put("expression", expression)
        .put("remote", false)
}

/**
 * What the privacy policy adds to the engine's word on a request, consulted on WebView's IO
 * threads ahead of the rule sets (implemented by `privacy/Privacy.kt`). The desktop's
 * counterpart is the `SafeBrowsingHandler` ahead of the rule engine in the request multiplexer
 * and the `httpsOnlyAllowed` flags the `PrivacyService` pushes.
 */
interface RequestPolicy {
    /**
     * Why `url` must not load as a document (main or sub frame), or null to let the engine decide.
     * `navigation` marks a main-frame document's request on a network thread: the process's first
     * may wait for the Safe Browsing tables to load (`SafeBrowsing.tablesForNavigation`); frames,
     * subresources and the main thread's early look at a navigation never do.
     */
    fun unsafe(url: String, navigation: Boolean = false): SafeBrowsingHit?

    /**
     * Whether HTTPS-only mode's upgrade of `url` is to be skipped: the user allowed the site over
     * plaintext. The mode's rule excludes those sites itself once the engine has reloaded it;
     * this covers the requests in between.
     */
    fun plaintextAllowed(url: String): Boolean

    /**
     * Whether a document request for `url` (a main frame's, `documentUrl` null, or a frame's
     * inside `documentUrl`) in the profile `containerId` goes without cookies under the per-site
     * cookie policy – a site on the never list, every unlisted site under "block all cookies"
     * (`SiteDataPolicy.verdict`). Such a document is relayed through the header stage, which
     * sends no `Cookie` and keeps no `Set-Cookie`: the desktop's request multiplexer strips the
     * same headers in place. The third-party rule is not asked here: WebView's own per-page
     * switch (`setAcceptThirdPartyCookies`) enforces it on every request, frames included.
     */
    fun cookiesWithheld(url: String, documentUrl: String?, containerId: String): Boolean = false
}
