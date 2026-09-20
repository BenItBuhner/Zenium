package app.zen.chromium

import org.junit.Assert.assertEquals
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
        assertEquals("zenium.site:", SitesChannels.PREFIX)
        assertEquals("zenium.sites", SitesChannels.GROUP_ID)
        assertEquals("Sites", SitesChannels.GROUP_NAME)
    }

    @Test
    fun theCardsIdsDoNotCollideWithTheOtherNotifications() {
        // Web notifications are told apart by tag; the private session's, the media one and the
        // extensions' by id. None of the ids may coincide with another's under the same tag space.
        val ids = listOf(WebNotifications.NOTIFICATION_ID, PrivateSession.NOTIFICATION_ID, MediaPlaybackService.NOTIFICATION_ID)
        assertEquals(ids.size, ids.toSet().size)
    }
}
