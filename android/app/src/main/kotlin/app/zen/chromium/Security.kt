package app.zen.chromium

import android.os.Handler
import android.os.Looper
import android.security.KeyChain
import android.webkit.ClientCertRequest
import android.webkit.HttpAuthHandler
import android.webkit.WebViewDatabase
import java.util.concurrent.Executors

/**
 * The two security prompts the WebView delegates to the app. HTTP authentication (Basic, Digest,
 * NTLM) goes to the core's shared sign-in dialog and comes back through `auth.respond`; a
 * client-certificate request opens the system KeyChain chooser, and the alias picked is kept per
 * host and port until Zenium quits. Nothing is ever sent without the user's say-so.
 */
class Security(private val host: Host) {
    private var seq = 0
    private val pendingAuth = HashMap<String, HttpAuthHandler>()
    private val certificateChoices = HashMap<String, String>()
    private val main = Handler(Looper.getMainLooper())
    private val keychain = Executors.newSingleThreadExecutor { r -> Thread(r, "zenium-keychain") }

    fun onHttpAuth(tab: TabWebView, handler: HttpAuthHandler, hostName: String, realm: String) {
        val id = "auth_${++seq}"
        pendingAuth[id] = handler
        host.chrome.hostEvent(
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

    fun shutdown() {
        keychain.shutdownNow()
    }
}
