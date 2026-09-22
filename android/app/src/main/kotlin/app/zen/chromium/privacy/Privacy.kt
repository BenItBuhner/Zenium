package app.zen.chromium.privacy

import android.content.Context
import android.content.res.AssetManager
import android.util.Log
import androidx.webkit.CustomHeader
import androidx.webkit.Profile
import androidx.webkit.ProfileStore
import androidx.webkit.WebViewFeature
import app.zen.chromium.Profiles
import app.zen.chromium.Storage
import app.zen.chromium.blocking.Blocking
import app.zen.chromium.blocking.Domains
import app.zen.chromium.blocking.RequestPolicy
import app.zen.chromium.blocking.SafeBrowsingHit
import org.json.JSONObject

/**
 * The Android host of the core's privacy features (`src/core/privacy`): keeps the policy the
 * core last pushed ([flags]), loads the Safe Browsing tables from the core's files
 * ([safeBrowsing]) and answers the request engine ahead of its rule sets ([RequestPolicy]).
 * The per-WebView half – third-party cookies, WebView's own Safe Browsing switch, the mixed
 * content mode of `always`, the `navigator` signals – is `TabWebView.applyPrivacy`, which reads
 * [flags]; the per-profile half, the GPC / DNT request headers, is here.
 *
 * One instance per process ([shared]), like the request engine: a custom tab has no core to push
 * a policy, so the last one applied is kept in `files/zen/privacy/flags.json` (its session-only
 * parts left out) and read at start.
 */
class Privacy private constructor(
    private val storage: Storage,
    private val assets: AssetManager,
    private val blocking: Blocking
) : RequestPolicy {
    @Volatile
    var flags: PrivacyFlags = PrivacyFlags.DEFAULT
        private set

    val safeBrowsing = SafeBrowsing(storage)

    private fun start() {
        flags = storage.read(FLAGS_FILE)?.let { text -> runCatching { PrivacyFlags.parse(JSONObject(text)) }.getOrNull() }
            ?: PrivacyFlags.DEFAULT
        safeBrowsing.start()
        blocking.policy = this
    }

    /** The core pushed the effective policy (`privacy.apply`, main thread). */
    fun apply(raw: JSONObject) {
        flags = PrivacyFlags.parse(raw)
        storage.write(FLAGS_FILE, flags.withoutSession().toJson().toString()) {}
        applySignalHeaders()
    }

    // --- RequestPolicy (IO threads) --------------------------------------------------------------

    override fun unsafe(url: String, navigation: Boolean): SafeBrowsingHit? {
        val f = flags
        if (!f.safeBrowsing) return null
        val host = Domains.hostnameOf(url) ?: return null
        if (f.isBypassed(url)) return null
        // A navigation's check may be the process's first: that one waits for the tables (bounded).
        val tables = if (navigation) safeBrowsing.tablesForNavigation() else safeBrowsing.tables
        return tables.lookup(host)
    }

    override fun plaintextAllowed(url: String): Boolean = flags.plaintextAllowed(url)

    /**
     * The per-site cookie policy's word on a document (the never list, "block all cookies"):
     * relayed without cookies when blocked. The third-party rule is left to the tab's own
     * switch (`TabWebView.applyCookiePolicy`), which WebView enforces on every request.
     */
    override fun cookiesWithheld(url: String, documentUrl: String?, containerId: String): Boolean {
        val policy = flags.siteData
        if (policy.isEmpty) return false
        return policy.verdict(url) == SiteDataPolicy.Verdict.BLOCKED
    }

    // --- the bundled snapshot (PrivacyHost.bundledSafeBrowsingFeed) ------------------------------

    /** The feed document the build ships for `id` (`assets/safebrowsing/<id>.json`), or null. */
    fun bundledFeed(id: String): String? {
        if (!FEED_ID.matches(id)) return null
        return runCatching { assets.open("$SNAPSHOT_DIR/$id.json").bufferedReader().use { it.readText() } }.getOrNull()
    }

    // --- GPC / DNT request headers, per profile --------------------------------------------------

    /**
     * Whether the WebView attaches the signal headers itself (every request of every profile:
     * `Profile.addCustomHeader`, androidx.webkit 1.17's name for the origin-matched headers).
     * Without the feature the tab adds them to the navigations it starts (`TabWebView.loadUrl`).
     */
    val headersSupported: Boolean
        get() = Profiles.supported && WebViewFeature.isFeatureSupported(WebViewFeature.CUSTOM_REQUEST_HEADERS)

    /** Bring every profile's headers in line with [flags]. */
    private fun applySignalHeaders() {
        if (!headersSupported) return
        runCatching {
            val store = ProfileStore.getInstance()
            for (name in store.allProfileNames) store.getProfile(name)?.let { applySignalHeaders(it) }
        }.onFailure { e -> Log.w(TAG, "signal headers not applied", e) }
    }

    /** What each profile was last given, so a page's creation re-applies nothing (main thread). */
    private val appliedHeaders = HashMap<String, String>()

    /** A profile's headers (every profile on a policy push; a container's when its first page is created). */
    fun applySignalHeaders(profile: Profile) {
        if (!headersSupported) return
        val headers = flags.signalHeaders()
        val signature = headers.entries.joinToString(";") { "${it.key}=${it.value}" }
        if (appliedHeaders[profile.name] == signature) return
        runCatching {
            for (name in SIGNAL_HEADERS) {
                // A header set twice for overlapping origins is refused: the old value goes first.
                if (profile.hasCustomHeader(name)) profile.clearCustomHeader(name)
                headers[name]?.let { value -> profile.addCustomHeader(CustomHeader(name, value, setOf("*"))) }
            }
            appliedHeaders[profile.name] = signature
        }.onFailure { e -> Log.w(TAG, "signal headers of profile ${profile.name} not applied", e) }
    }

    companion object {
        private const val TAG = "zen-privacy"

        /** The last policy applied, for a process that starts without the core (a custom tab). */
        const val FLAGS_FILE = "privacy/flags.json"

        /** Where the build's Safe Browsing snapshot is packaged (`copySafeBrowsingSnapshot` in build.gradle.kts). */
        const val SNAPSHOT_DIR = "safebrowsing"

        private val FEED_ID = Regex("^[a-z0-9-]+$")
        private val SIGNAL_HEADERS = listOf("Sec-GPC", "DNT")

        @Volatile
        private var sharedInstance: Privacy? = null

        /** The process's privacy host, started on first use over the request engine of the same process. */
        fun shared(context: Context): Privacy {
            sharedInstance?.let { return it }
            synchronized(this) {
                sharedInstance?.let { return it }
                val app = context.applicationContext
                return Privacy(Storage(app), app.assets, Blocking.shared(app)).also {
                    it.start()
                    sharedInstance = it
                }
            }
        }
    }
}
