package app.zen.chromium

import android.app.PendingIntent
import android.app.SearchManager
import android.content.ActivityNotFoundException
import android.content.BroadcastReceiver
import android.content.ClipData
import android.content.ClipboardManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.IntentSender
import android.content.pm.PackageManager
import android.content.pm.ResolveInfo
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Rect
import android.graphics.drawable.Drawable
import android.graphics.drawable.Icon
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.service.chooser.ChooserAction
import android.text.Layout
import android.text.StaticLayout
import android.text.TextPaint
import android.text.TextUtils
import android.util.Base64
import android.util.TypedValue
import android.webkit.CookieManager
import androidx.annotation.RequiresApi
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import androidx.core.content.IntentCompat
import com.google.zxing.common.BitMatrix
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executor
import kotlin.math.roundToInt

/**
 * Both directions of sharing. Out: the core's `app.share` becomes the system share sheet with a
 * link preview (title and favicon), Zenium's own action row on Android 14 (Copy link, QR code,
 * Long screenshot, Print; [browserRow]), or an image handed over as a file; below Android 14 the browser's own
 * shares go to Zenium's share panel in the chrome instead (SH-03, [openPanel]). In: another
 * app's `ACTION_SEND` or `ACTION_WEB_SEARCH` is described to the core, which routes it to a tab,
 * a search with the user's engine, or an image page.
 */
class Share(private val host: Host, private val io: Executor) {
    private val activity get() = host.activity
    private val main = Handler(Looper.getMainLooper())

    // --- out: the share sheet ----------------------------------------------------------------------

    /**
     * `app.share`: a link, text, an image (`imageUrl`) or a page's files (`files`, SH-14) onto the
     * system sheet. Text and a link both present go as one message, the link on its own line
     * (Chrome's Web Share does the same; a selection's share carries the text and its link to the
     * highlight, SH-11). With `awaitOutcome` the answer waits for the sheet to close and says how
     * it ended – `shared` or `aborted` – for a page's `navigator.share` promise (see [Outcome]);
     * without it the answer comes as soon as the sheet is up.
     */
    fun share(args: JSONObject, reply: (Any?) -> Unit) {
        val title = args.strOrNull("title")?.trim()?.ifEmpty { null }
        val url = args.strOrNull("url")?.trim()?.ifEmpty { null }
        val text = args.strOrNull("text")?.trim()?.ifEmpty { null }
        val imageUrl = args.strOrNull("imageUrl")?.trim()?.ifEmpty { null }
        val tabId = args.strOrNull("tabId")
        val favicon = args.strOrNull("favicon")?.ifEmpty { null }
        val files = args.optJSONArray("files")?.takeIf { it.length() > 0 }
        val awaitOutcome = args.optBoolean("awaitOutcome")
        val body = messageBody(text, url)
        when {
            files != null -> shareFiles(files, title, body, tabId, awaitOutcome, reply)
            imageUrl != null -> shareImage(imageUrl, title, tabId, reply)
            body != null -> shareText(title, text, body, url, favicon, tabId, awaitOutcome, reply)
            else -> reply(Host.Rejection("nothing to share"))
        }
    }

    /**
     * A link (or plain text). `EXTRA_TITLE` and a `ClipData` thumbnail are what the sharesheet
     * shows as the preview on Android 10+; the favicon is written to the cache so the sheet can
     * read it through the FileProvider. Below Android 14 the share goes to the panel instead, as a
     * link's or a selection's ([panelStandsIn]) – a page's awaited one too, the panel then holding
     * the page's promise until it is answered.
     */
    private fun shareText(title: String?, text: String?, body: String, url: String?, favicon: String?, tabId: String?, awaitOutcome: Boolean, reply: (Any?) -> Unit) {
        io.execute {
            val thumbnail = favicon?.let { runCatching { cacheImage(it, "favicon", null) }.getOrNull() }
            main.post {
                val send = Intent(Intent.ACTION_SEND).apply {
                    type = "text/plain"
                    putExtra(Intent.EXTRA_TEXT, body)
                    if (title != null) {
                        putExtra(Intent.EXTRA_SUBJECT, title)
                        putExtra(Intent.EXTRA_TITLE, title)
                    }
                    if (thumbnail != null) {
                        clipData = ClipData.newUri(activity.contentResolver, title ?: "Zenium", thumbnail)
                        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                    }
                }
                if (panelStandsIn()) {
                    val kind = if (text == null) PANEL_LINK else PANEL_TEXT
                    openPanel(send, ShareHistory.TYPE_TEXT, panelPreview(kind, title, url, text, favicon, null, awaitOutcome), url, tabId, awaitOutcome, reply)
                } else {
                    launchChooser(send, url, tabId, reply, awaitOutcome)
                }
            }
        }
    }

    /**
     * A page's files (`navigator.share({ files })`): each written to the cache under its own name
     * (`spillFiles`, unless the page-message path did it already and left a `uri`), then one
     * `ACTION_SEND` – or `ACTION_SEND_MULTIPLE` – with the files as streams under their common
     * type, the message (text, link) beside them. A file that cannot be written drops the share.
     */
    private fun shareFiles(files: JSONArray, title: String?, body: String?, tabId: String?, awaitOutcome: Boolean, reply: (Any?) -> Unit) {
        io.execute {
            val spilled = runCatching { spillFiles(files) }.getOrNull()
            main.post {
                if (spilled == null || spilled.length() == 0) {
                    reply(Host.Rejection("the files could not be prepared"))
                    return@post
                }
                val uris = ArrayList<Uri>()
                val types = ArrayList<String>()
                for (i in 0 until spilled.length()) {
                    val file = spilled.getJSONObject(i)
                    uris += Uri.parse(file.str("uri"))
                    types += file.str("type").ifEmpty { activity.contentResolver.getType(uris.last()) ?: "application/octet-stream" }
                }
                val send = Intent(if (uris.size == 1) Intent.ACTION_SEND else Intent.ACTION_SEND_MULTIPLE).apply {
                    type = commonMimeType(types)
                    if (uris.size == 1) putExtra(Intent.EXTRA_STREAM, uris[0]) else putParcelableArrayListExtra(Intent.EXTRA_STREAM, uris)
                    if (body != null) putExtra(Intent.EXTRA_TEXT, body)
                    if (title != null) {
                        putExtra(Intent.EXTRA_SUBJECT, title)
                        putExtra(Intent.EXTRA_TITLE, title)
                    }
                    val clip = ClipData.newUri(activity.contentResolver, title ?: "Files", uris[0])
                    for (i in 1 until uris.size) clip.addItem(ClipData.Item(uris[i]))
                    clipData = clip
                    addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                }
                launchChooser(send, null, tabId, reply, awaitOutcome)
            }
        }
    }

