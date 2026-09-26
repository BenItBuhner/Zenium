package app.zen.chromium

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** An installed app's notification identity (PWA-02): its channel group, its cards, the installed list it is read from. */
class WebAppChannelsTest {
    private val sketch = InstalledWebApp("http://127.0.0.1:18131/app/manifest.json", "Sketch", "http://127.0.0.1:18131/app/", "http://127.0.0.1:18131/app/")

    // --- the app's group and channel -------------------------------------------------------------------

    @Test
    fun theAppsGroupAndChannelAreNamedByItsShortcutId() {
        val id = sketch.shortcutId
        val channel = Notifications.webApp(sketch, 1700000000000L)
        assertEquals("zenium.webapp:$id", Notifications.webAppGroupId(id))
        assertEquals("zenium.webapp:$id;1700000000000", channel.id)
        assertTrue(channel.id.startsWith(Notifications.webAppPrefix(id)))
        // The channel and its group carry the app's name; the description names the app and its site.
        assertEquals("Sketch", channel.name)
        assertEquals(Notifications.webAppGroupId(id), channel.group?.id)
        assertEquals("Sketch", channel.group?.name)
        assertEquals("Notifications from Sketch (127.0.0.1:18131)", channel.description)
        // The group's id is no channel of the app's: `find` reads the channels by their prefix, and the group has none.
        assertFalse(Notifications.webAppGroupId(id).startsWith(Notifications.webAppPrefix(id)))
        // Apart from the sites' channels and their one group.
        assertFalse(Notifications.webAppGroupId(id).startsWith(Notifications.SITE_PREFIX))
        assertNotEquals(Notifications.SITES.id, Notifications.webAppGroupId(id))
    }

    @Test
    fun aChannelMadeAgainLaterIsAnotherIdUnderTheSamePrefix() {
        // Android remembers a deleted channel's settings by id: an app blocked, uninstalled and
        // installed again comes back with a fresh channel, found by the prefix all the same.
        val id = sketch.shortcutId
        val first = Notifications.webApp(sketch, 1_000L).id
        val again = Notifications.webApp(sketch, 2_000L).id
        assertNotEquals(first, again)
        assertTrue(first.startsWith(Notifications.webAppPrefix(id)) && again.startsWith(Notifications.webAppPrefix(id)))
        // Another app's prefix never matches: the shortcut id ends at the `;`.
        assertFalse(first.startsWith(Notifications.webAppPrefix("$id-2")))
    }

    @Test
    fun theShortcutIdIsTheLaunchersAndTheTilesOne() {
        assertEquals(Shortcuts.shortcutId(sketch.id), sketch.shortcutId)
        assertTrue(sketch.shortcutId.startsWith("webapp-"))
    }

    // --- the app's origin ---------------------------------------------------------------------------------

    @Test
    fun theAppsOriginIsItsScopesSiteAsTheCoreWritesIt() {
        assertEquals("http://127.0.0.1:18131", sketch.origin)
        assertEquals("https://app.example", InstalledWebApp("a", "A", "https://app.example/x/", "https://App.Example:443/x/").origin)
        assertEquals("https://app.example:8443", InstalledWebApp("a", "A", "https://app.example:8443/", "https://app.example:8443/").origin)
        // A scope that is no URL stands as it is rather than as nothing.
        assertEquals("not a url", InstalledWebApp("a", "A", "x", "not a url").origin)
    }

    @Test
    fun anOriginFoldsTheDefaultPortAndRefusesWhatIsNoWebUrl() {
        assertEquals("https://a.example", WebAppRules.origin("https://a.example:443/path?q=1#f"))
        assertEquals("http://a.example", WebAppRules.origin("HTTP://A.Example:80/"))
        assertEquals("http://a.example:8080", WebAppRules.origin("http://a.example:8080/"))
        assertNull(WebAppRules.origin("about:blank"))
        assertNull(WebAppRules.origin("zen-webapp://webapp-abc"))
        assertNull(WebAppRules.origin(""))
        assertNull(WebAppRules.origin(null))
    }

    // --- the installed list -------------------------------------------------------------------------------

    @Test
    fun theStoresPinnedListIsTheInstalledApps() {
        val apps = InstalledWebApps.parse(
            """{"version":1,"pinned":[
                {"id":"https://a.example/m.json","name":"Alpha","startUrl":"https://a.example/","scope":"https://a.example/","pinnedAt":1},
                {"id":"https://b.example/m.json","startUrl":"https://b.example/app/","scope":"https://b.example/app/"}
            ],"engagement":{}}"""
        )
        assertEquals(listOf("Alpha", "https://b.example/app/"), apps.map { it.name })
        assertEquals(listOf("https://a.example/", "https://b.example/app/"), apps.map { it.scope })
        assertEquals("https://b.example/m.json", apps[1].id)
    }

    @Test
    fun anEntryMissingItsWordsIsSkippedAndAFileOfAnotherShapeIsNoApp() {
        assertTrue(InstalledWebApps.parse(null).isEmpty())
        assertTrue(InstalledWebApps.parse("").isEmpty())
        assertTrue(InstalledWebApps.parse("not json").isEmpty())
        assertTrue(InstalledWebApps.parse("""{"version":1}""").isEmpty())
        assertTrue(InstalledWebApps.parse("""{"pinned":"nope"}""").isEmpty())
        val apps = InstalledWebApps.parse(
            """{"pinned":[
                {"id":"x"},
                {"name":"n","startUrl":"https://a.example/","scope":"https://a.example/"},
                7,
                {"id":"ok","name":"  ","startUrl":"https://c.example/","scope":"https://c.example/"}
            ]}"""
        )
        assertEquals(1, apps.size)
        assertEquals("ok", apps[0].id)
        // A blank name reads as the start URL, as the tile would.
        assertEquals("https://c.example/", apps[0].name)
    }

