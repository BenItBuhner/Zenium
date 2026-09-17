package app.zen.chromium

import android.net.Uri
import android.os.Binder
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.webkit.CookieManager
import android.webkit.WebSettings
import androidx.browser.customtabs.CustomTabsCallback
import androidx.browser.customtabs.CustomTabsService
import androidx.browser.customtabs.CustomTabsSessionToken
import java.net.InetAddress
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors

/**
 * What other apps bind (`CustomTabsClient.bindCustomTabsService`) before they open a custom tab:
 * `warmup` brings the WebView up, `newSession` gives the caller a session whose callback the
 * custom tab later reports navigation events to, and `mayLaunchUrl` resolves the likely hosts
 * ahead of time. The rest of the protocol (post messages, engagement signals, Trusted Web
 * Activities, file transfer) is declined.
 */
class CustomTabsConnectionService : CustomTabsService() {
    private val main = Handler(Looper.getMainLooper())

    override fun warmup(flags: Long): Boolean {
        // Loading the WebView provider is what a cold custom tab would otherwise pay for first.
        main.post {
            runCatching {
                WebSettings.getDefaultUserAgent(this)
                CookieManager.getInstance()
            }
        }
        return true
    }

    override fun newSession(sessionToken: CustomTabsSessionToken): Boolean {
        val uid = Binder.getCallingUid()
        val packageName = packageManager.getPackagesForUid(uid)?.firstOrNull()
        CustomTabSessions.register(sessionToken, packageName)
        Log.d(TAG, "session for ${packageName ?: "uid $uid"}")
        return true
    }

    override fun mayLaunchUrl(sessionToken: CustomTabsSessionToken, url: Uri?, extras: Bundle?, otherLikelyBundles: List<Bundle>?): Boolean {
        val hosts = ArrayList<String>()
        url?.host?.let(hosts::add)
        otherLikelyBundles?.forEach { bundle ->
            @Suppress("DEPRECATION")
            (bundle.getParcelable(KEY_URL) as? Uri)?.host?.let(hosts::add)
        }
        CustomTabSessions.likely(sessionToken, url?.toString())
        prefetch.execute {
            for (host in hosts.distinct().take(MAX_PREFETCH)) runCatching { InetAddress.getAllByName(host) }
        }
        return true
    }

    override fun extraCommand(commandName: String, args: Bundle?): Bundle? = null

    override fun updateVisuals(sessionToken: CustomTabsSessionToken, bundle: Bundle?): Boolean = false

    override fun requestPostMessageChannel(sessionToken: CustomTabsSessionToken, postMessageOrigin: Uri): Boolean = false

    override fun postMessage(sessionToken: CustomTabsSessionToken, message: String, extras: Bundle?): Int =
        RESULT_FAILURE_DISALLOWED

    override fun validateRelationship(sessionToken: CustomTabsSessionToken, relation: Int, origin: Uri, extras: Bundle?): Boolean =
        false

    override fun receiveFile(sessionToken: CustomTabsSessionToken, uri: Uri, purpose: Int, extras: Bundle?): Boolean = false

    override fun cleanUpSession(sessionToken: CustomTabsSessionToken): Boolean {
        CustomTabSessions.remove(sessionToken)
        return super.cleanUpSession(sessionToken)
    }

    companion object {
        private const val TAG = "ZenCustomTabs"
        private const val MAX_PREFETCH = 4
        private val prefetch = Executors.newSingleThreadExecutor { r -> Thread(r, "zen-cct-prefetch") }
    }
}

/** The sessions clients hold open, so a custom tab can find its caller and report back to it. */
object CustomTabSessions {
    class Session(val packageName: String?) {
        @Volatile var likelyUrl: String? = null
    }

    private val sessions = ConcurrentHashMap<CustomTabsSessionToken, Session>()

    fun register(token: CustomTabsSessionToken, packageName: String?) {
        sessions[token] = Session(packageName)
    }

    fun likely(token: CustomTabsSessionToken, url: String?) {
        sessions[token]?.likelyUrl = url
    }

    fun remove(token: CustomTabsSessionToken) {
        sessions.remove(token)
    }

    fun packageOf(token: CustomTabsSessionToken?): String? = token?.let { sessions[it]?.packageName }

    /** Deliver a `CustomTabsCallback.onNavigationEvent` to the session's client, if it is still connected. */
    fun navigationEvent(token: CustomTabsSessionToken?, event: Int) {
        val callback: CustomTabsCallback = token?.callback ?: return
        runCatching { callback.onNavigationEvent(event, null) }
    }
}
