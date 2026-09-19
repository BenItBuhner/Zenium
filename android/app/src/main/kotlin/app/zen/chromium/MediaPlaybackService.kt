package app.zen.chromium

import android.app.Notification
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat

/**
 * The foreground service behind the media notification ([MediaSessions]): while a page plays,
 * the process is one with a `mediaPlayback` service in the foreground, so the audio carries on
 * behind other apps and under the lock screen instead of being frozen with the rest of the app
 * (Chrome's media notification runs on the same kind of service). The notification itself is
 * [MediaSessions]'s: it is handed over here to be the service's, and updated in place from
 * there. Paused, the service leaves the foreground with the notification still up ([demote]) –
 * a paused notification can be swiped away, a playing one cannot – and stops; the session gone,
 * the notification goes with it.
 *
 * Everything here runs in the browser's process: no binding, the live instance is a static.
 */
class MediaPlaybackService : Service() {
    private var foreground = false

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        instance = this
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // A start must be followed by startForeground whatever happens next (Android 8+ ends the
        // process otherwise): with the session's notification, or, when the session paused or
        // ended while the start was in flight, with whatever stands and a step back out at once.
        val notification = pending ?: stub()
        foreground = runCatching {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK)
            else startForeground(NOTIFICATION_ID, notification)
        }.onFailure { Log.w(TAG, "media playback service could not enter the foreground: $it") }.isSuccess
        if (!wantForeground) {
            demote(keepNotification = pending != null)
            stopSelf(startId)
        }
        return START_NOT_STICKY
    }

    /** The user swiped the app out of Recents: the media stops with it, as Chrome's does. */
    override fun onTaskRemoved(rootIntent: Intent?) {
        pending = null
        wantForeground = false
        demote(keepNotification = false)
        stopSelf()
    }

    override fun onDestroy() {
        foreground = false
        if (instance === this) instance = null
        super.onDestroy()
    }

    /** Leave the foreground, keeping the notification up (a paused session) or taking it down (none). */
    fun demote(keepNotification: Boolean) {
        if (!foreground) return
        foreground = false
        runCatching {
            stopForeground(if (keepNotification) STOP_FOREGROUND_DETACH else STOP_FOREGROUND_REMOVE)
        }
    }

    private fun stub(): Notification {
        MediaSessions.ensureChannel(this)
        return NotificationCompat.Builder(this, MediaSessions.CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_zenium)
            .setContentTitle(getString(R.string.app_name))
            .setSilent(true)
            .build()
    }

    companion object {
        private const val TAG = "ZenMedia"
        /** The media notification's id (the extensions' cards use 1 with tags, the downloads' their own hashes). */
        const val NOTIFICATION_ID = 2

        /** The notification the service shows, or updates to. */
        @Volatile
        private var pending: Notification? = null
        /** Whether the session is playing (the service belongs in the foreground). */
        @Volatile
        private var wantForeground = false
        @Volatile
        private var instance: MediaPlaybackService? = null

        /**
         * Show `notification` as a playing session's: the service's notification, with the service
         * in the foreground. Already there, the notification is replaced in place. False when the
         * system refused the start (Android 12+ refuses one from an app in the background without a
         * user's press behind it) – the caller posts the notification as a plain one then.
         */
        fun foreground(context: Context, notification: Notification): Boolean {
            pending = notification
            wantForeground = true
            val running = instance
            if (running != null && running.foreground) {
                NotificationManagerCompat.from(context).notify(NOTIFICATION_ID, notification)
                return true
            }
            return runCatching {
                ContextCompat.startForegroundService(context, Intent(context, MediaPlaybackService::class.java))
                true
            }.onFailure { Log.w(TAG, "media playback service refused to start: $it") }.getOrDefault(false)
        }

        /** The session paused (`keepNotification`) or ended: the service leaves the foreground and stops. */
        fun background(keepNotification: Boolean) {
            wantForeground = false
            if (!keepNotification) pending = null
            val running = instance ?: return
            running.demote(keepNotification)
            running.stopSelf()
        }
    }
}
