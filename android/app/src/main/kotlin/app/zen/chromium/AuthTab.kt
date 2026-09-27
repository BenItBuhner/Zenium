package app.zen.chromium

import org.json.JSONArray
import java.net.URI
import java.util.Locale

/**
 * The Auth Tab (CCT-13): a custom tab another app launched for a sign-in, which ends when the
 * page navigates to the redirect the caller named – a custom scheme (`zeniumtest://done?code=…`)
 * or an https host and path the caller owns – and the tab, instead of loading it, hands the
 * URL back as the activity's result and closes, as Chrome's does (androidx.browser 1.9.0's
 * `AuthTabIntent`; Chrome's `AuthTabIntentDataProvider` and `AuthTabVerifier`).
 *
 * The decisions are pure and JVM-tested here: reading the redirect off the intent's extras,
 * whether a navigation is the redirect, the result code, and whether an `assetlinks.json`
 * statement names the caller. [AuthTabVerifier] runs them on the device.
 */
object AuthTab {
    /** `AuthTabIntent.EXTRA_LAUNCH_AUTH_TAB`: true on an Auth Tab's intent (`AuthTabIntent.Builder.build`). */
    const val EXTRA_LAUNCH_AUTH_TAB = "androidx.browser.auth.extra.LAUNCH_AUTH_TAB"
    /** `AuthTabIntent.EXTRA_REDIRECT_SCHEME`: the custom scheme the flow ends on. */
    const val EXTRA_REDIRECT_SCHEME = "androidx.browser.auth.extra.REDIRECT_SCHEME"
    /** `AuthTabIntent.EXTRA_HTTPS_REDIRECT_HOST` / `_PATH`: the https redirect, verified as the caller's. */
    const val EXTRA_HTTPS_REDIRECT_HOST = "androidx.browser.auth.extra.HTTPS_REDIRECT_HOST"
    const val EXTRA_HTTPS_REDIRECT_PATH = "androidx.browser.auth.extra.HTTPS_REDIRECT_PATH"

    /** `AuthTabIntent`'s result codes: the platform's two, and the https verification's two. */
    const val RESULT_OK = -1
    const val RESULT_CANCELED = 0
    const val RESULT_VERIFICATION_FAILED = 2
    const val RESULT_VERIFICATION_TIMED_OUT = 3

    /** How long a claimed https redirect waits for the caller's verification (Chrome's `VERIFICATION_TIMEOUT_MS`). */
    const val VERIFICATION_TIMEOUT_MS = 10_000L

    /** The Digital Asset Links relation the caller must grant the browser for its host (Chrome's `RELATION_HANDLE_ALL_URLS`). */
    const val RELATION_HANDLE_ALL_URLS = "delegate_permission/common.handle_all_urls"

    /**
     * Chrome's `UrlUtilities.SUPPORTED_SCHEMES`, which a custom redirect scheme can never be
     * (`AuthTabVerifier.isCustomScheme`), and Zenium's own, so no caller can name the browser's
     * internal pages as its redirect.
     */
    private val NEVER_A_REDIRECT_SCHEME = setOf(
        "about", "data", "file", "http", "https", "inline", "javascript",
        "blob", "content", "chrome", "chrome-extension", DeepLinks.INTERNAL_SCHEME, DeepLinks.PAGE_SCHEME
    )

    /** Where the caller's flow ends. Chrome reads both forms off one intent; a caller sends one. */
    class Redirect(
        /** The custom scheme, lower-case; null when the caller named none. */
        val scheme: String?,
        /** The https host, lower-case, and its exact path (`/` when the caller sent none); null without a host. */
        val host: String?,
        val path: String?
    ) {
        val https: Boolean get() = host != null && path != null
    }

