package app.zen.chromium

import android.app.NotificationChannel
import android.app.NotificationChannelGroup
import android.app.NotificationManager
import android.content.Context
import android.os.Build
import org.json.JSONObject
import java.io.File

/**
 * An installed web app's own notification identity (PWA-02): a notification channel GROUP per
 * installed app, named for the app, with the app's channel under it – the shape of the sites'
 * "Sites" group ([SitesChannels], NOT-23) and the extensions' per-extension channels
 * (`ExtensionNotifications`, #132), so the system's notification settings list the app as one
 * thing to silence or block, and the shade's card reads as the app's ("Zenium • <app>", the
 * app's tile) rather than as its site's. A WebAPK would be its own package with its own name on
 * the shade's header; Zenium mints none (a system-WebView browser, no spend), so this is the
 * platform's ceiling for a pinned shortcut's app.
 *
 * A page of the app posts under the app's channel wherever it runs – the app's own window
 * ([WebAppActivity], `WebAppNotifications`) or a tab of the browser inside the app's scope
 * ([WebNotifications]) – and the site's own channel is left alone for its pages outside the
 * scope. The channel's id carries the time it was made, as the sites' do: Android remembers a
 * deleted channel's settings by id, and an app blocked, uninstalled and installed again would
 * come back blocked otherwise.
 */
class WebAppChannels(context: Context) {
    private val system: NotificationManager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    private val installed = InstalledWebApps(File(context.filesDir, INSTALLED_FILE))
    /** Shortcut id → channel id, for the channels seen in this process (the system is asked otherwise). */
    private val known = HashMap<String, String>()

    /** The installed app whose scope holds `url` (the longest scope wins), or null: the page is a site's alone. */
    fun appFor(url: String): InstalledWebApp? = installed.appFor(url)

    /** The installed apps as the core's `webapps.json` lists them now. */
    fun apps(): List<InstalledWebApp> = installed.all()

    /** The app's channel, made with its group if the app has none yet; its id. */
    fun ensure(app: InstalledWebApp): String {
        known[app.shortcutId]?.let { return it }
        val existing = find(app.shortcutId)
        if (existing != null) {
            known[app.shortcutId] = existing
            return existing
        }
        val id = channelId(app.shortcutId, System.currentTimeMillis())
        runCatching {
            system.createNotificationChannelGroup(NotificationChannelGroup(groupId(app.shortcutId), app.name))
            system.createNotificationChannel(
                NotificationChannel(id, app.name, NotificationManager.IMPORTANCE_DEFAULT).apply {
                    description = "Notifications from ${app.name} (${SitesChannels.displayName(app.origin)})"
                    group = groupId(app.shortcutId)
                }
            )
        }
        known[app.shortcutId] = id
        return id
    }

    /** The user turned the app's channel – or its whole group – off in the system settings. */
    fun blocked(channelId: String): Boolean = runCatching {
        val channel = system.getNotificationChannel(channelId) ?: return false
        if (channel.importance == NotificationManager.IMPORTANCE_NONE) return true
        val group = channel.group ?: return false
        Build.VERSION.SDK_INT >= Build.VERSION_CODES.P && system.getNotificationChannelGroup(group)?.isBlocked == true
    }.getOrDefault(false)

    /** The channel id under which the app's notifications live, from the system's list, or null. */
    fun find(shortcutId: String): String? {
        val prefix = channelPrefix(shortcutId)
        return runCatching { system.notificationChannels.firstOrNull { it.id.startsWith(prefix) }?.id }.getOrNull()
    }

    /** The app's channel and its group go (the app was uninstalled, or its site's permission withdrawn). */
    fun delete(shortcutId: String) {
        val id = known.remove(shortcutId) ?: find(shortcutId)
        runCatching {
            if (id != null) system.deleteNotificationChannel(id)
            system.deleteNotificationChannelGroup(groupId(shortcutId))
        }
    }

    /** Every installed app of `origin` loses its channel: the site's permission was withdrawn ([WebNotifications.forgetOrigin]). */
    fun deleteForOrigin(origin: String) {
        for (app in installed.all()) if (app.origin == origin) delete(app.shortcutId)
    }

