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