    /**
     * The redirect the intent's extras describe, or null when the intent is not an Auth Tab's
     * (`EXTRA_LAUNCH_AUTH_TAB` unset) or names no usable redirect. The custom scheme is kept as
     * a scheme (letters, digits, `+-.`; never one of the browser's own). The host and path go
     * through one URL parse exactly as Chrome's do – `new GURL("https://" + host + path)`, then
     * its host (lower-cased, a trailing dot kept) and its path (`/` when empty) – so a path sent
     * without its leading slash folds into the host as it does there: `example.com` + `cb` names
     * the host `example.comcb` and the path `/`, and the caller's `https://example.com/cb` never
     * matches, in Chrome or here. Both extras must be present for the https form (androidx's
     * builder sends both); a host with userinfo, or one the parse refuses, names no https form.
     */
    fun redirect(launch: Boolean, scheme: String?, host: String?, path: String?): Redirect? {
        if (!launch) return null
        val customScheme = scheme?.trim()?.lowercase(Locale.ROOT)?.takeIf { isSchemeName(it) && it !in NEVER_A_REDIRECT_SCHEME }
        var httpsHost: String? = null
        var httpsPath: String? = null
        if (!host.isNullOrEmpty() && path != null) {
            val parsed = runCatching { URI("https://$host$path").normalize() }.getOrNull()
            val parsedHost = parsed?.host?.lowercase(Locale.ROOT)
            if (parsed != null && !parsedHost.isNullOrEmpty() && parsed.userInfo == null) {
                httpsHost = parsedHost
                httpsPath = parsed.rawPath.ifEmpty { "/" }
            }
        }
        if (customScheme == null && httpsHost == null) return null
        return Redirect(customScheme, httpsHost, httpsPath)
    }

    /**
     * The intercept's decision for one navigation, the whole of it ([Return.claim]): a subframe's
     * navigation is never the redirect, whatever its URL – it takes its own path, as any
     * subframe's does (Chrome may return a gestured subframe's custom-scheme navigation; Zenium is
     * tighter and takes the main frame alone) – and a main frame's is [match]. Null when the
     * navigation is not the redirect.
     */
    fun claimed(redirect: Redirect, url: String, mainFrame: Boolean): Match? =
        if (mainFrame) match(redirect, url) else null

    /**
     * Whether a navigation to [url] is the caller's redirect, so it is handed back instead of
     * loaded (Chrome's `AuthTabVerifier.isCustomScheme` / `isRedirectUrl`): the custom scheme
     * equal; or `https`, the host equal (the authority's real host, so the userinfo trick
     * `https://host@evil/` reads as evil's page; a trailing dot counts, as GURL keeps it) and the
     * path exactly equal – not a prefix, as Chrome compares it – with any query and fragment.
     * Null when it is not the redirect; else which form matched. The authority and path are cut
     * out by hand rather than through `java.net.URI`, which refuses characters a canonical URL's
     * query may carry (`|`, `{`, `[` – an identity provider's `state`), and a refused parse would
     * load the redirect as a page.
     */
    fun match(redirect: Redirect, url: String): Match? {
        val colon = url.indexOf(':')
        if (colon <= 0) return null
        val scheme = url.substring(0, colon).lowercase(Locale.ROOT)
        if (redirect.scheme != null && scheme == redirect.scheme) return Match.SCHEME
        if (scheme != "https" || !redirect.https) return null
        if (!url.startsWith("//", colon + 1)) return null
        val rest = url.substring(colon + 3)
        val authorityEnd = rest.indexOfAny(charArrayOf('/', '?', '#')).let { if (it < 0) rest.length else it }
        // The real host: past any userinfo, before the port.
        val hostPort = rest.substring(0, authorityEnd).substringAfterLast('@')
        val host = (if (hostPort.startsWith("[")) hostPort.substringBefore(']') + "]" else hostPort.substringBefore(':'))
            .lowercase(Locale.ROOT)
        if (host.isEmpty() || host != redirect.host) return null
        val rawPath = rest.substring(authorityEnd).takeWhile { it != '?' && it != '#' }.ifEmpty { "/" }
        return if (foldPath(rawPath) == redirect.path) Match.HTTPS else null
    }

    /** The path with its dot segments folded, as a canonical URL's is; a path the folding refuses stands as it is. */
    private fun foldPath(path: String): String =
        runCatching { URI("https://h$path").normalize().rawPath }.getOrNull()?.ifEmpty { "/" } ?: path

    enum class Match { SCHEME, HTTPS }

    /** What the https verification of the caller against its host came to. */
    enum class Verification { PENDING, VERIFIED, FAILED, TIMED_OUT }

    /**
     * The result the caller receives (Chrome's `returnAsActivityResultInternal`): a custom scheme
     * redirect is `RESULT_OK` at once; an https one is `RESULT_OK` only once verified, else the
     * verification's failure or its timeout. The URI travels only with `RESULT_OK`.
     */
    fun resultCode(match: Match, verification: Verification): Int = when (match) {
        Match.SCHEME -> RESULT_OK
        Match.HTTPS -> when (verification) {
            Verification.VERIFIED -> RESULT_OK
            Verification.TIMED_OUT -> RESULT_VERIFICATION_TIMED_OUT
            Verification.FAILED, Verification.PENDING -> RESULT_VERIFICATION_FAILED
        }
    }

