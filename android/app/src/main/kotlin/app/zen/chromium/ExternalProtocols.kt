package app.zen.chromium

import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.webkit.WebResourceRequest
import android.widget.Toast

/**
 * Links that leave the web. A page's `mailto:`, `tel:`, `market:`, `intent://` or custom-scheme
 * navigation is held here while the core decides (a remembered "always allow", or the confirm
 * sheet in the chrome); `externalProtocol.respond` then starts the app or drops the request. The
 * same sheet offers a site's own app for a web address it claims without being verified for it
 * (`AppLinks`), in which case the page loads regardless of the answer. In the browser window the
 * host is the core in the chrome; a custom tab answers the request natively (see `CustomTabHost`).
 */
class ExternalProtocols(private val host: PageHost) {
    private class Pending(
        val tab: TabWebView,
        val url: String,
        val intent: Intent?,
        /** The web address an `intent://` named for browsers without its app. */
        val fallbackUrl: String?,
        /** The site whose unverified app is on offer (an `AppLinks` candidate), else null. */
        val appHost: String?
    )

    private val pending = HashMap<String, Pending>()

    /** Sites whose unverified app the user declined this session: asked once per site. */
    private val declinedAppHosts = HashSet<String>()
    private var seq = 0

    /** A tab's navigation to a scheme the web does not render: hold it and ask the core. */
    fun request(tab: TabWebView, url: String, userGesture: Boolean) {
        val intent = parse(url)
        val resolved = intent?.let { host.activity.packageManager.resolveActivity(it, PackageManager.MATCH_DEFAULT_ONLY) }
        val handler = when {
            intent == null -> "none"
            resolved != null -> "known"
            // With no app visible for a scheme the manifest queries, there is none.
            canSeeHandlers(intent) -> "none"
            else -> "unknown"
        }
        // The resolver activity stands in when several apps qualify and none is the default.
        val appName = resolved
            ?.takeIf { it.activityInfo?.packageName != "android" }
            ?.loadLabel(host.activity.packageManager)?.toString()?.ifEmpty { null }
        val id = "ext-${++seq}"
        val fallbackUrl = intent?.getStringExtra(EXTRA_FALLBACK_URL)?.takeIf { it.startsWith("http://") || it.startsWith("https://") }
        intent?.removeExtra(EXTRA_FALLBACK_URL)
        pending[id] = Pending(tab, url, intent, fallbackUrl, null)
        host.hostEvent(
            "externalProtocol.request",
            json(
                "requestId" to id,
                "tabId" to tab.tabId,
                "url" to url,
                "appName" to appName,
                "handler" to handler,
                "userGesture" to userGesture
            )
        )
    }

    /**
     * A tap on another site (see `AppLinks.shouldProbe`): a verified App Link opens its app and
     * the tab does not load the page (true); an unverified app is offered through the sheet while
     * the page loads (false); anything else just loads (false).
     */
    fun appLink(tab: TabWebView, request: WebResourceRequest): Boolean {
        val target = request.url.toString()
        if (!AppLinks.shouldProbe(tab.url, target, request.isForMainFrame, request.isRedirect, request.hasGesture())) return false
        val site = request.url.host?.lowercase() ?: return false
        return when (val probe = AppLinks.probe(host.activity, request.url)) {
            AppLinks.Probe.Opened -> true
            is AppLinks.Probe.Candidate -> {
                if (site !in declinedAppHosts) offer(tab, target, probe, site)
                false
            }
            AppLinks.Probe.None -> false
        }
    }

    private fun offer(tab: TabWebView, url: String, candidate: AppLinks.Probe.Candidate, site: String) {
        val id = "ext-${++seq}"
        pending[id] = Pending(tab, url, candidate.intent, null, site)
        host.hostEvent(
            "externalProtocol.request",
            json(
                "requestId" to id,
                "tabId" to tab.tabId,
                "url" to url,
                "appName" to candidate.appName,
                "handler" to "known",
                "userGesture" to true
            )
        )
    }

    /** The core's answer: start the app, or let the request go. */
    fun respond(requestId: String, allow: Boolean) {
        val p = pending.remove(requestId) ?: return
        if (!allow) {
            p.appHost?.let(declinedAppHosts::add)
            return
        }
        val intent = p.intent ?: return
        try {
            host.activity.startActivity(intent)
        } catch (e: ActivityNotFoundException) {
            fallback(p)
        } catch (e: SecurityException) {
            fallback(p)
        }
    }

    /**
     * Nothing on the device took the intent after all (an app the manifest could not see was not
     * installed). An `intent://` names what should have: its web fallback loads in the tab, or
     * the store listing of the app it wants; anything else is a toast.
     */
    private fun fallback(p: Pending) {
        if (p.fallbackUrl != null) {
            p.tab.loadUrl(p.fallbackUrl)
            return
        }
        val pkg = p.intent?.`package`
        if (pkg != null) {
            val store = Intent(Intent.ACTION_VIEW, Uri.parse("market://details?id=$pkg")).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            try {
                host.activity.startActivity(store)
                return
            } catch (e: ActivityNotFoundException) {
                // No store either; the toast below says so.
            }
        }
        Toast.makeText(host.activity, "No app can open this link", Toast.LENGTH_SHORT).show()
    }

    /**
     * The intent a page's address stands for. An `intent://` URL is parsed the way Chrome does
     * and then disarmed: web content may only start activities that opted in with BROWSABLE,
     * never a named component or a selector of its choosing, and never with URI grants. The
     * browser's own fallback hint is read out of the extras by the caller and not passed on.
     */
    private fun parse(url: String): Intent? {
        val intent = runCatching {
            if (url.startsWith("intent:", ignoreCase = true)) Intent.parseUri(url, Intent.URI_INTENT_SCHEME)
            else Intent(Intent.ACTION_VIEW, Uri.parse(url))
        }.getOrNull() ?: return null
        intent.addCategory(Intent.CATEGORY_BROWSABLE)
        intent.component = null
        intent.selector = null
        intent.flags = (intent.flags and (Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION).inv()) or
            Intent.FLAG_ACTIVITY_NEW_TASK
        return intent
    }

    /** Whether package visibility lets Zenium see the apps for this intent's scheme. */
    private fun canSeeHandlers(intent: Intent): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return true
        val scheme = intent.data?.scheme?.lowercase() ?: intent.scheme?.lowercase()
        return scheme in VISIBLE_SCHEMES
    }

    companion object {
        /** `S.browser_fallback_url` of an `intent://` URL, as `Intent.parseUri` stores it. */
        const val EXTRA_FALLBACK_URL = "browser_fallback_url"

        /** The schemes the manifest's `<queries>` make visible on Android 11+ (keep both in step). */
        val VISIBLE_SCHEMES = setOf("http", "https", "mailto", "tel", "sms", "smsto", "mms", "mmsto", "market", "geo")
    }
}
