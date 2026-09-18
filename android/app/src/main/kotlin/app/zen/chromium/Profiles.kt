package app.zen.chromium

import android.content.Context
import android.webkit.CookieManager
import android.webkit.WebStorage
import android.webkit.WebView
import androidx.webkit.Profile
import androidx.webkit.ProfileStore
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature

/**
 * Zen containers → WebView profiles (separate cookies, storage and cache), the Android equivalent
 * of Chromium's session partitions. Needs a WebView that supports multi-profile (Chrome 111+);
 * older WebViews fall back to the default profile for every container.
 *
 * Private browsing is a container too ([PRIVATE_CONTAINER], the core's `PRIVATE_CONTAINER_ID`):
 * its tabs share one profile that is wiped when the last of them closes ([wipePrivate]) and
 * again at every start, so nothing of a session that ended in a crash survives it. The WebView
 * has no in-memory profile, so this is how a session leaves no trace.
 */
object Profiles {
    const val DEFAULT_CONTAINER = "default"
    const val PRIVATE_CONTAINER = "private"

    private const val PRIVATE_PROFILE = "zen-private"
    /** The private container's profile name before it had one of its own; wiped at start like the current one. */
    private const val LEGACY_PRIVATE_PROFILE = "zen-container-private"

    val supported: Boolean
        get() = WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE)

    fun isPrivate(containerId: String): Boolean = containerId == PRIVATE_CONTAINER

    fun nameFor(containerId: String): String = when (containerId) {
        DEFAULT_CONTAINER -> Profile.DEFAULT_PROFILE_NAME
        PRIVATE_CONTAINER -> PRIVATE_PROFILE
        else -> "zen-container-$containerId"
    }

    /** Must run before the WebView loads anything. */
    fun apply(webView: WebView, containerId: String) {
        if (containerId == DEFAULT_CONTAINER || !supported) return
        val name = nameFor(containerId)
        runCatching {
            ProfileStore.getInstance().getOrCreateProfile(name)
            WebViewCompat.setProfile(webView, name)
        }
    }

    /** The cookie jar of a container (the default one for the default container and old WebViews). */
    fun cookieManager(containerId: String): CookieManager {
        if (containerId == DEFAULT_CONTAINER || !supported) return CookieManager.getInstance()
        return runCatching { ProfileStore.getInstance().getProfile(nameFor(containerId))?.cookieManager }.getOrNull()
            ?: CookieManager.getInstance()
    }

    /** The storage (quota manager) of a container, see [cookieManager]. */
    fun webStorage(containerId: String): WebStorage {
        if (containerId == DEFAULT_CONTAINER || !supported) return WebStorage.getInstance()
        return runCatching { ProfileStore.getInstance().getProfile(nameFor(containerId))?.webStorage }.getOrNull()
            ?: WebStorage.getInstance()
    }

    /**
     * Wipe a container's data (the container was deleted, or the private session ended): cookies,
     * site storage and the HTTP cache, then the profile itself. Deleting the profile fails while a
     * WebView still uses it (a page that has not finished going away); the data is gone regardless,
     * and the next [wipePrivate] at start takes the empty profile with it.
     */
    fun clear(context: Context, containerId: String, done: () -> Unit = {}) {
        BrowsingData.clear(context, listOf(containerId), ALL_KINDS, { null }) {
            if (containerId != DEFAULT_CONTAINER && supported) {
                runCatching { ProfileStore.getInstance().deleteProfile(nameFor(containerId)) }
            }
            done()
        }
    }

    /**
     * Leave nothing of private browsing behind: at start (a session the last run did not get to
     * wipe – a crash, the system killing the app) and when the last private tab closes. Only
     * profiles that exist are touched, so a start without one costs nothing.
     */
    fun wipePrivate(context: Context, done: () -> Unit = {}) {
        if (!supported) {
            done()
            return
        }
        val store = runCatching { ProfileStore.getInstance() }.getOrNull()
        if (store == null) {
            done()
            return
        }
        val names = runCatching { store.allProfileNames }.getOrDefault(emptyList())
        if (LEGACY_PRIVATE_PROFILE in names) runCatching {
            val legacy = store.getProfile(LEGACY_PRIVATE_PROFILE)
            legacy?.cookieManager?.removeAllCookies(null)
            legacy?.webStorage?.deleteAllData()
            store.deleteProfile(LEGACY_PRIVATE_PROFILE)
        }
        if (PRIVATE_PROFILE !in names) {
            done()
            return
        }
        clear(context, PRIVATE_CONTAINER, done)
    }

    private val ALL_KINDS = setOf("cookies", "storage", "cache")
}
