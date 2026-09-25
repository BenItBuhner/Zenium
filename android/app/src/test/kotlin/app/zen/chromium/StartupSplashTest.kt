package app.zen.chromium

import android.view.View
import androidx.core.splashscreen.SplashScreenViewProvider
import org.junit.Assert.assertArrayEquals
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
        val notes = mutableListOf<String>()
        val warnings = mutableListOf<String>()
        val splash = StartupSplash(clock, bars, { animators }, null, { notes.add(it) }) { message, _ -> warnings.add(message) }
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
    fun aHandOverAfterTheLiftDepartsAtOnceAndHoldsNothing() {
        // The warm launch through the icon alias with NEW_TASK alone: the trampoline's starting
        // window is transferred over the running browser and the exit listener fires a second
        // time, after READY lifted the first view (runs 7 and 8 of #454: that copy stayed on
        // screen for good). It goes at once on the exit motion; the hold, the watchdog and the
        // lift's numbers are untouched.
        val rig = Rig(postThemeLightBars = true)
        rig.splash.handOver(rig.surface)
        rig.splash.systemBarsLight(true)
        rig.clock.now += 1_200
        rig.splash.ready()
        rig.surface.end()
        assertEquals(listOf("exit", "gone"), rig.surface.events)
        assertEquals(listOf(false, true), rig.bars.writes)
        assertEquals(1_200L, rig.splash.heldForMs)
        assertTrue(rig.clock.pending.isEmpty())
        // The library wrote the theme's tone as it handed the second view over; the chrome asked for dark icons.
        rig.clock.now += 4_000
        val late = FakeSurface()
        rig.splash.handOver(late)
        assertEquals("the late view departs at once, nothing is held", listOf("exit"), late.events)
        assertFalse("not held", rig.splash.held)
        assertEquals("no watchdog armed for it", emptyList<Long>(), rig.clock.pending.map { it.second })
        assertEquals("the lift's numbers stand", 1_200L, rig.splash.heldForMs)
        assertEquals("ready", rig.splash.hold.liftedBy)
        assertEquals("the splash's tone while its colour is on screen", listOf(false, true, false), rig.bars.writes)
        // A word from the chrome during the departure waits for its end, as during the lift's.
        rig.splash.systemBarsLight(true)
        assertEquals(listOf(false, true, false), rig.bars.writes)
        late.end()
        assertEquals("the chrome's tone back with the departure's end", listOf(false, true, false, true), rig.bars.writes)
        assertEquals("said once in the log, for the harness", 1, rig.notes.size)
        assertTrue(rig.notes[0], rig.notes[0].contains("a hand-over after the lift") && rig.notes[0].contains("departing at once"))
        assertTrue("no warning: this is the trampoline's copy, not a fault", rig.warnings.isEmpty())
        // The first view was never touched again.
        assertEquals(listOf("exit", "gone"), rig.surface.events)
        // And a third copy goes the same way.
        val third = FakeSurface()
        rig.splash.handOver(third)
        assertEquals(listOf("exit"), third.events)
        assertEquals(2, rig.notes.size)
    }

    @Test
    fun aHandOverAfterTheWatchdogsLiftDepartsAtOnceToo() {
        val rig = Rig()
        rig.splash.handOver(rig.surface)
        rig.clock.now += StartupSplash.WATCHDOG_MS
        rig.clock.fire()
        assertEquals("watchdog", rig.splash.hold.liftedBy)
        rig.surface.end()
        val late = FakeSurface()
        rig.splash.handOver(late)
        assertEquals(listOf("exit"), late.events)
        assertEquals("watchdog", rig.splash.hold.liftedBy)
        assertTrue("no second watchdog", rig.clock.pending.isEmpty())
        assertEquals(1, rig.warnings.size)
        assertEquals(1, rig.notes.size)
    }

    @Test
    fun aLateHandOverUnderReducedMotionDepartsOnTheFade() {
        val rig = Rig(animators = false)
        rig.splash.handOver(rig.surface)
        rig.splash.systemBarsLight(true)
        rig.splash.ready()
        rig.surface.end()
        val late = FakeSurface()
        rig.splash.handOver(late)
        assertEquals("§11.3's fade for the late copy as for the lift", listOf("fade"), late.events)
        assertEquals(listOf(false, true, false), rig.bars.writes)
        late.end()
        assertEquals(listOf(false, true, false, true), rig.bars.writes)
    }

    @Test
    fun aSecondViewWhileTheFirstIsHeldIsRemovedAndTheFirstIsTheOneLifted() {
        val rig = Rig()
        rig.splash.handOver(rig.surface)
        val surplus = FakeSurface()
        rig.splash.handOver(surplus)
        assertEquals("the surplus view goes at once, no motion", listOf("remove"), surplus.events)
        assertTrue("the first is still held", rig.splash.held)
        assertEquals("one watchdog, the first's", 1, rig.clock.pending.size)
        assertEquals(1, rig.notes.size)
        assertTrue(rig.notes[0], rig.notes[0].contains("second hand-over while the first is held"))
        rig.splash.ready()
        assertEquals("READY lifts the first", listOf("exit"), rig.surface.events)
        assertEquals(listOf("remove"), surplus.events)
        assertTrue(rig.clock.pending.isEmpty())
    }

    @Test
    fun twoViewsDepartingTogetherFlipTheBarsOnceAsTheLastIsGone() {
        // A late copy arriving inside the lift's 180 ms: the bars take the chrome's tone when the
        // last of the two is gone, not as the first ends over the second's colour.
        val rig = Rig(postThemeLightBars = true)
        rig.splash.handOver(rig.surface)
        rig.splash.systemBarsLight(true)
        rig.splash.ready()
        val late = FakeSurface()
        rig.splash.handOver(late)
        assertEquals(listOf("exit"), late.events)
        assertEquals(listOf(false, false), rig.bars.writes)
        rig.surface.end()
        assertEquals("the second is still on screen", listOf(false, false), rig.bars.writes)
        late.end()
        assertEquals(listOf(false, false, true), rig.bars.writes)
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
        assertEquals(SplashHold.HandOver.HOLD, hold.handOver())
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
        assertEquals("the hand-over finds READY waiting and lifts at once", SplashHold.HandOver.LIFT, hold.handOver())
        hold.lift("ready")
        assertEquals("ready", hold.liftedBy)
        assertEquals("a hand-over after the lift is late: nothing to hold, the view departs", SplashHold.HandOver.LATE, hold.handOver())
    }

    @Test
    fun theHoldAnswersEveryHandOverAndTakesTheFirstViewOnly() {
        val hold = SplashHold()
        assertEquals(SplashHold.HandOver.HOLD, hold.handOver())
        assertEquals("a second view while the first is held is surplus", SplashHold.HandOver.SURPLUS, hold.handOver())
        assertTrue("the surplus changed nothing", hold.handedOver && !hold.chromeReady && !hold.lifted)
        assertTrue(hold.ready())
        hold.lift("ready")
        assertEquals(SplashHold.HandOver.LATE, hold.handOver())
        assertEquals("and again", SplashHold.HandOver.LATE, hold.handOver())
        assertEquals("ready", hold.liftedBy)
        assertFalse("the late view never arms the watchdog", hold.watchdog())
        // Lifted by the watchdog: the same.
        val slow = SplashHold()
        slow.handOver()
        assertTrue(slow.watchdog())
        slow.lift("watchdog")
        assertEquals(SplashHold.HandOver.LATE, slow.handOver())
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
    fun theExitIsTheChromesDepartureOneObjectLeaving() {
        // v2 §11.10 (the design gate on #454): 180 ms on the standard curve, the mark at
        // scale(1 − .1·t) with its opacity, the ground's opacity with it, no delay between them.
        assertEquals("the pop's duration", 180L, SplashExit.DURATION_MS)
        assertEquals(1f, SplashExit.scale(0f), 1e-6f)
        assertEquals(0.95f, SplashExit.scale(0.5f), 1e-6f)
        assertEquals("the mark settles at .9, §11.4's departure", 0.9f, SplashExit.scale(1f), 1e-6f)
        for (t in listOf(0f, 0.25f, 0.5f, 0.75f, 1f)) {
            assertEquals("the ground's opacity is 1 − t", 1f - t, SplashExit.groundAlpha(t), 1e-6f)
            assertEquals("the mark's opacity is the ground's, in step at t=$t", SplashExit.groundAlpha(t), SplashExit.markAlpha(t), 1e-6f)
        }
        // The standard curve: --zen-ease, cubic-bezier(0.2, 0.8, 0.2, 1) (v1 §7), not the shell's ease.
        assertArrayEquals(floatArrayOf(0.2f, 0.8f, 0.2f, 1f), SplashExit.CURVE, 1e-6f)
        // §11.3's fade keeps its own duration: one number under reduced motion on both hosts.
        assertEquals(120L, SplashExit.REDUCED_FADE_MS)
        assertTrue("the departure is the pop, the reduced fade the state change", SplashExit.REDUCED_FADE_MS < SplashExit.DURATION_MS)
    }

    @Test
    fun thePlatformsViewTakesTheDepartureOnOneAnimatorTheMarkAndTheGroundTogether() {
        // The surface is the platform's view under a real animator, so its shape is pinned from
        // the source: one ValueAnimator on the departure's clock and curve, no start delay, the
        // mark's scale and the view's opacity from the same progress, the mark's opacity the
        // view's (one object; nothing set on the mark's alpha, so nothing compounds), the view
        // removed and the end told as the motion ends; the reduced fade on the same curve.
        val source = read("src/main/kotlin/app/zen/chromium/StartupSplash.kt", "app/src/main/kotlin/app/zen/chromium/StartupSplash.kt")
        val exit = Regex("""override fun exit\(icon: View\?, onEnd: \(\) -> Unit\) \{(.*?)\n    }\n""", RegexOption.DOT_MATCHES_ALL).find(source)
        assertTrue("PlatformSplashSurface.exit is there", exit != null)
        val body = exit!!.value
        assertTrue("one animator on the departure's clock", body.contains("ValueAnimator.ofFloat(0f, 1f)") && body.contains("duration = SplashExit.DURATION_MS"))
        assertTrue("on the standard curve", body.contains("interpolator = SplashExit.curve"))
        assertFalse("no delay between the mark and the ground", body.contains("startDelay") || body.contains("setStartDelay"))
        assertTrue("the mark scales from the progress", body.contains("val s = SplashExit.scale(t)") && body.contains("it.scaleX = s") && body.contains("it.scaleY = s"))
        assertTrue("the view's opacity is the ground's, the mark inside it", body.contains("view.alpha = SplashExit.groundAlpha(t)"))
        assertFalse("nothing compounds on the mark", Regex("""\.alpha = SplashExit\.markAlpha""").containsMatchIn(body))
        assertEquals("one animator started, not one per part", 1, Regex("""\bstart\(\)""").findAll(body).count())
        assertTrue("the view goes and the end is told as the motion ends", body.contains("override fun onAnimationEnd") && body.contains("provider.remove()") && body.contains("onEnd()"))
        val fade = Regex("""override fun fadeInPlace\(onEnd: \(\) -> Unit\) \{(.*?)\n    }\n""", RegexOption.DOT_MATCHES_ALL).find(source)
        assertTrue("PlatformSplashSurface.fadeInPlace is there", fade != null)
        assertTrue("§11.3's fade steps the ground's opacity on the same curve over its own duration", fade!!.value.contains("SplashExit.groundAlpha(SplashExit.curve.getInterpolation(t))") && fade.value.contains("SplashExit.REDUCED_FADE_MS"))
    }

    @Test
    fun theBarsToneIsWrittenForBothBarsThroughTheCompatController() {
        // androidx core 1.15.0's WindowInsetsControllerCompat.Impl30.setAppearanceLight* writes
        // the decor's legacy flag AND the platform controller's setSystemBarsAppearance (javap on
        // the library, round 5 of #454; Impl35 inherits the setters), so the bit is controlled and
        // holds through relayouts and the theme's seeding. Round 4's SystemBarInk doubled that
        // write on a premise the bytecode refutes; it is gone, and every writer of the tone in the
        // splash's reach is the compat, both bars in one tone.
        val source = read("src/main/kotlin/app/zen/chromium/StartupSplash.kt", "app/src/main/kotlin/app/zen/chromium/StartupSplash.kt")
        assertFalse("no SystemBarInk left", source.contains("object SystemBarInk"))
        val bars = Regex("""class WindowSplashBars\(.*?\n}\n""", RegexOption.DOT_MATCHES_ALL).find(source)
        assertTrue("WindowSplashBars is there", bars != null)
        val body = bars!!.value
        assertTrue("the status bar's tone read through the compat", body.contains("WindowInsetsControllerCompat(window, window.decorView).isAppearanceLightStatusBars"))
        assertTrue("both bars written in one tone", body.contains("controller.isAppearanceLightStatusBars = value") && body.contains("controller.isAppearanceLightNavigationBars = value"))
        val webApp = read("src/main/kotlin/app/zen/chromium/WebAppActivity.kt", "app/src/main/kotlin/app/zen/chromium/WebAppActivity.kt")
        assertFalse("nor in the web app's window", webApp.contains("SystemBarInk"))
        val scheme = Regex("""private fun applyScheme\(\) \{(.*?)\n    }\n""", RegexOption.DOT_MATCHES_ALL).find(webApp)
        assertTrue("WebAppActivity.applyScheme is there", scheme != null)
        assertTrue("the web app's scheme writes both bars through the compat", scheme!!.value.contains("WindowInsetsControllerCompat(window, shell)") && scheme.value.contains("controller.isAppearanceLightStatusBars = !scheme.lightToolbarForeground") && scheme.value.contains("controller.isAppearanceLightNavigationBars = !scheme.lightNavigationForeground"))
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

    /**
     * The icon's tap (IconTapActivity): the platform draws the splash from the theme of the
     * activity the launcher starts and transfers it within one task only, so the aliases' target
     * wears the splash theme, shares the browser's affinity (none of its own) and relinquishes
     * the task's identity to MainActivity – the shape that keeps an icon switch from removing the
     * browser's task. The shortcuts keep the other trampoline, in a task of its own, unseen.
     */
    @Test
    fun theIconsTapWearsTheSplashInTheBrowsersTaskAndHandsTheTasksIdentityOver() {
        val manifest = read("src/main/AndroidManifest.xml", "app/src/main/AndroidManifest.xml")
        val tap = Regex("""<activity\s+android:name="\.IconTapActivity"([^>]*)/>""").find(manifest)
        assertTrue(".IconTapActivity is declared", tap != null)
        val shape = tap!!.value
        assertTrue("the splash theme: the starting window from the tap", shape.contains("""android:theme="@style/Theme.Zen.Splash""""))
        assertTrue("the identity handed to MainActivity the moment it joins", shape.contains("""android:relinquishTaskIdentity="true""""))
        assertFalse("no affinity of its own: MainActivity joins this task, where the window is transferred", shape.contains("android:taskAffinity"))
        assertFalse("the task stays in Recents", shape.contains("android:excludeFromRecents"))
        assertTrue("not exported: the aliases are", shape.contains("""android:exported="false""""))
        val aliases = Regex("""<activity-alias(.*?)</activity-alias>""", RegexOption.DOT_MATCHES_ALL).findAll(manifest).map { it.value }.toList()
        assertTrue("the icon aliases are there", aliases.isNotEmpty())
        for (alias in aliases) assertTrue("every icon alias targets the tap's trampoline", alias.contains("""android:targetActivity=".IconTapActivity""""))
        val shortcuts = read("src/main/kotlin/app/zen/chromium/LauncherIconActivity.kt", "app/src/main/kotlin/app/zen/chromium/LauncherIconActivity.kt")
        assertTrue("the tap's trampoline is the shortcuts' forward under another manifest shape", read("src/main/kotlin/app/zen/chromium/IconTapActivity.kt", "app/src/main/kotlin/app/zen/chromium/IconTapActivity.kt").contains("class IconTapActivity : LauncherIconActivity()"))
        assertTrue("the forward precedes the finish (the task is found by affinity only while its top is not finishing)", shortcuts.indexOf("startActivity(forward)") in 0 until shortcuts.indexOf("finish()"))
        val old = Regex("""<activity\s+android:name="\.LauncherIconActivity"([^>]*)/>""").find(manifest)
        assertTrue("the shortcuts' trampoline keeps its own task and no window", old != null && old.value.contains("""android:taskAffinity=""""") && old.value.contains("Theme.NoDisplay"))
        val xml = read("src/main/shortcuts/shortcuts.xml", "app/src/main/shortcuts/shortcuts.xml")
        assertFalse("the shortcuts never take the tap's trampoline (their CLEAR_TASK would clear the browser's task)", xml.contains("IconTapActivity"))
    }

    @Test
    fun theRestoredPictureIsForTheBootsRestoreOnlyOverAnUnpaintedViewOnce() {
        assertTrue(RestoredPictures.wanted(restoring = true, painted = false, shown = false))
        assertFalse("a load after READY is the user's", RestoredPictures.wanted(restoring = false, painted = false, shown = false))
        assertFalse("a page that has drawn is not covered", RestoredPictures.wanted(restoring = true, painted = true, shown = false))
        assertFalse("one per tab", RestoredPictures.wanted(restoring = true, painted = false, shown = true))
    }
}
