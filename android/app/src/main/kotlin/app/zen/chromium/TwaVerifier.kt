package app.zen.chromium

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.util.Log
import app.zen.chromium.TwaScope.Verification
import java.io.IOException
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit

/**
 * A Trusted Web Activity's Digital Asset Links check on the device (CCT-20; Chrome's `TwaVerifier`
 * over `OriginVerifier`): each origin the client claims ([CustomTabConfig.trustedOrigins]) is
 * verified at every launch – Chrome rebuilds the pending set from the intent and starts a check
 * for each origin in it (`TwaVerifier.java:75-85, 116-130`) – beside the first load and never
 * ahead of it. The statement file at `<origin>/.well-known/assetlinks.json` must grant
 * `delegate_permission/common.handle_all_urls` to the client's package under one of its signing
 * certificates ([AuthTab.statementGrants]). Chrome's gate first (`OriginVerifier.java:197-207`):
 * an http origin off `localhost` fails without a fetch, and so does a client with no package to
 * name.
 *
 * What verified is remembered for the process ([Store]), as Chrome's `VerificationResultStore`
 * remembers it across restarts, keyed as Chrome keys it – the package under its certificates,
 * per origin ([Claimant]; `Relationship.java:43-51`) – and read where Chrome reads its store:
 * when the statement cannot be fetched the saved result stands in (`OriginVerifier.java:274-281`,
 * NO_CONNECTION → `checkForSavedResult`), and an origin the launch did not claim counts as
 * verified only if an earlier launch verified it (`TwaVerifier.java:87-88`, `wasPreviouslyVerified`
 * over the store, `ChromeOriginVerifier.java:150-155, 224-232`). A check that fails forgets the
 * saved success (`OriginVerifier.java:304-308, 327-337`), so a revoked statement is caught at the
 * next launch. Every verdict is named in the log with its reason – the whole of what Chrome 152
 * surfaces for a failed check, its `QualityEnforcer` gone since M115. Main thread, except the
 * lookups.
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
    /** This launch's checks as each settles, by origin. */
    private val settled = HashMap<String, Verification>()
    /** The claimant the checks ran for, known on the main thread with the first verdict. */
    private var claimant: Claimant? = null
    /**
     * This tab's lookups alone – two at a time, the threads gone after an idle half minute – so a
     * client's unreachable second origin (a connect and a read timeout) holds up no other tab's
     * verdict. Shut down with the tab.
     */
    private val lookups = ThreadPoolExecutor(2, 2, 30, TimeUnit.SECONDS, LinkedBlockingQueue()) { r -> Thread(r, "zen-twa-verify") }
        .apply { allowCoreThreadTimeOut(true) }

    /**
     * The settled verdicts [TwaScope.stateFor] reads: this launch's checks of the claimed origins
     * (none until each lands – PENDING), and for any other origin the store's word, verified for
     * this claimant at an earlier launch or nothing (Chrome's `wasPreviouslyVerified`).
     */
    val verdicts: Map<String, Verification>
        get() {
            val out = HashMap<String, Verification>()
            claimant?.let { c -> store.verifiedOrigins(c).forEach { if (it !in trusted) out[it] = Verification.VERIFIED } }
            out.putAll(settled)
            return out
        }

    /** Starts the check of every claimed origin, remembered or not. Returns at once. */
    fun start() {
        for (origin in trusted) lookups.execute { verify(origin) }
    }

    /** The tab is going: no verdict reaches [onVerdict] after this, and no lookup still queued starts. */
    fun destroy() {
        destroyed = true
        lookups.shutdownNow()
    }

    private fun verify(origin: String) {
        val who = clientPackage?.let { pkg ->
            Claimant(pkg, runCatching { DigitalAssetLinks.signingFingerprints(context, pkg) }.getOrDefault(emptyList()))
        }
        val verdict = check(origin, who, store) { DigitalAssetLinks.fetchStatements(it) }
        if (verdict.verification == Verification.VERIFIED) {
            Log.i(TAG, "Trusted Web Activity: $origin verified for ${who?.pkg}${verdict.reason?.let { " – $it" } ?: ""}")
        } else {
            Log.i(TAG, "Trusted Web Activity: $origin not verified for ${who?.pkg} – ${verdict.reason}; the tab keeps its toolbar there")
        }
        main.post {
            claimant = who
            settled[origin] = verdict.verification
            if (!destroyed) onVerdict(origin, verdict.verification)
        }
    }

    /** One origin's outcome and what the log says of it: a failure's reason, or how an unreachable statement was decided. */
    class Verdict(val verification: Verification, val reason: String?)

    /**
     * Who the statement must name: the client's package under its signing certificates, the
     * fingerprints sorted so the same certificates in any order are the same claimant. Chrome's
     * `Relationship` key less the origin and the one relation this check has
     * (`Relationship.java:43-51`): a package reinstalled under another certificate is a new
     * claimant and inherits nothing.
     */
    class Claimant(val pkg: String, fingerprints: List<String>) {
        val fingerprints: List<String> = fingerprints.sorted()

        override fun equals(other: Any?): Boolean = other is Claimant && other.pkg == pkg && other.fingerprints == fingerprints

        override fun hashCode(): Int = 31 * pkg.hashCode() + fingerprints.hashCode()

        override fun toString(): String = "$pkg,${fingerprints.joinToString(",")}"
    }

    /**
     * What the process remembers of the checks – Chrome's `VerificationResultStore`, which lives
     * in SharedPreferences across restarts where this one lives as long as the process: the
     * origins verified for each claimant. Written from the lookup threads, read on the main one.
     */
    class Store {
        private val verified = HashMap<Claimant, MutableSet<String>>()

        @Synchronized
        fun remember(claimant: Claimant, origin: String) {
            verified.getOrPut(claimant) { HashSet() }.add(origin)
        }

        @Synchronized
        fun forget(claimant: Claimant, origin: String) {
            verified[claimant]?.remove(origin)
        }

        @Synchronized
        fun remembers(claimant: Claimant, origin: String): Boolean = verified[claimant]?.contains(origin) == true

        @Synchronized
        fun verifiedOrigins(claimant: Claimant): Set<String> = verified[claimant]?.toSet().orEmpty()
    }

    companion object {
        private const val TAG = "ZenTwa"

        /** The process's store, one for every tab, as Chrome's is one for the browser. */
        private val store = Store()

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

        /**
         * One launch's check of [origin] for [claimant], the whole of it but the network – [fetch]
         * answers the statement URL with the file's body, null for any answer but 200, or throws
         * an [IOException] when the origin cannot be reached: the gate ([refusal]), the fetch, the
         * [verdict] on the statement; and the store kept as Chrome keeps its `VerificationResultStore`
         * (`OriginVerifier.java:289-308`) – a success remembered, a failure forgetting what an
         * earlier launch remembered, and an unreachable statement decided by the saved result
         * (`:274-281`): verified still when an earlier launch verified this claimant here, failed
         * when none did. Pure but for [store], so a JVM test runs launches back to back.
         */
        fun check(origin: String, claimant: Claimant?, store: Store, fetch: (statementUrl: String) -> String?): Verdict {
            refusal(origin, claimant?.pkg, claimant?.fingerprints.orEmpty())?.let { return Verdict(Verification.FAILED, it) }
            val who = checkNotNull(claimant) { "the gate names a null claimant" }
            val verdict = try {
                verdict(fetch(DigitalAssetLinks.statementUrl(origin)), who.pkg, who.fingerprints)
            } catch (e: IOException) {
                val why = "the statement could not be fetched (${e.javaClass.simpleName}: ${e.message})"
                return if (store.remembers(who, origin)) {
                    Verdict(Verification.VERIFIED, "$why; the result an earlier launch saved stands")
                } else {
                    Verdict(Verification.FAILED, "$why and no earlier launch verified it")
                }
            } catch (e: RuntimeException) {
                Verdict(Verification.FAILED, "the statement could not be read (${e.javaClass.simpleName})")
            }
            if (verdict.verification == Verification.VERIFIED) store.remember(who, origin) else store.forget(who, origin)
            return verdict
        }
    }
}
