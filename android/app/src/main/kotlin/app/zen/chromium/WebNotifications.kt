package app.zen.chromium

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationChannelGroup
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Build
import android.os.Handler
import android.os.Looper
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import org.json.JSONObject
import java.net.URI
import java.util.concurrent.Executor

/**
 * The pages' Web Notifications on the system shade, the Kotlin half of the core's
 * `WebNotificationHost` (`Platform.webNotifications`, `AndroidPlatform` in
 * `src/android/platform.ts`): the WebView hides `Notification` from pages, so the page script
 * polyfills it, the core answers from the shared permission model, and what a site was allowed
 * to show arrives here as `notification.show`.
 *
 * Chrome Android's shape: one notification channel per site, named after it and filed under a
 * "Sites" group in the app's notification settings, so the user can silence or block one site
 * from the system's side ([SitesChannels]); a site whose channel the user blocked there has its
 * permission in the browser follow (`notification.blocked`, and the core sets the site to
 * blocked). A notification with a tag replaces the site's earlier one under the same tag, a tap
 * brings the page's tab forward (`notification.event` `click`, through [MainActivity]), a swipe
 * reports `close`. Icons are fetched off the main thread; the card is posted from there.
 */
class WebNotifications(private val host: Host, private val io: Executor) {
    private val context: Context = host.activity.applicationContext
    private val manager = NotificationManagerCompat.from(context)
    private val main = Handler(Looper.getMainLooper())
    private val channels = SitesChannels(context)

    /** A notification up (or being posted), by the core's id. */
    private class Shown(val origin: String, val tag: String)
    private val shown = LinkedHashMap<String, Shown>()
    private var destroyed = false

    private val receiver = object : BroadcastReceiver() {
        override fun onReceive(c: Context, intent: Intent) {
            onIntent(intent)
        }
    }

    init {
        ContextCompat.registerReceiver(context, receiver, IntentFilter(ACTION_DISMISSED), ContextCompat.RECEIVER_NOT_EXPORTED)
    }

