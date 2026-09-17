package app.zen.chromium

import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri
import android.view.View
import android.view.ViewGroup
import android.webkit.WebChromeClient
import android.widget.FrameLayout
import android.widget.Toast
import androidx.core.content.ContextCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import org.json.JSONObject

/**
 * What a custom tab's page reports into. The browser window's [Host] forwards everything to the
 * core in the chrome; a custom tab has no chrome, so the few things a page needs answered –
 * a permission prompt, a link that leaves the web, a download starting – are answered here with
 * native UI, and navigation and title changes go to the activity's toolbar. Popups navigate the
 * one page (`popupsAsTabs` is false), and the page script is not installed: there is no core to
 * talk to about Glance or third-party links.
 */
class CustomTabHost(
    override val activity: CustomTabActivity,
    container: FrameLayout,
    private val fullscreenLayer: FrameLayout,
    override val themeDark: Boolean
) : PageHost {
    override val pageScript = ""
    override val pageToken = ""
    override val keys = Keys()
    override val downloads = Downloads(activity, this)
    override val permissions = Permissions(this)
    override val externalProtocols = ExternalProtocols(this)
    override val snapshots = HistorySnapshots(activity)
    override val tabs = TabHost(container, this)
    override var fullscreenTab: TabWebView? = null
        private set
    /** The v2 sheet scrim (§1): black at 40 percent light, 55 dark, never tinted. */
    override val themeScrim: Int = ContextCompat.getColor(activity, if (themeDark) R.color.v2_scrim_dark else R.color.v2_scrim_light)
    override val popupsAsTabs = false

    /** Set by the activity once its views exist: back gestures read the page's history through it. */
    lateinit var back: PredictiveBack

    private var fullscreenCallback: WebChromeClient.CustomViewCallback? = null

    // --- what the page reports ----------------------------------------------------------------------

    override fun viewEvent(tabId: String, name: String, payload: Any?) {
        activity.onPageEvent(name, payload as? JSONObject)
    }

    override fun hostEvent(name: String, payload: Any?) {
        val args = payload as? JSONObject ?: JSONObject()
        when (name) {
            "permission.request" -> askPermission(args)
            "externalProtocol.request" -> askExternal(args)
            "download.started" -> Toast.makeText(
                activity, activity.getString(R.string.cct_downloading, args.str("filename")), Toast.LENGTH_SHORT
            ).show()
            // Download progress, crash reports and the like: the DownloadManager notification and
            // the page itself are the UI a custom tab has for them.
        }
    }

    override fun progress(tabId: String, percent: Int) = activity.onProgress(percent)

    override fun onKey(tabId: String?, input: JSONObject) {
        // No shortcut table without the core; the page keeps every key.
    }

    override fun backChanged() {
        if (::back.isInitialized) back.refresh()
    }

    override fun onPageTransitionEnded(transition: PageBackTransition) {
        if (::back.isInitialized) back.onPageTransitionEnded(transition)
    }

    // --- prompts ------------------------------------------------------------------------------------

    /**
     * A site asked for the camera, microphone or location. The browser window remembers the
     * answer per site through the core; a custom tab asks each time, like Chrome's does.
     */
    private fun askPermission(args: JSONObject) {
        val requestId = args.str("requestId")
        val what = when (args.str("permission")) {
            "camera" -> R.string.cct_permission_camera
            "microphone" -> R.string.cct_permission_microphone
            "media" -> R.string.cct_permission_media
            "geolocation" -> R.string.cct_permission_location
            "mediaKeySystem" -> R.string.cct_permission_protected_media
            else -> {
                permissions.respond(requestId, false)
                return
            }
        }
        val site = hostOf(args.str("url"))
        var answered = false
        val answer = { allow: Boolean -> if (!answered) { answered = true; permissions.respond(requestId, allow) } }
        MaterialAlertDialogBuilder(activity)
            .setTitle(activity.getString(R.string.cct_permission_message, site))
            .setMessage(activity.getString(what))
            .setPositiveButton(R.string.cct_allow) { _, _ -> answer(true) }
            .setNegativeButton(R.string.cct_block) { _, _ -> answer(false) }
            .setOnCancelListener { answer(false) }
            .show()
    }

    /**
     * A `mailto:`, `tel:`, `intent://` or a site's own app. Confirmed before it opens, as the
     * browser window's sheet does; with no app at all the request goes through so the link's
     * fallback (an `intent://`'s web address, a store listing, a toast) runs.
     */
    private fun askExternal(args: JSONObject) {
        val requestId = args.str("requestId")
        if (args.str("handler") == "none") {
            externalProtocols.respond(requestId, true)
            return
        }
        val appName = args.strOrNull("appName")
        var answered = false
        val answer = { allow: Boolean -> if (!answered) { answered = true; externalProtocols.respond(requestId, allow) } }
        MaterialAlertDialogBuilder(activity)
            .setTitle(
                if (appName != null) activity.getString(R.string.cct_open_in_app, appName)
                else activity.getString(R.string.cct_open_in_another_app)
            )
            .setMessage(args.str("url"))
            .setPositiveButton(R.string.cct_open) { _, _ -> answer(true) }
            .setNegativeButton(R.string.cct_not_now) { _, _ -> answer(false) }
            .setOnCancelListener { answer(false) }
            .show()
    }

    // --- fullscreen ---------------------------------------------------------------------------------

    override fun enterFullscreen(tab: TabWebView, view: View, callback: WebChromeClient.CustomViewCallback) {
        fullscreenTab?.let(::exitFullscreen)
        fullscreenTab = tab
        fullscreenCallback = callback
        fullscreenLayer.addView(view, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        fullscreenLayer.visibility = View.VISIBLE
        setSystemBarsHidden(true)
        backChanged()
    }

    override fun exitFullscreen(tab: TabWebView) {
        if (fullscreenTab !== tab) return
        fullscreenLayer.removeAllViews()
        fullscreenLayer.visibility = View.GONE
        fullscreenCallback?.onCustomViewHidden()
        fullscreenCallback = null
        fullscreenTab = null
        setSystemBarsHidden(false)
        backChanged()
    }

    private fun setSystemBarsHidden(hidden: Boolean) {
        val controller = WindowInsetsControllerCompat(activity.window, fullscreenLayer)
        controller.systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        if (hidden) controller.hide(WindowInsetsCompat.Type.systemBars()) else controller.show(WindowInsetsCompat.Type.systemBars())
    }

    // --- services -----------------------------------------------------------------------------------

    override fun openExternal(url: String) {
        val intent = runCatching {
            if (url.startsWith("intent:")) Intent.parseUri(url, Intent.URI_INTENT_SCHEME) else Intent(Intent.ACTION_VIEW, Uri.parse(url))
        }.getOrNull() ?: return
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        try {
            activity.startActivity(intent)
        } catch (e: ActivityNotFoundException) {
            Toast.makeText(activity, R.string.cct_no_app, Toast.LENGTH_SHORT).show()
        }
    }

    fun destroy() {
        tabs.destroyAll()
    }

    companion object {
        fun hostOf(url: String): String =
            runCatching { Uri.parse(url).host }.getOrNull()?.removePrefix("www.")?.ifEmpty { null } ?: url
    }
}
