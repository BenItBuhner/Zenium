package app.zen.chromium

import android.content.res.Configuration
import androidx.appcompat.app.AppCompatDelegate
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PageThemeTest {
    private val day = Configuration.UI_MODE_TYPE_NORMAL or Configuration.UI_MODE_NIGHT_NO
    private val night = Configuration.UI_MODE_TYPE_NORMAL or Configuration.UI_MODE_NIGHT_YES

    @Test
    fun `the chrome's scheme picks the app's night mode, system and the unknown following the OS`() {
        assertEquals(AppCompatDelegate.MODE_NIGHT_YES, PageTheme.nightMode("dark"))
        assertEquals(AppCompatDelegate.MODE_NIGHT_NO, PageTheme.nightMode("light"))
        assertEquals(AppCompatDelegate.MODE_NIGHT_FOLLOW_SYSTEM, PageTheme.nightMode("system"))
        assertEquals(AppCompatDelegate.MODE_NIGHT_FOLLOW_SYSTEM, PageTheme.nightMode(""))
    }

    @Test
    fun `a switch that crosses between day and night is dispatched to the pages`() {
        assertTrue(PageTheme.nightFlipped(day, night))
        assertTrue(PageTheme.nightFlipped(night, day))
        // A configuration that never said (an activity before its first resolution) counts as a crossing too.
        assertTrue(PageTheme.nightFlipped(Configuration.UI_MODE_NIGHT_UNDEFINED, night))
    }

    @Test
    fun `a switch that leaves the night bit alone has nothing to tell the pages`() {
        // Light -> System on a light system, Dark -> System on a dark one.
        assertFalse(PageTheme.nightFlipped(day, day))
        assertFalse(PageTheme.nightFlipped(night, night))
    }

    @Test
    fun `the type bits of uiMode are not a flip`() {
        val carAtNight = Configuration.UI_MODE_TYPE_CAR or Configuration.UI_MODE_NIGHT_YES
        assertFalse(PageTheme.nightFlipped(night, carAtNight))
        assertTrue(PageTheme.nightFlipped(day, carAtNight))
    }
}
