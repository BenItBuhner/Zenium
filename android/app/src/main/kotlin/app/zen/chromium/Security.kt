package app.zen.chromium

import android.net.http.SslCertificate
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.security.KeyChain
import android.webkit.ClientCertRequest
import android.webkit.HttpAuthHandler
import android.webkit.WebViewDatabase
import org.json.JSONObject
import java.util.concurrent.Executors

/**
 * The security prompts the WebView delegates to the app. HTTP authentication (Basic, Digest,
 * NTLM) goes to the core's shared sign-in dialog and comes back through `auth.respond`; a
 * client-certificate request opens the system KeyChain chooser, and the alias picked is kept per
 * host and port until Zenium quits. A server certificate that fails verification is refused, and
 * the core's interstitial offers to proceed: the exception it records comes back through
 * `security.allowCertificate` ([certificateExceptions]) for the load that follows. Nothing is ever
 * sent without the user's say-so.
 */
class Security(private val host: PageHost) {
    private var seq = 0
    private val pendingAuth = HashMap<String, HttpAuthHandler>()
    private val certificateChoices = HashMap<String, String>()
    /** Server certificates proceeded past this session (the core's copy is the one that decides on the desktop). */
    val certificateExceptions = CertificateExceptions()
    private val main = Handler(Looper.getMainLooper())
    private val keychain = Executors.newSingleThreadExecutor { r -> Thread(r, "zenium-keychain") }

    fun onHttpAuth(tab: TabWebView, handler: HttpAuthHandler, hostName: String, realm: String) {
        val id = "auth_${++seq}"
        pendingAuth[id] = handler
        host.hostEvent(
            "auth.request",
            json("requestId" to id, "tabId" to tab.tabId, "host" to hostName, "realm" to realm, "url" to (tab.url ?: ""))
        )
    }

    /** The core's answer; no credentials means the user cancelled and the server's 401 page shows. */
    fun respondAuth(requestId: String, username: String?, password: String?) {
        val handler = pendingAuth.remove(requestId) ?: return
        if (username == null || password == null) handler.cancel() else handler.proceed(username, password)
    }

    fun onClientCertRequest(request: ClientCertRequest) {
        val key = "${request.host}:${request.port}"
        val remembered = certificateChoices[key]
        if (remembered != null) {
            proceed(key, remembered, request)
            return
        }
        KeyChain.choosePrivateKeyAlias(
            host.activity,
            { alias ->
                main.post {
                    if (alias == null) {
                        request.cancel()
                    } else {
                        certificateChoices[key] = alias
                        proceed(key, alias, request)
                    }
                }
            },
            request.keyTypes, request.principals, request.host, request.port, null
        )
    }

    /** KeyChain lookups block on another process: off the main thread, then back to answer. */
    private fun proceed(key: String, alias: String, request: ClientCertRequest) {
        keychain.execute {
            val privateKey = runCatching { KeyChain.getPrivateKey(host.activity, alias) }.getOrNull()
            val chain = runCatching { KeyChain.getCertificateChain(host.activity, alias) }.getOrNull()
            main.post {
                if (privateKey != null && chain != null) {
                    request.proceed(privateKey, chain)
                } else {
                    certificateChoices.remove(key)
                    request.cancel()
                }
            }
        }
    }

    /** Settings → Security → Forget now: the WebView's own copies go too. */
    fun forgetSession() {
        certificateChoices.clear()
        runCatching { WebViewDatabase.getInstance(host.activity).clearHttpAuthUsernamePassword() }
    }

    /** The user proceeded past the interstitial for the site of `url` over this certificate (the core recorded it). */
    fun allowCertificate(containerId: String, url: String, fingerprint: String) {
        certificateExceptions.allow(containerId, url, fingerprint)
    }

    /** Whether a request of a `containerId` page may go ahead over the certificate `fingerprint` names. */
    fun certificateAllowed(containerId: String, url: String, fingerprint: String?): Boolean =
        certificateExceptions.isAllowed(containerId, url, fingerprint)

    /**
     * The container's data went (deleted, private session over, cookies cleared): its exceptions
     * go, and the WebView's own memory of every `proceed()` on the profile with them, so the next
     * load asks again. `clearSslPreferences` is a view's call but clears the profile's store; a
     * container without a live page has its profile deleted with the data (`Profiles.clear`).
     */
    fun forgetCertificates(containerId: String) {
        certificateExceptions.forgetContainer(containerId)
        host.tabs.all().firstOrNull { it.containerId == containerId }?.clearSslPreferences()
    }

    fun shutdown() {
        keychain.shutdownNow()
    }

    companion object {
        /**
         * What the interstitial shows of a refused certificate (`CertificateDetails` in
         * `src/shared/types.ts`), with the fingerprint the exception is keyed by; null without a
         * certificate. Names are the common name, or the organisation when there is none.
         */
        fun describeCertificate(certificate: SslCertificate?): JSONObject? {
            if (certificate == null) return null
            val der = derOf(certificate)
            return json(
                "subjectName" to nameOf(certificate.issuedTo),
                "issuerName" to nameOf(certificate.issuedBy),
                "validStart" to (certificate.validNotBeforeDate?.time ?: 0L),
                "validExpiry" to (certificate.validNotAfterDate?.time ?: 0L),
                "fingerprint" to (der?.let(CertificateExceptions::fingerprintOf) ?: "")
            )
        }

        /** The certificate's fingerprint (`CertificateExceptions.fingerprintOf`), or null when its bytes are out of reach. */
        fun fingerprintOf(certificate: SslCertificate?): String? =
            certificate?.let(::derOf)?.let(CertificateExceptions::fingerprintOf)

        /** The DER bytes of a WebView certificate: its X509 from API 29, the saved state's copy before. */
        private fun derOf(certificate: SslCertificate): ByteArray? = runCatching {
            val x509 = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) certificate.x509Certificate else null
            x509?.encoded ?: SslCertificate.saveState(certificate).getByteArray("x509-certificate")
        }.getOrNull()

        private fun nameOf(name: SslCertificate.DName?): String =
            name?.cName?.takeIf { it.isNotEmpty() } ?: name?.oName?.takeIf { it.isNotEmpty() } ?: name?.dName ?: ""
    }
}
