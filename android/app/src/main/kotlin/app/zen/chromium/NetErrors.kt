package app.zen.chromium

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.net.http.SslError
import android.webkit.WebViewClient

/**
 * Load failures as Chromium `net::` codes, the language the core and its error page speak
 * (`src/shared/zenPages.ts`). WebView reports a failure twice over: a coarse `WebViewClient.ERROR_*`
 * code – which folds `ERR_INTERNET_DISCONNECTED`, `ERR_NAME_NOT_RESOLVED` and `ERR_ADDRESS_UNREACHABLE`
 * into one `ERROR_HOST_LOOKUP` – and a description that is the exact `net::ERR_…` name. The name wins
 * when the page knows it, the coarse code stands in otherwise, and a device `ConnectivityManager`
 * says is offline turns a failure to reach a host into `ERR_INTERNET_DISCONNECTED`, so the page can
 * say the device is offline rather than that the site is down.
 */
object NetErrors {
    const val FAILED = -2
    /** The request engine (or Chrome's extension layer) refused the navigation itself. */
    const val BLOCKED_BY_CLIENT = -20
    const val CONNECTION_REFUSED = -102
    const val NAME_NOT_RESOLVED = -105
    const val INTERNET_DISCONNECTED = -106
    const val CONNECTION_TIMED_OUT = -118
    /** Chromium never connects to a few reserved ports (1, 7, 25, …): `localhost:1` fails this way, not refused. */
    const val UNSAFE_PORT = -312
    const val CERT_COMMON_NAME_INVALID = -200
    const val CERT_DATE_INVALID = -201
    const val CERT_AUTHORITY_INVALID = -202
    const val CERT_INVALID = -207

    /** The codes the error page has copy for, by their Chromium name (keep equal to `NET_ERRORS` in `zenPages.ts`). */
    private val BY_NAME = mapOf(
        "ERR_FAILED" to FAILED,
        "ERR_FILE_NOT_FOUND" to -6,
        "ERR_TIMED_OUT" to -7,
        "ERR_BLOCKED_BY_CLIENT" to BLOCKED_BY_CLIENT,
        "ERR_NETWORK_ACCESS_DENIED" to -21,
        "ERR_CONNECTION_CLOSED" to -100,
        "ERR_CONNECTION_RESET" to -101,
        "ERR_CONNECTION_REFUSED" to CONNECTION_REFUSED,
        "ERR_NAME_NOT_RESOLVED" to NAME_NOT_RESOLVED,
        "ERR_INTERNET_DISCONNECTED" to INTERNET_DISCONNECTED,
        "ERR_SSL_PROTOCOL_ERROR" to -107,
        "ERR_ADDRESS_UNREACHABLE" to -109,
        "ERR_SSL_VERSION_OR_CIPHER_MISMATCH" to -113,
        "ERR_CONNECTION_TIMED_OUT" to CONNECTION_TIMED_OUT,
        "ERR_CERT_COMMON_NAME_INVALID" to CERT_COMMON_NAME_INVALID,
        "ERR_CERT_DATE_INVALID" to CERT_DATE_INVALID,
        "ERR_CERT_AUTHORITY_INVALID" to CERT_AUTHORITY_INVALID,
        "ERR_CERT_INVALID" to CERT_INVALID,
        "ERR_INVALID_URL" to -300,
        "ERR_TOO_MANY_REDIRECTS" to -310,
        "ERR_UNSAFE_PORT" to UNSAFE_PORT,
        "ERR_EMPTY_RESPONSE" to -324,
        "ERR_INSECURE_RESPONSE" to -501
    )
    private val NAMES = BY_NAME.entries.associate { (name, code) -> code to name }

    /**
     * Failures that mean the host was never reached – what being offline explains. A refused or
     * reset connection is not among them: something answered, so the network was there.
     */
    private val UNREACHED = setOf(FAILED, -7, -109, NAME_NOT_RESOLVED, CONNECTION_TIMED_OUT)

