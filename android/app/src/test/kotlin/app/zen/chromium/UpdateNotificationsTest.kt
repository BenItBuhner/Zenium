package app.zen.chromium

import android.app.NotificationManager
import androidx.core.app.NotificationCompat
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class UpdateNotificationsTest {
    @Test
    fun theChannelIsTheRegistrysUpdatesChannel() {
        // The channel itself (id, name, group) is pinned in NotificationsTest; the low importance is NOT-17's silent reminder.
        assertEquals("zenium.updates", Notifications.UPDATES.id)
        assertEquals(NotificationManager.IMPORTANCE_LOW, Notifications.UPDATES.importance)
        // §9.1: a description is a sentence, capitalised once and without a full stop.
        assertEquals("Tells you when a new version of Zenium is available and when it is ready to install", Notifications.UPDATES.description)
        assertEquals("zenium://settings/updates", UpdateNotifications.OPEN_URL)
    }

    /**
     * NOT-17: "Update available" once a release is found, "Update ready" once it is downloaded –
     * each naming the version – on the Updates channel, silent, alerting once, swiped away
     * freely, this device's alone and without a time: the values `notify` hands the builder.
     */
    @Test
    fun theTwoEdgesHaveTheirCards() {
        val available = UpdateNotifications.card("available", "0.4.36")!!
        assertEquals("Update available", available.title)
        assertEquals("Zenium 0.4.36 is available", available.text)
        val ready = UpdateNotifications.card("ready", "0.4.36")!!
        assertEquals("Update ready", ready.title)
        assertEquals("Zenium 0.4.36 is downloaded and ready to install", ready.text)
        for (card in listOf(available, ready)) {
            assertEquals(Notifications.UPDATES.id, card.channelId)
            assertTrue(card.autoCancel)
            assertFalse(card.ongoing)
            assertTrue(card.silent)
            assertTrue(card.onlyAlertOnce)
            assertTrue(card.localOnly)
            assertFalse(card.showWhen)
            assertEquals(NotificationCompat.CATEGORY_RECOMMENDATION, card.category)
        }
        // The flags do not move with the edge.
        assertEquals(available.copy(title = "", text = ""), ready.copy(title = "", text = ""))
    }

    @Test
    fun nothingToSayHasNoCard() {
        assertNull(UpdateNotifications.card(null, null))
        assertNull(UpdateNotifications.card("available", null))
        assertNull(UpdateNotifications.card("available", "  "))
        assertNull(UpdateNotifications.card("downloading", "0.4.36"))
        assertNull(UpdateNotifications.card("error", "0.4.36"))
    }
}