    /**
     * A page's share message on its way to the core (`TabWebView.onPageMessage`, SH-14): its
     * files' bytes (`data`, base64) written to the cache here, each replaced by the file's
     * `content:` address (`uri`), so the bytes cross into the chrome once, not as a string
     * through the core and back. Off the main thread; `then` on it, with the message as it
     * stands – unchanged when there are no files or the write failed (the core's checks refuse a
     * file left without either, and the page hears `aborted`).
     */
    fun spillPageShare(message: JSONObject, then: (JSONObject) -> Unit) {
        val files = message.optJSONObject("share")?.optJSONArray("files")?.takeIf { it.length() > 0 }
        if (files == null) {
            then(message)
            return
        }
        io.execute {
            val spilled = runCatching { spillFiles(files) }.getOrNull()
            main.post {
                if (spilled != null) message.getJSONObject("share").put("files", spilled)
                then(message)
            }
        }
    }

    /**
     * The files of a share call as files of Zenium's own: `[{ name, type, size, data | uri }]` →
     * the same with `uri` alone, the bytes decoded into `cache/share/<share>/<name>` behind the
     * FileProvider (a folder per share keeps the pages' own names, which the target reads). IO thread.
     */
    fun spillFiles(files: JSONArray): JSONArray {
        val dir = File(File(activity.cacheDir, "share"), "p${System.currentTimeMillis()}-${(Math.random() * 1_000_000).toInt()}").apply { mkdirs() }
        val out = JSONArray()
        val taken = HashSet<String>()
        for (i in 0 until files.length()) {
            val file = files.getJSONObject(i)
            val name = safeFileName(file.strOrNull("name"), file.str("type"), taken)
            val type = file.str("type")
            val uri = file.strOrNull("uri")?.ifEmpty { null } ?: run {
                val data = file.strOrNull("data") ?: throw IllegalStateException("a file without bytes")
                val target = File(dir, name)
                target.writeBytes(Base64.decode(data, Base64.DEFAULT))
                FileProvider.getUriForFile(activity, "${activity.packageName}.files", target).toString()
            }
            out.put(json("name" to name, "type" to type, "size" to file.optLong("size"), "uri" to uri))
        }
        return out
    }

    /**
     * An image as a file: fetched with the tab's cookies (or decoded from a `data:` URL) into the
     * cache. Below Android 14 it goes to the panel, with a small copy of itself for the preview.
     */
    private fun shareImage(imageUrl: String, title: String?, tabId: String?, reply: (Any?) -> Unit) {
        val userAgent = tabId?.let { host.tabs.get(it) }?.settings?.userAgentString
        io.execute {
            val file = runCatching { cacheImage(imageUrl, "image", userAgent) }.getOrNull()
            val preview = if (file != null && panelStandsIn()) runCatching { previewDataUrl(file) }.getOrNull() else null
            main.post {
                if (file == null) {
                    reply(Host.Rejection("the image could not be downloaded"))
                    return@post
                }
                val mime = activity.contentResolver.getType(file) ?: "image/*"
                val send = Intent(Intent.ACTION_SEND).apply {
                    type = mime
                    putExtra(Intent.EXTRA_STREAM, file)
                    if (title != null) putExtra(Intent.EXTRA_TITLE, title)
                    clipData = ClipData.newUri(activity.contentResolver, title ?: "Image", file)
                    addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                }
                if (panelStandsIn()) openPanel(send, ShareHistory.TYPE_IMAGE, panelPreview(PANEL_IMAGE, title, null, null, null, preview, false), null, tabId, false, reply)
                else launchChooser(send, null, tabId, reply)
            }
        }
    }

