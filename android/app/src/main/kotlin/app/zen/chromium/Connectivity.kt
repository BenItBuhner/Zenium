package app.zen.chromium

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.os.Handler
import android.util.Log

/**
 * The device's word on whether it is online, for the chrome (ERR-06 / ERR-07): the system's
 * default network through a [ConnectivityManager.NetworkCallback], read as Chrome reads it –
 * online when the default network has INTERNET and the system has VALIDATED it (a captive
 * portal or a Wi-Fi with no way out is offline), offline when there is none. Each change goes
 * to the core as the `connectivity` host event on the main thread; the core debounces (a
 * network switch loses one network and validates the next within a second) and owns the
 * banner, the toast and the error pages' reload. The boot payload carries the reading at boot.
 *
 * The folding of the callbacks into one reading is [Judge], free of Android types for JUnit.
 */
class Connectivity(context: Context, private val main: Handler, private val onChange: (Boolean) -> Unit) {
    private val manager = context.getSystemService(ConnectivityManager::class.java)
    private val judge = Judge()
    private var registered = false

    /** The system's reading right now (main thread or not: the manager answers from its own state). */
    val online: Boolean
        get() {
            val cm = manager ?: return true
            val network = cm.activeNetwork ?: return false
            val caps = cm.getNetworkCapabilities(network) ?: return false
            return Judge.onlineOf(
                caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET),
                caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)
            )
        }

    private val callback = object : ConnectivityManager.NetworkCallback() {
        override fun onAvailable(network: Network) = post { judge.available(network.toString()) }

        override fun onCapabilitiesChanged(network: Network, caps: NetworkCapabilities) = post {
            judge.capabilities(
                network.toString(),
                caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET),
                caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)
            )
        }

        override fun onLost(network: Network) = post { judge.lost(network.toString()) }

        override fun onUnavailable() = post { judge.unavailable() }
    }

    /** Start listening; the first change after this reaches [onChange]. Idempotent. */
    fun start() {
        val cm = manager ?: return
        if (registered) return
        judge.reset(online)
        runCatching { cm.registerDefaultNetworkCallback(callback) }
            .onSuccess { registered = true }
            .onFailure { Log.w(TAG, "no default network callback: ${it.javaClass.simpleName}") }
    }

    fun stop() {
        val cm = manager ?: return
        if (!registered) return
        registered = false
        runCatching { cm.unregisterNetworkCallback(callback) }
    }

    /** The callbacks arrive on the manager's thread; the judge and the chrome live on the main one. */
    private fun post(change: () -> Boolean?) {
        main.post {
            val online = change() ?: return@post
            Log.i(TAG, if (online) "online" else "offline")
            onChange(online)
        }
    }

    /**
     * Folds the default network callback's events into one online reading. The default network
     * is one network at a time: `onAvailable` names the new default (not yet online: its
     * capabilities follow), `onCapabilitiesChanged` says whether it reaches the internet,
     * `onLost` takes it away (offline until the next default validates), `onUnavailable` is a
     * request the system could not satisfy at all. Each method answers the new reading when it
     * changed, null when it did not.
     */
    class Judge(initial: Boolean = true) {
        private var online = initial
        private var current: String? = null

        val isOnline: Boolean get() = online

        fun reset(online: Boolean) {
            this.online = online
            current = null
        }

        fun available(network: String): Boolean? {
            current = network
            return null
        }

        fun capabilities(network: String, internet: Boolean, validated: Boolean): Boolean? {
            // A network other than the default the callback last named (the callbacks of a
            // network on its way out can trail the next one's `onAvailable`) has no say.
            if (current != null && network != current) return null
            current = network
            return settle(onlineOf(internet, validated))
        }

        fun lost(network: String): Boolean? {
            if (current != null && network != current) return null
            current = null
            return settle(false)
        }

        fun unavailable(): Boolean? {
            current = null
            return settle(false)
        }

        private fun settle(next: Boolean): Boolean? {
            if (next == online) return null
            online = next
            return next
        }

        companion object {
            /** Chrome's reading: a network is online when it reaches the internet and the system validated that. */
            fun onlineOf(internet: Boolean, validated: Boolean): Boolean = internet && validated
        }
    }

    companion object {
        private const val TAG = "ZenConnectivity"
    }
}
