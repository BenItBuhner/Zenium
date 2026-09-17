package app.zen.chromium

import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.webkit.WebResourceRequest
import android.widget.Toast

/**
 * Links that leave Zenium for another app (`tel:`, `mailto:`, `zoommtg:`, `intent:`). A page's
 * navigation is reported to the core, which requires a gesture and shows the shared "open in
 * another app" prompt (remembered per site and scheme) before answering through
 * `external.respond`; only then is the Intent started, sanitised the way Chrome does it.
 */
class ExternalLaunches(private val host: Host) {
    private var seq = 0
    private val pending = LinkedHashMap<String, Intent>()

    /**
     * A tab is navigating to a non-web scheme. Returns false when the WebView should load the URL
     * itself; true when it was taken over here (and possibly refused).
     */
    fun onNavigation(tab: TabWebView, request: WebResourceRequest): Boolean {
        val url = request.url.toString()
        if (!ExternalLaunchPolicy.leavesBrowser(url)) return false
        val intent = buildIntent(url) ?: return true
        val id = "ext_${++seq}"
        pending[id] = intent
        while (pending.size > MAX_PENDING) pending.remove(pending.keys.first())
        host.chrome.hostEvent(
            "external.request",
            json(
                "requestId" to id,
                "tabId" to tab.tabId,
                "url" to url,
                "hasGesture" to request.hasGesture(),
                "redirect" to request.isRedirect,
                "targetApp" to targetApp(intent)
            )
        )
        return true
    }

    /** The core's answer to `external.request`. */
    fun respond(requestId: String, allow: Boolean) {
        val intent = pending.remove(requestId) ?: return
        if (allow) start(intent)
    }

    /** A launch the core already cleared with the user (`app.openExternal`). */
    fun open(url: String) {
        buildIntent(url)?.let(::start)
    }

    /**
     * `Intent.parseUri` plus Chrome's sanitisation: no component or selector chosen by the page,
     * BROWSABLE so only activities meant for web links match, no URI-permission grants, and a
     * fallback only when it is a web page. Null when the URL is unusable or must never leave.
     */
    fun buildIntent(url: String): Intent? {
        if (ExternalLaunchPolicy.neverLaunched(ExternalLaunchPolicy.schemeOf(url))) return null
        if (ExternalLaunchPolicy.refusesIntentUrl(url)) return null
        val intent = try {
            if (ExternalLaunchPolicy.schemeOf(url) == "intent") Intent.parseUri(url, Intent.URI_INTENT_SCHEME)
            else Intent(Intent.ACTION_VIEW, Uri.parse(url))
        } catch (e: Exception) {
            return null
        }
        if (ExternalLaunchPolicy.neverLaunched(intent.data?.scheme)) return null
        intent.component = null
        intent.selector = null
        intent.addCategory(Intent.CATEGORY_BROWSABLE)
        intent.flags = ExternalLaunchPolicy.stripGrantFlags(intent.flags) or Intent.FLAG_ACTIVITY_NEW_TASK
        if (intent.hasExtra(ExternalLaunchPolicy.FALLBACK_EXTRA) && ExternalLaunchPolicy.fallbackUrl(url) == null) {
            intent.removeExtra(ExternalLaunchPolicy.FALLBACK_EXTRA)
        }
        return intent
    }

    private fun start(intent: Intent) {
        val data = intent.data
        // A plain web link is a page for one of our tabs, never a bounce to another browser.
        if (intent.action == Intent.ACTION_VIEW && intent.`package` == null && data?.scheme in setOf("http", "https")) {
            host.chrome.openUrl(data.toString())
            return
        }
        try {
            host.activity.startActivity(intent)
        } catch (e: ActivityNotFoundException) {
            fallback(intent)
        } catch (e: SecurityException) {
            fallback(intent)
        }
    }

    private fun fallback(intent: Intent) {
        val fallback = intent.getStringExtra(ExternalLaunchPolicy.FALLBACK_EXTRA)
        if (fallback != null) host.chrome.openUrl(fallback)
        else Toast.makeText(host.activity, "No app can open this link", Toast.LENGTH_SHORT).show()
    }

    /** The app that would take the Intent, for the prompt; null when unknown or the system resolver. */
    private fun targetApp(intent: Intent): String? {
        val pm = host.activity.packageManager
        val resolved = runCatching { pm.resolveActivity(intent, PackageManager.MATCH_DEFAULT_ONLY) }.getOrNull() ?: return null
        val info = resolved.activityInfo ?: return null
        if (info.packageName == "android" || info.packageName == host.activity.packageName) return null
        return runCatching { resolved.loadLabel(pm).toString() }.getOrNull()?.takeIf { it.isNotBlank() }
    }

    companion object {
        private const val MAX_PENDING = 32
    }
}
