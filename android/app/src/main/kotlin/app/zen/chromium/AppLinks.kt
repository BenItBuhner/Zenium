package app.zen.chromium

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.content.pm.ResolveInfo
import android.net.Uri
import android.os.Build
import java.net.URI

/**
 * Open in app. A tap on a link to another site whose native app is installed: a verified App Link
 * opens the app straight away (Android vouches for the domain), an app that merely claims the
 * domain is offered through the external-protocol sheet ("Open in <app>?") while the page loads.
 * Nothing else ever leaves the tab: redirects, navigations a script started without a tap, links
 * within the same site, addresses typed into the URL bar (those never reach
 * `shouldOverrideUrlLoading` at all).
 */
object AppLinks {
    /**
     * Whether a navigation from the page at `current` to `target` is one that may open an app –
     * decided before the system is asked anything. Pure, so it is unit-tested on the JVM.
     */
    fun shouldProbe(current: String?, target: String, mainFrame: Boolean, redirect: Boolean, gesture: Boolean): Boolean {
        if (!mainFrame || redirect || !gesture) return false
        if (!isWeb(target)) return false
        return !sameSite(current, target)
    }

    /**
     * Two web addresses are the same site when their registrable domains match. Approximated
     * without a public-suffix list: the last two labels, or three when the second-to-last is a
     * short second-level label under a two-letter country code (`bbc.co.uk`, `abc.net.au`). A
     * `www.` differs from the bare host only in name. Anything that is not a web address (a
     * `zen://` page, `about:blank`, nothing at all) is no site, so it is never the same one.
     */
    fun sameSite(a: String?, b: String?): Boolean {
        val ha = hostOf(a) ?: return false
        val hb = hostOf(b) ?: return false
        return registrableDomain(ha) == registrableDomain(hb)
    }

    /** The lower-case host of a web address, or null for anything that is not one. */
    fun hostOf(url: String?): String? {
        if (url == null || !isWeb(url)) return null
        val host = runCatching { URI(url).host }.getOrNull() ?: return null
        return host.lowercase().removeSuffix(".").ifEmpty { null }
    }

    /** `example.com` for `www.example.com`; `bbc.co.uk` for `news.bbc.co.uk`; an IP address as is. */
    fun registrableDomain(host: String): String {
        if (host.startsWith("[") || host.all { it.isDigit() || it == '.' }) return host
        val labels = host.split('.')
        if (labels.size <= 2) return host
        val tld = labels[labels.size - 1]
        val second = labels[labels.size - 2]
        val keep = if (tld.length == 2 && second.length <= 3 && labels.size >= 3) 3 else 2
        return labels.takeLast(keep).joinToString(".")
    }

    private fun isWeb(url: String): Boolean {
        val scheme = url.substringBefore(':', "").lowercase()
        return scheme == "http" || scheme == "https"
    }

    // --- asking the system -----------------------------------------------------------------------

    /** What the system had to say about the apps for a web address. */
    sealed class Probe {
        /** A verified App Link (or the user's own default app) opened; the tab must not load it. */
        object Opened : Probe()

        /** An app claims the address without being verified for it: the sheet offers it. */
        class Candidate(val intent: Intent, val appName: String) : Probe()

        /** Only browsers, or nothing at all: the tab loads the page. */
        object None : Probe()
    }

    /**
     * Android 11+ answers the question itself: an intent that may only resolve to a non-browser
     * app with a default (`FLAG_ACTIVITY_REQUIRE_NON_BROWSER` and `_REQUIRE_DEFAULT`) starts a
     * verified App Link and throws for everything else. Before that, the default resolution of a
     * plain VIEW intent is the verified app when there is one (a browser or the resolver
     * otherwise). Whatever is left that is not a browser is a candidate for the sheet.
     */
    fun probe(activity: Activity, uri: Uri): Probe {
        val pm = activity.packageManager
        val view = Intent(Intent.ACTION_VIEW, uri)
            .addCategory(Intent.CATEGORY_BROWSABLE)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            val verifiedOnly = Intent(view).addFlags(
                Intent.FLAG_ACTIVITY_REQUIRE_NON_BROWSER or Intent.FLAG_ACTIVITY_REQUIRE_DEFAULT
            )
            try {
                activity.startActivity(verifiedOnly)
                return Probe.Opened
            } catch (e: ActivityNotFoundException) {
                // No verified app; an unverified one may still claim the address below.
            }
        } else {
            val default = pm.resolveActivity(view, PackageManager.MATCH_DEFAULT_ONLY or PackageManager.GET_RESOLVED_FILTER)
            if (default != null && isApp(default, activity.packageName)) {
                val explicit = Intent(view).setClassName(default.activityInfo.packageName, default.activityInfo.name)
                return try {
                    activity.startActivity(explicit)
                    Probe.Opened
                } catch (e: ActivityNotFoundException) {
                    Probe.None
                }
            }
        }
        val candidate = pm.queryIntentActivities(view, PackageManager.MATCH_DEFAULT_ONLY or PackageManager.GET_RESOLVED_FILTER)
            .firstOrNull { isApp(it, activity.packageName) } ?: return Probe.None
        val explicit = Intent(view).setClassName(candidate.activityInfo.packageName, candidate.activityInfo.name)
        return Probe.Candidate(explicit, candidate.loadLabel(pm).toString())
    }

    /** A real app for the address: not a browser, not the system's resolver, not Zenium itself. */
    private fun isApp(info: ResolveInfo, self: String): Boolean {
        val activity = info.activityInfo ?: return false
        if (activity.packageName == self || activity.packageName == "android") return false
        return !isBrowserFilter(info.filter)
    }

    /**
     * A browser's filter takes every web address: http or https with no host of its own. An app's
     * filter for its site names the host (the resolved filter needs `GET_RESOLVED_FILTER`).
     */
    private fun isBrowserFilter(filter: IntentFilter?): Boolean {
        if (filter == null) return false
        val web = filter.hasDataScheme("http") || filter.hasDataScheme("https")
        return web && filter.countDataAuthorities() == 0
    }
}
