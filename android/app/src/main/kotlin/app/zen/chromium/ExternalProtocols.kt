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
        // An address that parsed to no intent has nothing to start; it does not vanish without a word.
        val intent = p.intent ?: run { fallback(p); return }
        try {
            host.activity.startActivity(intent)
        } catch (e: ActivityNotFoundException) {
            fallback(p)
        } catch (e: SecurityException) {
            fallback(p)
        }
    }

    /**
     * The host's own word that no app can open the link (`handler == "none"` answered natively –
     * the custom tab, which has no core to decide through): the request is REFUSED, nothing is
     * started for it, and the deliberate fallback runs in the browser window's order (the core's
     * `noHandler`, `src/core/externalProtocols.ts`: the `intent://`'s web address in the tab,
     * else the store listing of the app it wants, else the toast). No app was declined – there
     * was none – so no site is remembered as having declined one.
     */
    fun refuseWithFallback(requestId: String) {
        val p = pending.remove(requestId) ?: return
        fallback(p)
    }

    /**
     * Nothing on the device takes the link: an app the manifest could not see was not installed
     * after all, or the host knew from the start ([refuseWithFallback]). An `intent://` names
     * what should have ([Fallback]): its web fallback loads in the tab, or the store listing of
     * the app it wants; anything else is a toast. A window on its way out shows nothing.
     */
    private fun fallback(p: Pending) {
        if (host.activity.isFinishing || host.activity.isDestroyed) return
        when (val plan = Fallback.of(p.fallbackUrl, p.intent?.`package`)) {
            is Fallback.LoadInTab -> p.tab.loadUrl(plan.url)
            is Fallback.StoreListing -> {
                val store = Intent(Intent.ACTION_VIEW, Uri.parse(plan.uri)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                try {
                    host.activity.startActivity(store)
                } catch (e: ActivityNotFoundException) {
                    // No store either; the toast says so.
                    toastNoApp()
                }
            }
            Fallback.Toast -> toastNoApp()
        }
    }

    private fun toastNoApp() {
        Toast.makeText(host.activity, NO_APP_TOAST, Toast.LENGTH_SHORT).show()
    }

    /**
     * What runs for a link nothing on the device opens, decided from what the request carried –
     * the order the browser window's core runs (`noHandler`): the `intent://`'s
     * `S.browser_fallback_url` loaded in the tab; else the store listing of the package it names
     * (`market://details?id=`, as Chrome opens it); else a word. Pure, so the order is tested.
     */
    sealed class Fallback {
        data class LoadInTab(val url: String) : Fallback()
        data class StoreListing(val uri: String) : Fallback()
        object Toast : Fallback()

        companion object {
            fun of(fallbackUrl: String?, pkg: String?): Fallback = when {
                fallbackUrl != null -> LoadInTab(fallbackUrl)
                pkg != null -> StoreListing("market://details?id=$pkg")
                else -> Toast
            }
        }
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

        /** The word for a link nothing opens; the browser window's core says the same (`noHandler`). */
        const val NO_APP_TOAST = "No app can open this link"

        /** The schemes the manifest's `<queries>` make visible on Android 11+ (keep both in step). */
        val VISIBLE_SCHEMES = setOf("http", "https", "mailto", "tel", "sms", "smsto", "mms", "mmsto", "market", "geo")
    }
}
