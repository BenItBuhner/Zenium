package app.zen.chromium

import android.content.Context
import android.util.Log
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
 *
 * A wipe reaches only a profile of the container's own ([isOwnProfile]). On a WebView without
 * profiles every container – the private one included – runs on the default profile, and
 * [cookieManager] and [webStorage] hand out the default profile's stores for it, which is right
 * for a tab's settings and would make a wipe of "the private profile" a wipe of the user's
 * browsing data; the same if a lookup ever came back as the default profile. [clear],
 * [wipePrivate] and the steps of [BrowsingData.clear] refuse there (false, a line in the log)
 * and touch nothing. Private browsing's other traces are the core's, by container id, and do
 * not depend on the profile: its downloads stay out of the list and its pages out of history
 * whether the profile is wiped or not.
 */
object Profiles {
    const val DEFAULT_CONTAINER = "default"
    /** The core's `PRIVATE_CONTAINER_ID`: private tabs run in this container. */
    const val PRIVATE_CONTAINER = "private"

    private const val PRIVATE_PROFILE = "zen-private"
    /** The private container's profile name before it had one of its own; wiped at start like the current one. */
    private const val LEGACY_PRIVATE_PROFILE = "zen-container-private"
    private const val TAG = "ZenProfiles"

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

    /** A container's profile (the default one for the default container), or null on a WebView without profiles. */
    fun profile(containerId: String): Profile? {
        if (!supported) return null
        return runCatching { ProfileStore.getInstance().getProfile(nameFor(containerId)) }.getOrNull()
    }

    /**
     * The cookie jar a tab of the container runs on: the default one for the default container,
     * and for every container on an old WebView or when its profile cannot be found. Right for a
     * tab's settings and for reading; a wipe takes [ownStores] instead, which never falls back.
     */
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
     * Whether `resolved` – the name of the profile the store handed out for the container's
     * profile name, null when it had none – is a profile of the container's own: named for the
     * container and not the default profile. False for the default container, whose profile is
     * the default one by design, so nothing but the default container's data ever goes with
     * a wipe of the default profile.
     */
    fun isOwnProfile(containerId: String, resolved: String?): Boolean {
        if (containerId == DEFAULT_CONTAINER || resolved == null) return false
        val name = nameFor(containerId)
        return resolved == name && name != Profile.DEFAULT_PROFILE_NAME
    }

    /**
     * The name of `containerId`'s own profile ([isOwnProfile]) in `store`, or null when it has
     * none there: a WebView without profiles, a profile never created, a lookup that came back
     * as another profile.
     */
    fun ownProfile(containerId: String, store: Store): String? {
        if (!store.multiProfile) return null
        val name = nameFor(containerId)
        return name.takeIf { isOwnProfile(containerId, store.resolve(it)) }
    }

    /** A profile's two stores, as a wipe empties them. */
    class Stores(val cookies: CookieManager, val storage: WebStorage)

    /**
     * The stores a wipe of `containerId` may empty: the default profile's for the default
     * container, its own profile's for a container that has one, and null – nothing – for a
     * container that has not, where [cookieManager] and [webStorage] would hand out the default
     * profile's.
     */
    fun ownStores(containerId: String): Stores? {
        if (containerId == DEFAULT_CONTAINER) return Stores(CookieManager.getInstance(), WebStorage.getInstance())
        if (!supported) return null
        val profile = runCatching { ProfileStore.getInstance().getProfile(nameFor(containerId)) }.getOrNull() ?: return null
        if (!isOwnProfile(containerId, profile.name)) return null
        return Stores(profile.cookieManager, profile.webStorage)
    }

    /**
     * The WebView's profile store as the wipes see it. [LiveStore] is the WebView's own; the JVM
     * tests stand in one of theirs, the framework not being there.
     */
    interface Store {
        /** Whether this WebView keeps profiles at all (`WebViewFeature.MULTI_PROFILE`). */
        val multiProfile: Boolean

        /** The names of the profiles that exist. */
        fun names(): List<String>

        /** The name of the profile the store hands out for `name`; null when it has none by it. */
        fun resolve(name: String): String?

