package app.zen.chromium

import android.app.NotificationManager
import androidx.core.app.NotificationCompat
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PrivateSessionTest {
    @Test
    fun theCardsIdentityIsChromes() {
        assertEquals("Close all private tabs", PrivateSession.TITLE)
        assertEquals("zenium.private", PrivateSession.CHANNEL_ID)
        assertEquals("Private browsing", PrivateSession.CHANNEL_NAME)
        assertEquals("app.zen.chromium.PRIVATE_CLOSE_ALL", PrivateSession.ACTION_CLOSE_ALL)
    }

    /**
     * NOT-07: the card stays off the lock screen (`VISIBILITY_SECRET`, Chrome's Incognito card),
     * sits on its own low-importance channel, is ongoing and silent, alerts once at most, is this
     * device's alone and shows no time – the values `setOpenTabs` hands the builder.
     */
    @Test
    fun theCardIsSecretOngoingAndQuietOnTheLowChannel() {
        val card = PrivateSession.card(2)
        assertEquals(NotificationCompat.VISIBILITY_SECRET, card.visibility)
        assertEquals(PrivateSession.CHANNEL_ID, card.channelId)
        assertEquals(NotificationManager.IMPORTANCE_LOW, PrivateSession.CHANNEL_IMPORTANCE)
        assertTrue(card.ongoing)
        assertTrue(card.silent)
        assertTrue(card.onlyAlertOnce)
        assertTrue(card.localOnly)
        assertFalse(card.showWhen)
        assertEquals(NotificationCompat.CATEGORY_STATUS, card.category)
    }

    @Test
    fun theCardCountsThePrivateTabs() {
        assertEquals("Close all private tabs", PrivateSession.card(1).title)
        assertEquals("1 private tab is open", PrivateSession.card(1).text)
        assertEquals("2 private tabs are open", PrivateSession.card(2).text)
        assertEquals("7 private tabs are open", PrivateSession.card(7).text)
        // The flags do not move with the count.
        assertEquals(PrivateSession.card(1).copy(text = ""), PrivateSession.card(5).copy(text = ""))
    }
}
