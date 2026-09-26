package app.zen.chromium

import android.app.NotificationChannel
import android.app.NotificationChannelGroup
import android.app.NotificationManager
import android.content.Context
import app.zen.chromium.ext.ExtensionNotifications

/**
 * The app's notification channels and their groups, named once (NOT-23): what Android's
 * notification settings list for Zenium, in Chrome Android's shape – a "General" group with the
 * browser's own fixed channels under it, a "Sites" group with one channel per site that may
 * notify, and beside them the extensions' group (#132) and one group per installed web app
 * (PWA-02). Every poster takes its channel from here: the ids are the ones the posters used
 * before this registry existed and never change (Android keeps the user's per-channel settings
 * by id, so a renamed id would orphan them); the display names and importances follow Chrome's
 * where a Chrome channel matches, in Zenium's voice.
 *
 * Nothing here runs on the boot path. A channel is created at its poster's first use through
 * [ensure], and the first such call in a process registers the whole fixed set – Chrome's
 * startup channels, made once per process on the first post of any notification rather than in
 * the Application or the Activity. On a system that already has a channel under the id,
 * `createNotificationChannel` updates its name, its description and its group (a channel that
 * had none), lowers an importance the user never touched, and leaves everything the user set
 * alone – so an upgrader's channels move under General and take the aligned names with their
 * settings intact.
 *
 * The plain [Channel] and [Group] values are what the JVM tests read (`NotificationsTest`); the
 * system's [NotificationChannel] is built from them in [ensure] alone, and nowhere else in the
 * app (the test scans the sources for that).
 */
object Notifications {
    /** A channel group as the system's notification settings list it. */
    class Group(val id: String, val name: String)

    /**
     * A channel as the registry defines it. [badge] is whether the launcher may dot the icon for
     * the channel's notifications (Chrome: only completed downloads and announcements); [quiet]
     * is no vibration and no sound whatever the importance – the ongoing status cards.
     */
    class Channel(
        val id: String,
        val name: String,
        val importance: Int,
        val group: Group?,
        val description: String,
        val badge: Boolean = true,
        val quiet: Boolean = false
    )

    // --- the groups -----------------------------------------------------------------------------------

    /** Chrome's "General": the browser's own channels. */
    val GENERAL = Group("zenium.general", "General")

    /** Chrome's "Sites": one channel per site that may notify ([SitesChannels]). */
    val SITES = Group("zenium.sites", "Sites")

    /** The extensions' group, one channel per extension; the extension program's poster (`ExtensionNotifications`) makes them. */
    val EXTENSIONS = Group(ExtensionNotifications.GROUP_ID, ExtensionNotifications.GROUP_NAME)

    // --- the fixed channels, Chrome's General group ---------------------------------------------------------

    /** Chrome's "Browser": the app's own notices that belong to no other channel. Nothing posts on it yet. */
    val BROWSER = Channel(
        "zenium.browser", "Browser", NotificationManager.IMPORTANCE_LOW, GENERAL,
        "Notices from Zenium itself that fit no other category", badge = false
    )

    /** Chrome's "Active downloads": the ongoing progress cards and a failed transfer. */
    val DOWNLOADS = Channel(
        "zenium.downloads", "Active downloads", NotificationManager.IMPORTANCE_LOW, GENERAL,
        "Progress of files Zenium is downloading", badge = false
    )

    /** Chrome's "Completed downloads", low as Chrome's: the card sits in the shade, no chime. */
    val COMPLETED_DOWNLOADS = Channel(
        "zenium.downloads.complete", "Completed downloads", NotificationManager.IMPORTANCE_LOW, GENERAL,
        "A file Zenium downloaded is ready"
    )

    /** Chrome's "Incognito", in Zenium's voice: the "Close all private tabs" card ([PrivateSession]). */
    val PRIVATE = Channel(
        "zenium.private", "Private browsing", NotificationManager.IMPORTANCE_LOW, GENERAL,
        "Shows while private tabs are open, to close them all at once", badge = false, quiet = true
    )

    /** Chrome's "Playing media": the media session's controls ([MediaSessions], [MediaPlaybackService]). */
    val MEDIA = Channel(
        "zenium.media", "Playing media", NotificationManager.IMPORTANCE_LOW, GENERAL,
        "Controls for audio and video playing in Zenium", badge = false, quiet = true
    )

    /** Chrome's "Camera and microphone use": the capture ledger's cards ([CaptureNotifications], [CaptureService]). */
    val CAPTURE = Channel(
        "zenium.capture", "Camera and microphone use", NotificationManager.IMPORTANCE_LOW, GENERAL,
        "Shows while a site is using your camera or microphone", badge = false, quiet = true
    )

