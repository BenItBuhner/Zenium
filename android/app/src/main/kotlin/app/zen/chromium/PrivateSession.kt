package app.zen.chromium

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat

/**
 * The private session's presence outside the chrome, the Kotlin half of the core's
 * `PrivateSessionHost` (`Platform.privateSession`): while private tabs are open, a quiet,
 * ongoing notification offers to close them all, as Chrome Android's "Close all Incognito tabs"
 * does – the one way to end the session without opening the app and finding the tabs. It goes
 * with the last private tab (`private.setOpenTabs` 0), and a stale one – the process died with
 * private tabs open, which the core never restores – is taken down when the next [Host] starts,
 * together with [Profiles.wipePrivate].
 *
 * The button reaches [PrivateSessionReceiver], declared in the manifest, so a press on a stale
 * card after the process died still takes the card down; with the host alive it asks the core to
 * close every private tab (`private.closeAll`), and the count coming back to 0 ends the session
 * (the profile wipe, the downloads, the certificate decisions – `Browser.endPrivateSessionIfOver`).
 *
 * The window's screenshot guard while private browsing is on the screen (`FLAG_SECURE`, Chrome's
 * default for Incognito) is the chrome's to raise and release, through `window.setSecure`
 * ([PrivateBrowsing.guard]): the chrome knows the private new tab page, which has no page view,
 * and which pane the tab overview is on; a guess from the page views' visibility does not.
 */
class PrivateSession(private val host: Host) {
    private val context: Context = host.activity.applicationContext
    private val manager = NotificationManagerCompat.from(context)
    private var openTabs = 0

    init {
        live = this
        // A card a process that died with private tabs open left behind: the core never restores
        // them, so a session starts with none and the card comes down.
        manager.cancel(NOTIFICATION_ID)
    }

    /** `private.setOpenTabs`: how many private tabs there are now. */
    fun setOpenTabs(count: Int) {
        val before = openTabs
        openTabs = count.coerceAtLeast(0)
        if (openTabs == 0) {
            if (before > 0) manager.cancel(NOTIFICATION_ID)
            return
        }
        if (!manager.areNotificationsEnabled()) return
        ensureChannel(context)
        val notification = NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_private)
            .setContentTitle(TITLE)
            .setContentText(if (openTabs == 1) "1 private tab is open" else "$openTabs private tabs are open")
            .setContentIntent(closeAllIntent(context))
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setSilent(true)
            .setShowWhen(false)
            .setLocalOnly(true)
            // Not on the lock screen: what is private stays out of sight there, as Chrome keeps it.
            .setVisibility(NotificationCompat.VISIBILITY_SECRET)
            .setCategory(NotificationCompat.CATEGORY_STATUS)
            .build()
        runCatching { manager.notify(NOTIFICATION_ID, notification) }
    }

    /** The card's button: the core closes every private tab, and the count coming back takes the card down. */
    fun closeAll() {
        host.hostEvent("private.closeAll", null)
    }

    fun destroy() {
        if (live === this) live = null
        // The activity is going (a recreation or the end): the private tabs go with the core's
        // document, so the card has nothing left to close.
        manager.cancel(NOTIFICATION_ID)
    }

    companion object {
        /** Chrome's channel for it is "Incognito", low importance. */
        const val CHANNEL_ID = "zenium.private"
        const val CHANNEL_NAME = "Private browsing"
        const val TITLE = "Close all private tabs"
        /** The card's id (the extensions' use 1, the media notification 2, the pages' 3). */
        const val NOTIFICATION_ID = 4
        const val ACTION_CLOSE_ALL = "app.zen.chromium.PRIVATE_CLOSE_ALL"
        private const val REQUEST = 800

        /** The session of the live host, for the receiver. */
        @Volatile
        var live: PrivateSession? = null
            private set

        fun ensureChannel(context: Context) {
            val system = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            if (system.getNotificationChannel(CHANNEL_ID) != null) return
            system.createNotificationChannel(
                NotificationChannel(CHANNEL_ID, CHANNEL_NAME, NotificationManager.IMPORTANCE_LOW).apply {
                    description = "Shows while private tabs are open, to close them all at once"
                    setShowBadge(false)
                    enableVibration(false)
                    setSound(null, null)
                }
            )
        }

        private fun closeAllIntent(context: Context): PendingIntent {
            val intent = Intent(context, PrivateSessionReceiver::class.java).setAction(ACTION_CLOSE_ALL)
            return PendingIntent.getBroadcast(context, REQUEST, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        }
    }
}

/** "Close all private tabs" pressed on the private session's card (declared in the manifest, not exported). */
class PrivateSessionReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != PrivateSession.ACTION_CLOSE_ALL) return
        val session = PrivateSession.live
        if (session != null) session.closeAll()
        else NotificationManagerCompat.from(context).cancel(PrivateSession.NOTIFICATION_ID)
    }
}
