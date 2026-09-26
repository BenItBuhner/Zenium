package app.zen.chromium

import android.Manifest
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.SharedPreferences
import android.content.pm.PackageManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.ScriptHandler
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import org.json.JSONObject
import java.io.File
import java.security.SecureRandom
import java.util.concurrent.Executors

/**
 * `Notification` inside an installed web app's own window ([WebAppActivity], PWA-02). The WebView
 * hides the API from pages, and the browser's polyfill rides the browser's page script, which an
 * app's window (a [CustomTabHost], no core) never installs: so the window installs a script of its
 * own – `assets/webapp.js`, the polyfill over a bridge of its own (`__zenWebAppBridge`, a
 * per-window secret in place of the browser's session token) – and this class answers it, the
 * core's `WebNotificationService` cut down to one page of one app:
 *
 * - `query`: what `Notification.permission` reads – the site's standing ([standing]) as the
 *   browser has it, or as this window was answered; `denied` outside the app's scope (the app's
 *   window posts for the app's pages alone; a page out of scope has the browser for it) and while
 *   the user has the app's channel off in the system's settings (Chrome's rule: the channel's state
 *   is the permission's).
 * - `request`: a question still open asks with a native prompt, on a user gesture only (the
 *   browser's quiet ask is the pill's bell; an app window has no pill, so a request without a
 *   gesture is answered `default` and the page may ask again on a tap); the answer is kept for the
 *   app ([remember]), and Android 13's `POST_NOTIFICATIONS` is asked once for the whole app on the
 *   first grant, as the browser asks it ([NotificationAsk], the same memory).
 * - `show`: the card under the app's own channel group ([WebAppChannels]) with the app's identity
 *   ([NotificationIdentity.app]); a tap brings the app's task forward
 *   ([WebAppLauncherActivity.launchIntent] as the pending intent, `onNewIntent`) and fires the page's
 *   `click`; a swipe fires `close`; a replace under a tag is the site's one card by that tag, as in
 *   the browser; at most [MAX_LIVE] cards up per window, the oldest going first (the core's cap).
 * - `close`: the card comes down without an event.
 *
 * The browser's own answer for the site (Settings › Site settings, a tab's prompt) ranks above the
 * window's ([SiteDecisions], the core's `permissions.json` read as it is); an answer given here is
 * the app's own memory and is not listed in the browser's Site settings – the one seam the two
 * windows keep, stated in the row.
 */
class WebAppNotifications(private val activity: WebAppActivity, private val record: WebAppRecord) {
    private val context: Context = activity.applicationContext
    private val manager = NotificationManagerCompat.from(context)
    private val main = Handler(Looper.getMainLooper())
    private val io = Executors.newSingleThreadExecutor { r -> Thread(r, "zen-webapp-notifications") }
    private val channels = WebAppChannels(context)
    private val app = InstalledWebApp(record.id, record.name, record.startUrl, record.scope)
    private val decisions = SiteDecisions(File(context.filesDir, SiteDecisions.FILE))
    private val token: String = SecureRandom().let { r -> ByteArray(16).also(r::nextBytes).joinToString("") { "%02x".format(it) } }
    private val script: String by lazy { context.assets.open(SCRIPT_ASSET).bufferedReader().readText().replace(TOKEN_PLACEHOLDER, token) }

    private var attached: TabWebView? = null
    private var documentScript: ScriptHandler? = null
    /** The main frame's reply channel, from its `hello`; a new document says hello again. */
    private var replyProxy: JavaScriptReplyProxy? = null
    /** Counts the documents that said hello: a card's key is `<document>/<page id>`, so a new document's ids never meet an old document's cards. */
    private var document = 0
    /** The cards up, key → the page's tag (empty for none), oldest first. */
    private val shown = LinkedHashMap<String, String>()
    private var destroyed = false
    /** The prompt up, and who waits for its answer (requests while it is up share it). */
    private var promptWaiters: ArrayList<() -> Unit>? = null
    /** The sheet itself while it is up, so the window's end takes it down without an answer. */
    private var prompt: PermissionPromptSheet? = null

