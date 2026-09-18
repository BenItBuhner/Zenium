package app.zen.chromium.ext

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationChannelGroup
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.os.Build
import android.os.Handler
import android.os.Looper
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import app.zen.chromium.MainActivity
import app.zen.chromium.R
import org.json.JSONObject
import java.io.File
import java.util.concurrent.Executor

/**
 * `chrome.notifications` on the system shade: one notification channel per extension, named
 * after it (the user finds it under the app's notification settings, in an "Extensions" group)
 * and one card per notification id, edited in place by a re-post under the same tag. Chrome's
 * templates arrive flattened from the core (`src/android/extensionNotifications.ts`): title,
 * body, sub text, up to two buttons, a progress value, the icon and the hero picture as a
 * `data:` URL or a path inside the extension's directory.
 *
 * A tap and a button go through [MainActivity] (the extension's handler mostly opens a tab, which
 * wants the app in front), a swipe through a broadcast; each reaches [onEvent] as
 * `clicked` / `button` / `closed`. Android keeps the card across a process death, so a tap may
 * arrive before the extension runs again; [Extensions] holds it until then.
 */
class ExtensionNotifications(
    private val context: Context,
    private val io: Executor,
    private val onEvent: (extensionId: String, notificationId: String, event: String, index: Int) -> Unit
) {
    private val manager = NotificationManagerCompat.from(context)
    private val main = Handler(Looper.getMainLooper())
    /** Channels created in this process (creating one again is a no-op, but a lookup is cheaper). */
    private val channels = HashSet<String>()
    /** Per extension, the notification ids shown, to take them all down at once. */
    private val shown = HashMap<String, MutableSet<String>>()

    private val receiver = object : BroadcastReceiver() {
        override fun onReceive(c: Context, intent: Intent) {
            onIntent(intent)
        }
    }

    init {
        ContextCompat.registerReceiver(context, receiver, IntentFilter(ACTION_DISMISSED), ContextCompat.RECEIVER_NOT_EXPORTED)
    }

    /** Whether the app may post notifications right now (`getPermissionLevel`). */
    fun allowed(): Boolean =
        Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU ||
            ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED

    /**
     * Show (or replace) one notification. `dir` is the extension's directory for relative icon
     * paths; the images are decoded off the main thread and the card posted from there.
     */
    fun show(extensionId: String, dir: File?, n: JSONObject) {
        val notificationId = n.optString("notificationId")
        if (notificationId.isEmpty()) return
        val extensionName = n.optString("extensionName").ifEmpty { "Extension" }
        ensureChannel(extensionId, extensionName)
        shown.getOrPut(extensionId) { LinkedHashSet() }.add(notificationId)
        val iconUrl = n.optString("iconUrl").ifEmpty { null }
        val imageUrl = n.optString("imageUrl").ifEmpty { null }
        io.execute {
            val icon = iconUrl?.let { loadImage(dir, it, MAX_ICON_PX) }
            val picture = imageUrl?.let { loadImage(dir, it, MAX_PICTURE_PX) }
            main.post {
                // Taken down in the meantime: nothing to post.
                if (shown[extensionId]?.contains(notificationId) == true) post(extensionId, notificationId, n, icon, picture)
            }
        }
    }

    /** Take one down without an event (`clear`, the extension going). */
    fun hide(extensionId: String, notificationId: String) {
        shown[extensionId]?.remove(notificationId)
        manager.cancel(tag(extensionId, notificationId), NOTIFICATION_ID)
    }

    /** The extension is gone: its cards and its channel (Android remembers the channel's settings). */
    fun forget(extensionId: String) {
        for (id in shown.remove(extensionId).orEmpty()) manager.cancel(tag(extensionId, id), NOTIFICATION_ID)
        if (channels.remove(channelId(extensionId))) {
            runCatching { systemManager().deleteNotificationChannel(channelId(extensionId)) }
        }
    }

    /** A tap, button or swipe intent (from [MainActivity] or the dismiss receiver). */
    fun onIntent(intent: Intent): Boolean {
        val extensionId = intent.getStringExtra(EXTRA_EXTENSION) ?: return false
        val notificationId = intent.getStringExtra(EXTRA_NOTIFICATION) ?: return false
        val event = intent.getStringExtra(EXTRA_EVENT) ?: return false
        val index = intent.getIntExtra(EXTRA_INDEX, 0)
        if (event != EVENT_CLOSED) {
            // Android dismisses a tapped card itself (autoCancel); a button leaves it, Chrome does not.
            manager.cancel(tag(extensionId, notificationId), NOTIFICATION_ID)
        }
        shown[extensionId]?.remove(notificationId)
        onEvent(extensionId, notificationId, event, index)
        return true
    }

    fun destroy() {
        runCatching { context.unregisterReceiver(receiver) }
    }

    private fun post(extensionId: String, notificationId: String, n: JSONObject, icon: Bitmap?, picture: Bitmap?) {
        if (!allowed()) return
        val title = n.optString("title")
        val body = n.optString("body")
        val subText = n.optString("subText")
        val builder = NotificationCompat.Builder(context, channelId(extensionId))
            .setSmallIcon(R.drawable.ic_stat_zenium)
            .setContentTitle(title)
            .setContentText(body.lineSequence().firstOrNull() ?: "")
            .setAutoCancel(true)
            .setOnlyAlertOnce(true)
            .setPriority(priority(n.optInt("priority", 0)))
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .setContentIntent(activityIntent(extensionId, notificationId, EVENT_CLICKED, 0))
            .setDeleteIntent(dismissIntent(extensionId, notificationId))
        if (subText.isNotEmpty()) builder.setSubText(subText)
        if (n.optBoolean("silent", false)) builder.setSilent(true)
        if (icon != null) builder.setLargeIcon(icon)
        val eventTime = n.optLong("eventTime", 0L)
        if (eventTime > 0) builder.setWhen(eventTime).setShowWhen(true)
        val progress = if (n.isNull("progress")) -1 else n.optInt("progress", -1)
        if (progress in 0..100) builder.setProgress(100, progress, false)
        if (picture != null) {
            builder.setStyle(NotificationCompat.BigPictureStyle().bigPicture(picture).setSummaryText(body))
        } else if (body.contains('\n') || body.length > 40) {
            builder.setStyle(NotificationCompat.BigTextStyle().bigText(body))
        }
        val buttons = n.optJSONArray("buttons")
        if (buttons != null) {
            for (i in 0 until minOf(buttons.length(), MAX_BUTTONS)) {
                val label = buttons.optString(i)
                if (label.isEmpty()) continue
                builder.addAction(0, label, activityIntent(extensionId, notificationId, EVENT_BUTTON, i))
            }
        }
        runCatching { manager.notify(tag(extensionId, notificationId), NOTIFICATION_ID, builder.build()) }
    }

    private fun ensureChannel(extensionId: String, extensionName: String) {
        val id = channelId(extensionId)
        if (!channels.add(id)) return
        val system = systemManager()
        system.createNotificationChannelGroup(NotificationChannelGroup(GROUP_ID, GROUP_NAME))
        system.createNotificationChannel(
            NotificationChannel(id, extensionName, NotificationManager.IMPORTANCE_DEFAULT).apply {
                description = "Notifications from the $extensionName extension"
                group = GROUP_ID
            }
        )
    }

    private fun systemManager(): NotificationManager =
        context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager

    private fun activityIntent(extensionId: String, notificationId: String, event: String, index: Int): PendingIntent {
        val intent = Intent(context, MainActivity::class.java)
            .setAction(ACTION_OPENED)
            .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_NEW_TASK)
            .putExtra(EXTRA_EXTENSION, extensionId)
            .putExtra(EXTRA_NOTIFICATION, notificationId)
            .putExtra(EXTRA_EVENT, event)
            .putExtra(EXTRA_INDEX, index)
        return PendingIntent.getActivity(
            context, requestCode(extensionId, notificationId, event, index), intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
    }

    private fun dismissIntent(extensionId: String, notificationId: String): PendingIntent {
        val intent = Intent(ACTION_DISMISSED).setPackage(context.packageName)
            .putExtra(EXTRA_EXTENSION, extensionId)
            .putExtra(EXTRA_NOTIFICATION, notificationId)
            .putExtra(EXTRA_EVENT, EVENT_CLOSED)
        return PendingIntent.getBroadcast(
            context, requestCode(extensionId, notificationId, EVENT_CLOSED, 0), intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
    }

    /** One pending intent per (card, event, button): the extras differ, so the codes have to. */
    private fun requestCode(extensionId: String, notificationId: String, event: String, index: Int): Int =
        "$extensionId/$notificationId/$event/$index".hashCode()

    private fun loadImage(dir: File?, url: String, maxPx: Int): Bitmap? {
        val bytes = imageBytes(dir, url) ?: return null
        return runCatching {
            val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
            BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
            BitmapFactory.decodeByteArray(bytes, 0, bytes.size, BitmapFactory.Options().apply { inSampleSize = sampleSize(bounds.outWidth, bounds.outHeight, maxPx) })
        }.getOrNull()
    }

    companion object {
        /** The activity intent of a tap or a button (`MainActivity.handleIntent`). */
        const val ACTION_OPENED = "app.zen.chromium.EXT_NOTIFICATION"
        /** The broadcast of a swipe (the receiver above). */
        const val ACTION_DISMISSED = "app.zen.chromium.EXT_NOTIFICATION_DISMISSED"
        const val EXTRA_EXTENSION = "ext"
        const val EXTRA_NOTIFICATION = "notification"
        const val EXTRA_EVENT = "event"
        const val EXTRA_INDEX = "index"
        const val EVENT_CLICKED = "clicked"
        const val EVENT_BUTTON = "button"
        const val EVENT_CLOSED = "closed"
        const val GROUP_ID = "zenium.extensions"
        const val GROUP_NAME = "Extensions"
        /** Every card has its own tag; the numeric id is constant. */
        const val NOTIFICATION_ID = 1
        const val MAX_BUTTONS = 2
        private const val MAX_ICON_PX = 256
        private const val MAX_PICTURE_PX = 1024

        fun channelId(extensionId: String): String = "zenium.ext.$extensionId"
        fun tag(extensionId: String, notificationId: String): String = "zenium.ext/$extensionId/$notificationId"

        /** Chrome's -2..2 onto Android's pre-channel priorities (channels decide on Android 8+). */
        fun priority(chrome: Int): Int = when {
            chrome >= 2 -> NotificationCompat.PRIORITY_MAX
            chrome == 1 -> NotificationCompat.PRIORITY_HIGH
            chrome == -1 -> NotificationCompat.PRIORITY_LOW
            chrome <= -2 -> NotificationCompat.PRIORITY_MIN
            else -> NotificationCompat.PRIORITY_DEFAULT
        }

        /**
         * The bytes of an `iconUrl` / `imageUrl` as Chrome resolves them: a `data:` URL, or a path
         * inside the extension (`chrome-extension://<id>/x.png`, `/x.png` and `x.png` alike; one
         * that escapes the directory is nothing). Anything else (an http URL) is not fetched;
         * Chrome refuses those too.
         */
        fun imageBytes(dir: File?, url: String): ByteArray? = runCatching {
            if (url.startsWith("data:")) {
                val comma = url.indexOf(',')
                if (comma < 0) return null
                return if (url.substring(0, comma).endsWith(";base64")) java.util.Base64.getMimeDecoder().decode(url.substring(comma + 1).trim())
                else java.net.URLDecoder.decode(url.substring(comma + 1), "UTF-8").toByteArray()
            }
            val relative = url.replace(Regex("^chrome-extension://[a-p]{32}"), "")
            if (Regex("^[a-zA-Z][a-zA-Z0-9+.-]*:").containsMatchIn(relative)) return null
            val file = fileIn(dir ?: return null, relative) ?: return null
            if (file.isFile) file.readBytes() else null
        }.getOrNull()

        /** The power-of-two subsampling that brings a `width` x `height` image near `maxPx`. */
        fun sampleSize(width: Int, height: Int, maxPx: Int): Int {
            var sample = 1
            while (width / sample > maxPx * 2 || height / sample > maxPx * 2) sample *= 2
            return sample
        }

        private fun fileIn(dir: File, path: String): File? {
            val file = File(dir, path.trimStart('/'))
            val canonical = runCatching { file.canonicalPath }.getOrNull() ?: return null
            val root = runCatching { dir.canonicalPath }.getOrNull() ?: return null
            if (!canonical.startsWith(root + File.separator)) return null
            return file
        }
    }
}