    /**
     * Chrome's "Updates". Chrome's is high; Zenium's card is a silent reminder (NOT-17) and
     * Android never raises an existing channel's importance, so low it stays.
     */
    val UPDATES = Channel(
        "zenium.updates", "Updates", NotificationManager.IMPORTANCE_LOW, GENERAL,
        "Tells you when a new version of Zenium is available and when it is ready to install", badge = false, quiet = true
    )

    /** Chrome's "Sharing": tabs sent from the user's other devices ([SharingChannel]). Chrome's is high; see [UPDATES]. */
    val SHARING = Channel(
        "zenium.sharing", "Sharing", NotificationManager.IMPORTANCE_DEFAULT, GENERAL,
        "Tabs sent from your other devices"
    )

    /** Every fixed channel, in the order the settings page is meant to read them; all under [GENERAL]. */
    val fixed: List<Channel> = listOf(BROWSER, DOWNLOADS, COMPLETED_DOWNLOADS, PRIVATE, MEDIA, CAPTURE, UPDATES, SHARING)

    /** The fixed groups; an installed web app adds its own ([webAppGroup]). */
    val groups: List<Group> = listOf(GENERAL, SITES, EXTENSIONS)

    // --- the sites' channels (Chrome's Sites group) ---------------------------------------------------------

    /** What every site channel's id starts with; the origin and the time it was made follow. */
    const val SITE_PREFIX = "zenium.site:"

    /** What every channel id of `origin` starts with; the time it was made follows ([SitesChannels.find] reads by it). */
    fun sitePrefix(origin: String): String = "$SITE_PREFIX$origin;"

    /**
     * The channel of `origin`, made at `madeAt`: named by the site's host, under Sites. The id
     * carries the time because Android remembers a deleted channel's settings by id – a site
     * blocked, forgotten and allowed again would come back blocked otherwise, as Chrome found.
     */
    fun site(origin: String, madeAt: Long): Channel {
        val name = SitesChannels.displayName(origin)
        return Channel("${sitePrefix(origin)}$madeAt", name, NotificationManager.IMPORTANCE_DEFAULT, SITES, "Notifications from $name")
    }

    // --- an installed web app's channel (PWA-02) ----------------------------------------------------------

    /** What every web app group and channel id starts with. */
    const val WEBAPP_PREFIX = "zenium.webapp:"

    /** The id of the app's own group: one per installed app, so the settings list the app as one thing to silence. */
    fun webAppGroupId(shortcutId: String): String = "$WEBAPP_PREFIX$shortcutId"

    /** The app's group, named for it. */
    fun webAppGroup(shortcutId: String, name: String): Group = Group(webAppGroupId(shortcutId), name)

    /** What every channel id of the app starts with; the time it was made follows ([WebAppChannels.find] reads by it). */
    fun webAppPrefix(shortcutId: String): String = "$WEBAPP_PREFIX$shortcutId;"

    /** The app's channel under its group, made at `madeAt` (the time for the same reason as a site's). */
    fun webApp(app: InstalledWebApp, madeAt: Long): Channel = Channel(
        "${webAppPrefix(app.shortcutId)}$madeAt", app.name, NotificationManager.IMPORTANCE_DEFAULT,
        webAppGroup(app.shortcutId, app.name), "Notifications from ${app.name} (${SitesChannels.displayName(app.origin)})"
    )

    // --- registration ------------------------------------------------------------------------------------

    private var registered = false

    /**
     * The channel a poster is about to post on, made if the system has none under its id, and –
     * once per process, on the first call – the whole fixed set with its group. Synchronized so a
     * second poster on another thread never posts before the first call has made its channel.
     * Returns the channel's id for the builder.
     */
    @Synchronized
    fun ensure(context: Context, channel: Channel): String {
        val system = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        registerFixed(system)
        if (fixed.none { it.id == channel.id }) {
            runCatching {
                channel.group?.let { system.createNotificationChannelGroup(NotificationChannelGroup(it.id, it.name)) }
                system.createNotificationChannel(toSystem(channel))
            }
        }
        return channel.id
    }

    private fun registerFixed(system: NotificationManager) {
        if (registered) return
        registered = true
        runCatching { system.createNotificationChannelGroup(NotificationChannelGroup(GENERAL.id, GENERAL.name)) }
        for (channel in fixed) runCatching { system.createNotificationChannel(toSystem(channel)) }
    }

    private fun toSystem(channel: Channel): NotificationChannel =
        NotificationChannel(channel.id, channel.name, channel.importance).apply {
            description = channel.description
            group = channel.group?.id
            setShowBadge(channel.badge)
            if (channel.quiet) {
                enableVibration(false)
                setSound(null, null)
            }
        }
}
