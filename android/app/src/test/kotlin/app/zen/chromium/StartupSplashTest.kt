package app.zen.chromium

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * The cold start's splash (OS-26): the hold lifts once, on the chrome's READY after the platform's
 * hand-over – or on the watchdog, when no READY comes – and never before either; and the theme
 * wiring is checked from the files, since a splash theme whose post theme, colour or icon drifted
 * would still build and show the wrong thing for a second on every cold start.
 */
class StartupSplashTest {
    private fun read(vararg candidates: String): String {
        val file = candidates.map(::File).firstOrNull { it.exists() }
        assertTrue("${candidates.first()} not found from ${File(".").absolutePath}", file != null)
        return file!!.readText()
    }

    @Test
    fun theSplashLiftsOnReadyAfterTheHandOver() {
        val hold = SplashHold()
        assertFalse(hold.handOver())
        assertTrue(hold.handedOver)
        assertFalse(hold.lifted)
        assertTrue("READY after the hand-over lifts", hold.ready())
        hold.lift("ready")
        assertEquals("ready", hold.liftedBy)
        assertFalse("nothing to lift twice", hold.ready())
        assertFalse("the watchdog finds it lifted", hold.watchdog())
    }

    @Test
    fun readyBeforeTheHandOverWaitsForIt() {
        val hold = SplashHold()
        assertFalse("nothing handed over yet: nothing lifts", hold.ready())
        assertTrue(hold.chromeReady)
        assertTrue("the hand-over finds READY waiting and lifts at once", hold.handOver())
        hold.lift("ready")
        assertEquals("ready", hold.liftedBy)
        assertFalse("a second hand-over is nothing", hold.handOver())
    }

    @Test
    fun theWatchdogLiftsOnlyASplashStillUpWithNoReady() {
        val hold = SplashHold()
        assertFalse("before the hand-over there is nothing up", hold.watchdog())
        hold.handOver()
        assertTrue(hold.watchdog())
        hold.lift("watchdog")
        assertEquals("watchdog", hold.liftedBy)
        assertFalse("a late READY finds it lifted", hold.ready())
        assertFalse(hold.watchdog())
    }

    @Test
    fun theWatchdogYieldsToReady() {
        val hold = SplashHold()
        hold.handOver()
        assertTrue(hold.ready())
        assertFalse("READY heard: the watchdog has nothing to do", hold.watchdog())
        assertNull(hold.liftedBy)
    }

    @Test
    fun theExitIsTheSystemsRevealSequenceUntilRuled() {
        // WM Shell's SplashScreenExitAnimation: the icon first, then the splash over the app.
        assertEquals(133L, SplashExit.ICON_FADE_MS)
        assertEquals(83L, SplashExit.REVEAL_DELAY_MS)
        assertEquals(266L, SplashExit.REVEAL_MS)
        assertTrue("the icon is gone before the splash starts to go", SplashExit.ICON_FADE_MS <= SplashExit.REVEAL_DELAY_MS + SplashExit.REVEAL_MS)
    }

    @Test
    fun theSplashThemeIsTheLaunchersMarkOnTheBrandColourOverTheBrowserTheme() {
        val themes = read("src/main/res/values/themes.xml", "app/src/main/res/values/themes.xml")
        val splash = Regex("""<style name="Theme\.Zen\.Splash"[^>]*>(.*?)</style>""", RegexOption.DOT_MATCHES_ALL).find(themes)
        assertTrue("Theme.Zen.Splash is defined", splash != null)
        val style = splash!!.value
        assertTrue("parent is the library's", style.contains("""parent="Theme.SplashScreen""""))
        assertTrue("the browser theme follows the splash", style.contains("""<item name="postSplashScreenTheme">@style/Theme.Zen</item>"""))
        assertTrue("the brand colour is the default launcher icon's background", style.contains("""<item name="windowSplashScreenBackground">@color/ic_launcher_bg_indigo</item>"""))
        assertTrue("the mark is the launcher's foreground", style.contains("""<item name="windowSplashScreenAnimatedIcon">@drawable/ic_launcher_foreground</item>"""))
        assertTrue("API 33+ shows the icon for a plain start too", style.contains("""icon_preferred"""))
        assertTrue("light icons over the indigo", style.contains("""<item name="android:windowLightStatusBar">false</item>"""))

        // The colour is the launcher's: the default adaptive icon's background is that same colour.
        val icon = read("src/main/res/mipmap-anydpi-v26/ic_launcher.xml", "app/src/main/res/mipmap-anydpi-v26/ic_launcher.xml")
        assertTrue(icon.contains("""<background android:drawable="@color/ic_launcher_bg_indigo" />"""))
        assertTrue(icon.contains("""<foreground android:drawable="@drawable/ic_launcher_foreground" />"""))
    }

    @Test
    fun theMainActivityWearsTheSplashThemeAndTheBuildHasTheLibrary() {
        val manifest = read("src/main/AndroidManifest.xml", "app/src/main/AndroidManifest.xml")
        val activity = Regex("""<activity\s+android:name="\.MainActivity"(.*?)>""", RegexOption.DOT_MATCHES_ALL).find(manifest)
        assertTrue(".MainActivity is declared", activity != null)
        assertTrue("the splash theme is MainActivity's, not the application's", activity!!.value.contains("""android:theme="@style/Theme.Zen.Splash""""))
        assertTrue("the application keeps the browser theme", manifest.contains("""android:theme="@style/Theme.Zen""""))

        val build = read("build.gradle.kts", "app/build.gradle.kts")
        assertTrue(build.contains("androidx.core:core-splashscreen:"))
    }

    @Test
    fun theRestoredPictureIsForTheBootsRestoreOnlyOverAnUnpaintedViewOnce() {
        assertTrue(RestoredPictures.wanted(restoring = true, painted = false, shown = false))
        assertFalse("a load after READY is the user's", RestoredPictures.wanted(restoring = false, painted = false, shown = false))
        assertFalse("a page that has drawn is not covered", RestoredPictures.wanted(restoring = true, painted = true, shown = false))
        assertFalse("one per tab", RestoredPictures.wanted(restoring = true, painted = false, shown = true))
    }
}