    /** Whether the app may post notifications at all right now (the system's switch, Android 13's permission). */
    fun allowed(): Boolean = manager.areNotificationsEnabled() &&
        (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU ||
            ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) == android.content.pm.PackageManager.PERMISSION_GRANTED)

    // --- the core's WebNotificationHost ------------------------------------------------------------

    /**
     * `notification.ensureAllowed`: the app's own right to post (Android 13+ asks the user once,
     * as Chrome does when a site is first allowed); answers whether it has it.
     */
    fun ensureAllowed(reply: (Any?) -> Unit) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
            reply(manager.areNotificationsEnabled())
            return
        }
        host.permissions.requestForApp(Manifest.permission.POST_NOTIFICATIONS) { grant -> reply(grant == RuntimeGrant.GRANTED) }
    }

    /** `notification.show`: post `args` (a `WebNotificationRequest`); answers whether it went up. */
    fun show(args: JSONObject, reply: (Any?) -> Unit) {
        val id = args.strOrNull("id")
        val origin = args.strOrNull("origin")?.takeIf(String::isNotEmpty)
        if (id == null || origin == null || destroyed || !allowed()) {
            reply(false)
            return
        }
        val channelId = channels.ensure(origin)
        if (channels.blocked(channelId)) {
            // The user blocked the site in the system's notification settings: Chrome makes that
            // the site's permission, so the page reads `denied` from now on rather than posting into the void.
            host.hostEvent("notification.blocked", json("origin" to origin))
            reply(false)
            return
        }
        val tag = args.str("tag")
        // The same tag under the same site: the earlier notification is the one being replaced.
        if (tag.isNotEmpty()) {
            val replaced = shown.entries.firstOrNull { it.key != id && it.value.origin == origin && it.value.tag == tag }?.key
            if (replaced != null) {
                shown.remove(replaced)
                host.hostEvent("notification.event", json("id" to replaced, "event" to "replaced"))
            }
        }
        shown[id] = Shown(origin, tag)
        val iconUrl = args.strOrNull("icon")?.takeIf(String::isNotEmpty)
        val post = { icon: android.graphics.Bitmap? ->
            // Closed while the icon was on its way: nothing to post.
            if (!destroyed && shown.containsKey(id)) {
                val ok = runCatching { manager.notify(notificationTag(id, origin, tag), NOTIFICATION_ID, build(id, channelId, args, icon)) }.isSuccess
                if (!ok) shown.remove(id)
                reply(ok)
            } else reply(false)
        }
        if (iconUrl == null) {
            post(null)
            return
        }
        io.execute {
            val icon = MediaSessions.fetchBitmap(iconUrl, MAX_ICON_PX)
            main.post { post(icon) }
        }
    }

    /** `notification.close`: take one down without an event (the page's `close()`, the core's cap). */
    fun close(id: String) {
        val entry = shown.remove(id) ?: return
        manager.cancel(notificationTag(id, entry.origin, entry.tag), NOTIFICATION_ID)
    }

    /** `notification.forgetOrigin`: the site's permission was withdrawn – its notifications and its channel go. */
    fun forgetOrigin(origin: String) {
        for ((id, entry) in shown.entries.toList()) {
            if (entry.origin != origin) continue
            shown.remove(id)
            manager.cancel(notificationTag(id, origin, entry.tag), NOTIFICATION_ID)
        }
        channels.delete(origin)
    }

    // --- what comes back from the shade -----------------------------------------------------------

    /** [MainActivity] got a tap's intent: the page's tab comes forward (or its page opens again). */
    fun onOpenIntent(intent: Intent) {
        onIntent(intent)
    }

    private fun onIntent(intent: Intent): Boolean {
        val id = intent.getStringExtra(EXTRA_ID) ?: return false
        val event = intent.getStringExtra(EXTRA_EVENT) ?: return false
        shown.remove(id)
        val payload = json("id" to id, "event" to event)
        intent.getStringExtra(EXTRA_URL)?.let { payload.put("url", it) }
        host.hostEvent("notification.event", payload)
        return true
    }

    fun destroy() {
        destroyed = true
        runCatching { context.unregisterReceiver(receiver) }
    }

    // --- the card ------------------------------------------------------------------------------------

    private fun build(id: String, channelId: String, args: JSONObject, icon: android.graphics.Bitmap?): android.app.Notification {
        val origin = args.str("origin")
        val title = args.str("title")
        val body = args.str("body")
        val url = args.str("url")
        val tag = args.str("tag")
        val builder = NotificationCompat.Builder(context, channelId)
            .setSmallIcon(R.drawable.ic_stat_zenium)
            .setContentTitle(title)
            .setContentText(body.lineSequence().firstOrNull() ?: "")
            // Chrome shows the site under the text, as its own line.
            .setSubText(SitesChannels.displayName(origin))
            .setAutoCancel(true)
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .setContentIntent(activityIntent(id, url))
            .setDeleteIntent(dismissIntent(id))
            // A replace under a tag is quiet unless the page asked to be heard again (`renotify`).
            .setOnlyAlertOnce(tag.isNotEmpty() && !args.bool("renotify"))
        if (args.bool("silent")) builder.setSilent(true)
        if (icon != null) builder.setLargeIcon(icon)
        val timestamp = args.num("timestamp").toLong()
        if (timestamp > 0) builder.setWhen(timestamp).setShowWhen(true)
        if (body.contains('\n') || body.length > 40) builder.setStyle(NotificationCompat.BigTextStyle().bigText(body))
        return builder.build()
    }

    private fun activityIntent(id: String, url: String): PendingIntent {
        val intent = Intent(context, MainActivity::class.java)
            .setAction(ACTION_OPENED)
            .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_NEW_TASK)
            .putExtra(EXTRA_ID, id)
            .putExtra(EXTRA_EVENT, EVENT_CLICK)
        if (url.isNotEmpty()) intent.putExtra(EXTRA_URL, url)
        return PendingIntent.getActivity(context, requestCode(id, EVENT_CLICK), intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    }

    private fun dismissIntent(id: String): PendingIntent {
        val intent = Intent(ACTION_DISMISSED).setPackage(context.packageName)
            .putExtra(EXTRA_ID, id)
            .putExtra(EXTRA_EVENT, EVENT_CLOSE)
        return PendingIntent.getBroadcast(context, requestCode(id, EVENT_CLOSE), intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    }

    /** One pending intent per (notification, event): the extras differ, so the codes have to. */
    private fun requestCode(id: String, event: String): Int = "$id/$event".hashCode()

    companion object {
        /** The activity intent of a tap (`MainActivity.handleIntent`). */
        const val ACTION_OPENED = "app.zen.chromium.WEB_NOTIFICATION"
        /** The broadcast of a swipe (the receiver above). */
        const val ACTION_DISMISSED = "app.zen.chromium.WEB_NOTIFICATION_DISMISSED"
        const val EXTRA_ID = "id"
        const val EXTRA_EVENT = "event"
        const val EXTRA_URL = "url"
        const val EVENT_CLICK = "click"
        const val EVENT_CLOSE = "close"
        /** Every card has its own tag; the numeric id is constant (the extensions' use 1, the media notification 2). */
        const val NOTIFICATION_ID = 3
        private const val MAX_ICON_PX = 256

        /**
         * The Android tag a page's notification posts under: a page tag makes it the site's one
         * notification by that tag (a later one with the same replaces it, as the spec says);
         * without one, each notification is its own.
         */
        fun notificationTag(id: String, origin: String, tag: String): String =
            if (tag.isNotEmpty()) "zenium.web/$origin/tag:$tag" else "zenium.web/$id"
    }
}