    private val notificationAsk = NotificationAsk(
        askedBefore = { appPrefs().getBoolean(Permissions.KEY_NOTIFICATIONS_ASKED, false) },
        markAsked = { appPrefs().edit().putBoolean(Permissions.KEY_NOTIFICATIONS_ASKED, true).apply() }
    )

    private val receiver = object : BroadcastReceiver() {
        override fun onReceive(c: Context, intent: Intent) {
            onIntent(intent)
        }
    }

    init {
        ContextCompat.registerReceiver(context, receiver, IntentFilter(ACTION_DISMISSED), ContextCompat.RECEIVER_NOT_EXPORTED)
    }

    // --- the page's bridge --------------------------------------------------------------------------

    /**
     * The script and its bridge on `view` (the window's one page; a fresh view after a renderer
     * crash comes here again). Without document-start scripts or web message listeners in the
     * WebView there is no bridge, and the page keeps the WebView's own absence of the API.
     */
    fun attach(view: TabWebView) {
        detach()
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER) ||
            !WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)
        ) return
        runCatching {
            WebViewCompat.addWebMessageListener(view, BRIDGE, setOf("*")) { _, message, _, isMainFrame, proxy ->
                onMessage(view, message.data, isMainFrame, proxy)
            }
            documentScript = WebViewCompat.addDocumentStartJavaScript(view, script, setOf("*"))
            attached = view
        }
    }

    private fun detach() {
        documentScript?.remove()
        documentScript = null
        attached?.let { view -> runCatching { WebViewCompat.removeWebMessageListener(view, BRIDGE) } }
        attached = null
        replyProxy = null
    }

    private fun onMessage(view: TabWebView, data: String?, isMainFrame: Boolean, proxy: JavaScriptReplyProxy) {
        if (destroyed || !isMainFrame || data == null) return
        val message = runCatching { JSONObject(data) }.getOrNull() ?: return
        // A page's forgery (the script's token is this window's alone) is dropped, silently.
        if (message.optString("token") != token) return
        val url = view.url ?: ""
        when (message.optString("type")) {
            "hello" -> {
                replyProxy = proxy
                document++
            }
            "notification" -> {
                val request = message.optJSONObject("notification") ?: return
                when (request.optString("notification")) {
                    "query" -> post(json("type" to "notification", "action" to "status", "status" to status(url)))
                    // `gesture` left out (an engine without `userActivation`) counts as gestured, the core's rule: nothing is quieted on a guess.
                    "request" -> request(url, request.strOrNull("id"), request.optBoolean("gesture", true))
                    "show" -> show(url, request)
                    "close" -> close(request.strOrNull("id") ?: return)
                }
            }
        }
    }

    private fun post(payload: JSONObject) {
        val proxy = replyProxy ?: return
        runCatching { proxy.postMessage(payload.toString()) }
    }

    // --- the standing -------------------------------------------------------------------------------

    /** What `Notification.permission` reads in the app's page at `url`. */
    private fun status(url: String): String {
        val origin = WebAppRules.origin(url) ?: return DENIED
        if (!WebAppRules.inScope(url, record.scope)) return DENIED
        return when (standing(origin)) {
            ALLOW -> if (channels.find(app.shortcutId)?.let(channels::blocked) == true) DENIED else GRANTED
            DENY -> DENIED
            else -> DEFAULT
        }
    }

    /**
     * The site's standing: the browser's own answer for the site first (a rule set in Settings ›
     * Site settings or in a tab's prompt), then the answer given in this window, then the browser's
     * default for notifications (`ask`, or `deny` when the user turned every site's asking off).
     */
    private fun standing(origin: String): String {
        decisions.decision(origin, PERMISSION)?.let { return it }
        appPrefs(PREFS).getString(record.shortcutId, null)?.let { return it }
        return if (decisions.defaultFor(PERMISSION) == DENY) DENY else ASK
    }

    /** The window's own answer for the app, kept under its shortcut id. */
    private fun remember(decision: String) {
        appPrefs(PREFS).edit().putString(record.shortcutId, decision).apply()
    }

    private fun request(url: String, requestId: String?, gesture: Boolean) {
        val answer = { post(json("type" to "notification", "action" to "result", "status" to status(url), "id" to requestId)) }
        val origin = WebAppRules.origin(url)
        if (origin == null || !WebAppRules.inScope(url, record.scope)) return answer()
        when (standing(origin)) {
            ALLOW -> ensureAllowed { answer() }
            DENY -> answer()
            else -> if (gesture) ask(answer) else answer()
        }
    }

    /**
     * The native prompt on §9.23's sheet ([PermissionPromptSheet], the theme's inks in the
     * window's light or dark): "Allow <app> to show notifications?", Block the plain peer, Allow
     * the accent primary. Allow and Block are written ([remember]); the scrim, the system back and
     * the grabber are a dismissal that writes nothing and leaves the question open – the page
     * reads `default` and may ask again on its next gesture.
     */
    private fun ask(then: () -> Unit) {
        promptWaiters?.let { waiting ->
            waiting += then
            return
        }
        val waiting = arrayListOf(then)
        promptWaiters = waiting
        var answered = false
        val settle = { decision: String? ->
            if (!answered) {
                answered = true
                promptWaiters = null
                prompt = null
                if (decision != null) remember(decision)
                if (decision == ALLOW) ensureAllowed { for (w in waiting) w() } else for (w in waiting) w()
            }
        }
        if (activity.isFinishing || activity.isDestroyed) return settle(null)
        val sheet = PermissionPromptSheet(
            activity,
            activity.scheme.dark,
            requester = record.name,
            question = R.string.webapp_notifications_question,
            block = activity.getString(R.string.cct_block),
            allow = NativePromptSheet.Peer(activity.getString(R.string.cct_allow), NativePromptSheet.Tone.ACCENT)
        ) { answer ->
            when (answer) {
                PermissionPromptSheet.Answer.ALLOWED -> settle(ALLOW)
                PermissionPromptSheet.Answer.BLOCKED -> settle(DENY)
                PermissionPromptSheet.Answer.DISMISSED -> settle(null)
            }
        }
        prompt = sheet
        sheet.show()
    }

    /** Android 13's `POST_NOTIFICATIONS`, the app's own right to post: the browser's once-only ask, the same memory ([Permissions.KEY_NOTIFICATIONS_ASKED]). */
    private fun ensureAllowed(then: () -> Unit) {
        val needsPrompt = Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        if (notificationAsk.arrive(needsPrompt, manager.areNotificationsEnabled(), { then() })) {
            activity.requestRuntimePermissions(listOf(Manifest.permission.POST_NOTIFICATIONS)) { results ->
                notificationAsk.settle(results[Manifest.permission.POST_NOTIFICATIONS] == true)
            }
        }
    }

    /** Whether the app may post at all right now (the system's switch, Android 13's permission). */
    private fun allowed(): Boolean = manager.areNotificationsEnabled() &&
        (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU ||
            ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED)

    // --- the cards ----------------------------------------------------------------------------------

    private fun show(url: String, request: JSONObject) {
        val pageId = request.strOrNull("id")?.takeIf { it.isNotEmpty() } ?: return
        val error = { post(json("type" to "notification", "action" to "error", "id" to pageId)) }
        val origin = WebAppRules.origin(url)
        if (origin == null || status(url) != GRANTED || !allowed()) return error()
        val channelId = channels.ensure(app)
        val key = "$document/$pageId"
        val tag = text(request, "tag")
        // The same tag: the earlier card is the one being replaced (its key goes; the card is overwritten).
        if (tag.isNotEmpty()) shown.entries.firstOrNull { it.key != key && it.value == tag }?.let { shown.remove(it.key) }
        shown[key] = tag
        while (shown.size > MAX_LIVE) {
            val oldest = shown.entries.first()
            shown.remove(oldest.key)
            manager.cancel(notificationTag(app.shortcutId, oldest.key, oldest.value), WebNotifications.NOTIFICATION_ID)
        }
        val timestamp = request.optDouble("timestamp", Double.NaN)
        val args = json(
            "id" to key, "origin" to origin, "url" to url,
            "title" to text(request, "title"), "body" to text(request, "body"), "tag" to tag,
            "silent" to request.optBoolean("silent", false), "renotify" to request.optBoolean("renotify", false),
            "timestamp" to if (timestamp.isFinite() && timestamp > 0) timestamp else System.currentTimeMillis().toDouble()
        )
        val iconUrl = request.strOrNull("icon")?.takeIf { it.startsWith("http://", true) || it.startsWith("https://", true) }
        io.execute {
            val icon = iconUrl?.let { MediaSessions.fetchBitmap(it, MAX_ICON_PX) }
            val identity = NotificationIdentity.app(context, app, icon)
            main.post {
                // Closed, or replaced, while the icon was on its way: nothing to post.
                if (destroyed || !shown.containsKey(key)) return@post
                val card = webNotificationCard(context, channelId, args, identity, contentIntent(key, url), dismissIntent(key))
                val ok = runCatching { manager.notify(notificationTag(app.shortcutId, key, tag), WebNotifications.NOTIFICATION_ID, card) }.isSuccess
                if (ok) post(json("type" to "notification", "action" to "shown", "id" to pageId))
                else {
                    shown.remove(key)
                    error()
                }
            }
        }
    }

    /** The page's `close()`: the card comes down without an event. */
    private fun close(pageId: String) {
        val key = "$document/$pageId"
        val tag = shown.remove(key) ?: return
        manager.cancel(notificationTag(app.shortcutId, key, tag), WebNotifications.NOTIFICATION_ID)
    }

    /** The tap's intent reached the window ([WebAppActivity.onNewIntent]): the page's `click`. True when it was a card's. */
    fun onOpenIntent(intent: Intent): Boolean = onIntent(intent)

    private fun onIntent(intent: Intent): Boolean {
        val key = intent.getStringExtra(EXTRA_NOTIFICATION) ?: return false
        val event = intent.getStringExtra(EXTRA_EVENT) ?: return false
        shown.remove(key)
        // The event is the page's while the document that showed the card is the one up.
        if (key.substringBefore('/') == document.toString()) {
            post(json("type" to "notification", "action" to event, "id" to key.substringAfter('/')))
        }
        return true
    }

    private fun contentIntent(key: String, url: String): PendingIntent {
        val intent = WebAppLauncherActivity.launchIntent(context, record, url)
            .putExtra(EXTRA_NOTIFICATION, key)
            .putExtra(EXTRA_EVENT, EVENT_CLICK)
        return PendingIntent.getActivity(context, requestCode(key, EVENT_CLICK), intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    }

    private fun dismissIntent(key: String): PendingIntent {
        val intent = Intent(ACTION_DISMISSED).setPackage(context.packageName)
            .putExtra(EXTRA_NOTIFICATION, key)
            .putExtra(EXTRA_EVENT, EVENT_CLOSE)
        return PendingIntent.getBroadcast(context, requestCode(key, EVENT_CLOSE), intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    }

    /** One pending intent per (card, event) of this app: the extras differ, so the codes have to. */
    private fun requestCode(key: String, event: String): Int = "${app.shortcutId}/$key/$event".hashCode()

    private fun appPrefs(name: String = Permissions.PREFS): SharedPreferences = context.getSharedPreferences(name, Context.MODE_PRIVATE)

    fun destroy() {
        destroyed = true
        prompt?.dismiss()
        prompt = null
        promptWaiters = null
        detach()
        runCatching { context.unregisterReceiver(receiver) }
        io.shutdown()
    }

    companion object {
        /** The bridge object the window's script posts through (`src/android/webAppScript.ts`), not the browser's. */
        const val BRIDGE = "__zenWebAppBridge"
        const val SCRIPT_ASSET = "webapp.js"
        private const val TOKEN_PLACEHOLDER = "__ZEN_TOKEN__"
        /** The broadcast of a swipe (the receiver above); the browser's cards have their own. */
        const val ACTION_DISMISSED = "app.zen.chromium.WEBAPP_NOTIFICATION_DISMISSED"
        const val EXTRA_NOTIFICATION = "app.zen.chromium.extra.WEBAPP_NOTIFICATION"
        const val EXTRA_EVENT = "app.zen.chromium.extra.WEBAPP_NOTIFICATION_EVENT"
        const val EVENT_CLICK = "click"
        const val EVENT_CLOSE = "close"
        /** The window's own answers, by shortcut id (`allow` / `deny`). */
        const val PREFS = "zenium.webapp.notifications"
        const val PERMISSION = "notifications"
        /** The core's cap of cards up per site (`MAX_LIVE_PER_ORIGIN`). */
        const val MAX_LIVE = 20
        private const val MAX_ICON_PX = 256
        /** The core's cap on a notification's words (`MAX_NOTIFICATION_TEXT`). */
        const val MAX_TEXT = 1024

        const val ALLOW = "allow"
        const val DENY = "deny"
        const val ASK = "ask"
        const val GRANTED = "granted"
        const val DENIED = "denied"
        const val DEFAULT = "default"

        /** A field of the page's request as text, capped as the core caps it. */
        fun text(request: JSONObject, key: String): String = (request.strOrNull(key) ?: "").take(MAX_TEXT)

        /**
         * The Android tag an app window's card posts under, apart from the browser's
         * (`zenium.web/…`): the app's one card by a page tag, else the card's own.
         */
        fun notificationTag(shortcutId: String, key: String, tag: String): String =
            if (tag.isNotEmpty()) "zenium.webapp/$shortcutId/tag:$tag" else "zenium.webapp/$shortcutId/$key"
    }
}

/**
 * The browser's answers for the sites, read as the core keeps them (`permissions.json` under
 * `files/zen/`: `{version: 1, decisions: {"<origin>|<permission>": "allow" | "deny", "*|<permission>":
 * the user's default}}`) and re-read when the file changed – the store is the core's to write, and
 * a window without the core reads it as it is. The origin is the core's `permissionSite` form.
 */
class SiteDecisions(private val file: File) {
    private var seenStamp = Long.MIN_VALUE
    private var seenLength = Long.MIN_VALUE
    private var decisions: JSONObject = JSONObject()

    private fun current(): JSONObject {
        val stamp = runCatching { file.lastModified() }.getOrDefault(0L)
        val length = runCatching { file.length() }.getOrDefault(0L)
        if (stamp != seenStamp || length != seenLength) {
            seenStamp = stamp
            seenLength = length
            decisions = parse(runCatching { if (file.isFile) file.readText() else null }.getOrNull())
        }
        return decisions
    }

    /** The site's stored answer for `permission` (`allow` / `deny`), or null for none. */
    fun decision(origin: String, permission: String): String? = decision(current(), origin, permission)

    /** The user's default for `permission` (`deny` when every site's asking is off), or null for the built-in one. */
    fun defaultFor(permission: String): String? = decision(current(), DEFAULT_ORIGIN, permission)

    companion object {
        const val FILE = "zen/permissions.json"
        /** The core's key for a permission's default (`DEFAULT_ORIGIN` in `permissions.ts`). */
        const val DEFAULT_ORIGIN = "*"

        /** The `decisions` map of the store's document; empty for a file that is not there or not the shape. */
        fun parse(text: String?): JSONObject {
            if (text.isNullOrEmpty()) return JSONObject()
            val document = runCatching { JSONObject(text) }.getOrNull() ?: return JSONObject()
            return document.optJSONObject("decisions") ?: JSONObject()
        }

        fun decision(decisions: JSONObject, origin: String, permission: String): String? =
            decisions.strOrNull("$origin|$permission")?.takeIf { it == WebAppNotifications.ALLOW || it == WebAppNotifications.DENY }
    }
}
