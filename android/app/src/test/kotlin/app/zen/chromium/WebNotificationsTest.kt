package app.zen.chromium

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class WebNotificationsTest {
    // --- the shade's tags: one card per (site, tag), one per notification otherwise ------------------

    @Test
    fun aTaggedNotificationReplacesTheSitesEarlierOneUnderTheSameTag() {
        val first = WebNotifications.notificationTag("n1", "https://chat.example", "thread-7")
        val second = WebNotifications.notificationTag("n2", "https://chat.example", "thread-7")
        assertEquals(first, second)
        // The same tag from another site is another card.
        assertNotEquals(first, WebNotifications.notificationTag("n3", "https://other.example", "thread-7"))
        // Another tag from the same site too.
        assertNotEquals(first, WebNotifications.notificationTag("n4", "https://chat.example", "thread-8"))
    }

    @Test
    fun anUntaggedNotificationIsACardOfItsOwn() {
        val a = WebNotifications.notificationTag("n1", "https://chat.example", "")
        val b = WebNotifications.notificationTag("n2", "https://chat.example", "")
        assertNotEquals(a, b)
        assertEquals(a, WebNotifications.notificationTag("n1", "https://elsewhere.example", ""))
    }

    @Test
    fun theTagsAreNamespacedAwayFromTheOtherCards() {
        assertTrue(WebNotifications.notificationTag("n1", "https://a.example", "").startsWith("zenium.web/"))
        assertTrue(WebNotifications.notificationTag("n1", "https://a.example", "t").startsWith("zenium.web/"))
    }

    // --- the channel per site ---------------------------------------------------------------------

    @Test
    fun aSitesChannelIsNamedForItsHostAndPort() {
        assertEquals("news.example", SitesChannels.displayName("https://news.example"))
        assertEquals("news.example:8443", SitesChannels.displayName("https://news.example:8443"))
        assertEquals("localhost:3000", SitesChannels.displayName("http://localhost:3000"))
        // Something that is not a URL shows as it is rather than nothing.
        assertEquals("not a url", SitesChannels.displayName("not a url"))
        assertEquals("", SitesChannels.displayName(""))
    }

    @Test
    fun theChannelIdsAreGroupedUnderSites() {
        // The registry's site channel: the prefix, the origin, the time; under the Sites group; named by the host.
        val channel = Notifications.site("https://news.example:8443", 1_700_000_000_000L)
        assertEquals("zenium.site:https://news.example:8443;1700000000000", channel.id)
        assertTrue(channel.id.startsWith(Notifications.sitePrefix("https://news.example:8443")))
        assertEquals("news.example:8443", channel.name)
        assertEquals("Notifications from news.example:8443", channel.description)
        assertEquals(Notifications.SITES, channel.group)
        assertEquals("zenium.sites", Notifications.SITES.id)
        assertEquals("Sites", Notifications.SITES.name)
    }

    // --- the app's Sharing channel (tabs sent from another device) ---------------------------------

    @Test
    fun aSentTabsRequestIsToldApartByItsChannel() {
        assertTrue(WebNotifications.isSharing(JSONObject().put("channel", "sharing")))
        // A page's request never carries one; an unknown value is a page's too (never the app's channel by accident).
        assertFalse(WebNotifications.isSharing(JSONObject().put("origin", "https://a.example")))
        assertFalse(WebNotifications.isSharing(JSONObject().put("channel", "sites")))
        assertFalse(WebNotifications.isSharing(JSONObject().put("channel", "")))
    }

    @Test
    fun theSharingChannelIsTheAppsOwnBesideTheSitesGroup() {
        assertEquals("Sharing", Notifications.SHARING.name)
        assertEquals("sharing", SharingChannel.KIND)
        // Not a site's channel (the sites' prefix would make it one the site's permission could withdraw).
        assertFalse(Notifications.SHARING.id.startsWith(Notifications.SITE_PREFIX))
        // A fixed channel of the app's own, under General beside the Sites group (the registry pins the rest).
        assertTrue(Notifications.SHARING in Notifications.fixed)
        assertEquals(Notifications.GENERAL, Notifications.SHARING.group)
    }

    @Test
    fun theCardsIdsDoNotCollideWithTheOtherNotifications() {
        // Web notifications are told apart by tag; the private session's, the media one and the
        // extensions' by id. None of the ids may coincide with another's under the same tag space.
        val ids = listOf(WebNotifications.NOTIFICATION_ID, PrivateSession.NOTIFICATION_ID, MediaPlaybackService.NOTIFICATION_ID)
        assertEquals(ids.size, ids.toSet().size)
    }
}
