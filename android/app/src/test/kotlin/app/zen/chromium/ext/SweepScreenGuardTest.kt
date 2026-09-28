package app.zen.chromium.ext

import app.zen.chromium.ext.SweepScreenGuard.Exit
import app.zen.chromium.ext.SweepScreenGuard.Reading
import app.zen.chromium.ext.SweepScreenGuard.Window
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** The compat sweep's screen guard (`CompatSweep.onScreen` and its prompt taps), decided in [SweepScreenGuard]. */
class SweepScreenGuardTest {
    private val browser = "io.github.benitbuhner.zenium.debug"
    private val typeIme = 2
    private val typeSystem = 3

    private val statusBar = Window(typeSystem, "com.android.systemui", 90)
    private val navBar = Window(typeSystem, "com.android.systemui", 91)
    private val browserWindow = Window(SweepScreenGuard.TYPE_APPLICATION, browser, 10)
    private val browserSheet = Window(SweepScreenGuard.TYPE_APPLICATION, browser, 12)
    private val overview = Window(SweepScreenGuard.TYPE_APPLICATION, "com.android.launcher3", 20)

    @Test
    fun `the browser alone under the system bars is on top`() {
        assertEquals(Reading.BrowserOnTop, SweepScreenGuard.read(listOf(statusBar, browserWindow, navBar), browser))
    }

    @Test
    fun `the browser's own sheet window and the keyboard over it are its own`() {
        val ime = Window(typeIme, "com.google.android.inputmethod.latin", 30)
        assertEquals(Reading.BrowserOnTop, SweepScreenGuard.read(listOf(browserWindow, browserSheet, ime, navBar), browser))
    }

    @Test
    fun `the launcher's window over the browser's is Overview - the AOSP lane's Adblock row`() {
        // The transient Recents launch: the browser stays RESUMED under launcher3's window.
        assertEquals(Reading.OverviewOver("com.android.launcher3"), SweepScreenGuard.read(listOf(statusBar, browserWindow, overview, navBar), browser))
        val pixel = overview.copy(packageName = "com.google.android.apps.nexuslauncher")
        assertEquals(Reading.OverviewOver("com.google.android.apps.nexuslauncher"), SweepScreenGuard.read(listOf(browserWindow, pixel), browser))
        val systemUi = overview.copy(packageName = "com.android.systemui")
        assertEquals(Reading.OverviewOver("com.android.systemui"), SweepScreenGuard.read(listOf(browserWindow, systemUi), browser))
    }

    @Test
    fun `the launcher's window under the browser's is Home behind the app, not over it`() {
        val homeBehind = overview.copy(layer = 5)
        assertEquals(Reading.BrowserOnTop, SweepScreenGuard.read(listOf(homeBehind, browserWindow, navBar), browser))
    }

    @Test
    fun `another app's window over the browser's is named`() {
        val other = Window(SweepScreenGuard.TYPE_APPLICATION, "org.videolan.vlc", 20)
        assertEquals(Reading.OtherAppOver("org.videolan.vlc"), SweepScreenGuard.read(listOf(browserWindow, other, navBar), browser))
    }

    @Test
    fun `the topmost foreign window decides when several are over the browser`() {
        val other = Window(SweepScreenGuard.TYPE_APPLICATION, "org.videolan.vlc", 15)
        assertEquals(Reading.OverviewOver("com.android.launcher3"), SweepScreenGuard.read(listOf(browserWindow, other, overview), browser))
    }

    @Test
    fun `no browser window in the list leaves the decision to the lifecycle stage`() {
        assertEquals(Reading.BrowserAbsent, SweepScreenGuard.read(listOf(statusBar, overview, navBar), browser))
        assertEquals(Reading.BrowserAbsent, SweepScreenGuard.read(emptyList(), browser))
    }

    @Test
    fun `a window without a root is skipped`() {
        val rootless = Window(SweepScreenGuard.TYPE_APPLICATION, null, 40)
        assertEquals(Reading.BrowserOnTop, SweepScreenGuard.read(listOf(browserWindow, rootless), browser))
    }

    @Test
    fun `a launcher is known by name or by calling itself one`() {
        assertTrue(SweepScreenGuard.isLauncher("com.android.launcher3"))
        assertTrue(SweepScreenGuard.isLauncher("com.teslacoilsw.launcher"))
        assertTrue(SweepScreenGuard.isLauncher("com.example.launcher.app"))
        assertFalse(SweepScreenGuard.isLauncher("org.videolan.vlc"))
        assertFalse(SweepScreenGuard.isLauncher(browser))
    }

    // --- leaving what is over the browser -----------------------------------------------------------

    @Test
    fun `Overview is left with BACK, at most MAX_BACKS times`() {
        val over = Reading.OverviewOver("com.android.launcher3")
        assertEquals(Exit.PressBack, SweepScreenGuard.exit(over, backsPressed = 0, relaunched = false))
        assertEquals(Exit.PressBack, SweepScreenGuard.exit(over, backsPressed = 1, relaunched = false))
        val gaveUp = SweepScreenGuard.exit(over, backsPressed = SweepScreenGuard.MAX_BACKS, relaunched = false)
        assertTrue(gaveUp is Exit.GiveUp)
        assertTrue((gaveUp as Exit.GiveUp).reason.contains("com.android.launcher3"))
    }

    @Test
    fun `another app is left by relaunching the browser's task, once`() {
        val over = Reading.OtherAppOver("org.videolan.vlc")
        assertEquals(Exit.Relaunch, SweepScreenGuard.exit(over, backsPressed = 0, relaunched = false))
        assertTrue(SweepScreenGuard.exit(over, backsPressed = 0, relaunched = true) is Exit.GiveUp)
    }

    @Test
    fun `a browser on top or absent needs no exit`() {
        assertEquals(Exit.Done, SweepScreenGuard.exit(Reading.BrowserOnTop, backsPressed = 0, relaunched = false))
        assertEquals(Exit.Done, SweepScreenGuard.exit(Reading.BrowserAbsent, backsPressed = 2, relaunched = true))
    }

    // --- the prompt's second finger ---------------------------------------------------------------

    @Test
    fun `a first finger always may go`() {
        assertTrue(SweepScreenGuard.mayTapAgain(0, Reading.OverviewOver("com.android.launcher3")))
        assertTrue(SweepScreenGuard.mayTapAgain(0, Reading.BrowserOnTop))
    }

    @Test
    fun `no second finger where the first opened Overview - the command answers the prompt`() {
        assertFalse(SweepScreenGuard.mayTapAgain(1, Reading.OverviewOver("com.android.launcher3")))
        assertFalse(SweepScreenGuard.mayTapAgain(1, Reading.OtherAppOver("org.videolan.vlc")))
    }

    @Test
    fun `a second finger may go when the first left the browser on top - the sheet still sliding`() {
        assertTrue(SweepScreenGuard.mayTapAgain(1, Reading.BrowserOnTop))
        assertTrue(SweepScreenGuard.mayTapAgain(1, Reading.BrowserAbsent))
    }
}
