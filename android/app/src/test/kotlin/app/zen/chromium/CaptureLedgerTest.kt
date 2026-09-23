package app.zen.chromium

import androidx.core.app.NotificationCompat
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class CaptureLedgerTest {
    private val meet = "https://meet.example.test/room/7"

    @Test
    fun theChannelReadsInSentenceCase() {
        assertEquals("zenium.capture", CaptureLedger.CHANNEL_ID)
        assertEquals("Camera and microphone", CaptureLedger.CHANNEL_NAME)
        assertEquals("Shows while a site is using your camera or microphone", CaptureLedger.CHANNEL_DESCRIPTION)
        assertEquals("app.zen.chromium.CAPTURE_OPEN", CaptureNotifications.ACTION_OPEN)
    }

    /**
     * NOT-13: "<site> is using your microphone" – Chrome's words, the camera first when both are
     * held, the site as its host – ongoing and silent on the low Camera and microphone channel,
     * this device's alone, without a time, and public: what the shade shows is what the user is
     * doing on the page in front of them.
     */
    @Test
    fun theCardNamesTheSiteAndWhatItHolds() {
        val card = CaptureLedger.card("t1", meet, CaptureUse.MICROPHONE, private = false)
        assertEquals("meet.example.test is using your microphone", card.title)
        assertEquals("meet.example.test is using your camera", CaptureLedger.card("t1", meet, CaptureUse.CAMERA, false).title)
        assertEquals(
            "meet.example.test is using your camera and microphone",
            CaptureLedger.card("t1", meet, CaptureUse.BOTH, false).title
        )
        assertEquals(CaptureLedger.CHANNEL_ID, card.channelId)
        assertEquals(NotificationCompat.VISIBILITY_PUBLIC, card.visibility)
        assertTrue(card.ongoing)
        assertTrue(card.silent)
        assertTrue(card.onlyAlertOnce)
        assertTrue(card.localOnly)
        assertFalse(card.showWhen)
        assertEquals(NotificationCompat.CATEGORY_STATUS, card.category)
    }

    /** A private tab's card names no site (Chrome's Incognito card) and stays off the lock screen (INC-05). */
    @Test
    fun aPrivateTabsCardNamesNoSiteAndIsSecret() {
        val card = CaptureLedger.card("p1", meet, CaptureUse.BOTH, private = true)
        assertEquals("A private tab is using your camera and microphone", card.title)
        assertEquals(NotificationCompat.VISIBILITY_SECRET, card.visibility)
        assertFalse(card.title.contains("meet.example.test"))
    }

    /**
     * The start/stop table's first row: the grant path arms a tab – the card is up and the
     * service's kind is set at once, while the app is still in front (Android 14 refuses a
     * camera or microphone service started later, from the background) – the page's report
     * confirms it, and the report of nothing ends it.
     */
    @Test
    fun aGrantArmsTheCardAndTheReportConfirmsAndEndsIt() {
        val ledger = CaptureLedger()
        assertTrue(ledger.isEmpty)
        assertEquals(CaptureUse.NONE, ledger.use())

        assertTrue(ledger.granted("t1", meet, CaptureUse.MICROPHONE, private = false, now = 1_000L))
        assertEquals(listOf("meet.example.test is using your microphone"), ledger.cards().map { it.title })
        assertEquals(CaptureUse.MICROPHONE, ledger.use())
        assertEquals(1_000L + CaptureLedger.CONFIRM_WINDOW_MS, ledger.nextDeadline())

        // The page opened the stream: the same card, and nothing left to expire.
        assertFalse(ledger.reported("t1", meet, CaptureUse.MICROPHONE, private = false))
        assertNull(ledger.nextDeadline())
        assertFalse(ledger.expire(now = 1_000L + CaptureLedger.CONFIRM_WINDOW_MS * 10))
        assertEquals(CaptureUse.MICROPHONE, ledger.use())

        // The tracks stopped: the card comes down.
        assertTrue(ledger.reported("t1", meet, CaptureUse.NONE, private = false))
        assertTrue(ledger.isEmpty)
        assertEquals(CaptureUse.NONE, ledger.use())
    }

    /** The page's word rules: a grant for both that the page opened with the microphone alone reads as the microphone. */
    @Test
    fun theReportRefinesTheGrantsKinds() {
        val ledger = CaptureLedger()
        ledger.granted("t1", meet, CaptureUse.BOTH, private = false, now = 0L)
        assertEquals(CaptureUse.BOTH, ledger.use())
        assertTrue(ledger.reported("t1", meet, CaptureUse.MICROPHONE, private = false))
        assertEquals(CaptureUse.MICROPHONE, ledger.use())
        assertEquals("meet.example.test is using your microphone", ledger.cards().single().title)
        // The camera joining later, from the page's own report.
        assertTrue(ledger.reported("t1", meet, CaptureUse.BOTH, private = false))
        assertEquals("meet.example.test is using your camera and microphone", ledger.cards().single().title)
    }

    /** A grant the page never used comes down when its window closes; a report keeps a live one up. */
    @Test
    fun anUnconfirmedGrantExpiresAndAConfirmedOneStays() {
        val ledger = CaptureLedger(confirmWindowMs = 100L)
        ledger.granted("t1", meet, CaptureUse.CAMERA, private = false, now = 0L)
        ledger.granted("t2", "https://cam.test/", CaptureUse.MICROPHONE, private = false, now = 50L)
        ledger.reported("t2", "https://cam.test/", CaptureUse.MICROPHONE, private = false)
        assertEquals(100L, ledger.nextDeadline())

        assertFalse(ledger.expire(now = 99L))
        assertEquals(2, ledger.cards().size)
        assertTrue(ledger.expire(now = 100L))
        assertEquals(listOf("t2"), ledger.cards().map { it.tabId })
        assertEquals(CaptureUse.MICROPHONE, ledger.use())
        assertNull(ledger.nextDeadline())
    }

    /** A cancelled request drops its arm and nothing else; a tab gone drops everything of it. */
    @Test
    fun aCancelledRequestDropsTheArmAndATabGoneDropsAll() {
        val ledger = CaptureLedger()
        ledger.granted("t1", meet, CaptureUse.MICROPHONE, private = false, now = 0L)
        assertTrue(ledger.cancelled("t1"))
        assertTrue(ledger.isEmpty)

        // A capture the page reported outlives a cancelled later request.
        ledger.reported("t1", meet, CaptureUse.MICROPHONE, private = false)
        ledger.granted("t1", meet, CaptureUse.CAMERA, private = false, now = 5L)
        assertEquals(CaptureUse.BOTH, ledger.use())
        assertTrue(ledger.cancelled("t1"))
        assertEquals(CaptureUse.MICROPHONE, ledger.use())
        assertFalse(ledger.cancelled("nobody"))

        assertTrue(ledger.ended("t1"))
        assertFalse(ledger.ended("t1"))
        assertTrue(ledger.isEmpty)
    }

    /** Two tabs: the service's kind is the union, the cards keep the order the captures began in. */
    @Test
    fun severalTabsUniteIntoTheServicesKindAndKeepTheirOrder() {
        val ledger = CaptureLedger()
        ledger.reported("t1", meet, CaptureUse.MICROPHONE, private = false)
        ledger.reported("t2", "https://cam.test/", CaptureUse.CAMERA, private = true)
        assertEquals(CaptureUse.BOTH, ledger.use())
        assertEquals(listOf("t1", "t2"), ledger.cards().map { it.tabId })
        assertEquals(
            listOf("meet.example.test is using your microphone", "A private tab is using your camera"),
            ledger.cards().map { it.title }
        )
        // A tab's later report does not reorder it.
        ledger.reported("t1", meet, CaptureUse.BOTH, private = false)
        assertEquals(listOf("t1", "t2"), ledger.cards().map { it.tabId })
        ledger.reported("t1", meet, CaptureUse.NONE, private = false)
        assertEquals(CaptureUse.CAMERA, ledger.use())
    }

    @Test
    fun aUseUnitesAndKnowsWhetherItHoldsAnything() {
        assertFalse(CaptureUse.NONE.any)
        assertTrue(CaptureUse.CAMERA.any)
        assertEquals(CaptureUse.BOTH, CaptureUse.CAMERA union CaptureUse.MICROPHONE)
        assertEquals(CaptureUse.MICROPHONE, CaptureUse.NONE union CaptureUse.MICROPHONE)
        assertEquals("microphone", CaptureLedger.useLabel(CaptureUse.MICROPHONE))
        assertEquals("camera", CaptureLedger.useLabel(CaptureUse.CAMERA))
        assertEquals("camera and microphone", CaptureLedger.useLabel(CaptureUse.BOTH))
    }
}
