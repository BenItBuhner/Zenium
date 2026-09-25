package app.zen.chromium

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * The web app's cold launch splash (PWA-06): the ground, the icon's size and the bars' tone are
 * decided by numbers a JVM can check; the theme wiring is checked from the files, as the
 * browser's is (StartupSplashTest) – the platform reads the splash off the theme before any code
 * runs, so a theme that drifted (Zenium's mark back on it, a colour of its own, the wrong post
 * theme) would show for a second on every launch and no test of the class would notice.
 */
class WebAppSplashTest {
    private fun read(vararg candidates: String): String {
        val file = candidates.map(::File).firstOrNull { it.exists() }
        assertTrue("${candidates.first()} not found from ${File(".").absolutePath}", file != null)
        return file!!.readText()
    }

    private fun style(themes: String): String {
        val splash = Regex("""<style name="Theme\.Zen\.WebApp\.Splash"[^>]*>(.*?)</style>""", RegexOption.DOT_MATCHES_ALL).find(themes)
        assertTrue("Theme.Zen.WebApp.Splash is defined", splash != null)
        return splash!!.value
    }

    @Test
    fun theGroundIsTheManifestsColourElseTheWindowsPageColour() {
        assertEquals(0xFF7A1FA2.toInt(), WebAppSplash.ground(0xFF7A1FA2.toInt(), 0xFFFBFBFE.toInt()))
        assertEquals("no background_color: the page colour, which the theme's ground already is", 0xFFFBFBFE.toInt(), WebAppSplash.ground(null, 0xFFFBFBFE.toInt()))
    }

    @Test
    fun theBarsIconsFollowTheGround() {
        assertTrue("dark icons over the light page colour", WebAppSplash.lightBarsOver(0xFFFBFBFE.toInt()))
        assertFalse("light icons over the night page colour", WebAppSplash.lightBarsOver(0xFF1C1B22.toInt()))
        assertFalse("light icons over a deep manifest colour", WebAppSplash.lightBarsOver(0xFF7A1FA2.toInt()))
    }

    @Test
    fun theIconTakesThePlatformsSizeWhenItLaidOneOutElseTheGuidelines() {
        assertEquals("the platform's icon view, as laid out for the browser's own splash", 448, WebAppSplash.iconSizePx(448, 2.8f))
        assertEquals("no icon view (the solid style): 192 dp", 538, WebAppSplash.iconSizePx(0, 2.8f))
        assertEquals(192, WebAppSplash.ICON_DP)
    }

    @Test
    fun theSplashThemeIsAFixedGroundWithNoMarkOverTheWebAppTheme() {
        val day = style(read("src/main/res/values/themes.xml", "app/src/main/res/values/themes.xml"))
        val night = style(read("src/main/res/values-night/themes.xml", "app/src/main/res/values-night/themes.xml"))
        for ((name, style) in listOf("day" to day, "night" to night)) {
            assertTrue("$name: parent is the library's", style.contains("""parent="Theme.SplashScreen""""))
            assertTrue("$name: the web app theme follows the splash", style.contains("""<item name="postSplashScreenTheme">@style/Theme.Zen.WebApp</item>"""))
            assertTrue("$name: no icon of Zenium's stands in for the app's", style.contains("""<item name="windowSplashScreenAnimatedIcon">@android:color/transparent</item>"""))
            assertTrue("$name: API 33+ builds the icon view for a plain start too", style.contains("icon_preferred"))
        }
        assertTrue("the day ground is the window's page colour", day.contains("""<item name="windowSplashScreenBackground">@color/v2_page_light</item>"""))
        assertTrue("dark icons over it", day.contains("""<item name="android:windowLightStatusBar">true</item>"""))
        assertTrue("the night ground is the night page colour", night.contains("""<item name="windowSplashScreenBackground">@color/v2_page_dark</item>"""))
        assertTrue("light icons over it", night.contains("""<item name="android:windowLightStatusBar">false</item>"""))
        val themes = read("src/main/res/values/themes.xml", "app/src/main/res/values/themes.xml")
        assertTrue("the post theme is the browser theme under the web app's name", themes.contains("""<style name="Theme.Zen.WebApp" />"""))
    }

    @Test
    fun theWebAppActivityWearsTheSplashThemeAndTheTrampolineNone() {
        val manifest = read("src/main/AndroidManifest.xml", "app/src/main/AndroidManifest.xml")
        val activity = Regex("""<activity\s+android:name="\.WebAppActivity"(.*?)>""", RegexOption.DOT_MATCHES_ALL).find(manifest)
        assertTrue(".WebAppActivity is declared", activity != null)
        assertTrue("the splash theme is the window's", activity!!.value.contains("""android:theme="@style/Theme.Zen.WebApp.Splash""""))
        // The tile's trampoline keeps NoDisplay where the icon's (IconTapActivity) wears the splash:
        // the platform transfers a starting window within one task only, and the app's window
        // lives in a document task of its own, never the trampoline's – a splash theme here would
        // be two windows and a task switch between them.
        val trampoline = Regex("""<activity\s+android:name="\.WebAppLauncherActivity"(.*?)>""", RegexOption.DOT_MATCHES_ALL).find(manifest)
        assertTrue(".WebAppLauncherActivity is declared", trampoline != null)
        assertTrue("the trampoline shows nothing of its own: the starting window is the app window's, in the app's task", trampoline!!.value.contains("""android:theme="@android:style/Theme.NoDisplay""""))
        assertTrue("in a task of its own, out of the app's", trampoline.value.contains("""android:taskAffinity="""""))
    }
}
