package app.zen.chromium

import android.app.NotificationManager
import app.zen.chromium.ext.ExtensionNotifications
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * NOT-23: the one registry of the app's notification channels and groups – Chrome Android's
 * shape (General with the browser's fixed channels, Sites with one channel per site, the
 * extensions' and the installed apps' groups beside them), the ids byte-identical to the ones
 * the posters used before the registry existed, the names Chrome's in Zenium's voice.
 */
class NotificationsTest {
    private val sketch = InstalledWebApp("http://127.0.0.1:18131/app/manifest.json", "Sketch", "http://127.0.0.1:18131/app/", "http://127.0.0.1:18131/app/")

    // --- the ids ------------------------------------------------------------------------------------------

    /**
     * The ids the posters carried as their own literals before the registry (`DownloadNotifications`,
     * `MediaSessions`, `CaptureLedger`, `UpdateNotifications`, `PrivateSession`, `SharingChannel`,
     * `SitesChannels`, `WebAppChannels`, `ExtensionNotifications`), spelled out here as literals
     * so that a rename fails this test: Android keeps the user's per-channel settings by id, and a
     * renamed id would orphan them. The two new ids are the Browser channel and the General group.
     */
    @Test
    fun theIdsAreTheOnesThePostersUsedBeforeTheRegistry() {
        assertEquals("zenium.downloads", Notifications.DOWNLOADS.id)
        assertEquals("zenium.downloads.complete", Notifications.COMPLETED_DOWNLOADS.id)
        assertEquals("zenium.media", Notifications.MEDIA.id)
        assertEquals("zenium.capture", Notifications.CAPTURE.id)
        assertEquals("zenium.updates", Notifications.UPDATES.id)
        assertEquals("zenium.private", Notifications.PRIVATE.id)
        assertEquals("zenium.sharing", Notifications.SHARING.id)
        assertEquals("zenium.sites", Notifications.SITES.id)
        assertEquals("zenium.site:", Notifications.SITE_PREFIX)
        assertEquals("zenium.site:https://a.example;1700000000000", Notifications.site("https://a.example", 1_700_000_000_000L).id)
        assertEquals("zenium.webapp:", Notifications.WEBAPP_PREFIX)
        assertEquals("zenium.webapp:${sketch.shortcutId}", Notifications.webAppGroupId(sketch.shortcutId))
        assertEquals("zenium.webapp:${sketch.shortcutId};1700000000000", Notifications.webApp(sketch, 1_700_000_000_000L).id)
        assertEquals("zenium.extensions", Notifications.EXTENSIONS.id)
        assertEquals("zenium.ext.abc", ExtensionNotifications.channelId("abc"))
        // New with the registry.
        assertEquals("zenium.browser", Notifications.BROWSER.id)
        assertEquals("zenium.general", Notifications.GENERAL.id)
    }

    @Test
    fun everyIdIsItsOwn() {
        val channelIds = Notifications.fixed.map { it.id } +
            Notifications.site("https://a.example", 1L).id +
            Notifications.webApp(sketch, 1L).id +
            ExtensionNotifications.channelId("abc")
        assertEquals(channelIds.size, channelIds.toSet().size)
        val groupIds = Notifications.groups.map { it.id } + Notifications.webAppGroupId(sketch.shortcutId)
        assertEquals(groupIds.size, groupIds.toSet().size)
        // A group's id is never a channel's, and no fixed channel sits under a dynamic family's prefix.
        assertTrue((channelIds.toSet() intersect groupIds.toSet()).isEmpty())
        for (channel in Notifications.fixed) {
            assertFalse(channel.id, channel.id.startsWith(Notifications.SITE_PREFIX))
            assertFalse(channel.id, channel.id.startsWith(Notifications.WEBAPP_PREFIX))
            assertFalse(channel.id, channel.id.startsWith("zenium.ext."))
        }
        // The fixed list names every fixed channel once.
        assertEquals(8, Notifications.fixed.size)
        assertEquals(
            setOf(Notifications.BROWSER, Notifications.DOWNLOADS, Notifications.COMPLETED_DOWNLOADS, Notifications.PRIVATE, Notifications.MEDIA, Notifications.CAPTURE, Notifications.UPDATES, Notifications.SHARING),
            Notifications.fixed.toSet()
        )
    }