    companion object {
        /** The core's registry of the apps on the Home screen (`src/core/webapp.ts`, under `files/zen/`). */
        const val INSTALLED_FILE = "zen/webapps.json"
        const val PREFIX = "zenium.webapp:"

        /** The app's group: one per installed app, named for it. */
        fun groupId(shortcutId: String): String = "$PREFIX$shortcutId"

        /** What every channel id of the app starts with; the time it was made follows. */
        fun channelPrefix(shortcutId: String): String = "$PREFIX$shortcutId;"

        fun channelId(shortcutId: String, madeAt: Long): String = "${channelPrefix(shortcutId)}$madeAt"
    }
}

/**
 * An app on the Home screen as the core's `webapps.json` lists it (`PinnedWebApp`: the id, the
 * launcher's name, the start URL and the scope). The list is the truth of "installed": an entry
 * arrives with the launcher's confirmation of the pin and leaves with the uninstall, so a pin
 * the user cancelled and an app removed are both no app here.
 */
class InstalledWebApp(val id: String, val name: String, val startUrl: String, val scope: String) {
    /** The launcher's id for the app's shortcut, the name of its record and tile ([WebAppStore]) and of its channel group. */
    val shortcutId: String get() = Shortcuts.shortcutId(id)

    /** The scope's origin (`scheme://host[:port]`), the site the app's pages belong to; the scope itself when it is no URL. */
    val origin: String get() = WebAppRules.origin(scope) ?: scope
}

/**
 * The core's `webapps.json` read from disk, and re-read when the file changed (its size or its
 * time: the core writes a fresh file under the name on every change). A stat per question, a
 * parse per change; a file that is not there, or not the shape, is an empty list.
 */
class InstalledWebApps(private val file: File) {
    private var seenStamp = Long.MIN_VALUE
    private var seenLength = Long.MIN_VALUE
    private var apps: List<InstalledWebApp> = emptyList()

    fun all(): List<InstalledWebApp> {
        val stamp = runCatching { file.lastModified() }.getOrDefault(0L)
        val length = runCatching { file.length() }.getOrDefault(0L)
        if (stamp != seenStamp || length != seenLength) {
            seenStamp = stamp
            seenLength = length
            apps = parse(runCatching { if (file.isFile) file.readText() else null }.getOrNull())
        }
        return apps
    }

    fun appFor(url: String): InstalledWebApp? = appFor(url, all())

    companion object {
        /** The pinned list of the store's document (`{version: 1, pinned: [...]}`); an entry without its four words is skipped. */
        fun parse(text: String?): List<InstalledWebApp> {
            if (text.isNullOrEmpty()) return emptyList()
            val document = runCatching { JSONObject(text) }.getOrNull() ?: return emptyList()
            val pinned = document.optJSONArray("pinned") ?: return emptyList()
            val out = ArrayList<InstalledWebApp>(pinned.length())
            for (i in 0 until pinned.length()) {
                val entry = pinned.optJSONObject(i) ?: continue
                val id = entry.strOrNull("id")?.takeIf { it.isNotEmpty() } ?: continue
                val startUrl = entry.strOrNull("startUrl")?.takeIf { it.isNotEmpty() } ?: continue
                val scope = entry.strOrNull("scope")?.takeIf { it.isNotEmpty() } ?: continue
                out += InstalledWebApp(id, entry.strOrNull("name")?.ifBlank { null } ?: startUrl, startUrl, scope)
            }
            return out
        }

        /**
         * The app whose scope holds `url`, the longest scope winning when apps nest (the core's
         * `pinnedAppFor`, `shared/webApp.ts`); null when no installed app's scope does.
         */
        fun appFor(url: String, apps: List<InstalledWebApp>): InstalledWebApp? {
            var best: InstalledWebApp? = null
            for (app in apps) {
                if (!WebAppRules.inScope(url, app.scope)) continue
                if (best == null || app.scope.length > best.scope.length) best = app
            }
            return best
        }
    }
}