    /**
     * Whether the host's `/.well-known/assetlinks.json` ([json]) grants [RELATION_HANDLE_ALL_URLS]
     * to the Android app [packageName] signed with one of [fingerprints] (SHA-256, `AA:BB:…`, any
     * case): one statement with the relation, the `android_app` namespace, the package and a
     * matching certificate. Malformed text grants nothing.
     */
    fun statementGrants(json: String, packageName: String, fingerprints: Collection<String>): Boolean {
        val wanted = fingerprints.map { normaliseFingerprint(it) }.toSet()
        if (wanted.isEmpty()) return false
        val statements = runCatching { JSONArray(json) }.getOrNull() ?: return false
        for (i in 0 until statements.length()) {
            val statement = statements.optJSONObject(i) ?: continue
            val relations = statement.optJSONArray("relation") ?: continue
            if ((0 until relations.length()).none { relations.optString(it) == RELATION_HANDLE_ALL_URLS }) continue
            val target = statement.optJSONObject("target") ?: continue
            if (target.optString("namespace") != "android_app" || target.optString("package_name") != packageName) continue
            val certs = target.optJSONArray("sha256_cert_fingerprints") ?: continue
            if ((0 until certs.length()).any { normaliseFingerprint(certs.optString(it)) in wanted }) return true
        }
        return false
    }

    /** `AA:BB:…` as the DAL files spell it, from any case and with or without the colons. */
    fun normaliseFingerprint(fingerprint: String): String {
        val hex = fingerprint.filter { it != ':' }.uppercase(Locale.ROOT)
        return hex.chunked(2).joinToString(":")
    }

    /** The colon-separated upper-case SHA-256 of a signing certificate's bytes, as DAL files carry it. */
    fun fingerprintOf(certificate: ByteArray): String {
        val digest = java.security.MessageDigest.getInstance("SHA-256").digest(certificate)
        return digest.joinToString(":") { "%02X".format(it) }
    }

    /**
     * `Build.VERSION_CODES.P`: from API 28 Android reports a package's signers through
     * `PackageInfo.signingInfo`; Android 8.0 / 8.1 – this app's minSdk is 26 – have only the
     * legacy `signatures`, and reading the newer field there is a `NoSuchFieldError` that would
     * fail every https verification. [AuthTabVerifier] reads the shape the device has.
     */
    const val SIGNING_INFO_SDK = 28

    /**
     * The certificates a statement may name, out of API 28's `SigningInfo` handed over as plain
     * lists: every signer of the APK's contents when it has several, else the one signer's
     * lineage (`signingCertificateHistory`: a rotated key's earlier certificate still grants) –
     * the recipe `SigningInfo` documents and Android's own app-links verifier follows. Nothing
     * from nothing.
     */
    fun signerCertificates(multipleSigners: Boolean, apkContentsSigners: List<ByteArray>?, certificateHistory: List<ByteArray>?): List<ByteArray> =
        (if (multipleSigners) apkContentsSigners else certificateHistory).orEmpty()

    /** The fingerprints of [certificates], as the statement spells them – from either shape's list. */
    fun fingerprintsOf(certificates: List<ByteArray>): List<String> = certificates.map(::fingerprintOf)

    /** Where the caller's statements live: `https://<host>/.well-known/assetlinks.json`. */
    fun assetLinksUrl(host: String): String = "https://$host/.well-known/assetlinks.json"

    private fun isSchemeName(scheme: String): Boolean =
        scheme.isNotEmpty() && scheme[0].isLetter() && scheme.all { it.isLetterOrDigit() || it == '+' || it == '-' || it == '.' }

    /**
     * What a page's navigation asks of an Auth Tab's host, read first in every navigation decision
     * ([TabWebView], `navigationTaken`): whether the URL is the caller's redirect, in which case the
     * host returns it and the page does not load it. Every other host answers null for the whole
     * thing ([PageHost.authTab]), one null read per navigation.
     */
    fun interface Return {
        /** True when the navigation is the caller's redirect ([claimed]: the main frame's alone): it must not load. */
        fun claim(url: String, mainFrame: Boolean): Boolean
    }
}
