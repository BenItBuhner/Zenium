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
import app.zen.chromium.blocking.Blocking
import app.zen.chromium.privacy.Privacy
import org.json.JSONObject

/**
 * What a custom tab's page reports into. The browser window's [Host] forwards everything to the
 * core in the chrome; a custom tab has no chrome, so the few things a page needs answered –
 * a permission prompt and the Open in <App>? confirmation of a link that leaves the web (both on
 * §9.23's native sheet, the forms the browser window asks them in), a download starting – are
 * answered here with native UI, and navigation and title changes go to the activity's toolbar.
 * Popups navigate the one page (`popupsAsTabs` is false), and the page script is not installed:
 * there is no core to talk to about Glance or third-party links.
 *
 * An installed web app's window ([WebAppActivity], PWA-07) is the same kind of host – one page,
 * no chrome, the browser's rules – so it is this class with the activity as its [Listener]; only
 * what it says of itself differs (`pageDialogs`: the app's `alert` / `confirm` / `prompt` are the
 * native prompt sheets, as in a tab of the browser, since the sheet needs no chrome).
 */
class CustomTabHost(
    override val activity: BrowserActivity,
    private val listener: Listener,
    container: FrameLayout,
    private val fullscreenLayer: FrameLayout,
    override val themeDark: Boolean,
    override val pageDialogs: Boolean = false
) : PageHost {
    /** The activity the one page reports to: its navigation, title and loading, and its progress. */
    interface Listener {
        /** What the page reports through [viewEvent]: `navigated`, `title`, `startLoading`, … */
        fun onPageEvent(name: String, payload: JSONObject?)
        fun onProgress(percent: Int)
        /**
         * A page element went fullscreen (`active`) or left it, the system bars hidden and shown
         * with it. A window that hides the bars on its own account (`display: fullscreen`) puts
         * them back out of sight after; a custom tab has nothing to do.
         */
        fun onFullscreenChanged(active: Boolean) {}
    }

    override val pageScript = ""
    override val pageToken = ""
    /** The browser's rule sets apply here too: same engine, same files under `zen/blocking/`. */
    override val blocking = Blocking.shared(activity)
    /** And the privacy policy the browser last applied (kept on disk for a process without the core). */
    override val privacy = Privacy.shared(activity)
    /** And the page fonts it last applied, the same way: a page here reads like the browser's (PageFonts). */
    override val pageFonts = PageFonts.load(Storage(activity))
    override val keys = Keys()
    override val downloads = Downloads(activity, this)
    override val permissions = Permissions(this)
    override val externalProtocols = ExternalProtocols(this)
    override val security = Security(this)
    override val snapshots = HistorySnapshots(activity)
    override val tabs = TabHost(container, this)
    override var fullscreenTab: TabWebView? = null
        private set
    /** The v2 sheet scrim (§1): black at 40 percent light, 55 dark, never tinted. */
    override val themeScrim: Int = ContextCompat.getColor(activity, if (themeDark) R.color.v2_scrim_dark else R.color.v2_scrim_light)
    override val popupsAsTabs = false

    /**
     * Desktop site (CCT-03), the menu's check row: a state of this tab alone, with no core to
     * remember it per site. The rules mirror it so every navigation keeps the shape the user
     * chose (a page switches its user agent by the rules on each load, `switchDesktopModeFor`),
     * and the page script lays the document out at the desktop width from the same word.
     */
    var desktopSite = false
        set(value) {
            field = value
            pageRules = PageRules(value, emptyMap(), false, emptyMap(), 1.0, emptyMap(), 1.0, false)
            pageRulesJson = JSONObject().put("desktop", JSONObject().put("default", value))
        }
    override var pageRules: PageRules = PageRules.NONE
        private set
    override var pageRulesJson: JSONObject = JSONObject()
        private set

    /** Set by the activity once its views exist: back gestures read the page's history through it. */
    lateinit var back: PredictiveBack

    private var fullscreenCallback: WebChromeClient.CustomViewCallback? = null

    // --- what the page reports ----------------------------------------------------------------------

    override fun viewEvent(tabId: String, name: String, payload: Any?) {
        listener.onPageEvent(name, payload as? JSONObject)
    }

    override fun hostEvent(name: String, payload: Any?) {
        val args = payload as? JSONObject ?: JSONObject()
        when (name) {
            "permission.request" -> askPermission(args)
            "externalProtocol.request" -> askExternal(args)
            // A custom tab has no sign-in dialog: the server's own 401 page shows instead.
            "auth.request" -> security.respondAuth(args.str("requestId"), null, null)
            "download.started" -> downloadStarted(args)
            "download.done" -> downloadDone(args)
            "download.action" -> downloadAction(args)
            // A word the host has for the user (the file chooser's camera refused, OS-22): a
            // custom tab has no message cards, so it is the system's toast, as its other words
            // are; the card's Open settings action has no place on one and is left out.
            "toast" -> args.strOrNull("message")?.takeIf { it.isNotEmpty() }?.let { Toast.makeText(activity, it, Toast.LENGTH_LONG).show() }
            // Download progress, crash reports and the like: the downloader's notification and
            // the page itself are the UI a custom tab has for them.
        }
    }

    override fun progress(tabId: String, percent: Int) = listener.onProgress(percent)

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

    /** The permission asks of this window: the one on the sheet and the ones waiting behind it. */
    private val permissionAsks = CustomTabPermissionPrompt.Queue()
    /** The sheet while it is up, so the window's end takes it down without an answer. */
    private var permissionPrompt: PermissionPromptSheet? = null

    /**
     * A site asked for the camera, microphone or location. The browser window remembers the
     * answer per site through the core; a custom tab asks each time, like Chrome's does – on
     * §9.23's native prompt sheet ([PermissionPromptSheet], the one chassis the installed app's
     * window asks with too), in this tab's scheme ([themeDark]: the caller's colour scheme, else
     * the system's), the family's question naming the site ("Allow <host> to know your
     * location?") and §9.11's pair Block | Allow with Allow the accent primary (§9.29).
     *
     * Allow grants THIS request, Block refuses it; a dismissal (the scrim, the system back, the
     * grabber) refuses it too, exactly as the dialog's cancel did – there is no core here, so no
     * site decision is written and nothing is remembered either way: the page's next request asks
     * again. One sheet per window at a time: a request arriving while one is up waits behind it,
     * or shares its answer when it asks the same question of the same site
     * ([CustomTabPermissionPrompt.Queue]). A window on its way out asks nothing.
     */
    private fun askPermission(args: JSONObject) {
        val requestId = args.str("requestId")
        val question = CustomTabPermissionPrompt.questionFor(args.str("permission"))
        if (question == null || activity.isFinishing || activity.isDestroyed) {
            permissions.respond(requestId, false)
            return
        }
        if (permissionAsks.add(requestId, question, hostOf(args.str("url")))) showPermissionPrompt()
    }

    /** The sheet for the current ask; its answer settles the ask and brings up the next one waiting. */
    private fun showPermissionPrompt() {
        val ask = permissionAsks.current ?: return
        var answered = false
        val sheet = PermissionPromptSheet(
            activity,
            themeDark,
            requester = ask.site,
            question = ask.question,
            block = activity.getString(R.string.cct_block),
            allow = NativePromptSheet.Peer(activity.getString(R.string.cct_allow), NativePromptSheet.Tone.ACCENT)
        ) { answer ->
            if (answered) return@PermissionPromptSheet
            answered = true
            permissionPrompt = null
            // ALLOWED grants; BLOCKED and DISMISSED both refuse this request and remember nothing.
            val allow = answer == PermissionPromptSheet.Answer.ALLOWED
            permissionAsks.settle()
            for (id in ask.requestIds) permissions.respond(id, allow)
            if (!activity.isFinishing && !activity.isDestroyed) showPermissionPrompt()
        }
        permissionPrompt = sheet
        sheet.show()
    }

    /** The Open in <App>? sheet while it is up, and the request it asks about; the window's end takes it down without an answer. */
    private var externalPrompt: NativePromptSheet? = null
    private var externalRequestId: String? = null

    /**
     * A `mailto:`, `tel:`, `intent://` or a site's own app. Confirmed before it opens, as the
     * browser window's sheet does – in ITS form, on §9.23's native chassis ([NativePromptSheet];
     * [CustomTabOpenInAppPrompt] has the browser sheet's words): "Open in <App>?" over its
     * sentence and the decoded address on a line of its own, Not now | Open with Open the accent
     * primary, in this tab's scheme. Open lets the request go; Not now, the scrim's tap and the
     * system back refuse it, and nothing is remembered – no core here to remember a scheme with,
     * so no Always open row: every ask is answered for itself. With no app at all the request
     * goes through unasked so the link's fallback (an `intent://`'s web address, a store listing,
     * a toast) runs. One question per window, the core's rule: a newer request under a tap takes
     * the sheet over (the one it replaces answered `false`), one without a tap is refused – a
     * script firing on its own does not get to replace the question the user is reading.
     */
    private fun askExternal(args: JSONObject) {
        val requestId = args.str("requestId")
        if (args.str("handler") == "none") {
            externalProtocols.respond(requestId, true)
            return
        }
        if (activity.isFinishing || activity.isDestroyed) {
            externalProtocols.respond(requestId, false)
            return
        }
        externalRequestId?.let { standing ->
            if (!args.optBoolean("userGesture", false)) {
                externalProtocols.respond(requestId, false)
                return
            }
            externalPrompt?.dismiss()
            externalPrompt = null
            externalRequestId = null
            externalProtocols.respond(standing, false)
        }
        val url = args.str("url")
        val appName = args.strOrNull("appName")
        val scheme = CustomTabOpenInAppPrompt.schemeOf(url)
        val site = CustomTabOpenInAppPrompt.siteOf(tabs.get(args.str("tabId"))?.url)
        val title = if (appName != null) activity.getString(R.string.cct_open_in_app, appName) else activity.getString(R.string.cct_open_in_another_app)
        val description = if (CustomTabOpenInAppPrompt.isWeb(scheme)) {
            // A site's own app offering to open a page that loads regardless: the sentence says so.
            if (appName != null) activity.getString(R.string.cct_open_link_also_in_app, appName) else activity.getString(R.string.cct_open_link_also_in_an_app)
        } else {
            val obj = CustomTabOpenInAppPrompt.objectFor(scheme)?.let(activity::getString) ?: activity.getString(R.string.cct_open_object_other, scheme)
            activity.getString(R.string.cct_open_wants, site.ifEmpty { activity.getString(R.string.cct_this_page) }, obj)
        }
        var answered = false
        val sheet = NativePromptSheet(
            activity,
            V2Ink(activity, themeDark),
            NativePromptSheet.Content(
                title = title,
                description = description,
                detail = CustomTabOpenInAppPrompt.displayAddress(url),
                detailName = url,
                titleOneLine = true,
                secondary = activity.getString(R.string.cct_not_now),
                primary = NativePromptSheet.Peer(activity.getString(R.string.cct_open), NativePromptSheet.Tone.ACCENT)
            )
        ) { answer ->
            if (answered) return@NativePromptSheet
            answered = true
            if (externalRequestId == requestId) {
                externalPrompt = null
                externalRequestId = null
            }
            // Open lets the request go; Not now, the scrim and the system back refuse it, and nothing is remembered.
            externalProtocols.respond(requestId, answer.accepted)
        }
        externalPrompt = sheet
        externalRequestId = requestId
        sheet.show()
    }

    // --- downloads ----------------------------------------------------------------------------------

    /**
     * The downloader announces a transfer and waits for a record to bind it to; in the browser
     * window the core keeps that record and picks the destination. A custom tab has no core, so
     * the transfer is bound here at once – to the default download folder, under its token as the
     * id – and runs with the downloader's notification, whose Pause, Resume and Cancel come back
     * as `download.action`. What the downloader reported is kept per id, so a finished file can
     * be published under its final name and an interrupted one resumed from its partial file.
     */
    private val downloadRecords = HashMap<String, JSONObject>()
    private val downloadIdByToken = HashMap<String, String>()

    private fun downloadStarted(args: JSONObject) {
        Toast.makeText(activity, activity.getString(R.string.cct_downloading, args.str("filename")), Toast.LENGTH_SHORT).show()
        val token = args.str("token")
        // A resumed transfer reports under a new token but keeps its id; it is bound already.
        val resumes = args.strOrNull("resumes")
        val id = resumes ?: token
        downloadIdByToken[token] = id
        val record = downloadRecords.getOrPut(id) { json("id" to id, "private" to false) }
        for (key in listOf("url", "referrer", "filename", "mimeType", "containerId")) record.put(key, args.str(key))
        record.put("totalBytes", args.num("totalBytes"))
        if (resumes == null) downloads.bind(token, id, json("mode" to "default"), false)
    }

    private fun downloadDone(args: JSONObject) {
        val id = downloadIdByToken.remove(args.str("token")) ?: return
        val record = downloadRecords[id] ?: return
        when {
            args.str("state") == "completed" -> {
                downloadRecords.remove(id)
                downloads.release(
                    json(
                        "id" to id, "url" to record.str("url"), "referrer" to record.str("referrer"),
                        "savePath" to args.str("savePath"), "filename" to args.str("filename"),
                        "finalName" to args.str("finalName"), "mimeType" to args.str("mimeType"),
                        "private" to false, "notify" to true
                    )
                ) {}
            }
            args.str("state") == "interrupted" && args.bool("canResume") -> {
                record.put("savePath", args.str("savePath"))
                record.put("finalName", args.str("finalName"))
                record.put("totalBytes", args.num("totalBytes"))
            }
            // Chrome's mixed-content rule refused the chain; without the core's row there is no
            // Keep anyway here, only the word (the browser window offers it).
            args.str("state") == "insecure-blocked" -> {
                downloadRecords.remove(id)
                Toast.makeText(activity, activity.getString(R.string.cct_download_insecure, args.str("filename")), Toast.LENGTH_LONG).show()
            }
            else -> downloadRecords.remove(id)
        }
    }

    private fun downloadAction(args: JSONObject) {
        val id = args.str("id")
        // Every window's downloader hears every notification action; only ours are answered here.
        val record = downloadRecords[id] ?: return
        when (args.str("op")) {
            "pause" -> downloads.pause(id)
            "resume" -> downloads.resume(record)
            "cancel" -> if (downloadIdByToken.containsValue(id)) downloads.cancel(id) else {
                downloadRecords.remove(id)
                downloads.discard(record) {}
            }
        }
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
        listener.onFullscreenChanged(true)
    }

    override fun exitFullscreen(tab: TabWebView) {
        if (fullscreenTab !== tab) return
        fullscreenLayer.removeAllViews()
        fullscreenLayer.visibility = View.GONE
        fullscreenCallback?.onCustomViewHidden()
        fullscreenCallback = null
        fullscreenTab = null
        // The page draws in its own view again ([TabWebView.onDraw] drew nothing under the layer).
        tab.invalidate()
        setSystemBarsHidden(false)
        backChanged()
        listener.onFullscreenChanged(false)
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
        // The sheets go with the window, without an answer; the page they asked for is going too.
        permissionPrompt?.dismiss()
        permissionPrompt = null
        permissionAsks.clear()
        externalPrompt?.dismiss()
        externalPrompt = null
        externalRequestId = null
        security.shutdown()
        tabs.destroyAll()
        downloads.destroy()
    }

    companion object {
        fun hostOf(url: String): String =
            runCatching { Uri.parse(url).host }.getOrNull()?.removePrefix("www.")?.ifEmpty { null } ?: url
    }
}
