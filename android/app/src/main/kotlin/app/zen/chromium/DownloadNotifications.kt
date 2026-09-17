package app.zen.chromium

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import java.util.Locale

/**
 * The system notifications of the Zenium downloader: one silent, ongoing card per transfer with
 * a progress bar and Pause / Resume / Cancel actions (the actions go back through the core, which
 * owns the state), a "Download failed" card, and a "Download complete" card that opens the file.
 * The action buttons broadcast to a receiver registered for the life of the activity; a
 * transfer only runs while the process does, so nothing is lost when it goes.
 */
class DownloadNotifications(private val context: Context, private val onAction: (id: String, op: String) -> Unit) {
    private val manager = NotificationManagerCompat.from(context)
    private var channelsReady = false

    private val receiver = object : BroadcastReceiver() {
        override fun onReceive(c: Context, intent: Intent) {
            val id = intent.getStringExtra(EXTRA_ID) ?: return
            val op = intent.getStringExtra(EXTRA_OP) ?: return
            onAction(id, op)
        }
    }

    init {
        ContextCompat.registerReceiver(context, receiver, IntentFilter(ACTION), ContextCompat.RECEIVER_NOT_EXPORTED)
    }

    /**
     * The ongoing card of a transfer. A private transfer (a private window's tab) shows neither
     * the file name nor the site, only that Zenium is downloading and how far it got.
     */
    fun progress(id: String, filename: String, received: Long, total: Long, paused: Boolean, private: Boolean = false) {
        ensureChannels()
        val text = when {
            paused -> "Paused · ${formatBytes(received)}${if (total > 0) " of ${formatBytes(total)}" else ""}"
            total > 0 -> "${formatBytes(received)} of ${formatBytes(total)}"
            else -> formatBytes(received)
        }
        val builder = NotificationCompat.Builder(context, CHANNEL_PROGRESS)
            .setSmallIcon(android.R.drawable.stat_sys_download)
            .setContentTitle(if (private) PRIVATE_TITLE else filename)
            .setContentText(text)
            .setOngoing(!paused)
            .setOnlyAlertOnce(true)
            .setSilent(true)
            .setCategory(NotificationCompat.CATEGORY_PROGRESS)
            .setContentIntent(openApp())
            .setProgress(
                if (total > 0) 1000 else 0,
                if (total > 0) ((received * 1000) / total).toInt().coerceIn(0, 1000) else 0,
                total <= 0 && !paused
            )
        if (paused) builder.addAction(0, "Resume", action(id, "resume"))
        else builder.addAction(0, "Pause", action(id, "pause"))
        builder.addAction(0, "Cancel", action(id, "cancel"))
        post(TAG_PROGRESS, id, builder)
    }

    fun failed(id: String, filename: String, reason: String, private: Boolean = false) {
        ensureChannels()
        val builder = NotificationCompat.Builder(context, CHANNEL_PROGRESS)
            .setSmallIcon(android.R.drawable.stat_notify_error)
            .setContentTitle(if (private) "$PRIVATE_TITLE failed" else "Download failed")
            .setContentText(if (private) describe(reason) else "$filename · ${describe(reason)}")
            .setAutoCancel(true)
            .setSilent(true)
            .setCategory(NotificationCompat.CATEGORY_ERROR)
            .setContentIntent(openApp())
        post(TAG_PROGRESS, id, builder)
    }

    fun completed(id: String, filename: String, mimeType: String, uri: Uri?, private: Boolean = false) {
        ensureChannels()
        manager.cancel(TAG_PROGRESS, id.hashCode())
        val builder = NotificationCompat.Builder(context, CHANNEL_DONE)
            .setSmallIcon(android.R.drawable.stat_sys_download_done)
            .setContentTitle(if (private) "$PRIVATE_TITLE complete" else "Download complete")
            .setContentText(if (private) "Tap to open the file" else filename)
            .setAutoCancel(true)
            .setCategory(NotificationCompat.CATEGORY_STATUS)
        val view = uri?.let {
            Intent(Intent.ACTION_VIEW).apply {
                setDataAndType(it, mimeType.ifEmpty { "*/*" })
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
            }
        }
        builder.setContentIntent(
            if (view != null && view.resolveActivity(context.packageManager) != null)
                PendingIntent.getActivity(context, ("open:$id").hashCode(), view, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
            else openApp()
        )
        post(TAG_DONE, id, builder)
    }

    fun dismiss(id: String) {
        manager.cancel(TAG_PROGRESS, id.hashCode())
    }

    fun destroy() {
        runCatching { context.unregisterReceiver(receiver) }
    }

    private fun post(tag: String, id: String, builder: NotificationCompat.Builder) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) return
        runCatching { manager.notify(tag, id.hashCode(), builder.build()) }
    }

    private fun action(id: String, op: String): PendingIntent {
        val intent = Intent(ACTION).setPackage(context.packageName).putExtra(EXTRA_ID, id).putExtra(EXTRA_OP, op)
        return PendingIntent.getBroadcast(
            context, ("$id:$op").hashCode(), intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
    }

    private fun openApp(): PendingIntent {
        val intent = Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP).putExtra(EXTRA_SHOW_DOWNLOADS, true)
        return PendingIntent.getActivity(context, 0, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    }

    private fun ensureChannels() {
        if (channelsReady) return
        channelsReady = true
        val system = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        system.createNotificationChannel(
            NotificationChannel(CHANNEL_PROGRESS, "Downloads", NotificationManager.IMPORTANCE_LOW).apply {
                description = "Progress of files Zenium is downloading"
                setShowBadge(false)
            }
        )
        system.createNotificationChannel(
            NotificationChannel(CHANNEL_DONE, "Completed downloads", NotificationManager.IMPORTANCE_DEFAULT).apply {
                description = "A file Zenium downloaded is ready"
            }
        )
    }

    companion object {
        const val ACTION = "app.zen.chromium.DOWNLOAD_ACTION"
        const val EXTRA_ID = "id"
        const val EXTRA_OP = "op"
        const val EXTRA_SHOW_DOWNLOADS = "zenium.showDownloads"
        const val CHANNEL_PROGRESS = "zenium.downloads"
        const val CHANNEL_DONE = "zenium.downloads.complete"
        private const val TAG_PROGRESS = "zenium.download"
        private const val TAG_DONE = "zenium.download.done"
        /** What a private transfer's card says instead of the file name. */
        const val PRIVATE_TITLE = "Private download"

        fun formatBytes(bytes: Long): String {
            if (bytes < 1024) return "$bytes B"
            val units = arrayOf("KB", "MB", "GB", "TB")
            var value = bytes.toDouble() / 1024
            var unit = 0
            while (value >= 1024 && unit < units.size - 1) {
                value /= 1024
                unit++
            }
            return String.format(Locale.US, if (value >= 100) "%.0f %s" else "%.1f %s", value, units[unit])
        }

        /** Chrome's wording for its interrupt reasons. */
        fun describe(reason: String): String = when (reason) {
            "network-disconnected" -> "No internet"
            "network-timeout" -> "Network timed out"
            "network-failed" -> "Network error"
            "server-unauthorized" -> "Needs authorization"
            "server-forbidden" -> "Forbidden"
            "server-bad-content" -> "No file"
            "server-no-range" -> "Server problem"
            "server-failed" -> "Server problem"
            "file-no-space" -> "Not enough space"
            "file-access-denied" -> "Insufficient permissions"
            "shutdown" -> "Zenium was closed"
            else -> "Download error"
        }
    }
}
