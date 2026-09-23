package app.zen.chromium

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import org.json.JSONObject

/**
 * "<site> is using your microphone" (NOT-13): an ongoing card per capturing tab while a page
 * holds the camera or the microphone, on the app's Camera and microphone channel, with the
 * capture kept alive behind other apps by [CaptureService] – the oldest capture's card is the
 * service's own, the others ride beside it under the tab's tag. A tap brings the tab to the
 * front (`capture.reveal`, the core's `revealTab`).
 *
 * Two voices feed the [CaptureLedger]: the grant path in `Permissions.onPermissionRequest`
 * ([granted] – the card and the service at once, while the app is still in front, which is
 * when Android 14 lets a camera or microphone service start) and the page's own report
 * ([reported] – the shared `capture-state` fold the desktop's tab dot reads too, folded per tab
 * by the core and handed over as `capture.update`), which confirms, refines and ends the card.
 * The ledger's rules are its own; this class draws what it says and keeps the clock for an arm
 * no report confirms.
 */
class CaptureNotifications(private val host: Host) {
    private val context: Context = host.activity.applicationContext
    private val manager = NotificationManagerCompat.from(context)
    private val handler = Handler(Looper.getMainLooper())
    private val ledger = CaptureLedger()
    /** The tabs whose cards ride beside the service's, by tag, so a card that ended is taken down. */
    private val tagged = HashSet<String>()
    /** Whether the first card is up as a plain notification (the service's start was refused). */
    private var plain = false
    private var destroyed = false
    private val expiry = Runnable { if (ledger.expire(now())) render() else schedule() }

    init {
        // A card of the process before this one (the app died capturing): nothing captures now.
        manager.cancel(CaptureService.NOTIFICATION_ID)
    }

    /** The grant path: the page of `tabId` at `url` may capture `use` now (`Permissions.onPermissionRequest`). */
    fun granted(tabId: String, url: String, use: CaptureUse, private: Boolean) {
        if (destroyed) return
        if (ledger.granted(tabId, url, use, private, now())) render() else schedule()
    }

    /** `capture.update`: the core's fold of the tab's `capture-state` reports – what the page holds now. */
    fun reported(args: JSONObject) {
        if (destroyed) return
        val tabId = args.strOrNull("tabId") ?: return
        val use = CaptureUse(camera = args.bool("camera"), microphone = args.bool("microphone"))
        if (ledger.reported(tabId, args.str("url"), use, args.bool("private"))) render()
    }

    /** The page took a request back before it captured (`onPermissionRequestCanceled`). */
    fun cancelled(tabId: String) {
        if (destroyed) return
        if (ledger.cancelled(tabId)) render()
    }

    /** The tab is gone: its card with it. */
    fun ended(tabId: String) {
        if (destroyed) return
        if (ledger.ended(tabId)) render()
    }

    /** [MainActivity] got a card's tap: its tab comes to the front. */
    fun onOpenIntent(intent: Intent) {
        val tabId = intent.getStringExtra(EXTRA_TAB) ?: return
        host.hostEvent("capture.reveal", json("tabId" to tabId))
    }

    /** The cards as they stand (the demos read them). */
    fun cards(): List<CaptureCard> = ledger.cards()

    fun destroy() {
        destroyed = true
        handler.removeCallbacks(expiry)
        // The activity is going (a recreation or the end): the pages go with it, and the capture.
        CaptureService.background()
        manager.cancel(CaptureService.NOTIFICATION_ID)
        for (tabId in tagged) manager.cancel(tabId, CaptureService.NOTIFICATION_ID)
        tagged.clear()
    }

    private fun now(): Long = SystemClock.elapsedRealtime()

    private fun schedule() {
        handler.removeCallbacks(expiry)
        val deadline = ledger.nextDeadline() ?: return
        handler.postDelayed(expiry, (deadline - now()).coerceAtLeast(0L))
    }

    /** Draw the ledger: the first card as the service's, the rest beside it, nothing when nothing captures. */
    private fun render() {
        schedule()
        val cards = ledger.cards()
        val first = cards.firstOrNull()
        val rest = cards.drop(1)
        for (tabId in tagged - rest.map { it.tabId }.toSet()) manager.cancel(tabId, CaptureService.NOTIFICATION_ID)
        tagged.clear()
        if (first == null) {
            CaptureService.background()
            if (plain) manager.cancel(CaptureService.NOTIFICATION_ID)
            plain = false
            return
        }
        // With the app's notifications off the shade shows nothing, but the service still holds
        // the capture up behind other apps: the start is the point, the card its face.
        ensureChannel(context)
        val notification = build(first)
        val type = CaptureService.typeOf(ledger.use())
        if (CaptureService.foreground(context, notification, type)) {
            plain = false
        } else {
            // The system refused the service (the app was in the background at the start): the
            // card still says what is happening, as a plain notification.
            plain = true
            runCatching { manager.notify(CaptureService.NOTIFICATION_ID, notification) }
        }
        for (card in rest) {
            tagged += card.tabId
            runCatching { manager.notify(card.tabId, CaptureService.NOTIFICATION_ID, build(card)) }
        }
    }

    private fun build(card: CaptureCard): Notification =
        NotificationCompat.Builder(context, card.channelId)
            .setSmallIcon(R.drawable.ic_stat_zenium)
            .setColor(ContextCompat.getColor(context, R.color.zen_accent))
            .setContentTitle(card.title)
            .setContentIntent(openIntent(context, card.tabId))
            .setOngoing(card.ongoing)
            .setOnlyAlertOnce(card.onlyAlertOnce)
            .setSilent(card.silent)
            .setShowWhen(card.showWhen)
            .setLocalOnly(card.localOnly)
            .setVisibility(card.visibility)
            .setCategory(card.category)
            .build()

    companion object {
        const val ACTION_OPEN = "app.zen.chromium.CAPTURE_OPEN"
        const val EXTRA_TAB = "tabId"

        fun ensureChannel(context: Context) {
            val system = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            if (system.getNotificationChannel(CaptureLedger.CHANNEL_ID) != null) return
            system.createNotificationChannel(
                NotificationChannel(CaptureLedger.CHANNEL_ID, CaptureLedger.CHANNEL_NAME, NotificationManager.IMPORTANCE_LOW).apply {
                    description = CaptureLedger.CHANNEL_DESCRIPTION
                    setShowBadge(false)
                    enableVibration(false)
                    setSound(null, null)
                }
            )
        }

        private fun openIntent(context: Context, tabId: String): PendingIntent {
            val intent = Intent(context, MainActivity::class.java)
                .setAction(ACTION_OPEN)
                .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_NEW_TASK)
                .putExtra(EXTRA_TAB, tabId)
            return PendingIntent.getActivity(context, tabId.hashCode(), intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        }
    }
}