/**
 * The sites' notification channels, Chrome Android's way: one per origin, named after the site
 * and grouped under "Sites" in the app's notification settings. A channel's id carries the time
 * it was made ([SitesChannels.ensure]) because Android remembers a deleted channel by id – a site
 * blocked, forgotten and allowed again would come back blocked otherwise, as Chrome found.
 */
class SitesChannels(private val context: Context) {
    private val system: NotificationManager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    /** Origin → channel id, for the channels seen in this process (the system is asked otherwise). */
    private val known = HashMap<String, String>()

    /** The channel for `origin`, made if the site has none yet; its id. */
    fun ensure(origin: String): String {
        known[origin]?.let { return it }
        val existing = find(origin)
        if (existing != null) {
            known[origin] = existing
            return existing
        }
        val id = "$PREFIX$origin;${System.currentTimeMillis()}"
        runCatching {
            system.createNotificationChannelGroup(NotificationChannelGroup(GROUP_ID, GROUP_NAME))
            system.createNotificationChannel(
                NotificationChannel(id, displayName(origin), NotificationManager.IMPORTANCE_DEFAULT).apply {
                    description = "Notifications from ${displayName(origin)}"
                    group = GROUP_ID
                }
            )
        }
        known[origin] = id
        return id
    }

    /** The user turned the site's channel off in the system settings. */
    fun blocked(channelId: String): Boolean =
        runCatching { system.getNotificationChannel(channelId)?.importance == NotificationManager.IMPORTANCE_NONE }.getOrDefault(false)

    /** The site's channel goes (its permission was withdrawn); Android keeps its settings under the old id, which is why ids carry a time. */
    fun delete(origin: String) {
        val id = known.remove(origin) ?: find(origin) ?: return
        runCatching { system.deleteNotificationChannel(id) }
    }

    /** The channel id under which `origin`'s notifications live, from the system's list, or null. */
    fun find(origin: String): String? {
        val prefix = "$PREFIX$origin;"
        return runCatching { system.notificationChannels.firstOrNull { it.id.startsWith(prefix) }?.id }.getOrNull()
    }

    companion object {
        const val PREFIX = "zenium.site:"
        const val GROUP_ID = "zenium.sites"
        /** Chrome's group for the sites' channels. */
        const val GROUP_NAME = "Sites"

        /** How a site reads on its channel and under its notifications: the host (with a port when it has one), no scheme. */
        fun displayName(origin: String): String {
            val uri = runCatching { URI(origin) }.getOrNull()
            val host = uri?.host?.takeIf(String::isNotEmpty) ?: return origin
            val port = uri.port
            return if (port > 0) "$host:$port" else host
        }
    }
}