    // --- the posters ---------------------------------------------------------------------------------------

    /** Every card a poster builds on the JVM names a channel the registry has. */
    @Test
    fun everyPostersChannelIsInTheRegistry() {
        val fixedIds = Notifications.fixed.map { it.id }.toSet()
        assertTrue(UpdateNotifications.card("available", "0.5.3")!!.channelId in fixedIds)
        assertEquals(Notifications.UPDATES.id, UpdateNotifications.card("ready", "0.5.3")!!.channelId)
        assertEquals(Notifications.CAPTURE.id, CaptureLedger.card("t1", "https://meet.example", CaptureUse.MICROPHONE, false).channelId)
        assertEquals(Notifications.PRIVATE.id, PrivateSession.card(1).channelId)
        // The dynamic families build their channel through the registry too.
        assertEquals(Notifications.SITES, Notifications.site("https://a.example", 1L).group)
        assertEquals(Notifications.webAppGroupId(sketch.shortcutId), Notifications.webApp(sketch, 1L).group?.id)
    }

    /**
     * No poster makes a system channel of its own any more: the `NotificationChannel` and
     * `NotificationChannelGroup` constructors, and the manager's `create…` calls, appear in the
     * registry alone – and in the extension program's poster, which is its own (#132) and whose
     * group the registry lists by reference. No builder takes a literal channel id either.
     */
    @Test
    fun onlyTheRegistryMakesSystemChannels() {
        val root = repoRoot()
        val sources = File(root, "android/app/src/main/kotlin").walkTopDown().filter { it.isFile && it.extension == "kt" }.toList()
        assertTrue(sources.size > 50)
        val allowed = setOf("Notifications.kt", "ExtensionNotifications.kt")
        val construction = Regex("""\bNotificationChannel(Group)?\(|createNotificationChannel(Group)?\(""")
        val literalBuilder = Regex("""NotificationCompat\.Builder\([^,)]+,\s*"""")
        for (file in sources) {
            val code = file.readText().replace(Regex("""/\*[\s\S]*?\*/"""), "").lines().filterNot { it.trim().startsWith("//") }.joinToString("\n")
            if (file.name !in allowed) assertFalse("${file.name} makes a system channel of its own", construction.containsMatchIn(code))
            assertFalse("${file.name} hands the builder a literal channel id", literalBuilder.containsMatchIn(code))
        }
        // The extension poster's group is the registry's by reference, not a copy.
        assertEquals(ExtensionNotifications.GROUP_ID, Notifications.EXTENSIONS.id)
        assertEquals(ExtensionNotifications.GROUP_NAME, Notifications.EXTENSIONS.name)
    }

    // --- the groups ----------------------------------------------------------------------------------------

    /** Chrome's shape: the browser's fixed channels under General, the sites under Sites, each app under its own group. */
    @Test
    fun theGroupsAreChromes() {
        for (channel in Notifications.fixed) assertEquals(channel.id, Notifications.GENERAL, channel.group)
        assertEquals(listOf(Notifications.GENERAL, Notifications.SITES, Notifications.EXTENSIONS), Notifications.groups)
        assertEquals("General", Notifications.GENERAL.name)
        assertEquals("Sites", Notifications.SITES.name)
        assertEquals("Extensions", Notifications.EXTENSIONS.name)
        val app = Notifications.webApp(sketch, 1L)
        assertEquals("Sketch", app.group?.name)
        assertEquals("Sketch", app.name)
        assertEquals("Notifications from Sketch (127.0.0.1:18131)", app.description)
    }

    // --- the names ----------------------------------------------------------------------------------------

    /**
     * The display names and importances beside Chrome 152's (`ChromeChannelDefinitions.java`,
     * `browser_ui_strings.grd`, `android_chrome_strings.grd` on branch-heads/7977): Browser
     * (low), Active downloads (low), Completed downloads (low, badged), Incognito → Private
     * browsing (low), Playing media (low), Camera and microphone use (low), Updates (Chrome high;
     * Zenium's stays low – a silent reminder, and Android never raises an existing channel),
     * Sharing (Chrome high; Zenium's stays default for the same reason). Chrome shows a badge
     * only for completed downloads and announcements.
     */
    @Test
    fun theNamesAndImportancesAreChromesInZeniumsVoice() {
        val low = NotificationManager.IMPORTANCE_LOW
        val table = listOf(
            Triple(Notifications.BROWSER, "Browser", low),
            Triple(Notifications.DOWNLOADS, "Active downloads", low),
            Triple(Notifications.COMPLETED_DOWNLOADS, "Completed downloads", low),
            Triple(Notifications.PRIVATE, "Private browsing", low),
            Triple(Notifications.MEDIA, "Playing media", low),
            Triple(Notifications.CAPTURE, "Camera and microphone use", low),
            Triple(Notifications.UPDATES, "Updates", low),
            Triple(Notifications.SHARING, "Sharing", NotificationManager.IMPORTANCE_DEFAULT)
        )
        assertEquals(Notifications.fixed, table.map { it.first })
        for ((channel, name, importance) in table) {
            assertEquals(name, channel.name)
            assertEquals(name, importance, channel.importance)
        }
        // Chrome's four startup channels are in the fixed set: Browser, the active downloads, Incognito, the media.
        assertTrue(listOf(Notifications.BROWSER, Notifications.DOWNLOADS, Notifications.PRIVATE, Notifications.MEDIA).all { it in Notifications.fixed })
        // Badges: the completed download and the sent tab may dot the launcher icon; the ongoing status cards never.
        assertEquals(setOf(Notifications.COMPLETED_DOWNLOADS, Notifications.SHARING), Notifications.fixed.filter { it.badge }.toSet())
        // Quiet (no sound, no vibration whatever the importance): the ongoing status cards.
        assertEquals(setOf(Notifications.PRIVATE, Notifications.MEDIA, Notifications.CAPTURE, Notifications.UPDATES), Notifications.fixed.filter { it.quiet }.toSet())
        // A site's channel is named by its host, at Chrome's default importance; an app's by the app.
        assertEquals("news.example", Notifications.site("https://news.example", 1L).name)
        assertEquals(NotificationManager.IMPORTANCE_DEFAULT, Notifications.site("https://news.example", 1L).importance)
        assertEquals(NotificationManager.IMPORTANCE_DEFAULT, Notifications.webApp(sketch, 1L).importance)
    }

    /** §9.1: names and descriptions in sentence case – one capital, no full stop; a description is a sentence. */
    @Test
    fun theWordsAreSentenceCase() {
        for (channel in Notifications.fixed) {
            assertTrue(channel.name, channel.name.first().isUpperCase())
            assertTrue(channel.name, channel.name.split(' ').drop(1).none { it.first().isUpperCase() })
            assertTrue(channel.description, channel.description.first().isUpperCase() && !channel.description.endsWith("."))
        }
        for (group in Notifications.groups) assertTrue(group.name, group.name.first().isUpperCase() && group.name.split(' ').drop(1).none { it.first().isUpperCase() })
    }

    companion object {
        fun repoRoot(): File {
            var dir: File? = File(System.getProperty("user.dir") ?: ".").absoluteFile
            while (dir != null) {
                if (File(dir, "package.json").isFile && File(dir, "android").isDirectory) return dir
                dir = dir.parentFile
            }
            error("not inside the repository")
        }
    }
}
