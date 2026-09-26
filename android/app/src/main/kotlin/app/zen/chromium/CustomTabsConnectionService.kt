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
import androidx.browser.customtabs.EngagementSignalsCallback
import java.net.InetAddress
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/**
 * What other apps bind (`CustomTabsClient.bindCustomTabsService`) before they open a custom tab:
 * `warmup` brings the WebView up, `newSession` gives the caller a session whose callback the
 * custom tab later reports navigation events to, and `mayLaunchUrl` resolves the likely hosts
 * ahead of time; `setEngagementSignalsCallback` keeps the callback the tab's scrolls and its
 * end are reported to (CCT-14). The rest of the protocol (post messages, Trusted Web
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

    /**
     * The caller's later changes to its custom tab's visuals (`CustomTabsSession.setToolbarItem`,
     * `setSecondaryToolbarViews`, `setSecondaryToolbarSwipeUpGesture`), applied on the main thread
     * to the live custom tab of the session; false when no tab of the session is showing or the
     * bundle names nothing the tab knows. Answered from this binder thread once the main thread
     * has applied it, as Chrome answers (the client expects the result, not a promise).
     */
    override fun updateVisuals(sessionToken: CustomTabsSessionToken, bundle: Bundle?): Boolean {
        if (bundle == null) return false
        // A client in this very process (the instrumentation driver) reaches here on the main
        // thread itself, where a wait would be for nothing.
        if (Looper.myLooper() == Looper.getMainLooper()) {
            return runCatching { CustomTabSessions.updateVisuals(sessionToken, bundle) }.getOrDefault(false)
        }
        val done = CountDownLatch(1)
        var applied = false
        main.post {
            applied = runCatching { CustomTabSessions.updateVisuals(sessionToken, bundle) }.getOrDefault(false)
            done.countDown()
        }
        return done.await(UPDATE_VISUALS_WAIT_MS, TimeUnit.MILLISECONDS) && applied
    }

    /**
     * The engagement signals (CCT-14, androidx.browser 1.8.0's `EngagementSignalsCallback`):
     * the API is there for every client, and a session the client holds open gets its callback
     * kept, to hear the custom tab's scroll direction, greatest scroll percentage and end
     * ([CustomTabEngagement] decides them from the page). A session never opened, or cleaned up,
     * takes no callback, as Chrome's `ClientManager` answers.
     */
    override fun isEngagementSignalsApiAvailable(sessionToken: CustomTabsSessionToken, extras: Bundle): Boolean = true

    override fun setEngagementSignalsCallback(sessionToken: CustomTabsSessionToken, callback: EngagementSignalsCallback, extras: Bundle): Boolean =
        CustomTabSessions.setEngagementCallback(sessionToken, callback)

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
        private const val UPDATE_VISUALS_WAIT_MS = 2000L
        private val prefetch = Executors.newSingleThreadExecutor { r -> Thread(r, "zen-cct-prefetch") }
    }
}

/** The sessions clients hold open, so a custom tab can find its caller and report back to it. */
object CustomTabSessions {
    class Session(val packageName: String?) {
        @Volatile var likelyUrl: String? = null
    }

    /** A live custom tab of a session: what `updateVisuals` reaches. Main thread only. */
    interface Visuals {
        fun applyVisuals(bundle: Bundle): Boolean
    }

    private val sessions = ConcurrentHashMap<CustomTabsSessionToken, Session>()
    private val live = ConcurrentHashMap<CustomTabsSessionToken, Visuals>()
    /** The clients' `EngagementSignalsCallback`s, one per session that asked (CCT-14). */
    private val engagement = ConcurrentHashMap<CustomTabsSessionToken, EngagementSignalsCallback>()

    fun register(token: CustomTabsSessionToken, packageName: String?) {
        sessions[token] = Session(packageName)
    }

    fun likely(token: CustomTabsSessionToken, url: String?) {
        sessions[token]?.likelyUrl = url
    }

    fun remove(token: CustomTabsSessionToken) {
        sessions.remove(token)
        live.remove(token)
        engagement.remove(token)
    }

    /** The client's engagement callback for a session it holds; false for one never opened (or cleaned up). */
    fun setEngagementCallback(token: CustomTabsSessionToken, callback: EngagementSignalsCallback): Boolean {
        if (!sessions.containsKey(token)) return false
        engagement[token] = callback
        return true
    }

    /** A user scroll of the session's tab started, or turned: `onVerticalScrollEvent(isDirectionUp)`. */
    fun verticalScroll(token: CustomTabsSessionToken?, isDirectionUp: Boolean) {
        val callback = token?.let { engagement[it] } ?: return
        runCatching { callback.onVerticalScrollEvent(isDirectionUp, Bundle()) }
    }

    /** The farthest the user scrolled the session's tab's document reached a new 5 % step. */
    fun greatestScrollPercentage(token: CustomTabsSessionToken?, percentage: Int) {
        val callback = token?.let { engagement[it] } ?: return
        runCatching { callback.onGreatestScrollPercentageIncreased(percentage, Bundle()) }
    }

    /** The session's tab closed: `onSessionEnded(didUserInteract)`. The callback stays for the session's next tab. */
    fun sessionEnded(token: CustomTabsSessionToken?, didUserInteract: Boolean) {
        val callback = token?.let { engagement[it] } ?: return
        runCatching { callback.onSessionEnded(didUserInteract, Bundle()) }
    }

    fun packageOf(token: CustomTabsSessionToken?): String? = token?.let { sessions[it]?.packageName }

    /** The custom tab showing for a session (one at a time: a new tab of the same session replaces the old). */
    fun attach(token: CustomTabsSessionToken?, tab: Visuals) {
        if (token != null) live[token] = tab
    }

    fun detach(token: CustomTabsSessionToken?, tab: Visuals) {
        if (token != null) live.remove(token, tab)
    }

    /** Main thread: apply the caller's `updateVisuals` bundle to the session's live tab. */
    fun updateVisuals(token: CustomTabsSessionToken, bundle: Bundle): Boolean = live[token]?.applyVisuals(bundle) ?: false

    /** Deliver a `CustomTabsCallback.onNavigationEvent` to the session's client, if it is still connected. */
    fun navigationEvent(token: CustomTabsSessionToken?, event: Int) {
        val callback: CustomTabsCallback = token?.callback ?: return
        runCatching { callback.onNavigationEvent(event, null) }
    }

    /**
     * The tab minimized into its floating card, or brought back: `CustomTabsCallback.onMinimized`
     * / `onUnminimized` (androidx.browser 1.8.0's pair; the callback's extras are empty, as
     * Chrome sends them).
     */
    fun minimized(token: CustomTabsSessionToken?, event: CustomTabMinimize.Event) {
        val callback: CustomTabsCallback = token?.callback ?: return
        runCatching {
            when (event) {
                CustomTabMinimize.Event.MINIMIZED -> callback.onMinimized(Bundle())
                CustomTabMinimize.Event.UNMINIMIZED -> callback.onUnminimized(Bundle())
            }
        }
    }
}