    @Test
    fun thePageBelongsToTheAppWhoseScopeHoldsItTheLongestScopeWinning() {
        val outer = InstalledWebApp("o", "Outer", "https://a.example/", "https://a.example/")
        val inner = InstalledWebApp("i", "Inner", "https://a.example/mail/", "https://a.example/mail/")
        val apps = listOf(outer, inner)
        assertEquals("Inner", InstalledWebApps.appFor("https://a.example/mail/inbox", apps)?.name)
        assertEquals("Outer", InstalledWebApps.appFor("https://a.example/docs", apps)?.name)
        assertEquals("Inner", InstalledWebApps.appFor("https://a.example/mail/inbox", apps.reversed())?.name)
        assertNull(InstalledWebApps.appFor("https://other.example/mail/", apps))
        assertNull(InstalledWebApps.appFor("not a url", apps))
        assertNull(InstalledWebApps.appFor("https://a.example/", emptyList()))
    }

    // --- the browser's answers for the sites --------------------------------------------------------------

    @Test
    fun theBrowsersAnswerForTheSiteIsReadAsTheCoreKeepsIt() {
        val decisions = SiteDecisions.parse(
            """{"version":1,"decisions":{
                "https://a.example|notifications":"allow",
                "https://b.example|notifications":"deny",
                "https://c.example|notifications":"ask",
                "*|notifications":"deny",
                "https://a.example|camera":"deny"
            }}"""
        )
        assertEquals("allow", SiteDecisions.decision(decisions, "https://a.example", "notifications"))
        assertEquals("deny", SiteDecisions.decision(decisions, "https://b.example", "notifications"))
        // Only the two standing answers count: `ask` is no decision, and a site not there has none.
        assertNull(SiteDecisions.decision(decisions, "https://c.example", "notifications"))
        assertNull(SiteDecisions.decision(decisions, "https://d.example", "notifications"))
        assertEquals("deny", SiteDecisions.decision(decisions, SiteDecisions.DEFAULT_ORIGIN, "notifications"))
        // Another permission's answer is not this one's.
        assertNull(SiteDecisions.decision(decisions, "https://b.example", "camera"))
        assertEquals("deny", SiteDecisions.decision(decisions, "https://a.example", "camera"))
    }

    @Test
    fun aStoreThatIsNotThereOrNotTheShapeHoldsNoAnswers() {
        assertEquals(0, SiteDecisions.parse(null).length())
        assertEquals(0, SiteDecisions.parse("").length())
        assertEquals(0, SiteDecisions.parse("nope").length())
        assertEquals(0, SiteDecisions.parse("""{"version":1}""").length())
        assertEquals(0, SiteDecisions.parse("""{"decisions":[]}""").length())
    }

    // --- the app window's cards -----------------------------------------------------------------------------

    @Test
    fun anAppWindowsCardsAreTaggedApartFromTheBrowsersAndFromAnotherApps() {
        val id = sketch.shortcutId
        val tagged = WebAppNotifications.notificationTag(id, "1/n1", "thread")
        // The app's one card by a page tag, whichever document showed it.
        assertEquals(tagged, WebAppNotifications.notificationTag(id, "2/n9", "thread"))
        assertNotEquals(tagged, WebAppNotifications.notificationTag("webapp-other", "1/n1", "thread"))
        assertNotEquals(tagged, WebAppNotifications.notificationTag(id, "1/n1", "other-thread"))
        // Untagged: a card of its own per (document, page id).
        val a = WebAppNotifications.notificationTag(id, "1/n1", "")
        val b = WebAppNotifications.notificationTag(id, "1/n2", "")
        val c = WebAppNotifications.notificationTag(id, "2/n1", "")
        assertNotEquals(a, b)
        assertNotEquals(a, c)
        // Never the browser's tag for the same site's card, or an untagged card's shape by accident.
        assertTrue(a.startsWith("zenium.webapp/"))
        assertFalse(a.startsWith("zenium.web/"))
        assertNotEquals(WebNotifications.notificationTag("1/n1", "http://127.0.0.1:18131", "thread"), tagged)
        // A key always carries its document before the page's id, so a page id shaped like a tag's slot is no collision.
        assertNotEquals(WebAppNotifications.notificationTag(id, "1/tag:thread", ""), tagged)
    }

    @Test
    fun aRequestsWordsAreCappedAsTheCoreCapsThem() {
        val request = JSONObject().put("title", "x".repeat(2000)).put("body", JSONObject.NULL)
        assertEquals(1024, WebAppNotifications.text(request, "title").length)
        assertEquals("", WebAppNotifications.text(request, "body"))
        assertEquals("", WebAppNotifications.text(request, "tag"))
        assertEquals(1024, WebAppNotifications.MAX_TEXT)
        // The core's `MAX_LIVE_PER_ORIGIN`.
        assertEquals(20, WebAppNotifications.MAX_LIVE)
    }
}