    /**
     * The system sheet for `send`. Zenium's own action row (Android 14) goes with a link of the
     * browser's own (`url`); a page's awaited share gets the plain sheet – a Copy link there would
     * end the page's promise as a dismissal. With `awaitOutcome` the sheet is started for a
     * result and told to report the chosen target ([Outcome]); the reply is `shared` or `aborted`.
     */
    fun launchChooser(send: Intent, url: String?, tabId: String?, reply: (Any?) -> Unit, awaitOutcome: Boolean = false) {
        val outcome = if (awaitOutcome) Outcome(reply) else null
        val chooser = if (outcome != null) Intent.createChooser(send, null, outcome.sender()) else Intent.createChooser(send, null)
        // Zenium is a share target itself; sharing from it to it is never what the tap meant.
        chooser.putExtra(Intent.EXTRA_EXCLUDE_COMPONENTS, arrayOf(ComponentName(activity, MainActivity::class.java)))
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE && url != null && outcome == null) {
            chooser.putExtra(Intent.EXTRA_CHOOSER_CUSTOM_ACTIONS, browserActions(url, tabId).toTypedArray())
        }
        try {
            if (outcome != null) {
                pending?.settle(SHARE_ABORTED)
                pending = outcome
                outcome.register()
                if (!activity.launchChooserForResult(chooser, outcome::onReturned)) throw IllegalStateException("the share sheet could not be opened")
            } else {
                activity.startActivity(chooser)
                reply(null)
            }
        } catch (e: Exception) {
            pending?.takeIf { it === outcome }?.let { pending = null }
            outcome?.unregister()
            reply(Host.Rejection(e.message ?: "the share sheet could not be opened"))
        }
    }

    /** The one awaited share on the sheet (a second call supersedes it: its page hears `aborted`). */
    private var pending: Outcome? = null

    /**
     * How an awaited share ends. The chooser reports a chosen target through the `IntentSender`
     * it was given (a broadcast back into this process; immutable – the chosen component is not
     * needed, that it fired is) and finishes either way, so the activity's result alone cannot
     * tell a share from a dismissal. The two arrive in no fixed order: a report settles `shared`
     * once the sheet has returned, a return waits [CHOSEN_GRACE_MS] for a report before settling
     * `aborted`. Settled once; the receiver goes with it.
     */
    private inner class Outcome(private val reply: (Any?) -> Unit) {
        private var chosen = false
        private var returned = false
        private var settled = false
        private val grace = Runnable { settle(if (chosen) SHARE_SHARED else SHARE_ABORTED) }
        private val receiver = object : BroadcastReceiver() {
            override fun onReceive(context: Context, intent: Intent) {
                chosen = true
                if (returned) settle(SHARE_SHARED)
            }
        }

        fun sender(): IntentSender {
            val intent = Intent(ACTION_CHOSEN).setPackage(activity.packageName)
            return PendingIntent.getBroadcast(activity, 0, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE).intentSender
        }

        fun register() {
            ContextCompat.registerReceiver(activity, receiver, IntentFilter(ACTION_CHOSEN), ContextCompat.RECEIVER_NOT_EXPORTED)
        }

        fun unregister() {
            runCatching { activity.unregisterReceiver(receiver) }
        }

        /** The chooser activity finished (a target taken, or the sheet dismissed). */
        fun onReturned() {
            returned = true
            if (chosen) settle(SHARE_SHARED) else main.postDelayed(grace, CHOSEN_GRACE_MS)
        }

        fun settle(result: String) {
            if (settled) return
            settled = true
            main.removeCallbacks(grace)
            unregister()
            if (pending === this) pending = null
            reply(result)
        }
    }


    /**
     * Android 14's row of the sharing app's own actions ([browserRow]). Each is a `PendingIntent`
     * back into `MainActivity` (single task, so it arrives as a new intent) naming the action and
     * the link.
     */
    @RequiresApi(Build.VERSION_CODES.UPSIDE_DOWN_CAKE)
    private fun browserActions(url: String, tabId: String?): List<ChooserAction> =
        browserRow(withTab = tabId != null).map { row ->
            val intent = Intent(activity, MainActivity::class.java)
                .setAction(ACTION_BROWSER_ACTION)
                .putExtra(EXTRA_KIND, row.kind)
                .putExtra(EXTRA_URL, url)
                .putExtra(EXTRA_TAB_ID, tabId)
            // One request code per action keeps the four apart; the URL is updated in place.
            val pending = PendingIntent.getActivity(
                activity, row.kind.hashCode(), intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            )
            ChooserAction.Builder(Icon.createWithResource(activity, row.icon), row.label, pending).build()
        }

    /** One of the action row's buttons was tapped (the sheet has closed and Zenium is back). */
    fun onBrowserAction(intent: Intent) {
        val kind = intent.getStringExtra(EXTRA_KIND) ?: return
        val url = intent.getStringExtra(EXTRA_URL) ?: return
        val tabId = intent.getStringExtra(EXTRA_TAB_ID)
        if (kind == KIND_QR) {
            showQrCode(url, tabId)
            return
        }
        val event = json("kind" to kind, "url" to url, "tabId" to tabId)
        // The long screenshot stitches the page out of the window, so it wants the page back on
        // screen first: the sheet is still on its way out.
        if (kind == KIND_LONG_SCREENSHOT) main.postDelayed({ host.chrome.hostEvent("share.action", event) }, SCREENSHOT_DELAY_MS)
        else host.chrome.hostEvent("share.action", event)
    }

    // --- the share panel (below Android 14; SH-03) --------------------------------------------------

    /**
     * Below Android 14 the system sheet has no row for the sharing app's own actions
     * (`EXTRA_CHOOSER_CUSTOM_ACTIONS` is 14's), so the browser's own shares go to Zenium's panel
     * in the chrome, as Chrome 152's sharing hub stands in for the system sheet there
     * (`ShareDelegateImpl.isSharingHubEnabled`: not a custom tab, below 14): the share's preview,
     * the apps the user shares to, Zenium's own chips, and More for the system sheet. A page's
     * awaited share (`navigator.share`) takes the same fork, as it does in Chrome (a Web Share
     * goes through `ShareDelegateImpl.share` like the menu's): the panel then holds the page's
     * promise until it is answered ([Panel.awaited]). A page's files keep the system sheet, as
     * Chrome's do. Android 14 and later keep the system sheet as it is.
     */
    private fun panelStandsIn(): Boolean = panelStandsIn(Build.VERSION.SDK_INT, files = false)

    /**
     * A share the panel is showing: its intent, kept for the chrome's answer, and the `app.share`
     * call still waiting on it. The browser's own share is answered once the chrome has the
     * request, or [PANEL_CANCELLED] when a fresh share supersedes it first. A page's [awaited]
     * share is answered as Chrome answers a Web Share's promise from its hub
     * (`ShareParams.TargetChosenCallback`): [SHARE_SHARED] once an app has the share, once
     * one of the browser's own chips ran (Chrome's `callTargetChosenCallback()` on a first-party
     * tap), or as the system sheet ends after More; [SHARE_ABORTED] on a dismissal, an app that
     * could not be started, or a fresh share superseding it. Answered once; later answers are nothing.
     */
    private class Panel(val send: Intent, val type: String, val url: String?, val tabId: String?, val private: Boolean, val awaited: Boolean, reply: (Any?) -> Unit) {
        private var pending: ((Any?) -> Unit)? = reply

        fun answer(result: Any?) {
            val reply = pending ?: return
            pending = null
            reply(result)
        }

        /**
         * The chrome's action on the panel, as the `app.share` call hears it: a page's awaited
         * share gets [awaitedPanelAnswer]'s word (none for More, whose word is the system sheet's);
         * the browser's own was answered at the event and hears nothing more.
         */
        fun settle(kind: String, started: Boolean = true) {
            if (awaited) awaitedPanelAnswer(kind, started)?.let { answer(it) } else answer(null)
        }

        /** The answer when the panel goes without a share: nothing for the browser's own, `aborted` for a page's. */
        fun release() = settle("dismiss")
    }

    /** One app of the panel's row. */
    class PanelTarget(val component: String, val label: String, val icon: String)

    /**
     * The row's launcher icons as the panel draws them, kept per component and size: an icon
     * through `loadIcon`, a canvas and WebP costs some 150–250 ms each on the emulator, so a row
     * of seven drawn per open held the host's gather at 1.0–1.6 s; drawn once, a later open
     * gathers in the time it takes to rank. Emptied when a package was installed, updated or
     * removed since the last look (`PackageManager.getChangedPackages`, API 26), so an updated
     * app's new icon comes through at its next share. Read on the IO executor; synchronised.
     */
    private class IconCache {
        private val icons = HashMap<String, String>()
        private var sequence = 0

        /** Drop every icon when the installed packages changed since the last call. */
        @Synchronized
        fun refresh(pm: PackageManager) {
            val changed = runCatching { pm.getChangedPackages(sequence) }.getOrNull() ?: return
            icons.clear()
            sequence = changed.sequenceNumber
        }

        @Synchronized
        fun icon(component: String, side: Int, draw: () -> String): String = icons.getOrPut("$component@$side", draw)
    }

    private var panelSeq = 0
    /** The one panel up (a new share supersedes it: its chrome sheet is replaced, its call answered). */
    private var panel: Pair<String, Panel>? = null
    private val history by lazy { ShareHistory(PrefsStore(activity.getSharedPreferences(PANEL_PREFS, Context.MODE_PRIVATE))) }
    private val icons = IconCache()

    /**
     * The preview the panel draws: what is shared, as the chrome shows it at the sheet's head,
     * and where the share came from – the browser's menu (`menu`) or a page's `navigator.share`
     * (`page`), which decides the chrome's chips (a page's share is not the page: no Long
     * screenshot, no Print).
     */
    private fun panelPreview(kind: String, title: String?, url: String?, text: String?, favicon: String?, image: String?, fromPage: Boolean): JSONObject =
        json("kind" to kind, "title" to title, "url" to url, "text" to text, "favicon" to favicon, "image" to image, "source" to if (fromPage) PANEL_SOURCE_PAGE else PANEL_SOURCE_MENU)

    /**
     * Put the panel up for `send`: the intent is held under the panel's id, the apps for its type
     * are found and ranked off the main thread, and the chrome hears `share.panel` with the
     * preview, the tab, whether it is private (nothing is recorded then) and the row. The answer
     * to `app.share` comes as the event is sent, as it does when the system sheet is up – unless
     * the share is a page's `awaited` one, whose answer is the panel's outcome ([Panel]). A panel
     * still up – or still gathering its row – is superseded: the chrome replaces its sheet under
     * the new id, and its own call is answered [PANEL_CANCELLED] (a page's: `aborted`) rather
     * than left waiting.
     */
    private fun openPanel(send: Intent, type: String, preview: JSONObject, url: String?, tabId: String?, awaited: Boolean, reply: (Any?) -> Unit) {
        val id = "share-panel-${++panelSeq}"
        val private = tabId?.let { host.tabs.get(it) }?.let { Profiles.isPrivate(it.containerId) } == true
        panel?.second?.let { if (it.awaited) it.answer(SHARE_ABORTED) else it.answer(PANEL_CANCELLED) }
        val entry = Panel(send, type, url, tabId, private, awaited, reply)
        panel = id to entry
        io.execute {
            val targets = runCatching { panelTargets(send.type, type) }.getOrElse { emptyList() }
            main.post {
                if (panel?.first != id) return@post
                val row = JSONArray()
                for (target in targets) row.put(json("component" to target.component, "label" to target.label, "icon" to target.icon))
                val payload = JSONObject(preview.toString()).put("id", id).put("tabId", tabId).put("private", private).put("targets", row)
                host.chrome.hostEvent("share.panel", payload)
                if (!awaited) entry.answer(null)
            }
        }
    }

    /**
     * The apps that take an `ACTION_SEND` of `mime` (the manifest's `<queries>` make them visible
     * on API 30+), Zenium and the CTS shims left out, sorted by package name as Chrome sorts them
     * (`ShareSheetUsageRankingHelper.ResolveInfoPackageNameComparator`), ranked by Zenium's own
     * history for the share's type, at most [MAX_PANEL_TARGETS] (Chrome's `MAX_NUM_APPS`), each
     * with its launcher icon drawn at the row's [PANEL_ICON_DP] as a `data:` URL – once per
     * component and size ([IconCache]). IO thread.
     */
    fun panelTargets(mime: String?, type: String): List<PanelTarget> {
        val pm = activity.packageManager
        val probe = Intent(Intent.ACTION_SEND).setType(mime ?: "text/plain")
        val byComponent = LinkedHashMap<String, ResolveInfo>()
        for (info in resolveSendTargets(pm, probe).sortedBy { it.activityInfo.packageName }) {
            val activityInfo = info.activityInfo ?: continue
            if (activityInfo.packageName == activity.packageName || activityInfo.packageName in PANEL_BLOCKED_PACKAGES) continue
            if (!activityInfo.exported) continue
            byComponent[ComponentName(activityInfo.packageName, activityInfo.name).flattenToString()] = info
        }
        icons.refresh(pm)
        val side = (PANEL_ICON_DP * activity.resources.displayMetrics.density).roundToInt()
        return history.rank(type, byComponent.keys.toList()).take(MAX_PANEL_TARGETS).map { component ->
            val info = byComponent.getValue(component)
            PanelTarget(component, info.loadLabel(pm).toString(), icons.icon(component, side) { iconDataUrl(info.loadIcon(pm), side) })
        }
    }

    @Suppress("DEPRECATION")
    private fun resolveSendTargets(pm: PackageManager, probe: Intent): List<ResolveInfo> =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            pm.queryIntentActivities(probe, PackageManager.ResolveInfoFlags.of(PackageManager.MATCH_DEFAULT_ONLY.toLong()))
        } else {
            pm.queryIntentActivities(probe, PackageManager.MATCH_DEFAULT_ONLY)
        }

    /**
     * The chrome's answer to the panel (`share.panelAction`): an app gets the same intent direct
     * to its component, as Chrome sends it (`ShareHelper.shareDirectly`: `setComponent`,
     * `FLAG_ACTIVITY_FORWARD_RESULT | FLAG_ACTIVITY_PREVIOUS_IS_TOP`), and the choice is recorded
     * unless the tab was private (`ShareHistory.record` writes nothing for one); More gets the
     * system sheet; QR the code dialog; Copy image the image on the clipboard; a dismissal
     * releases the intent. The chrome's own chips (Copy link, Copy text, Long screenshot, Print)
     * run in the chrome and end here as `chip`. A page's awaited share is answered by the action
     * ([Panel]): an app started, a chip, QR or Copy image → `shared`; More → the system sheet's
     * own outcome; a dismissal or an app that would not start → `aborted`. What the user is told
     * goes through the chrome's toast.
     */
    fun onPanelAction(args: JSONObject, reply: (Any?) -> Unit) {
        val id = args.str("id")
        val current = panel
        if (current == null || current.first != id) {
            reply(null)
            return
        }
        panel = null
        val entry = current.second
        when (args.str("kind")) {
            "target" -> {
                val flat = args.str("component")
                val component = ComponentName.unflattenFromString(flat)
                if (component == null) {
                    entry.settle("target", started = false)
                    reply(Host.Rejection("no such app"))
                    return
                }
                val direct = Intent(entry.send).setComponent(component)
                    .addFlags(Intent.FLAG_ACTIVITY_FORWARD_RESULT or Intent.FLAG_ACTIVITY_PREVIOUS_IS_TOP)
                try {
                    activity.startActivity(direct)
                    io.execute { history.record(entry.type, flat, entry.private) }
                    entry.settle("target")
                } catch (e: ActivityNotFoundException) {
                    toast("That app is no longer installed")
                    io.execute { history.forget(flat) }
                    entry.settle("target", started = false)
                } catch (e: SecurityException) {
                    toast("That app could not be opened")
                    entry.settle("target", started = false)
                }
            }
            "more" -> launchChooser(entry.send, entry.url, entry.tabId, { result ->
                if (result is Host.Rejection) {
                    toast(result.message)
                    entry.release()
                } else {
                    entry.answer(if (entry.awaited) result else null)
                }
            }, awaitOutcome = entry.awaited)
            "qr" -> {
                entry.url?.let { showQrCode(it, entry.tabId) }
                entry.settle("qr")
            }
            "copyImage" -> {
                copyImage(entry.send)
                entry.settle("copyImage")
            }
            "chip" -> entry.settle("chip")
            else -> entry.release()
        }
        reply(null)
    }

    /** The shared image's address on the clipboard (Chrome's Copy image: the URI, which a paste reads through the provider). */
    private fun copyImage(send: Intent) {
        val uri = IntentCompat.getParcelableExtra(send, Intent.EXTRA_STREAM, Uri::class.java) ?: return
        val clipboard = activity.getSystemService(ClipboardManager::class.java) ?: return
        clipboard.setPrimaryClip(ClipData.newUri(activity.contentResolver, "Image", uri))
        // Android 13 shows its own chip for a copy; below it the app says so.
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) toast("Image copied")
    }

    /** A word to the user through the chrome's toast (the one toast the app has; `BrowserActivity` speaks the same way). */
    private fun toast(message: String, kind: String = "info") {
        host.chrome.hostEvent("toast", json("message" to message, "kind" to kind, "action" to null))
    }

    /** A launcher icon as a `data:` WebP of `side` px (adaptive icons draw their mask themselves). */
    private fun iconDataUrl(drawable: Drawable, side: Int): String {
        val bitmap = Bitmap.createBitmap(side, side, Bitmap.Config.ARGB_8888)
        drawable.setBounds(0, 0, side, side)
        drawable.draw(Canvas(bitmap))
        val out = ByteArrayOutputStream()
        bitmap.compress(webpFormat(), PANEL_ICON_QUALITY, out)
        bitmap.recycle()
        return dataUrl("image/webp", out.toByteArray())
    }

    /** The shared image, small, for the panel's preview: its longer side at the row's picture size. IO thread. */
    private fun previewDataUrl(uri: Uri): String? {
        val resolver = activity.contentResolver
        val bytes = resolver.openInputStream(uri)?.use { it.readBytes() } ?: return null
        val side = (PANEL_PREVIEW_DP * activity.resources.displayMetrics.density).roundToInt()
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
        if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null
        var sample = 1
        while (maxOf(bounds.outWidth, bounds.outHeight) / (sample * 2) >= side) sample *= 2
        val bitmap = BitmapFactory.decodeByteArray(bytes, 0, bytes.size, BitmapFactory.Options().apply { inSampleSize = sample }) ?: return null
        val out = ByteArrayOutputStream()
        bitmap.compress(webpFormat(), PANEL_ICON_QUALITY, out)
        bitmap.recycle()
        return dataUrl("image/webp", out.toByteArray())
    }

    @Suppress("DEPRECATION")
    private fun webpFormat(): Bitmap.CompressFormat =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) Bitmap.CompressFormat.WEBP_LOSSY else Bitmap.CompressFormat.WEBP

    /** The share history's home: one string in the app's preferences. */
    private class PrefsStore(private val prefs: android.content.SharedPreferences) : ShareHistory.Store {
        override fun read(): String? = prefs.getString(PANEL_PREFS_KEY, null)
        override fun write(value: String) = prefs.edit().putString(PANEL_PREFS_KEY, value).apply()
    }

    // --- in: Zenium as a share target ------------------------------------------------------------

    /** Another app shared into Zenium (`ACTION_SEND`): text, a link in text, or an image. */
    fun onReceived(intent: Intent) {
        val text = intent.getStringExtra(Intent.EXTRA_TEXT)
        val subject = intent.getStringExtra(Intent.EXTRA_SUBJECT)
        val type = intent.type
        val stream = if (type?.startsWith("image/") == true) IntentCompat.getParcelableExtra(intent, Intent.EXTRA_STREAM, Uri::class.java) else null
        val describe = { imageDataUrl: String? ->
            host.chrome.hostEvent(
                "intent",
                json("kind" to "send", "text" to text, "subject" to subject, "mimeType" to type, "imageDataUrl" to imageDataUrl)
            )
        }
        if (stream == null) {
            describe(null)
            return
        }
        io.execute {
            val dataUrl = runCatching { readSharedImage(stream, type!!) }.getOrNull()
            main.post { describe(dataUrl) }
        }
    }

    /** `ACTION_WEB_SEARCH`: the query runs with the user's engine. */
    fun onWebSearch(intent: Intent) {
        val query = intent.getStringExtra(SearchManager.QUERY) ?: return
        host.chrome.hostEvent("intent", json("kind" to "search", "text" to query))
    }

    /**
     * The shared image as a `data:` URL the core can show in a tab. Decoded through a sample size
     * that keeps the longer side within `MAX_IMAGE_SIDE`, so a 50-megapixel photo does not become
     * a hundred-megabyte string; PNG stays PNG (transparency), a small GIF stays itself (animation).
     */
    private fun readSharedImage(uri: Uri, type: String): String? {
        val resolver = activity.contentResolver
        val bytes = resolver.openInputStream(uri)?.use { input -> readAtMost(input.readBytes(), MAX_IMAGE_BYTES) } ?: return null
        val mime = resolver.getType(uri) ?: type
        if (mime == "image/gif" && bytes.size <= MAX_GIF_BYTES) return dataUrl(mime, bytes)
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
        if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null
        var sample = 1
        while (maxOf(bounds.outWidth, bounds.outHeight) / sample > MAX_IMAGE_SIDE) sample *= 2
        val bitmap = BitmapFactory.decodeByteArray(bytes, 0, bytes.size, BitmapFactory.Options().apply { inSampleSize = sample })
            ?: return null
        val out = ByteArrayOutputStream()
        val png = mime == "image/png" || bitmap.hasAlpha()
        bitmap.compress(if (png) Bitmap.CompressFormat.PNG else Bitmap.CompressFormat.JPEG, 88, out)
        bitmap.recycle()
        return dataUrl(if (png) "image/png" else "image/jpeg", out.toByteArray())
    }

    private fun readAtMost(bytes: ByteArray, limit: Int): ByteArray? = if (bytes.size > limit) null else bytes

    private fun dataUrl(mime: String, bytes: ByteArray): String =
        "data:$mime;base64," + Base64.encodeToString(bytes, Base64.NO_WRAP)

    // --- QR code (the action row's and the panel's "QR code"; SH-06) -------------------------------

    /**
     * The link as a QR code in the chrome's code sheet (`components/qr/QrCodeSheet.tsx`), as
     * Chrome 152's sharing hub option opens `QrCodeDialog`: the code is encoded here
     * ([QrCodeLogic.codeFor]) and handed over as its modules (`qr.code`), the sheet draws it and
     * asks [downloadQrCode] for Download. A link too long for a code (Chrome's 2331) or one the
     * encoder refuses goes over as the error the sheet shows in the code's place.
     */
    private fun showQrCode(url: String, tabId: String?) {
        io.execute {
            val code = QrCodeLogic.codeFor(url)
            val payload = json("url" to url, "tabId" to tabId, "rows" to JSONArray(code.rows), "error" to code.error)
            main.post { host.chrome.hostEvent("qr.code", payload) }
        }
    }

    /**
     * `qr.download`: the sheet's Download. The picture Chrome's `addUrlToBitmap` composes – the
     * link above the code on white ([QrCodeLogic.composition]) – as a PNG in the public Downloads
     * collection, named `zenium_qrcode_<millis>.png` as Chrome's `chrome_qrcode_<millis>` is; the
     * chrome's toast says it is there, or that it could not be kept. The sheet has already gone
     * (Chrome's dialog closes on Download); the answer comes as soon as the write is under way.
     */
    fun downloadQrCode(url: String, reply: (Any?) -> Unit) {
        reply(null)
        io.execute {
            val bytes = runCatching { composeQrPicture(url) }.getOrNull()?.let { picture ->
                ByteArrayOutputStream().also { picture.compress(Bitmap.CompressFormat.PNG, 100, it) }.toByteArray()
            }
            main.post {
                if (bytes == null) {
                    toast("Could not save the QR code", kind = "error")
                    return@post
                }
                host.saveToDownloads(QrCodeLogic.fileName(System.currentTimeMillis()), QrCodeLogic.MIME, bytes) { result ->
                    if (result != null) toast("Saved to Downloads") else toast("Could not save the QR code", kind = "error")
                }
            }
        }
    }

    /**
     * Chrome's `QrCodeShareMediator.addUrlToBitmap`: the link in black at `text_size_large`,
     * centred, as wide as the code, two lines at most with the second ellipsised, 70 dp from the
     * top; the code 200 dp on a side 25 dp under it, drawn module for module (no filtering, so
     * the edges stay hard); 50 dp of white at either side and the text's band again under the
     * code. Null when the link makes no code. Off the main thread.
     */
    private fun composeQrPicture(url: String): Bitmap? {
        val matrix = QrCodeLogic.encode(url) ?: return null
        val metrics = activity.resources.displayMetrics
        val paint = TextPaint().apply {
            isAntiAlias = true
            color = Color.BLACK
            textSize = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_SP, QrCodeLogic.URL_TEXT_SP, metrics)
        }
        val codeSize = (QrCodeLogic.CODE_DP * metrics.density).roundToInt()
        val text = StaticLayout.Builder.obtain(url, 0, url.length, paint, codeSize)
            .setAlignment(Layout.Alignment.ALIGN_CENTER)
            .setMaxLines(QrCodeLogic.URL_MAX_LINES)
            .setEllipsize(TextUtils.TruncateAt.END)
            .setIncludePad(true)
            .build()
        val geometry = QrCodeLogic.composition(metrics.density, text.height)
        val picture = Bitmap.createBitmap(geometry.width, geometry.height, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(picture)
        canvas.drawColor(Color.WHITE)
        canvas.save()
        canvas.translate(geometry.textLeft.toFloat(), geometry.textTop.toFloat())
        text.draw(canvas)
        canvas.restore()
        val modules = qrBitmap(matrix)
        val target = Rect(geometry.codeLeft, geometry.codeTop, geometry.codeLeft + geometry.codeSize, geometry.codeTop + geometry.codeSize)
        canvas.drawBitmap(modules, null, target, Paint().apply { isFilterBitmap = false })
        return picture
    }

    // --- cache files behind the FileProvider ----------------------------------------------------

    /**
     * Fetch (or decode) an image into `cache/share/` and return its content URI. HTTP fetches carry
     * the cookies the tab has for the address, so an image behind a login comes through as the
     * page showed it. Files older than a day are cleared on the way.
     */
    private fun cacheImage(source: String, prefix: String, userAgent: String?): Uri {
        val dir = File(activity.cacheDir, "share").apply { mkdirs() }
        val cutoff = System.currentTimeMillis() - CACHE_TTL_MS
        dir.listFiles()?.forEach { if (it.lastModified() < cutoff) it.delete() }
        val (bytes, declaredMime) = if (source.startsWith("data:")) {
            val comma = source.indexOf(',')
            val header = source.substring(5, maxOf(5, comma))
            val mime = header.substringBefore(';').ifEmpty { null }
            val payload = source.substring(comma + 1)
            val decoded = if (header.contains(";base64")) Base64.decode(payload, Base64.DEFAULT) else Uri.decode(payload).toByteArray()
            decoded to mime
        } else {
            val conn = (URL(source).openConnection() as HttpURLConnection).apply {
                connectTimeout = FETCH_TIMEOUT_MS
                readTimeout = FETCH_TIMEOUT_MS
                instanceFollowRedirects = true
                CookieManager.getInstance().getCookie(source)?.let { setRequestProperty("Cookie", it) }
                userAgent?.let { setRequestProperty("User-Agent", it) }
                setRequestProperty("Accept", "image/*,*/*;q=0.8")
            }
            if (conn.responseCode !in 200..299) throw IllegalStateException("HTTP ${conn.responseCode}")
            val data = conn.inputStream.use { it.readBytes() }
            data to conn.contentType?.substringBefore(';')?.trim()
        }
        if (bytes.isEmpty()) throw IllegalStateException("empty image")
        val mime = sniffImageMime(bytes) ?: declaredMime?.takeIf { it.startsWith("image/") } ?: "image/png"
        val file = File(dir, "$prefix-${System.currentTimeMillis()}.${extensionFor(mime)}")
        file.writeBytes(bytes)
        return FileProvider.getUriForFile(activity, "${activity.packageName}.files", file)
    }

    companion object {
        /** The action row's `PendingIntent`s come back to `MainActivity` under this action. */
        const val ACTION_BROWSER_ACTION = "app.zen.chromium.SHARE_ACTION"
        const val EXTRA_KIND = "kind"
        const val EXTRA_URL = "url"
        const val EXTRA_TAB_ID = "tabId"
        const val KIND_COPY = "copy"
        const val KIND_QR = "qr"
        /**
         * The row's Long screenshot: the chrome's editor over the page (SH-08), the one the share
         * panel's chip opens below 14 – the word the chrome's platform routes to it
         * (`src/android/platform.ts`, `share.action`), not the core's viewport shot.
         */
        const val KIND_LONG_SCREENSHOT = "longScreenshot"
        const val KIND_PRINT = "print"

        /** One of the row's actions: the kind the tap's intent names, the button's label and glyph. */
        data class RowAction(val kind: String, val label: String, val icon: Int)

        /**
         * Zenium's row in Android 14's share sheet (SH-02), in the design's order – Copy link, QR
         * code, Long screenshot, Print – the same words in the same order as the share panel's
         * chips below 14 (§9.38: one order for one object on both paths). Long screenshot and
         * Print work on the sharing tab, so a share without one (a bare link's) goes without them.
         */
        fun browserRow(withTab: Boolean): List<RowAction> {
            val row = mutableListOf(
                RowAction(KIND_COPY, "Copy link", R.drawable.ic_share_copy),
                RowAction(KIND_QR, "QR code", R.drawable.ic_share_qr)
            )
            if (withTab) {
                row += RowAction(KIND_LONG_SCREENSHOT, "Long screenshot", R.drawable.ic_share_long_screenshot)
                row += RowAction(KIND_PRINT, "Print", R.drawable.ic_share_print)
            }
            return row
        }

        /** The chooser's report of a chosen target comes back under this action ([Outcome]). */
        const val ACTION_CHOSEN = "app.zen.chromium.SHARE_CHOSEN"
        /** An awaited share's answers, as the core reads them (`ShareOutcome`). */
        const val SHARE_SHARED = "shared"
        const val SHARE_ABORTED = "aborted"
        /** How long a returned sheet waits for the chosen-target report before it counts as dismissed. */
        const val CHOSEN_GRACE_MS = 800L
        /** A shared file's name is cut to this many characters (the extension kept). */
        const val FILE_NAME_MAX = 120

        /** The panel's kinds of share (`SharePanelRequest.kind`): a page or link, a selection, an image. */
        const val PANEL_LINK = "link"
        const val PANEL_TEXT = "text"
        const val PANEL_IMAGE = "image"
        /** Where the panel's share came from (`SharePanelRequest.source`): the browser's menu, or a page's `navigator.share`. */
        const val PANEL_SOURCE_MENU = "menu"
        const val PANEL_SOURCE_PAGE = "page"
        /**
         * What a superseded panel's `app.share` is answered: the core awaits a share of its own for
         * its failure alone (`Browser.share`), so the word is the bridge's record, not a rejection.
         */
        const val PANEL_CANCELLED = "cancelled"
        /** The panel's row shows at most this many apps (Chrome's `ShareSheetPropertyModelBuilder.MAX_NUM_APPS`). */
        const val MAX_PANEL_TARGETS = 7
        /** The row's launcher icons, in dp (the design's 40 in the §9.3 box). */
        const val PANEL_ICON_DP = 40
        /** The preview's picture of a shared image, in dp (the sheet header's 40 thumbnail; the decode lands between 1× and 2× of it). */
        const val PANEL_PREVIEW_DP = 40
        /** The icons' and the preview's WebP quality: a launcher icon reads at this, and seven of them fit one event. */
        const val PANEL_ICON_QUALITY = 85
        const val PANEL_PREFS = "share-history"
        const val PANEL_PREFS_KEY = "v1"
        /** Chrome's `PACKAGE_BLOCK_LIST` (crbug.com/40838852): the CTS shims declare a share target that opens nothing. */
        val PANEL_BLOCKED_PACKAGES = setOf("com.android.cts.ctsshim", "com.android.cts.priv.ctsshim")

        /** The sheet's way out before the row's Long screenshot is relayed: its stitch copies the page off the screen. */
        private const val SCREENSHOT_DELAY_MS = 450L
        private const val FETCH_TIMEOUT_MS = 10_000

        /**
         * Whether Zenium's own share panel stands in for the system sheet: below Android 14 (where
         * the sheet has no row for the sharing app's actions), for a link, text or an image – a
         * page's awaited `navigator.share` included, as Chrome's hub takes one – but never for a
         * page's files, which Chrome too hands to the system sheet.
         */
        fun panelStandsIn(sdkInt: Int, files: Boolean): Boolean = !files && sdkInt < Build.VERSION_CODES.UPSIDE_DOWN_CAKE

        /**
         * What a page's awaited share hears for the panel's answer (`share.panelAction`), as
         * Chrome's hub answers a Web Share's `TargetChosenCallback`: [SHARE_SHARED] when an app
         * took the share (`started`), when one of the browser's own chips ran (a first-party
         * tap calls `callTargetChosenCallback()` in Chrome), for QR and Copy image; [SHARE_ABORTED]
         * for a dismissal or an app that would not start; nothing for More – the system sheet
         * it opens answers for itself ([Outcome]).
         */
        fun awaitedPanelAnswer(kind: String, started: Boolean = true): String? = when (kind) {
            "target" -> if (started) SHARE_SHARED else SHARE_ABORTED
            "chip", "qr", "copyImage" -> SHARE_SHARED
            "more" -> null
            else -> SHARE_ABORTED
        }

        /** The sheet's type for a set of files: their one type, the group's wildcard (`image` slash star) for pictures of several kinds, else anything. */
        fun commonMimeType(types: List<String>): String {
            val distinct = types.map { it.ifEmpty { "application/octet-stream" } }.distinct()
            if (distinct.size == 1) return distinct[0]
            val groups = distinct.map { it.substringBefore('/') }.distinct()
            return if (groups.size == 1) "${groups[0]}/*" else "*/*"
        }

        /**
         * The one message a share carries for its text and link: the text, then the link on a line
         * of its own (Chrome's `navigator.share` composition; a selection's share reads as the
         * quote and its link to the highlight), either alone when the other is missing, null when both are.
         */
        fun messageBody(text: String?, url: String?): String? = when {
            text != null && url != null -> if (text == url) url else "$text\n$url"
            else -> text ?: url
        }

        /**
         * A page's file name made safe for the cache: path separators and control characters out,
         * an empty or dotted name replaced by one from its type, cut to [FILE_NAME_MAX] with the
         * extension kept, and unique among `taken` (a numbered copy otherwise).
         */
        fun safeFileName(name: String?, type: String, taken: MutableSet<String>): String {
            var base = (name ?: "").replace(Regex("[\\\\/\\p{Cntrl}]"), "_").trim().trimStart('.')
            if (base.isEmpty()) base = "file.${extensionFor(type)}"
            val dot = base.lastIndexOf('.')
            var stem = if (dot > 0) base.substring(0, dot) else base
            val ext = if (dot > 0) base.substring(dot) else ""
            if (stem.length + ext.length > FILE_NAME_MAX) stem = stem.take(maxOf(1, FILE_NAME_MAX - ext.length))
            var candidate = stem + ext
            var n = 2
            while (!taken.add(candidate)) candidate = "$stem (${n++})$ext"
            return candidate
        }
        private const val CACHE_TTL_MS = 24 * 60 * 60 * 1000L
        /** A shared image larger than this is not read at all (the text that came with it still is). */
        private const val MAX_IMAGE_BYTES = 40 * 1024 * 1024
        private const val MAX_GIF_BYTES = 4 * 1024 * 1024
        private const val MAX_IMAGE_SIDE = 2048

        /** A code's modules as a bitmap, one pixel a module, black on white (the quiet zone is the matrix's). */
        fun qrBitmap(matrix: BitMatrix): Bitmap {
            val pixels = IntArray(matrix.width * matrix.height)
            for (y in 0 until matrix.height) for (x in 0 until matrix.width) {
                pixels[y * matrix.width + x] = if (matrix.get(x, y)) Color.BLACK else Color.WHITE
            }
            return Bitmap.createBitmap(pixels, matrix.width, matrix.height, Bitmap.Config.RGB_565)
        }

        /** The image type from the bytes' signature; servers and `data:` URLs get it wrong often enough. */
        fun sniffImageMime(bytes: ByteArray): String? {
            fun startsWith(vararg signature: Int): Boolean =
                bytes.size >= signature.size && signature.indices.all { bytes[it].toInt() and 0xff == signature[it] }
            return when {
                startsWith(0x89, 0x50, 0x4e, 0x47) -> "image/png"
                startsWith(0xff, 0xd8, 0xff) -> "image/jpeg"
                startsWith(0x47, 0x49, 0x46, 0x38) -> "image/gif"
                startsWith(0x52, 0x49, 0x46, 0x46) && bytes.size >= 12 &&
                    bytes[8].toInt() == 0x57 && bytes[9].toInt() == 0x45 && bytes[10].toInt() == 0x42 && bytes[11].toInt() == 0x50 -> "image/webp"
                startsWith(0x42, 0x4d) -> "image/bmp"
                bytes.size >= 12 && bytes[4].toInt() == 0x66 && bytes[5].toInt() == 0x74 && bytes[6].toInt() == 0x79 && bytes[7].toInt() == 0x70 -> "image/avif"
                bytes.take(256).toByteArray().toString(Charsets.US_ASCII).contains("<svg") -> "image/svg+xml"
                else -> null
            }
        }

        fun extensionFor(mime: String): String = when (mime) {
            "image/jpeg" -> "jpg"
            "image/gif" -> "gif"
            "image/webp" -> "webp"
            "image/bmp" -> "bmp"
            "image/avif" -> "avif"
            "image/svg+xml" -> "svg"
            else -> "png"
        }
    }
}
