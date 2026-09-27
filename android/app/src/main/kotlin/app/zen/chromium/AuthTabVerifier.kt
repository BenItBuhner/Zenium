package app.zen.chromium

import android.content.Context
import android.content.pm.PackageManager
import android.content.pm.verify.domain.DomainVerificationManager
import android.content.pm.verify.domain.DomainVerificationUserState
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Log
import java.util.concurrent.Executors

/**
 * The Auth Tab's return on the device (CCT-13; Chrome's `AuthTabVerifier`): claims the
 * navigation that is the caller's redirect ([AuthTab.match]) and answers the caller through
 * [onResult] – at once for a custom scheme; for an https redirect once the caller is verified as
 * the host's app, which starts as the tab opens and runs beside the sign-in: Android's own
 * verified links of the caller's package (`DomainVerificationManager`, API 31+), else the host's
 * `/.well-known/assetlinks.json` granting `handle_all_urls` to the caller's package and signing
 * certificate ([AuthTab.statementGrants]). A redirect that arrives before the verdict waits for
 * it up to [AuthTab.VERIFICATION_TIMEOUT_MS], then answers `RESULT_VERIFICATION_TIMED_OUT`; a
 * failed verdict answers `RESULT_VERIFICATION_FAILED`; the URI travels only with `RESULT_OK`.
 * Main thread, except the two lookups.
 */
class AuthTabVerifier(
    private val context: Context,
    private val redirect: AuthTab.Redirect,
    /** The app that started the tab for a result (`getCallingActivity`), whose statement the host must carry. */
    private val callerPackage: String?,
    /** The answer: the result code and, with `RESULT_OK`, the redirect URL. Called once, on the main thread. */
    private val onResult: (code: Int, url: String?) -> Unit
) : AuthTab.Return {
    private val main = Handler(Looper.getMainLooper())
    private var verification = AuthTab.Verification.PENDING
    /** The https redirect that arrived while the verification was pending. */
    private var heldUrl: String? = null
    private var answered = false
    private var destroyed = false
    private val timeout = Runnable {
        if (verification == AuthTab.Verification.PENDING) verification = AuthTab.Verification.TIMED_OUT
        heldUrl?.let { answer(AuthTab.Match.HTTPS, it) }
    }

    init {
        if (redirect.https) startVerification()
    }

    /** True when the navigation is the caller's redirect: it is not loaded, the caller gets it. */
    override fun claim(url: String, mainFrame: Boolean): Boolean {
        val match = AuthTab.claimed(redirect, url, mainFrame) ?: return false
        if (answered) return true
        when (match) {
            AuthTab.Match.SCHEME -> answer(match, url)
            AuthTab.Match.HTTPS -> if (verification == AuthTab.Verification.PENDING) {
                // Chrome's rule: the redirect waits for the verdict, at most the timeout.
                if (heldUrl == null) main.postDelayed(timeout, AuthTab.VERIFICATION_TIMEOUT_MS)
                heldUrl = url
            } else {
                answer(match, url)
            }
        }
        return true
    }

    /** The tab is going: nothing is answered after this (the activity's default result stands). */
    fun destroy() {
        destroyed = true
        main.removeCallbacks(timeout)
    }

    private fun answer(match: AuthTab.Match, url: String) {
        if (answered || destroyed) return
        answered = true
        main.removeCallbacks(timeout)
        val code = AuthTab.resultCode(match, verification)
        onResult(code, if (code == AuthTab.RESULT_OK) url else null)
    }

    private fun startVerification() {
        val host = redirect.host ?: return
        val pkg = callerPackage
        if (pkg == null) {
            // No caller to verify against (started without a result to return): the https form
            // can never be granted, as Chrome's origin verifier fails a null package.
            verification = AuthTab.Verification.FAILED
            return
        }
        lookups.execute {
            val verified = runCatching { verifiedByAndroid(pkg, host) || verifiedByStatement(pkg, host) }
                .onFailure { Log.w(TAG, "auth tab verification of $pkg for $host failed", it) }
                .getOrDefault(false)
            main.post {
                if (destroyed || verification != AuthTab.Verification.PENDING) return@post
                verification = if (verified) AuthTab.Verification.VERIFIED else AuthTab.Verification.FAILED
                heldUrl?.let { answer(AuthTab.Match.HTTPS, it) }
            }
        }
    }

    /** Android's own verdict on the caller's app links (API 31+): the host among its verified domains. */
    private fun verifiedByAndroid(pkg: String, host: String): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return false
        val manager = context.getSystemService(DomainVerificationManager::class.java) ?: return false
        val state = try {
            manager.getDomainVerificationUserState(pkg)
        } catch (e: PackageManager.NameNotFoundException) {
            null
        } ?: return false
        return state.hostToStateMap.any { (domain, value) ->
            value == DomainVerificationUserState.DOMAIN_STATE_VERIFIED && domain.equals(host, ignoreCase = true)
        }
    }

    /**
     * The host's `assetlinks.json`, fetched once ([DigitalAssetLinks.fetchStatements]), against
     * the caller's package and signing certificates.
     */
    private fun verifiedByStatement(pkg: String, host: String): Boolean {
        val fingerprints = DigitalAssetLinks.signingFingerprints(context, pkg)
        if (fingerprints.isEmpty()) return false
        val text = DigitalAssetLinks.fetchStatements(AuthTab.assetLinksUrl(host)) ?: return false
        return AuthTab.statementGrants(text, pkg, fingerprints)
    }

    companion object {
        private const val TAG = "ZenAuthTab"
        private val lookups = Executors.newSingleThreadExecutor { r -> Thread(r, "zen-auth-tab-verify") }
    }
}
