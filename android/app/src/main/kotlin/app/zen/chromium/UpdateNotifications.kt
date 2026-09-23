package app.zen.chromium

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import org.json.JSONObject

/**
 * The updates' presence on the shade (NOT-17), the Kotlin half of the core's `UpdateHost.notify`
 * (`update.notify`): "Update available" once the core has found a release, "Update ready" once
 * its APK is downloaded and verified, both on the app's own low-importance Updates channel and
 * both opening Settings › Updates – where the release notes, the Download and the Install
 * buttons are – through the `zenium://settings/updates` deep link [MainActivity] takes. One
 * card, updated in place as the phase moves on, taken down when neither edge stands (the update
 * installed, the check reset, an error) and when a host starts, so a card never outlives its
 * truth: the core says it again on its next check.
 */
class UpdateNotifications(context: Context) {
    private val context: Context = context.applicationContext
    private val manager = NotificationManagerCompat.from(this.context)

    init {
        // A card of the process before this one: the core has not checked yet, so nothing stands.
        manager.cancel(NOTIFICATION_ID)
    }

    /** `update.notify`: the core's notice (`{ kind, version }`), or null for none. */
    fun notify(notice: JSONObject?) {
        val card = card(notice?.strOrNull("kind"), notice?.strOrNull("version"))
        if (card == null) {
            manager.cancel(NOTIFICATION_ID)
            return
        }
        if (!manager.areNotificationsEnabled()) return
        ensureChannel(context)
        val notification = NotificationCompat.Builder(context, card.channelId)
            .setSmallIcon(R.drawable.ic_stat_zenium)
            .setColor(ContextCompat.getColor(context, R.color.zen_accent))
            .setContentTitle(card.title)
            .setContentText(card.text)
            .setContentIntent(openIntent(context))
            .setAutoCancel(card.autoCancel)
            .setOngoing(card.ongoing)
            .setOnlyAlertOnce(card.onlyAlertOnce)
            .setSilent(card.silent)
            .setShowWhen(card.showWhen)
            .setLocalOnly(card.localOnly)
            .setCategory(card.category)
            .build()
        runCatching { manager.notify(NOTIFICATION_ID, notification) }
    }

    /**
     * The card as plain values the builder reads (JVM-pinned in `UpdateNotificationsTest`): what
     * the shade shows and how the card behaves – on the Updates channel, silent, alerting once,
     * swiped away freely (the Settings page keeps the state; the card is a reminder, not the
     * state's home), this device's alone and without a time.
     */
    data class Card(
        val title: String,
        val text: String,
        val channelId: String,
        val autoCancel: Boolean,
        val ongoing: Boolean,
        val silent: Boolean,
        val onlyAlertOnce: Boolean,
        val localOnly: Boolean,
        val showWhen: Boolean,
        val category: String
    )

    companion object {
        /** Chrome's own updates arrive through Play; this channel is Zenium's for its APK updates. */
        const val CHANNEL_ID = "zenium.updates"
        const val CHANNEL_NAME = "Updates"
        const val CHANNEL_DESCRIPTION = "Tells you when a new version of Zenium is available and when it is ready to install"
        const val CHANNEL_IMPORTANCE = NotificationManager.IMPORTANCE_LOW
        const val TITLE_AVAILABLE = "Update available"
        const val TITLE_READY = "Update ready"
        /** The card's id (the extensions' use 1, the media notification 2, the pages' 3, the private session 4, the capture 6). */
        const val NOTIFICATION_ID = 5
        /** Where a tap goes: the Settings page the core keeps the update's state on. */
        const val OPEN_URL = "${DeepLinks.PAGE_SCHEME}://settings/updates"
        private const val REQUEST = 900

        /**
         * The card for a notice of `kind` (`available` or `ready`) about `version`, or null for
         * no notice, a kind the shade has no card for, or no version to name; see [Card].
         */
        fun card(kind: String?, version: String?): Card? {
            val named = version?.trim()?.takeIf(String::isNotEmpty) ?: return null
            val (title, text) = when (kind) {
                "available" -> TITLE_AVAILABLE to "Zenium $named is available"
                "ready" -> TITLE_READY to "Zenium $named is downloaded and ready to install"
                else -> return null
            }
            return Card(
                title = title,
                text = text,
                channelId = CHANNEL_ID,
                autoCancel = true,
                ongoing = false,
                silent = true,
                onlyAlertOnce = true,
                localOnly = true,
                showWhen = false,
                category = NotificationCompat.CATEGORY_RECOMMENDATION
            )
        }

        fun ensureChannel(context: Context) {
            val system = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            if (system.getNotificationChannel(CHANNEL_ID) != null) return
            system.createNotificationChannel(
                NotificationChannel(CHANNEL_ID, CHANNEL_NAME, CHANNEL_IMPORTANCE).apply {
                    description = CHANNEL_DESCRIPTION
                    setShowBadge(false)
                    enableVibration(false)
                    setSound(null, null)
                }
            )
        }

        /** A tap: the browser window on Settings › Updates (the `VIEW zenium://…` path of [MainActivity.handleIntent]). */
        private fun openIntent(context: Context): PendingIntent {
            val intent = Intent(Intent.ACTION_VIEW, Uri.parse(OPEN_URL))
                .setClass(context, MainActivity::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_NEW_TASK)
            return PendingIntent.getActivity(context, REQUEST, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        }
    }
}
