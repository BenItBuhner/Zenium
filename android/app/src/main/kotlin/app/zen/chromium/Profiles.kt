package app.zen.chromium

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
 */
object Profiles {
    const val DEFAULT_CONTAINER = "default"
    /** Custom Tabs intentionally use the main profile, sharing its WebView cookie jar and sign-in. */
    const val CUSTOM_TAB_CONTAINER = DEFAULT_CONTAINER

    val supported: Boolean
        get() = WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE)

    fun nameFor(containerId: String): String =
        if (containerId == DEFAULT_CONTAINER) Profile.DEFAULT_PROFILE_NAME else "zen-container-$containerId"

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

    /** Wipe a container's data (the container was deleted). */
    fun clear(containerId: String) {
        if (containerId == DEFAULT_CONTAINER || !supported) {
            CookieManager.getInstance().removeAllCookies(null)
            WebStorage.getInstance().deleteAllData()
            return
        }
        runCatching {
            val store = ProfileStore.getInstance()
            val profile = store.getProfile(nameFor(containerId)) ?: return
            profile.cookieManager.removeAllCookies(null)
            profile.webStorage.deleteAllData()
            // Deleting fails while a WebView still uses the profile; the data is gone regardless.
            runCatching { store.deleteProfile(nameFor(containerId)) }
        }
    }
}
