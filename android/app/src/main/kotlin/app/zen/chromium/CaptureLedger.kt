package app.zen.chromium

import androidx.core.app.NotificationCompat

/** What a page holds of the device: the camera, the microphone, both or neither (the WebView's two capture kinds). */
data class CaptureUse(val camera: Boolean, val microphone: Boolean) {
    val any: Boolean get() = camera || microphone

    /** Both uses together. */
    infix fun union(other: CaptureUse): CaptureUse = CaptureUse(camera || other.camera, microphone || other.microphone)

    companion object {
        val NONE = CaptureUse(camera = false, microphone = false)
        val CAMERA = CaptureUse(camera = true, microphone = false)
        val MICROPHONE = CaptureUse(camera = false, microphone = true)
        val BOTH = CaptureUse(camera = true, microphone = true)
    }
}

/**
 * One capturing tab's card as plain values the builder reads (NOT-13; JVM-pinned in
 * `CaptureLedgerTest`): "<site> is using your microphone", ongoing and silent on the low
 * Camera and microphone channel, this device's alone and without a time. A private tab's card
 * names no site – "A private tab is using your camera", Chrome's Incognito wording – and is
 * [NotificationCompat.VISIBILITY_SECRET], so nothing of it reaches the lock screen (INC-05).
 */
data class CaptureCard(
    val tabId: String,
    val title: String,
    val use: CaptureUse,
    val channelId: String,
    val visibility: Int,
    val ongoing: Boolean,
    val silent: Boolean,
    val onlyAlertOnce: Boolean,
    val localOnly: Boolean,
    val showWhen: Boolean,
    val category: String
)

/**
 * Which tabs are capturing, and what (NOT-13): the pure half of [CaptureNotifications], fed from
 * two sides and read for the cards and the service's kind.
 *
 * The grant path ([granted], `Permissions.onPermissionRequest`) ARMS a tab: the page may capture
 * now, so the card goes up at once and the service takes the foreground while the app is still
 * in front – Android 14 refuses a camera or microphone service started from the background, and
 * the page's first frames are seconds away. The page's own report ([reported], the shared
 * `capture-state` fold routed through `capture.update`) then RULES: it confirms the arm, refines
 * the kinds (a request for both the page opened with the microphone alone) and ends the card
 * when the tracks stop. An arm no report confirms within [confirmWindowMs] – the page never
 * opened the stream, or the document has no reporter – is dropped ([expire]), so a card never
 * outlives a capture that never happened. A request the page cancelled drops its arm
 * ([cancelled]); a tab gone drops everything of it ([ended]).
 */
class CaptureLedger(private val confirmWindowMs: Long = CONFIRM_WINDOW_MS) {
    private class Entry(
        var url: String,
        var private: Boolean,
        /** The grant path's word, until a report replaces it or the window closes. */
        var armed: CaptureUse,
        var armedAt: Long,
        /** The page's word, once it has spoken. */
        var reported: CaptureUse
    ) {
        val use: CaptureUse get() = armed union reported
    }

    /** By tab, oldest capture first: the first card is the service's own. */
    private val tabs = LinkedHashMap<String, Entry>()

    /** The grant path: the page of `tabId` at `url` may capture `use` from `now`. Whether the cards changed. */
    fun granted(tabId: String, url: String, use: CaptureUse, private: Boolean, now: Long): Boolean {
        if (!use.any) return false
        val before = snapshot()
        val entry = tabs[tabId]
        if (entry == null) {
            tabs[tabId] = Entry(url, private, use, now, CaptureUse.NONE)
        } else {
            entry.url = url
            entry.private = private
            entry.armed = entry.armed union use
            entry.armedAt = now
        }
        return snapshot() != before
    }

    /** The page's report of what it holds now: it rules, and closes any arm. Whether the cards changed. */
    fun reported(tabId: String, url: String, use: CaptureUse, private: Boolean): Boolean {
        val before = snapshot()
        if (!use.any) {
            tabs.remove(tabId)
        } else {
            val entry = tabs[tabId]
            if (entry == null) {
                tabs[tabId] = Entry(url, private, CaptureUse.NONE, 0L, use)
            } else {
                entry.url = url
                entry.private = private
                entry.armed = CaptureUse.NONE
                entry.reported = use
            }
        }
        return snapshot() != before
    }

    /** The page took its request back (`onPermissionRequestCanceled`): the arm goes, a capture it reported stays. */
    fun cancelled(tabId: String): Boolean {
        val before = snapshot()
        val entry = tabs[tabId] ?: return false
        entry.armed = CaptureUse.NONE
        if (!entry.use.any) tabs.remove(tabId)
        return snapshot() != before
    }

    /** The tab is gone (closed, its document replaced by one the core says holds nothing): everything of it goes. */
    fun ended(tabId: String): Boolean = tabs.remove(tabId) != null

    /** Time passed: an arm no report confirmed within the window is dropped. Whether the cards changed. */
    fun expire(now: Long): Boolean {
        val before = snapshot()
        val gone = ArrayList<String>()
        for ((tabId, entry) in tabs) {
            if (entry.armed.any && now - entry.armedAt >= confirmWindowMs) entry.armed = CaptureUse.NONE
            if (!entry.use.any) gone += tabId
        }
        for (tabId in gone) tabs.remove(tabId)
        return snapshot() != before
    }

    /** When the earliest arm's window closes, or null with nothing armed. */
    fun nextDeadline(): Long? = tabs.values.filter { it.armed.any }.minOfOrNull { it.armedAt + confirmWindowMs }

    /** Everything held, over every tab: the foreground service's kind. */
    fun use(): CaptureUse = tabs.values.fold(CaptureUse.NONE) { acc, entry -> acc union entry.use }

    /** The cards, oldest capture first. */
    fun cards(): List<CaptureCard> = tabs.map { (tabId, entry) -> card(tabId, entry.url, entry.use, entry.private) }

    val isEmpty: Boolean get() = tabs.isEmpty()

    private fun snapshot(): List<Triple<String, CaptureUse, Pair<String, Boolean>>> =
        tabs.map { (tabId, entry) -> Triple(tabId, entry.use, entry.url to entry.private) }

    companion object {
        /** How long a grant stands unconfirmed by the page's report before the card comes down. */
        const val CONFIRM_WINDOW_MS = 15_000L
        /** Chrome's channel for it is "Media capture"; the name says what the user sees the card about. */
        const val CHANNEL_ID = "zenium.capture"
        const val CHANNEL_NAME = "Camera and microphone"
        const val CHANNEL_DESCRIPTION = "Shows while a site is using your camera or microphone"
        const val PRIVATE_SUBJECT = "A private tab"

        /** What `use` is called on the card: Chrome's words, the camera first. */
        fun useLabel(use: CaptureUse): String = when {
            use.camera && use.microphone -> "camera and microphone"
            use.camera -> "camera"
            else -> "microphone"
        }

        /** The card for the tab of `tabId` at `url` holding `use`; see [CaptureCard]. */
        fun card(tabId: String, url: String, use: CaptureUse, private: Boolean): CaptureCard {
            val subject = if (private) PRIVATE_SUBJECT else SitesChannels.displayName(url)
            return CaptureCard(
                tabId = tabId,
                title = "$subject is using your ${useLabel(use)}",
                use = use,
                channelId = CHANNEL_ID,
                visibility = if (private) NotificationCompat.VISIBILITY_SECRET else NotificationCompat.VISIBILITY_PUBLIC,
                ongoing = true,
                silent = true,
                onlyAlertOnce = true,
                localOnly = true,
                showWhen = false,
                category = NotificationCompat.CATEGORY_STATUS
            )
        }
    }
}
