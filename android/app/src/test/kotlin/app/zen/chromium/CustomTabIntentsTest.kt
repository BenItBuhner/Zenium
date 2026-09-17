package app.zen.chromium

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class CustomTabIntentsTest {
    private val view = "android.intent.action.VIEW"

    @Test
    fun plainWebLinkIsALink() {
        assertEquals(CustomTabIntents.Kind.LINK, CustomTabIntents.classify(view, "https", emptySet()))
        assertEquals(CustomTabIntents.Kind.LINK, CustomTabIntents.classify(view, "HTTP", emptySet()))
        // Extras of the caller's own do not make it a custom tab.
        assertEquals(CustomTabIntents.Kind.LINK, CustomTabIntents.classify(view, "https", setOf("com.example.EXTRA_FROM")))
    }

    @Test
    fun sessionExtraMakesACustomTab() {
        // Chrome's rule: EXTRA_SESSION present, even holding a null binder.
        assertEquals(
            CustomTabIntents.Kind.CUSTOM_TAB,
            CustomTabIntents.classify(view, "https", setOf("android.support.customtabs.extra.SESSION"))
        )
    }

    @Test
    fun otherCustomTabExtrasAloneMakeACustomTab() {
        // A hand-built intent without a session but with a toolbar colour is still a custom tab.
        assertEquals(
            CustomTabIntents.Kind.CUSTOM_TAB,
            CustomTabIntents.classify(view, "http", setOf("android.support.customtabs.extra.TOOLBAR_COLOR"))
        )
        assertEquals(
            CustomTabIntents.Kind.CUSTOM_TAB,
            CustomTabIntents.classify(view, "https", setOf("androidx.browser.customtabs.extra.SHARE_STATE"))
        )
    }

    @Test
    fun onlyWebViewsCount() {
        assertEquals(CustomTabIntents.Kind.NONE, CustomTabIntents.classify("android.intent.action.SEND", "https", emptySet()))
        assertEquals(CustomTabIntents.Kind.NONE, CustomTabIntents.classify(view, null, setOf("android.support.customtabs.extra.SESSION")))
        assertEquals(CustomTabIntents.Kind.NONE, CustomTabIntents.classify(view, "mailto", setOf("android.support.customtabs.extra.SESSION")))
        assertEquals(CustomTabIntents.Kind.NONE, CustomTabIntents.classify(null, "https", emptySet()))
    }

    @Test
    fun referrerNamesTheCallingApp() {
        assertEquals("com.example.news", CustomTabIntents.packageOfReferrer("android-app://com.example.news"))
        assertEquals("com.example.news", CustomTabIntents.packageOfReferrer("android-app://com.example.news/https/example.com/story"))
        assertEquals("com.example.news", CustomTabIntents.packageOfReferrer("android-app://com.example.news?x=1"))
        assertNull(CustomTabIntents.packageOfReferrer("https://example.com/"))
        assertNull(CustomTabIntents.packageOfReferrer("android-app://"))
        assertNull(CustomTabIntents.packageOfReferrer(null))
    }
}
