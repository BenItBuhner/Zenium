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
     * `MediaSessions`, `CaptureLedger`, `UpdateNotifications`, `PrivateSession`, `SitesChannels`,
     * `WebAppChannels`, `ExtensionNotifications`), spelled out here as literals so that a rename
     * fails this test: Android keeps the user's per-channel settings by id, and a renamed id would
     * orphan them. The one exception is the Sharing channel, re-made under a new id so it could go
     * high ([theLegacySharingIdIsDeletedOnUpgradeAndNeverReused]); the two new ids besides it are
     * the Browser channel and the General group.
     */
    @Test
    fun theIdsAreTheOnesThePostersUsedBeforeTheRegistry() {
        assertEquals("zenium.downloads", Notifications.DOWNLOADS.id)
        assertEquals("zenium.downloads.complete", Notifications.COMPLETED_DOWNLOADS.id)
        assertEquals("zenium.media", Notifications.MEDIA.id)
        assertEquals("zenium.capture", Notifications.CAPTURE.id)
        assertEquals("zenium.updates", Notifications.UPDATES.id)
        assertEquals("zenium.private", Notifications.PRIVATE.id)
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
        assertEquals("zenium.sharing.tabs", Notifications.SHARING.id)
    }

    /**
     * The Sharing channel went from the default importance to Chrome's high (a sent tab is
     * something the user is waiting to see), and Android never raises an existing channel's
     * importance – so the channel is re-made under a new id and the old `zenium.sharing` is in the
     * registry's legacy list, deleted at the first registration in a process, as Chrome deletes its
     * `LEGACY_CHANNEL_IDS` (the deletion itself, and its place before the fixed set, is pinned by
     * [theFirstRegistrationDeletesTheLegacyIdsThenMakesGeneralAndTheFixedSetOnce]). A deleted id
     * must never be given out again (Android un-deletes it with its old settings), so the old
     * literal may appear in the registry alone: no poster, no test helper, no driver builds on it.
     */
    @Test
    fun theLegacySharingIdIsDeletedOnUpgradeAndNeverReused() {
        assertEquals(listOf("zenium.sharing"), Notifications.legacy)
        assertEquals(NotificationManager.IMPORTANCE_HIGH, Notifications.SHARING.importance)
        val current = Notifications.fixed.map { it.id } + Notifications.groups.map { it.id }
        for (id in Notifications.legacy) assertFalse(id, id in current)
        val root = repoRoot()
        val sources = File(root, "android/app/src").walkTopDown().filter { it.isFile && it.extension == "kt" && it.name != "NotificationsTest.kt" }.toList()
        assertTrue(sources.size > 50)
        for (file in sources) {
            val code = file.readText().replace(Regex("""/\*[\s\S]*?\*/"""), "").lines().filterNot { it.trim().startsWith("//") }.joinToString("\n")
            for (id in Notifications.legacy) {
                if (file.name != "Notifications.kt") assertFalse("${file.name} carries the deleted channel id $id", code.contains("\"$id\""))
            }
        }
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
        // A group's id is never a channel's, a legacy id is neither, and no fixed channel sits under a dynamic family's prefix.
        assertTrue((channelIds.toSet() intersect groupIds.toSet()).isEmpty())
        val everyId = channelIds + groupIds + Notifications.legacy
        assertEquals(everyId.size, everyId.toSet().size)
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

    // --- the registration ---------------------------------------------------------------------------------

    /** A fake of the system's three channel calls that writes each one down in order; one call may be made to throw. */
    private class RecordingSystem : Notifications.ChannelSystem {
        val calls = mutableListOf<String>()
        var failOn: String? = null

        override fun delete(id: String) = record("delete $id")
        override fun group(group: Notifications.Group) = record("group ${group.id}")
        override fun channel(channel: Notifications.Channel) = record("channel ${channel.id}")

        private fun record(call: String) {
            calls += call
            if (call == failOn) throw IllegalStateException(call)
        }
    }

    /** What the process's first registration must do, in order: the legacy ids deleted, General made, the eight fixed channels made. */
    private val firstRegistration = listOf("delete zenium.sharing", "group zenium.general") + Notifications.fixed.map { "channel ${it.id}" }

    /**
     * The act behind the legacy list, pinned on a fake of the system: the process's first
     * `ensure` deletes the legacy ids before anything is created (an id deleted after its
     * re-creation would take the new channel with it), then makes General, then the eight fixed
     * channels in the settings page's order – and only that first call does. A later `ensure` of a
     * fixed channel makes nothing (it came with the set); a later `ensure` of a site's or an app's
     * channel makes its group and itself alone. Drop the deletion loop and this fails.
     */
    @Test
    fun theFirstRegistrationDeletesTheLegacyIdsThenMakesGeneralAndTheFixedSetOnce() {
        val system = RecordingSystem()
        val registrar = Notifications.Registrar()
        registrar.ensure(system, Notifications.DOWNLOADS)
        assertEquals(firstRegistration, system.calls)
        assertEquals("delete zenium.sharing", system.calls.first())
        system.calls.clear()
        registrar.ensure(system, Notifications.SHARING)
        assertEquals(emptyList<String>(), system.calls)
        val site = Notifications.site("https://news.example", 1L)
        registrar.ensure(system, site)
        assertEquals(listOf("group zenium.sites", "channel ${site.id}"), system.calls)
        system.calls.clear()
        val app = Notifications.webApp(sketch, 1L)
        registrar.ensure(system, app)
        assertEquals(listOf("group ${Notifications.webAppGroupId(sketch.shortcutId)}", "channel ${app.id}"), system.calls)
    }

    /** A site's channel on the process's first call: the whole registration first, the caller's group and channel after it. */
    @Test
    fun aDynamicChannelOnTheFirstCallComesAfterTheFixedSet() {
        val system = RecordingSystem()
        val site = Notifications.site("https://news.example", 1L)
        Notifications.Registrar().ensure(system, site)
        assertEquals(firstRegistration + listOf("group zenium.sites", "channel ${site.id}"), system.calls)
    }

    /**
     * A system call that fails is swallowed – every other call is still made and the poster still
     * posts – and the registration is tried again at the next call instead of being marked done
     * for the process; once every call went through, it is done and never repeated.
     */
    @Test
    fun aFailedRegistrationIsRetriedAtTheNextCallAndThenDone() {
        val system = RecordingSystem().apply { failOn = "channel ${Notifications.MEDIA.id}" }
        val registrar = Notifications.Registrar()
        registrar.ensure(system, Notifications.DOWNLOADS)
        assertEquals(firstRegistration, system.calls)
        system.calls.clear()
        system.failOn = null
        registrar.ensure(system, Notifications.DOWNLOADS)
        assertEquals(firstRegistration, system.calls)
        system.calls.clear()
        registrar.ensure(system, Notifications.DOWNLOADS)
        assertEquals(emptyList<String>(), system.calls)
    }

    /**
     * Nothing registers a channel on the boot path: the three files that run at start – the
     * Application, the Activity and the `Host` it builds – never call `Notifications.ensure` (a
     * poster does, at its first post) nor reach the registration behind it. A text pin, as
     * `PrivateLockTest` reads `Host.kt`: a registration added to `Host`'s body went green without it.
     */
    @Test
    fun nothingRegistersAChannelOnTheBootPath() {
        val sources = File(repoRoot(), "android/app/src/main/kotlin/app/zen/chromium")
        val registration = Regex("""\bNotifications\.ensure\(|\bregisterFixed\b|\bRegistrar\b|\bChannelSystem\b""")
        for (name in listOf("ZenApplication.kt", "MainActivity.kt", "Host.kt")) {
            val file = File(sources, name)
            assertTrue(name, file.isFile)
            val code = file.readText().replace(Regex("""/\*[\s\S]*?\*/"""), "").lines().filterNot { it.trim().startsWith("//") }.joinToString("\n")
            assertFalse("$name registers a notification channel on the boot path", registration.containsMatchIn(code))
        }
        // The registration has the one entry: `registerFixed` is private to the registrar, reached through `ensure` alone.
        val registry = File(sources, "Notifications.kt").readText()
        assertTrue(Regex("""private fun registerFixed\(""").containsMatchIn(registry))
        assertEquals(1, Regex("""registerFixed\(system\)""").findAll(registry).count())
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
     * Sharing (high, Chrome's – a sent tab must arrive as a heads-up; the channel was re-made
     * under a new id for it). Chrome shows a badge only for completed downloads and announcements.
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
            Triple(Notifications.SHARING, "Sharing", NotificationManager.IMPORTANCE_HIGH)
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
