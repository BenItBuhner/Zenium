package app.zen.chromium

import org.junit.Assert.assertEquals
import org.junit.Test

class PrivateSessionTest {
    @Test
    fun theCardsIdentityIsChromes() {
        assertEquals("Close all private tabs", PrivateSession.TITLE)
        assertEquals("zenium.private", PrivateSession.CHANNEL_ID)
        assertEquals("app.zen.chromium.PRIVATE_CLOSE_ALL", PrivateSession.ACTION_CLOSE_ALL)
    }
}