    /**
     * The Chromium code for a `WebViewClient.onReceivedError`: `description` is WebView's
     * (`net::ERR_…`), `offline` what [offline] said at the time of the failure.
     */
    fun code(webViewCode: Int, description: CharSequence?, offline: Boolean): Int {
        val named = description?.let { nameIn(it.toString()) }?.let { BY_NAME[it] }
        val code = named ?: fromWebViewCode(webViewCode)
        return if (offline && code in UNREACHED) INTERNET_DISCONNECTED else code
    }

    /** A failed load as the core hears of it: the `net::` code and the `ERR_…` name the page prints, if any. */
    class Failure(val code: Int, val name: String?)

    /**
     * [code] together with the name for it. A `net::ERR_…` WebView reports that the table has no
     * copy for still is Chromium's name for the failure, so the page prints it over the coarse
     * stand-in code's – unless being offline explained the failure, when that is the truth.
     */
    fun failure(webViewCode: Int, description: CharSequence?, offline: Boolean): Failure {
        val reported = description?.let { nameIn(it.toString()) }
        val code = code(webViewCode, description, offline)
        val unlisted = reported != null && reported !in BY_NAME && code != INTERNET_DISCONNECTED
        return Failure(code, if (unlisted) reported else NAMES[code])
    }

    /** The Chromium code behind a refused certificate (`WebViewClient.onReceivedSslError`). */
    fun sslCode(primaryError: Int): Int = when (primaryError) {
        SslError.SSL_EXPIRED, SslError.SSL_NOTYETVALID, SslError.SSL_DATE_INVALID -> CERT_DATE_INVALID
        SslError.SSL_IDMISMATCH -> CERT_COMMON_NAME_INVALID
        SslError.SSL_UNTRUSTED -> CERT_AUTHORITY_INVALID
        else -> CERT_INVALID
    }

    /** The `ERR_…` name of `code` when the page has copy for it, else null. */
    fun name(code: Int): String? = NAMES[code]

    /** `ERR_…` out of `net::ERR_…` (or the bare name), else null. */
    fun nameIn(description: String): String? {
        val match = NAME_PATTERN.matchEntire(description.trim()) ?: return null
        return match.groupValues[1]
    }

    /** Whether the device has no network with internet access right now. */
    fun offline(context: Context): Boolean = runCatching {
        val manager = context.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager ?: return false
        val network = manager.activeNetwork ?: return true
        val capabilities = manager.getNetworkCapabilities(network) ?: return true
        !capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
    }.getOrDefault(false)

    /** WebViewClient error codes → the nearest Chromium `net::` code, for a description without a name. */
    fun fromWebViewCode(code: Int): Int = when (code) {
        WebViewClient.ERROR_HOST_LOOKUP -> NAME_NOT_RESOLVED
        WebViewClient.ERROR_CONNECT -> CONNECTION_REFUSED
        WebViewClient.ERROR_TIMEOUT -> CONNECTION_TIMED_OUT
        WebViewClient.ERROR_IO -> -100
        WebViewClient.ERROR_REDIRECT_LOOP -> -310
        WebViewClient.ERROR_UNSUPPORTED_SCHEME, WebViewClient.ERROR_BAD_URL -> -300
        WebViewClient.ERROR_FAILED_SSL_HANDSHAKE -> -107
        WebViewClient.ERROR_FILE, WebViewClient.ERROR_FILE_NOT_FOUND -> -6
        WebViewClient.ERROR_UNSAFE_RESOURCE -> -20
        WebViewClient.ERROR_TOO_MANY_REQUESTS -> -100
        WebViewClient.ERROR_AUTHENTICATION, WebViewClient.ERROR_PROXY_AUTHENTICATION,
        WebViewClient.ERROR_UNSUPPORTED_AUTH_SCHEME -> -100
        else -> FAILED
    }

    private val NAME_PATTERN = Regex("^(?:net::)?(ERR_[A-Z0-9_]+)$")
}