        /** Cookies, site storage and HTTP cache of the container's profile; `done` once the WebView has answered. */
        fun clearData(containerId: String, done: () -> Unit)

        /** Cookies and site storage of the profile `name`, from the profile itself (no container leads to it any more). */
        fun clearProfile(name: String)

        /** Delete the profile `name`; false when the WebView would not (a view still on it). */
        fun delete(name: String): Boolean

        fun log(message: String)
    }

    /**
     * Wipe a container's data (the container was deleted, or the private session ended): cookies,
     * site storage and the HTTP cache, then the profile itself. Deleting the profile fails while a
     * WebView still uses it (a page that has not finished going away); the data is gone regardless,
     * and the next [wipePrivate] at start takes the empty profile with it.
     *
     * True when the wipe went ahead. False – with a line in the log, and `done` run all the same –
     * when the container has no profile of its own here ([ownProfile]): its data is the default
     * profile's, and nothing is touched.
     */
    fun clear(context: Context, containerId: String, done: () -> Unit = {}): Boolean =
        clear(containerId, LiveStore(context), done)

    fun clear(containerId: String, store: Store, done: () -> Unit = {}): Boolean {
        if (containerId == DEFAULT_CONTAINER) {
            store.clearData(containerId, done)
            return true
        }
        val own = ownProfile(containerId, store)
        if (own == null) {
            store.log(
                "container $containerId has no profile of its own on this WebView (its data is the default profile's): nothing wiped"
            )
            done()
            return false
        }
        store.clearData(containerId) {
            store.delete(own)
            done()
        }
        return true
    }

    /**
     * Leave nothing of private browsing behind: at start (a session the last run did not get to
     * wipe – a crash, the system killing the app) and when the last private tab closes. Only
     * profiles that exist are touched, so a start without one costs nothing; on a WebView without
     * profiles there is no private profile to wipe, and nothing is (the default profile is not
     * private browsing's). True when a private profile was found and wiped.
     */
    fun wipePrivate(context: Context, done: () -> Unit = {}): Boolean = wipePrivate(LiveStore(context), done)

    fun wipePrivate(store: Store, done: () -> Unit = {}): Boolean {
        if (!store.multiProfile) {
            store.log("no private profile to wipe: this WebView keeps no profiles (private tabs are off here)")
            done()
            return false
        }
        val names = store.names()
        var wiped = false
        if (LEGACY_PRIVATE_PROFILE in names && store.resolve(LEGACY_PRIVATE_PROFILE) == LEGACY_PRIVATE_PROFILE) {
            store.clearProfile(LEGACY_PRIVATE_PROFILE)
            store.delete(LEGACY_PRIVATE_PROFILE)
            wiped = true
        }
        if (PRIVATE_PROFILE !in names) {
            done()
            return wiped
        }
        return clear(PRIVATE_CONTAINER, store, done) || wiped
    }

    private val ALL_KINDS = setOf("cookies", "storage", "cache")

    /** The WebView's profile store; every call guarded, since the WebView may be mid-update. */
    private class LiveStore(private val context: Context) : Store {
        override val multiProfile: Boolean
            get() = supported

        private val profiles: ProfileStore?
            get() = if (supported) runCatching { ProfileStore.getInstance() }.getOrNull() else null

        override fun names(): List<String> =
            profiles?.let { runCatching { it.allProfileNames }.getOrNull() } ?: emptyList()

        override fun resolve(name: String): String? =
            profiles?.let { runCatching { it.getProfile(name)?.name }.getOrNull() }

        override fun clearData(containerId: String, done: () -> Unit) {
            BrowsingData.clear(context, listOf(containerId), ALL_KINDS, { null }, done)
        }

        override fun clearProfile(name: String) {
            runCatching {
                val profile = profiles?.getProfile(name) ?: return
                profile.cookieManager.removeAllCookies(null)
                profile.webStorage.deleteAllData()
            }
        }

        override fun delete(name: String): Boolean =
            profiles?.let { runCatching { it.deleteProfile(name) }.getOrDefault(false) } ?: false

        override fun log(message: String) {
            Log.w(TAG, message)
        }
    }
}
