package app.zen.chromium

import android.view.View
import androidx.core.splashscreen.SplashScreenViewProvider
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * The cold start's splash (OS-26): the hold lifts once, on the chrome's READY after the platform's
 * hand-over – or on the watchdog, when no READY comes – and never before either; the class around
 * it, run against fakes of its three seams (the platform's view, the bars, the clock): the bars'
 * tone kept for the exit's end, the reduced-motion fade, the watchdog's fire, cancel after the
 * hand-over; and the theme wiring is checked from the files, since a splash theme whose post
 * theme, colour or icon drifted would still build and show the wrong thing for a second on every
 * cold start.
 */
class StartupSplashTest {
    private fun read(vararg candidates: String): String {
        val file = candidates.map(::File).firstOrNull { it.exists() }
        assertTrue("${candidates.first()} not found from ${File(".").absolutePath}", file != null)
        return file!!.readText()
    }

    /** The platform's view as the test sees it: what the hold did to it, in order; the motion's end is the test's to call. */
    private class FakeSurface : SplashSurface {
        val events = mutableListOf<String>()
        private var ended: (() -> Unit)? = null
        override fun dress(skin: (SplashScreenViewProvider) -> SplashSkin): SplashSkin? {
            events.add("dress")
            return null
        }
        override fun exit(icon: View?, onEnd: () -> Unit) {
            events.add("exit")
            ended = onEnd
        }
        override fun fadeInPlace(onEnd: () -> Unit) {
            events.add("fade")
            ended = onEnd
        }
        override fun remove() {
            events.add("remove")
        }
        /** The motion's last frame: the view is gone. */
        fun end() {
            val done = ended
            ended = null
            events.add("gone")
            done?.invoke()
        }
    }

    private class FakeBars(initial: Boolean) : SplashBars {
        val writes = mutableListOf<Boolean>()
        override var light: Boolean = initial
            set(value) {
                field = value
                writes.add(value)
            }
    }

    private class FakeClock : SplashClock {
        var now = 1_000L
        val pending = mutableListOf<Pair<Runnable, Long>>()
        override fun uptimeMillis(): Long = now
        override fun postDelayed(work: Runnable, delayMs: Long) {
            pending.add(work to delayMs)
        }
        override fun removeCallbacks(work: Runnable) {
            pending.removeAll { it.first === work }
        }
        /** Every delayed work item runs, as the main thread would run it once its delay is over. */
        fun fire() {
            val due = pending.toList()
            pending.clear()
            for ((work, _) in due) work.run()
        }
    }

    private class Rig(postThemeLightBars: Boolean = true, animators: Boolean = true) {
        val surface = FakeSurface()
        val bars = FakeBars(postThemeLightBars)
        val clock = FakeClock()
        val warnings = mutableListOf<String>()
        val splash = StartupSplash(clock, bars, { animators }, null) { message, _ -> warnings.add(message) }
    }

    @Test
    fun theBarsWearTheSplashsToneFromTheHandOverToTheExitsEnd() {
        // The post theme asked for dark icons (a light chrome); the splash's indigo wants light ones.
        val rig = Rig(postThemeLightBars = true)
        rig.splash.handOver(rig.surface)
        assertEquals("the splash's tone at the hand-over", listOf(false), rig.bars.writes)
        assertTrue(rig.splash.held)
        // The chrome's theme asks for dark icons while the splash is up: kept, not applied.
        rig.splash.systemBarsLight(true)
        assertEquals(listOf(false), rig.bars.writes)
        rig.clock.now += 1_500
        rig.splash.ready()
        assertEquals("READY starts the exit motion", listOf("exit"), rig.surface.events)
        assertEquals(1_500L, rig.splash.heldForMs)
        assertFalse(rig.splash.held)
        assertEquals("the exit's start flips nothing: the indigo is still on screen", listOf(false), rig.bars.writes)
        rig.surface.end()
        assertEquals("the chrome's tone lands with the exit's end", listOf(false, true), rig.bars.writes)
        assertTrue("the watchdog was withdrawn", rig.clock.pending.isEmpty())
    }

    @Test
    fun theChromesToneIsAppliedAtOnceOnlyWhenNothingOfTheSplashIsOnScreen() {
        val rig = Rig(postThemeLightBars = true)
        // Before the hand-over the window is bare: the chrome's word goes straight through, and
        // it is the word the lift restores (the post theme's is not read over it).
        rig.splash.systemBarsLight(false)
        assertEquals(listOf(false), rig.bars.writes)
        rig.splash.handOver(rig.surface)
        assertEquals(listOf(false, false), rig.bars.writes)
        rig.splash.ready()
        // A new word during the exit motion waits for its end too.
        rig.splash.systemBarsLight(true)
        assertEquals(listOf(false, false), rig.bars.writes)
        rig.surface.end()
        assertEquals(listOf(false, false, true), rig.bars.writes)
        // After the lift the bars are the chrome's alone.
        rig.splash.systemBarsLight(false)
        assertEquals(listOf(false, false, true, false), rig.bars.writes)
    }

    @Test
    fun reducedMotionLiftsOnTheFadeInPlaceNotACut() {
        val rig = Rig(animators = false)
        rig.splash.handOver(rig.surface)
        rig.splash.systemBarsLight(true)
        rig.splash.ready()
        assertEquals("§11.3's departure: the fade, never remove()", listOf("fade"), rig.surface.events)
        assertEquals(listOf(false), rig.bars.writes)
        rig.surface.end()
        assertEquals("the bars' tone with the fade's end, as with the motion's", listOf(false, true), rig.bars.writes)
        assertEquals(120L, SplashExit.REDUCED_FADE_MS)
    }

    @Test
    fun readyBeforeTheHandOverLiftsAtTheHandOverWithNoWatchdogPosted() {
        val rig = Rig()
        rig.splash.ready()
        assertTrue(rig.surface.events.isEmpty())
        rig.splash.handOver(rig.surface)
        assertEquals(listOf("exit"), rig.surface.events)
        assertEquals("ready", rig.splash.hold.liftedBy)
        assertTrue("nothing to watch", rig.clock.pending.isEmpty())
    }

    @Test
    fun theWatchdogLiftsASplashWithNoReadyAndSaysSo() {
        val rig = Rig()
        rig.splash.handOver(rig.surface)
        assertEquals(listOf(StartupSplash.WATCHDOG_MS), rig.clock.pending.map { it.second })
        rig.clock.now += StartupSplash.WATCHDOG_MS
        rig.clock.fire()
        assertEquals("watchdog", rig.splash.hold.liftedBy)
        assertEquals(listOf("exit"), rig.surface.events)
        assertEquals(1, rig.warnings.size)
        assertTrue(rig.warnings[0], rig.warnings[0].contains("did not report ready within ${StartupSplash.WATCHDOG_MS} ms"))
        // A late READY finds the splash lifted.
        rig.splash.ready()
        assertEquals(listOf("exit"), rig.surface.events)
    }

    @Test
    fun cancelAfterTheHandOverRemovesTheViewAndTheWatchdogAndALaterReadyDoesNothing() {
        val rig = Rig()
        rig.splash.handOver(rig.surface)
        rig.splash.cancel()
        assertEquals(listOf("remove"), rig.surface.events)
        assertTrue("no watchdog into a dead window", rig.clock.pending.isEmpty())
        rig.clock.fire()
        rig.splash.ready()
        assertEquals("nothing left to lift", listOf("remove"), rig.surface.events)
        assertNull(rig.splash.hold.liftedBy)
        assertEquals("no bars touched after the window's end", listOf(false), rig.bars.writes)
        assertTrue(rig.warnings.isEmpty())
        // Cancel before any hand-over is nothing at all.
        val fresh = Rig()
        fresh.splash.cancel()
        assertTrue(fresh.surface.events.isEmpty())
    }

    @Test
    fun theWatchdogIsDerivedFromTheLongestHoldTheEmulatorHasShown() {
        // The status bar driver's first boot on the API 35 image held the splash 4205 ms; the
        // margin is twice that, rounded up – a slower runner's boot still lifts by READY.
        assertEquals(4_205L, StartupSplash.LONGEST_HELD_SEEN_MS)
        assertTrue(StartupSplash.WATCHDOG_MS >= 2 * StartupSplash.LONGEST_HELD_SEEN_MS)
        assertEquals(10_000L, StartupSplash.WATCHDOG_MS)
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
        assertTrue("the boot theme follows the splash", style.contains("""<item name="postSplashScreenTheme">@style/Theme.Zen.Boot</item>"""))
        assertTrue("the brand colour is the default launcher icon's background", style.contains("""<item name="windowSplashScreenBackground">@color/ic_launcher_bg_indigo</item>"""))
        assertTrue("the mark is the launcher's foreground", style.contains("""<item name="windowSplashScreenAnimatedIcon">@drawable/ic_launcher_foreground</item>"""))
        assertTrue("API 33+ shows the icon for a plain start too", style.contains("""icon_preferred"""))
        assertTrue("light icons over the indigo", style.contains("""<item name="android:windowLightStatusBar">false</item>"""))

        // The window the splash is handed to wears the splash's colour until the chrome's first
        // theme (Host.applyTheme): the frame the platform draws between its starting window and
        // the transferred splash view is indigo, not zen_background – the plain window the row
        // removes. Theme.Zen's child by name, so the night Theme.Zen is its parent at night too.
        val boot = Regex("""<style name="Theme\.Zen\.Boot"[^>]*>(.*?)</style>""", RegexOption.DOT_MATCHES_ALL).find(themes)
        assertTrue("Theme.Zen.Boot is defined", boot != null)
        assertFalse("the browser theme is its parent by name", boot!!.value.contains("parent="))
        assertTrue("the window's background is the splash's colour", boot.value.contains("""<item name="android:windowBackground">@color/ic_launcher_bg_indigo</item>"""))
        assertTrue("light icons over it, as over the splash", boot.value.contains("""<item name="android:windowLightStatusBar">false</item>"""))
        assertTrue(boot.value.contains("""<item name="android:windowLightNavigationBar" tools:targetApi="o">false</item>"""))
        val night = read("src/main/res/values-night/themes.xml", "app/src/main/res/values-night/themes.xml")
        assertFalse("one boot theme for both schemes: the night file defines none of its own", night.contains("Theme.Zen.Boot"))

        // The colour is the launcher's: the default adaptive icon's background is that same colour.
        val icon = read("src/main/res/mipmap-anydpi-v26/ic_launcher.xml", "app/src/main/res/mipmap-anydpi-v26/ic_launcher.xml")
        assertTrue(icon.contains("""<background android:drawable="@color/ic_launcher_bg_indigo" />"""))
        assertTrue(icon.contains("""<foreground android:drawable="@drawable/ic_launcher_foreground" />"""))
    }

    @Test
    fun theBootThemeIsReplacedByTheChromesFirstThemeBeforeReady() {
        // Host.applyTheme paints the root and the decor in the chrome's colour at every
        // `chrome.setTheme`; the first comes with the chrome's boot, before READY's theme-painted
        // fact – so nothing after the boot wears the boot theme's indigo. Pinned from the source.
        val host = read("src/main/kotlin/app/zen/chromium/Host.kt", "app/src/main/kotlin/app/zen/chromium/Host.kt")
        val applyTheme = Regex("""fun applyTheme\((.*?)\n    }\n""", RegexOption.DOT_MATCHES_ALL).find(host)
        assertTrue("Host.applyTheme is there", applyTheme != null)
        assertTrue("the decor's background is the chrome's", applyTheme!!.value.contains("activity.window.decorView.setBackgroundColor(color)"))
        assertTrue("the root's too", applyTheme.value.contains("root.setBackgroundColor(color)"))
        assertTrue("and the bars' tone is the chrome's word to the splash", applyTheme.value.contains("activity.setSystemBarsLight(!dark)"))
    }

    @Test
    fun theRestoredPictureIsOfferedOnBothOfTheBootsRestorePaths() {
        // The session's tabs come back through `view.restoreNavigation` (their lists kept) and a
        // tab without a list through `view.load`; run 1 of the harness failed on the picture
        // offered at `view.load` alone. Both dispatch branches offer it, and nothing else does.
        val host = read("src/main/kotlin/app/zen/chromium/Host.kt", "app/src/main/kotlin/app/zen/chromium/Host.kt")
        fun branch(case: String): String {
            val start = host.indexOf("\n            \"$case\" -> {")
            assertTrue("the dispatch has a $case branch", start >= 0)
            val next = host.indexOf("\n            \"", start + 1)
            return host.substring(start, if (next < 0) host.length else next)
        }
        assertTrue("view.load offers the picture", branch("view.load").contains("restoredPictures.offer(tab, url)"))
        val restore = branch("view.restoreNavigation")
        assertTrue("view.restoreNavigation offers it for the entry the list is loading", restore.contains("NavigationState.currentUrl(entries, index)?.let { restoredPictures.offer(tab, it) }"))
        assertTrue("only a list that was restored has an entry loading", restore.contains("if (restored) NavigationState.currentUrl"))
        assertEquals("the two sites, and no third", 2, Regex("""restoredPictures\.offer\(""").findAll(host).count())
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
