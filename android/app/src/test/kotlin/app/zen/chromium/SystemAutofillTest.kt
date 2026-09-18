package app.zen.chromium

import android.view.View
import org.junit.Assert.assertEquals
import org.junit.Test

/** The provider setting as the page WebViews apply it (`autofill.setProvider`). */
class SystemAutofillTest {
    @Test
    fun zeniumTakesThePagesOutOfTheFramework() {
        assertEquals(View.IMPORTANT_FOR_AUTOFILL_NO_EXCLUDE_DESCENDANTS, SystemAutofill.importance(SystemAutofill.PROVIDER_ZENIUM))
    }

    @Test
    fun theSystemServiceKeepsTheDefault() {
        assertEquals(View.IMPORTANT_FOR_AUTOFILL_AUTO, SystemAutofill.importance(SystemAutofill.PROVIDER_SYSTEM))
        assertEquals(View.IMPORTANT_FOR_AUTOFILL_AUTO, SystemAutofill.importance("something else"))
    }

    @Test
    fun providerNamesFromTheBridgeAreNormalised() {
        assertEquals(SystemAutofill.PROVIDER_ZENIUM, SystemAutofill.provider("zenium"))
        assertEquals(SystemAutofill.PROVIDER_SYSTEM, SystemAutofill.provider("system"))
        assertEquals(SystemAutofill.PROVIDER_SYSTEM, SystemAutofill.provider(null))
        assertEquals(SystemAutofill.PROVIDER_SYSTEM, SystemAutofill.provider("Zenium"))
    }
}
