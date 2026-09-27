package app.zen.chromium

/**
 * The scope rules of a Trusted Web Activity (CCT-20), pure so they have a JVM test. A custom tab
 * launched with `EXTRA_LAUNCH_AS_TRUSTED_WEB_ACTIVITY` names the origins its client claims: the
 * launch URL's and `EXTRA_ADDITIONAL_TRUSTED_ORIGINS`. Each is verified once against the site's
 * Digital Asset Links statement ([TwaVerifier]); every committed navigation is then judged by its
 * origin alone, as Chrome 152's `CurrentPageVerifier.verify` (`CurrentPageVerifier.java:118-132`)
 * judges it through `TwaVerifier.verify` (`TwaVerifier.java:70-92`): a claimed origin is pending
 * until its verdict lands, any other origin counts only if it was verified before, and a URL with
 * no origin – `about:blank`, a `data:` document, the error page – leaves the state as it was
 * (`getVerifiedScope` answers null, `CurrentPageVerifier.java:120-121`).
 *
 * The toolbar follows the state. Chrome's `SharedActivityCoordinator.appModeUiAllowedFor`
 * (`SharedActivityCoordinator.java:133-136`) keeps the app-mode chrome – no toolbar – for a null
 * or pending state and for a verified one; only FAILURE brings the browser's controls, and
 * `TrustedWebActivityBrowserControlsVisibilityManager.computeBrowserControlsState`
 * (`TrustedWebActivityBrowserControlsVisibilityManager.java:116-129`) forces them shown whatever
 * the state on a page whose security level is DANGEROUS or WARNING – an http page off the
 * loopback, a `data:` document ([notSecure]).
 */
object TwaScope {
    /** androidx.browser's `TrustedWebActivityIntentBuilder.EXTRA_LAUNCH_AS_TRUSTED_WEB_ACTIVITY`. */
    const val EXTRA_LAUNCH_AS_TRUSTED_WEB_ACTIVITY = "android.support.customtabs.extra.LAUNCH_AS_TRUSTED_WEB_ACTIVITY"

    /** androidx.browser's `TrustedWebActivityIntentBuilder.EXTRA_ADDITIONAL_TRUSTED_ORIGINS`. */
    const val EXTRA_ADDITIONAL_TRUSTED_ORIGINS = "android.support.customtabs.extra.ADDITIONAL_TRUSTED_ORIGINS"

    /** One claimed origin's verdict; Chrome's `CurrentPageVerifier.VerificationStatus`. */
    enum class Verification { PENDING, VERIFIED, FAILED }

    /**
     * The origin a navigation is judged by, as Chrome's `Origin.create` (`Origin.java:46-77`)
     * writes it: `http` or `https` only, the scheme and host in lower case, a default port
     * folded, any `user:password` dropped. Null for anything else – `about:blank`, `data:`,
     * `javascript:`, the error page, a string that is no URL – so the caller keeps its state.
     */
    fun origin(url: String?): String? {
        val parts = WebAppRules.parse(url) ?: return null
        if (parts.scheme != "http" && parts.scheme != "https") return null
        return WebAppRules.origin(url)
    }

    /**
     * The origins the client claims: the launch URL's and each additional one it named
     * (`CustomTabIntentDataProvider.java:1602-1621` builds the same set from the intent). Strings
     * that name no http(s) origin are dropped.
     */
    fun trustedOrigins(launchUrl: String?, additional: List<String>?): Set<String> {
        val out = LinkedHashSet<String>()
        origin(launchUrl)?.let(out::add)
        additional?.forEach { origin(it)?.let(out::add) }
        return out
    }

    /**
     * The state after a navigation to [url]: unchanged from [previous] when the URL has no
     * origin; for a claimed origin its verdict from [verdicts] or PENDING while none has landed;
     * for any other origin VERIFIED only if [verdicts] already says so (Chrome's
     * `wasPreviouslyVerified`, `TwaVerifier.java:86-88`), else FAILED at once – an unclaimed
     * origin is never verified on the way. [verdicts] holds settled verdicts alone.
     */
    fun stateFor(
        url: String?,
        trusted: Set<String>,
        verdicts: Map<String, Verification>,
        previous: Verification?,
    ): Verification? {
        val origin = origin(url) ?: return previous
        val verdict = verdicts[origin]
        return when {
            origin in trusted -> verdict ?: Verification.PENDING
            verdict == Verification.VERIFIED -> Verification.VERIFIED
            else -> Verification.FAILED
        }
    }

    /** Whether the window is in app mode – no toolbar – for this state: everything but FAILED. */
    fun appMode(state: Verification?): Boolean = state != Verification.FAILED

    /**
     * Whether the toolbar shows on [url]: out of app mode, or whatever the state on a page Chrome
     * badges "Not secure" (the controls forced SHOWN for a DANGEROUS or WARNING level).
     */
    fun toolbarShown(state: Verification?, url: String?): Boolean = !appMode(state) || notSecure(url)

    /**
     * The pages Chrome's `security_state::GetSecurityLevel` puts at WARNING (`security_state.cc:
     * 91-95, 118-136`): a `data:` document, and an http page off the loopback. An error page, a
     * `blob:` of a secure page and `about:blank` stay NONE and keep the app-mode chrome.
     */
    fun notSecure(url: String?): Boolean {
        if (url.isNullOrEmpty()) return false
        return when (url.substringBefore(':', "").lowercase()) {
            "data" -> true
            "http" -> CustomTabPageInfo.connectionOf(url) == CustomTabPageInfo.Connection.INSECURE
            else -> false
        }
    }

    /**
     * The history index the close button returns to when the page is out of scope: the newest
     * entry before [currentIndex] whose origin is verified – Chrome's
     * `CloseButtonNavigator.navigateSingleTab` (`CloseButtonNavigator.java:125-139`) with the
     * TWA's landing-page criterion, `wasPreviouslyVerified` (`SharedActivityCoordinator.java:72-74`)
     * – or null when there is none and the window closes instead.
     */
    fun landingIndex(history: List<String>, currentIndex: Int, verdicts: Map<String, Verification>): Int? {
        for (i in (currentIndex - 1).coerceAtMost(history.lastIndex) downTo 0) {
            val origin = origin(history[i]) ?: continue
            if (verdicts[origin] == Verification.VERIFIED) return i
        }
        return null
    }
}
