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
 * The foreground service behind the capture card ([CaptureNotifications], NOT-13): while a page
 * holds the camera or the microphone, the process is one with a `camera` / `microphone` service
 * in the foreground, so the capture carries on behind other apps – a call in a tab keeps its
 * audio when the user switches to another app to read something – instead of being cut as
 * Android 11+ cuts a background app's capture (Chrome's "<site> is using your microphone"
 * notification runs on the same kind of service). The service's kind is the union of what the
 * pages hold, and moves with it: a camera joining a microphone re-enters the foreground as both.
 *
 * Android 14 lets a camera or microphone service start only while the app is in front; the
 * grant path starts it there, and a start the system refuses all the same is answered with the
 * card posted plainly ([foreground] false), the capture then at the system's mercy in the
 * background. The notification itself is [CaptureNotifications]'s, handed over to be the
 * service's and updated in place.
 *
 * Everything here runs in the browser's process: no binding, the live instance is a static.
 */
class CaptureService : Service() {
    private var foreground = false
    private var type = 0

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        instance = this
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // A start must be followed by startForeground whatever happens next (Android 8+ ends the
        // process otherwise): with the capture's card, or, when the capture ended while the
        // start was in flight, with whatever stands and a step back out at once.
        enter(pending ?: stub(), pendingType)
        if (!wantForeground) {
            demote()
            stopSelf(startId)
        }
        return START_NOT_STICKY
    }

    /** The user swiped the app out of Recents: the pages go with the task, and the card with them. */
    override fun onTaskRemoved(rootIntent: Intent?) {
        pending = null
        wantForeground = false
        demote()
        stopSelf()
    }

    override fun onDestroy() {
        foreground = false
        if (instance === this) instance = null
        super.onDestroy()
    }

    /** Enter the foreground as `type` (or stay there as a new type) with `notification`. */
    private fun enter(notification: Notification, type: Int): Boolean {
        val ok = runCatching {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R && type != 0) startForeground(NOTIFICATION_ID, notification, type)
            else startForeground(NOTIFICATION_ID, notification)
        }.onFailure { Log.w(TAG, "capture service could not enter the foreground as $type: $it") }.isSuccess
        if (ok) {
            foreground = true
            this.type = type
        }
        return ok
    }

    /** Leave the foreground and take the card down (the capture ended). */
    private fun demote() {
        if (!foreground) return
        foreground = false
        type = 0
        runCatching { stopForeground(STOP_FOREGROUND_REMOVE) }
    }

    private fun stub(): Notification {
        CaptureNotifications.ensureChannel(this)
        return NotificationCompat.Builder(this, CaptureLedger.CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_zenium)
            .setColor(ContextCompat.getColor(this, R.color.zen_accent))
            .setContentTitle(getString(R.string.app_name))
            .setSilent(true)
            .build()
    }

    companion object {
        private const val TAG = "ZenCapture"
        /** The capture card's id (the extensions' use 1, the media notification 2, the pages' 3, the private session 4, the updates' 5). */
        const val NOTIFICATION_ID = 6

        /** The notification the service shows, or updates to, and the kind it holds it as. */
        @Volatile
        private var pending: Notification? = null
        @Volatile
        private var pendingType = 0
        /** Whether a page captures (the service belongs in the foreground). */
        @Volatile
        private var wantForeground = false
        @Volatile
        private var instance: CaptureService? = null

        /** Whether the service stands in the foreground right now, for diagnostics and the demos. */
        val inForeground: Boolean get() = instance?.foreground == true

        /** The kind the service holds the foreground as (`ServiceInfo.FOREGROUND_SERVICE_TYPE_*` bits; 0 for none), for the demos. */
        val foregroundType: Int get() = instance?.takeIf { it.foreground }?.type ?: 0

        /**
         * The `startForeground` kind for `use`: the camera and microphone bits Android 11+ names
         * (the kinds a service may hold while the app is in the background); nothing on older
         * releases, whose `startForeground` takes no kind.
         */
        fun typeOf(use: CaptureUse): Int {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return 0
            var type = 0
            if (use.camera) type = type or ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA
            if (use.microphone) type = type or ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
            return type
        }

        /**
         * Show `notification` as a capturing page's: the service's notification, with the service
         * in the foreground as `type`. Already there, the notification is replaced in place, and
         * a change of kind re-enters the foreground as the new one. False when the system refused
         * the start (Android 14 refuses a camera or microphone service from an app in the
         * background) – the caller posts the card as a plain notification then.
         */
        fun foreground(context: Context, notification: Notification, type: Int): Boolean {
            pending = notification
            pendingType = type
            wantForeground = true
            val running = instance
            if (running != null && running.foreground) {
                if (running.type == type) {
                    runCatching { NotificationManagerCompat.from(context).notify(NOTIFICATION_ID, notification) }
                    return true
                }
                return running.enter(notification, type)
            }
            return runCatching {
                ContextCompat.startForegroundService(context, Intent(context, CaptureService::class.java))
                true
            }.onFailure { Log.w(TAG, "capture service refused to start: $it") }.getOrDefault(false)
        }

        /** The capture ended: the service leaves the foreground, takes the card down and stops. */
        fun background() {
            wantForeground = false
            pending = null
            pendingType = 0
            val running = instance ?: return
            running.demote()
            running.stopSelf()
        }
    }
}
