package app.zen.chromium

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class CustomTabSchemeTest {
    private val light = CustomTabScheme.Defaults(toolbar = 0xFFE9E9E9.toInt(), navigationBar = 0xFFFBFBFE.toInt())
    private val dark = CustomTabScheme.Defaults(toolbar = 0xFF131313.toInt(), navigationBar = 0xFF1C1B22.toInt())
    private val none = CustomTabScheme.Params()

    @Test
    fun schemeFollowsTheCallerThenTheSystem() {
        assertFalse(CustomTabScheme.isDark(CustomTabScheme.LIGHT, systemDark = true))
        assertTrue(CustomTabScheme.isDark(CustomTabScheme.DARK, systemDark = false))
        assertTrue(CustomTabScheme.isDark(CustomTabScheme.SYSTEM, systemDark = true))
        assertFalse(CustomTabScheme.isDark(CustomTabScheme.SYSTEM, systemDark = false))
        // Unknown values count as the system's scheme.
        assertTrue(CustomTabScheme.isDark(42, systemDark = true))
    }

    @Test
    fun withoutCallerColoursZeniumsOwnAreUsed() {
        val resolved = CustomTabScheme.resolve(CustomTabScheme.SYSTEM, systemDark = false, none, light, dark)
        assertFalse(resolved.dark)
        assertEquals(light.toolbar, resolved.toolbar)
        assertFalse(resolved.toolbarIsCallers)
        assertEquals(light.navigationBar, resolved.navigationBar)
        assertNull(resolved.navigationBarDivider)
        assertFalse(resolved.lightToolbarForeground)
        assertFalse(resolved.lightNavigationForeground)

        val darkResolved = CustomTabScheme.resolve(CustomTabScheme.DARK, systemDark = false, none, light, dark)
        assertTrue(darkResolved.dark)
        assertEquals(dark.toolbar, darkResolved.toolbar)
        assertEquals(dark.navigationBar, darkResolved.navigationBar)
        assertTrue(darkResolved.lightToolbarForeground)
        assertTrue(darkResolved.lightNavigationForeground)
    }

    @Test
    fun callerToolbarColourAlsoColoursTheNavigationBar() {
        val brand = 0xFF2E5BFF.toInt()
        val resolved = CustomTabScheme.resolve(CustomTabScheme.LIGHT, systemDark = false, CustomTabScheme.Params(toolbar = brand), light, dark)
        assertEquals(brand, resolved.toolbar)
        assertTrue(resolved.toolbarIsCallers)
        assertEquals(brand, resolved.navigationBar)
        // A saturated blue is dark enough for white glyphs.
        assertTrue(resolved.lightToolbarForeground)
        assertTrue(resolved.lightNavigationForeground)
        // The scheme itself stays light: the menu sheet is Zenium's light panel.
        assertFalse(resolved.dark)
    }

    @Test
    fun explicitNavigationBarAndDividerWin() {
        val params = CustomTabScheme.Params(toolbar = 0xFFFFFFFF.toInt(), navigationBar = 0xFF101010.toInt(), navigationBarDivider = 0x80404040.toInt())
        val resolved = CustomTabScheme.resolve(CustomTabScheme.LIGHT, systemDark = false, params, light, dark)
        assertEquals(0xFFFFFFFF.toInt(), resolved.toolbar)
        assertFalse(resolved.lightToolbarForeground)
        assertEquals(0xFF101010.toInt(), resolved.navigationBar)
        assertTrue(resolved.lightNavigationForeground)
        // Alpha is dropped: system bars are opaque.
        assertEquals(0xFF404040.toInt(), resolved.navigationBarDivider)
    }

    @Test
    fun translucentCallerColoursBecomeOpaque() {
        val resolved = CustomTabScheme.resolve(CustomTabScheme.LIGHT, systemDark = false, CustomTabScheme.Params(toolbar = 0x002E5BFF), light, dark)
        assertEquals(0xFF2E5BFF.toInt(), resolved.toolbar)
    }

    @Test
    fun lightGlyphsFromThreeToOneAgainstWhite() {
        assertFalse(CustomTabScheme.needsLightForeground(0xFFFFFFFF.toInt()))
        assertFalse(CustomTabScheme.needsLightForeground(0xFFE9E9E9.toInt()))
        // The threshold sits at about #959595: #969696 is just under 3:1 with white, #929292 just over.
        assertFalse(CustomTabScheme.needsLightForeground(0xFF969696.toInt()))
        assertTrue(CustomTabScheme.needsLightForeground(0xFF929292.toInt()))
        assertTrue(CustomTabScheme.needsLightForeground(0xFF767676.toInt()))
        assertTrue(CustomTabScheme.needsLightForeground(0xFF000000.toInt()))
        assertEquals(21.0, CustomTabScheme.contrastWithWhite(0xFF000000.toInt()), 0.01)
        assertEquals(1.0, CustomTabScheme.contrastWithWhite(0xFFFFFFFF.toInt()), 0.0001)
    }
}
