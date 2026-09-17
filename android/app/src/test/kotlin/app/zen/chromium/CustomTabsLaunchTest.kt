package app.zen.chromium

import androidx.browser.customtabs.CustomTabsIntent
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class CustomTabsLaunchTest {
    @Test
    fun classifierOnlyRecognizesCustomTabsExtras() {
        assertTrue(CustomTabsLaunch.isCustomTabsExtras(setOf("android.support.customtabs.extra.SESSION")))
        assertTrue(CustomTabsLaunch.isCustomTabsExtras(setOf("androidx.browser.customtabs.extra.COLOR_SCHEME")))
        assertFalse(CustomTabsLaunch.isCustomTabsExtras(setOf("android.intent.extra.TEXT")))
        assertFalse(CustomTabsLaunch.isCustomTabsExtras(emptySet()))
    }

    @Test
    fun resolverFollowsExplicitAndSystemColorSchemes() {
        assertFalse(CustomTabColorSchemeResolver.resolve(null, CustomTabsIntent.COLOR_SCHEME_SYSTEM, false).dark)
        assertTrue(CustomTabColorSchemeResolver.resolve(null, CustomTabsIntent.COLOR_SCHEME_SYSTEM, true).dark)
        assertFalse(CustomTabColorSchemeResolver.resolve(null, CustomTabsIntent.COLOR_SCHEME_LIGHT, true).dark)
        assertTrue(CustomTabColorSchemeResolver.resolve(null, CustomTabsIntent.COLOR_SCHEME_DARK, false).dark)
    }

    @Test
    fun resolverPreservesToolbarColorAndDerivesNavigationBar() {
        val colors = CustomTabColorSchemeResolver.resolve(0xff336699.toInt(), CustomTabsIntent.COLOR_SCHEME_LIGHT, false)

        assertEquals(0xff336699.toInt(), colors.toolbar)
        assertEquals(0xff2e5e8c.toInt(), colors.navigationBar)
    }
}
