package app.zen.chromium

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * The plans behind Settings › Security › Notifications (SET-26) and the link menu's Call, Send
 * message, Add to contacts and Send email items (PUI-22): the action, the data and the extras
 * each intent carries, and the fallback chain's order.
 */
class SystemIntentsTest {
    @Test
    fun notificationSettingsNameTheAppThenFallBackToItsDetailsPage() {
        val plans = SystemIntents.notificationSettings("io.github.benitbuhner.zenium")
        assertEquals(2, plans.size)
        assertEquals("android.settings.APP_NOTIFICATION_SETTINGS", plans[0].action)
        assertEquals(mapOf("android.provider.extra.APP_PACKAGE" to "io.github.benitbuhner.zenium"), plans[0].extras)
        assertNull(plans[0].data)
        assertEquals("android.settings.APPLICATION_DETAILS_SETTINGS", plans[1].action)
        assertEquals("package:io.github.benitbuhner.zenium", plans[1].data)
    }

    @Test
    fun callDialsTheNumberWithoutRinging() {
        val plan = SystemIntents.call("tel:+1-555-010-9999")
        assertEquals("android.intent.action.DIAL", plan?.action)
        assertEquals("tel:+1-555-010-9999", plan?.data)
        assertEquals(emptyMap<String, String>(), plan?.extras)
    }

    @Test
    fun messageOpensANewTextToTheNumber() {
        val plan = SystemIntents.message("tel:5550109999")
        assertEquals("android.intent.action.SENDTO", plan?.action)
        assertEquals("smsto:5550109999", plan?.data)
    }

    @Test
    fun addContactFillsTheNewContactFormsPhoneField() {
        val plan = SystemIntents.addContact("tel:+44 20 7946 0958")
        assertEquals("android.intent.action.INSERT", plan?.action)
        assertEquals("vnd.android.cursor.dir/contact", plan?.type)
        assertNull(plan?.data)
        assertEquals(mapOf("phone" to "+442079460958"), plan?.extras)
    }

    @Test
    fun emailSendsTheWholeMailtoUrlSoTheSubjectTravels() {
        val plan = SystemIntents.email("mailto:hello@example.com?subject=Hi%20there&body=Zenium")
        assertEquals("android.intent.action.SENDTO", plan?.action)
        assertEquals("mailto:hello@example.com?subject=Hi%20there&body=Zenium", plan?.data)
        assertNull(SystemIntents.email("mailto:"))
        assertNull(SystemIntents.email("tel:5550109999"))
    }

    @Test
    fun phoneNumberUndoesEscapesDropsParametersAndKeepsTheDialersSeparators() {
        assertEquals("+15550109999", SystemIntents.phoneNumber("tel:%2B15550109999"))
        assertEquals("+1-555-010-9999", SystemIntents.phoneNumber("TEL:+1-555-010-9999;ext=12"))
        assertEquals("(555)010.9999", SystemIntents.phoneNumber("tel:(555) 010.9999"))
        assertEquals("+1%ZZ555", SystemIntents.phoneNumber("tel:+1%ZZ555"))
        assertNull(SystemIntents.phoneNumber("tel:"))
        assertNull(SystemIntents.phoneNumber("tel:;ext=1"))
        assertNull(SystemIntents.phoneNumber("tel:+-()"))
        assertNull(SystemIntents.phoneNumber("mailto:hello@example.com"))
        assertNull(SystemIntents.call("mailto:hello@example.com"))
    }
}
