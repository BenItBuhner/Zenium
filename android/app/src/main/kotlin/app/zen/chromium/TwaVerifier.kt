package app.zen.chromium

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.util.Log
import app.zen.chromium.TwaScope.Verification
import java.io.IOException
import java.util.concurrent.Executors

/**
 * A Trusted Web Activity's Digital Asset Links check on the device (CCT-20; Chrome's `TwaVerifier`
 * over `OriginVerifier`): each origin the client claims ([CustomTabConfig.trustedOrigins]) is
 * verified once, beside the first load and never ahead of it – the statement file at
 * `<origin>/.well-known/assetlinks.json` must grant `delegate_permission/common.handle_all_urls`
 * to the client's package under one of its signing certificates ([AuthTab.statementGrants]).
 * Chrome's gate first (`OriginVerifier.java:197-207`): an http origin off `localhost` fails
 * without a fetch, and so does a client with no package to name. A verified origin is remembered
 * for the process, as Chrome's `VerificationResultStore` remembers one, so the next launch has
 * its verdict at once (`CurrentPageVerifier.java:122-124`); a failure is this tab's alone and a
 * later launch tries again. Every verdict is named in the log with its reason – the whole of what
 * Chrome 152 surfaces for a failed check, its `QualityEnforcer` gone since M115. Main thread,
 * except the lookups.
 */
class TwaVerifier(
    private val context: Context,
    /** The client's package: the session's binder (`CustomTabSessions.packageOf`), else the caller extra. */
    private val clientPackage: String?,
    private val trusted: Set<String>,
    /** Hears each verdict as it settles, on the main thread, once [verdicts] carries it. */
    private val onVerdict: (origin: String, verification: Verification) -> Unit
) {
    private val main = Handler(Looper.getMainLooper())
    private var destroyed = false
    /** This tab's failures; its successes go to [remembered]. */
    private val failed = HashSet<String>()

    /** The settled verdicts [TwaScope.stateFor] reads: the process's verified origins for this client, and this tab's failures. */
    val verdicts: Map<String, Verification>
        get() {
            val out = HashMap<String, Verification>()
            clientPackage?.let { pkg -> remembered[pkg]?.forEach { out[it] = Verification.VERIFIED } }
            failed.forEach { out[it] = Verification.FAILED }
            return out
        }

    /** Starts the check of every claimed origin without a verdict yet. Returns at once. */
    fun start() {
        val settled = verdicts
        for (origin in trusted) {
            if (origin in settled) continue
            lookups.execute { verify(origin) }
        }
    }

    /** The tab is going: no verdict reaches [onVerdict] after this. */
    fun destroy() {
        destroyed = true
    }

    private fun verify(origin: String) {
        val pkg = clientPackage
        val fingerprints = if (pkg == null) emptyList() else runCatching { DigitalAssetLinks.signingFingerprints(context, pkg) }.getOrDefault(emptyList())
        val verdict = refusal(origin, pkg, fingerprints)?.let { Verdict(Verification.FAILED, it) }
            ?: try {
                verdict(DigitalAssetLinks.fetchStatements(DigitalAssetLinks.statementUrl(origin)), pkg!!, fingerprints)
            } catch (e: IOException) {
                Verdict(Verification.FAILED, "the statement could not be fetched (${e.javaClass.simpleName}: ${e.message})")
            } catch (e: RuntimeException) {
                Verdict(Verification.FAILED, "the statement could not be read (${e.javaClass.simpleName})")
            }
        if (verdict.verification == Verification.VERIFIED) {
            Log.i(TAG, "Trusted Web Activity: $origin verified for $pkg")
        } else {
            Log.i(TAG, "Trusted Web Activity: $origin not verified for $pkg – ${verdict.reason}; the tab keeps its toolbar there")
        }
        main.post {
            if (verdict.verification == Verification.VERIFIED) {
                pkg?.let { remembered.getOrPut(it) { HashSet() }.add(origin) }
            } else {
                failed.add(origin)
            }
            if (!destroyed) onVerdict(origin, verdict.verification)
        }
    }

    /** One origin's outcome and, for a failure, the reason the log names. */
    class Verdict(val verification: Verification, val reason: String?)

    companion object {
        private const val TAG = "ZenTwa"
        private val lookups = Executors.newSingleThreadExecutor { r -> Thread(r, "zen-twa-verify") }

        /** Verified origins by client package, for the process; Chrome's `VerificationResultStore` remembers the same. */
        private val remembered = HashMap<String, MutableSet<String>>()

        /**
         * Chrome's gate before any fetch (`OriginVerifier.java:197-207`): only https and http on
         * `localhost` itself can be verified.
         */
        fun verifiable(origin: String): Boolean {
            val parts = WebAppRules.parse(origin) ?: return false
            return parts.scheme == "https" || (parts.scheme == "http" && parts.host == "localhost")
        }

        /**
         * Why an origin fails before its statement is fetched, null when the fetch is due: no
         * client package to name (Chrome's origin verifier fails a null package), a package that
         * is not installed or has no signing certificates, or an origin the gate refuses.
         */
        fun refusal(origin: String, clientPackage: String?, fingerprints: List<String>): String? = when {
            clientPackage == null -> "the launch names no client package"
            !verifiable(origin) -> "not https or localhost"
            fingerprints.isEmpty() -> "$clientPackage is not installed or has no signing certificate"
            else -> null
        }

        /**
         * The verdict once the statement file is in hand – or not: no file (any answer but 200)
         * fails, a file that grants the relation to [clientPackage] under one of [fingerprints]
         * verifies, anything else fails.
         */
        fun verdict(statements: String?, clientPackage: String, fingerprints: List<String>): Verdict = when {
            statements == null -> Verdict(Verification.FAILED, "no assetlinks.json (not a 200)")
            AuthTab.statementGrants(statements, clientPackage, fingerprints) -> Verdict(Verification.VERIFIED, null)
            else -> Verdict(Verification.FAILED, "assetlinks.json grants handle_all_urls to no matching package and certificate")
        }
    }
}
