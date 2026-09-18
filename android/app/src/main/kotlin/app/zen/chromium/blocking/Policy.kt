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
    /** Why `url` must not load as a document (main or sub frame), or null to let the engine decide. */
    fun unsafe(url: String): SafeBrowsingHit?

    /**
     * Whether HTTPS-only mode's upgrade of `url` is to be skipped: the user allowed the site over
     * plaintext. The mode's rule excludes those sites itself once the engine has reloaded it;
     * this covers the requests in between.
     */
    fun plaintextAllowed(url: String): Boolean
}
