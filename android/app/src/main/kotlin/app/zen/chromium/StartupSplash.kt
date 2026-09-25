package app.zen.chromium

import android.animation.Animator
import android.animation.AnimatorListenerAdapter
import android.animation.ValueAnimator
import android.app.Activity
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import android.view.View
import android.view.Window
import android.view.animation.PathInterpolator
import androidx.core.splashscreen.SplashScreen
import androidx.core.splashscreen.SplashScreenViewProvider
import androidx.core.view.WindowInsetsControllerCompat

/**
 * The hold's bookkeeping, pure so the JVM test can run it (StartupSplashTest): the splash lifts
 * once, on the first of the chrome's READY after the hand-over and the watchdog. READY before
 * the hand-over (the chrome faster than the platform's first frame) waits for it; a second READY
 * or a watchdog after the lift do nothing. A hand-over is answered every time ([HandOver]): the
 * hold takes the first view only – a second one while it is held is surplus, and one after the
 * lift is LATE, a view nothing would ever lift (READY has been heard, the watchdog needs the
 * hold), so [StartupSplash] sends it away at once instead of keeping it.
 */
class SplashHold {
    var handedOver = false
        private set
    var chromeReady = false
        private set
    var lifted = false
        private set
    /** What lifted the splash: "ready" or "watchdog"; null while it is up or was never handed over. */
    var liftedBy: String? = null
        private set

    /** The hold's answer to a hand-over. */
    enum class HandOver {
        /** The first view, READY not heard yet: hold it, arm the watchdog. */
        HOLD,
        /** The first view, READY already heard: lift it now. */
        LIFT,
        /** A second view while the first is held: it goes, the first stays the one lifted. */
        SURPLUS,
        /** A view after the lift – the icon trampoline's starting window transferred over the running chrome: it departs at once, the hold untouched. */
        LATE
    }

    /** The platform handed a splash view over. */
    fun handOver(): HandOver = when {
        lifted -> HandOver.LATE
        handedOver -> HandOver.SURPLUS
        else -> {
            handedOver = true
            if (chromeReady) HandOver.LIFT else HandOver.HOLD
        }
    }

    /** The chrome's first real frame is on screen: true when the splash should lift now. */
    fun ready(): Boolean {
        if (chromeReady) return false
        chromeReady = true
        return handedOver && !lifted
    }

    /** The watchdog fired: true when the splash is still up with no READY heard. */
    fun watchdog(): Boolean = handedOver && !lifted && !chromeReady

    fun lift(by: String) {
        lifted = true
        liftedBy = by
    }
}

/**
 * The exit motion's numbers (v2 §11.10, the design gate on #454): the chrome's DEPARTURE, one
 * object leaving – 180 ms on the standard curve (`--zen-ease`, v1 §7's pop), the mark at
 * `scale(1 − .1·t)` with its opacity, the ground's opacity with it (§11.4's card departure), no
 * delay between the two, the system bars' tone flipping at the end. Not the platform's app reveal
 * (its icon fade, then its view fade, on a radial reveal's timings) and not a spring on an
 * opacity. Under reduced motion the departure is §11.3's: a 120 ms opacity fade in place on the
 * same curve, the mark with the ground (the chrome's `REDUCED_FADE_MS`), not a cut.
 *
 * `t` is the curve's progress: 0 at the lift, 1 as the view is gone. The mark's opacity is the
 * ground's – the platform's view fades as one object, its mark inside it, the way a card and its
 * content take one `opacity` – so the two are in step by construction and nothing compounds;
 * [markAlpha] and [groundAlpha] name the two for the reader and the test.
 */
object SplashExit {
    /** The departure's clock: the pop's 180 ms (v1 §7). */
    const val DURATION_MS = 180L
    /** §11.3's one duration under reduced motion. */
    const val REDUCED_FADE_MS = 120L
    /** The mark's scale runs from 1 to 1 − this: §11.4's `scale(1 − .1·t)`. */
    const val SCALE_DEPTH = 0.1f
    /** The standard curve's control points: `--zen-ease`, `cubic-bezier(0.2, 0.8, 0.2, 1)`. */
    val CURVE = floatArrayOf(0.2f, 0.8f, 0.2f, 1f)
    /** Lazily: the interpolator is the platform's class, and the JVM test reads the numbers alone. */
    val curve by lazy { PathInterpolator(CURVE[0], CURVE[1], CURVE[2], CURVE[3]) }

    /** The mark's scale at progress [t]. */
    fun scale(t: Float): Float = 1f - SCALE_DEPTH * t
    /** The mark's opacity at [t]: the ground's, in step. */
    fun markAlpha(t: Float): Float = 1f - t
    /** The ground's opacity at [t]. */
    fun groundAlpha(t: Float): Float = 1f - t
}

/**
 * What a window's own skin put on the platform's splash view at the hand-over (PWA-06,
 * [WebAppSplash]): the mark the departure scales and fades with the ground (null: the platform's
 * own icon view), and the tone the system bars' icons keep while the splash is held (light for a
 * light ground).
 */
class SplashSkin(val iconView: View?, val lightBars: Boolean)

/**
 * The platform's splash view as the hold works it – dressed by a skin, faded at the exit, taken
 * away – behind an interface, so the hold's decisions run on the JVM against a recording fake
 * (StartupSplashTest); [PlatformSplashSurface] is the app's, over the library's provider.
 */
interface SplashSurface {
    /** The skin's dress of the platform's view (PWA-06); null where there is no view to dress. */
    fun dress(skin: (SplashScreenViewProvider) -> SplashSkin): SplashSkin?
    /**
     * The departure ([SplashExit]): the mark – `icon` when the skin put one on, else the
     * platform's – at `scale(1 − .1·t)` while the view, mark and all, fades over the app as one
     * object, 180 ms on the standard curve; `onEnd` as the view is gone.
     */
    fun exit(icon: View?, onEnd: () -> Unit)
    /** The reduced-motion departure: the view, mark and all, fades in place over [SplashExit.REDUCED_FADE_MS]; `onEnd` as it is gone. */
    fun fadeInPlace(onEnd: () -> Unit)
    /** Gone at once, no motion (the activity's end). */
    fun remove()
}

/** The system bars' icon tone: read at the hand-over, written at the lift. The window's controller in the app, a fake in the test. */
interface SplashBars {
    var light: Boolean
}

/** The main thread's clock and delayed work (the watchdog, the held time for the log): a Handler in the app, a fake in the test. */
interface SplashClock {
    fun uptimeMillis(): Long
    fun postDelayed(work: Runnable, delayMs: Long)
    fun removeCallbacks(work: Runnable)
}

/**
 * The cold start's splash (OS-26): the platform's starting window – the launcher's mark on the
 * brand colour, `Theme.Zen.Splash` – handed to this window at its first frame and held there
 * until the chrome's first real frame, then lifted on the exit motion.
 *
 * A web app's window ([WebAppActivity]) uses the same hold with a [skin]: at the hand-over the
 * skin re-dresses the platform's view in the app's own colour and tile ([WebAppSplash]), and the
 * page's first frame is its READY. The bars' tone for the hold and the icon the exit fades are
 * the skin's then; with no skin they are the browser's (light icons over the indigo, the
 * platform's icon view).
 *
 * The hold is the exit listener's, not `setKeepOnScreenCondition`'s. That one holds the window's
 * first frame back from an `OnPreDrawListener`, which would hold back the chrome WebView's draws
 * while it boots – the very frame being waited for – and move `am start -W`'s TotalTime (the
 * plain window's first frame) out from under the pair tool's before/after. With the listener
 * set, the platform draws the window's first frame under the splash as before, moves the
 * `SplashScreenView` into this window and hands it here; the chrome boots under it, drawing every
 * frame it likes, and [lift] takes it away once the chrome has painted its first real frame
 * (MainActivity.onChromeReady: `chrome.ready` from boot.ts, confirmed by the WebView's
 * visual-state callback).
 *
 * READY comes from the chrome or not at all (a boot that fails never says it): the watchdog lifts
 * the splash [WATCHDOG_MS] after the hand-over so the window is never a splash for good, and says
 * so in the log. It is a safety net, not the exit condition.
 *
 * The listener fires once per starting window the platform gives this window, and a running
 * browser can be given a second one: a launch through the icon alias with `FLAG_ACTIVITY_NEW_TASK`
 * alone (Settings' Open, `adb shell am start`, `getLaunchIntentForPackage`) puts [IconTapActivity]
 * on top of the live task, the platform draws its splash for the task switch, transfers it to this
 * window at the forward's clear-top and hands the copy here – after the lift, with the chrome
 * READY long since. Nothing would lift that copy (the hold is spent, the watchdog needs it), so it
 * departs at once on the exit motion ([SplashHold.HandOver.LATE]); until round 5 of #454 it stayed
 * on screen for good – runs 7 and 8's `alias_open` recordings. A second view while the first is
 * held (SURPLUS) is removed; the first stays the one lifted.
 *
 * The system bars' icon tone during the hold is the splash theme's (light icons over the indigo);
 * what the chrome asks for meanwhile (Host.applyTheme → [systemBarsLight]) is kept and applied
 * at the exit's END – the splash's colour is on screen until the last frame of the departure, and
 * dark icons over the indigo for its 180 ms would be the flip the hold exists to avoid.
 *
 * Reduced motion (the animator duration scale at zero – Settings' "Remove animations" sets it;
 * nothing else is read) lifts the splash on §11.3's 120 ms opacity fade in place.
 */
class StartupSplash internal constructor(
    private val clock: SplashClock,
    private val bars: SplashBars,
    private val animatorsEnabled: () -> Boolean,
    /** A window's own dress for the platform's splash view, applied once at the hand-over (PWA-06); null for the browser's. */
    private val skin: ((SplashScreenViewProvider) -> SplashSkin)?,
    /** A line for the log at an event the harness reads (the late hand-over): `Log.i` in the app. */
    private val note: (String) -> Unit,
    private val warn: (String, Throwable?) -> Unit
) {
    /** The app's: the window's bars, the main thread's Handler and clock, the platform's animator switch, logcat. */
    constructor(window: Window, skin: ((SplashScreenViewProvider) -> SplashSkin)? = null) : this(
        HandlerSplashClock(Handler(Looper.getMainLooper())),
        WindowSplashBars(window),
        { ValueAnimator.areAnimatorsEnabled() },
        skin,
        { message -> Log.i(TAG, message) },
        { message, error -> Log.w(TAG, message, error) }
    )

    val hold = SplashHold()
    private var surface: SplashSurface? = null
    private var skinned: SplashSkin? = null
    private var barsLight: Boolean? = null
    private var handedOverAt = 0L
    /** Views on the exit motion: while one is, the splash's colour is still on screen and the bars keep its tone. */
    private var departing = 0
    private val exiting: Boolean get() = departing > 0
    private val watchdog = Runnable {
        if (!hold.watchdog()) return@Runnable
        warn("splash: the chrome did not report ready within $WATCHDOG_MS ms of the hand-over; lifting", null)
        lift("watchdog")
    }

    /**
     * Lets the platform's exit listener go at the lift; set by [attach], run once. With no listener
     * registered, the next resume of the activity reports `handleSplashScreenExit = false`
     * (`ResumeActivityItem.postExecute` → `ActivityRecord.setCustomizeSplashScreenExitAnimation`),
     * and a starting window transferred to this window later – the icon trampoline's, on a
     * `NEW_TASK`-alone relaunch over the running chrome – is never copied to the client: the
     * platform's own splash runs its exit and removes itself, and nothing is reparented. The copy
     * path (`transferSplashScreenIfNeeded` → the copy attached to the decor, the shell's window
     * hidden through a leash, `onSplashScreenAttachComplete`'s `cancelAnimation` reparenting the
     * shell's surface back before its removal lands) is the flash runs 7–9 of #454 recorded.
     */
    internal var release: (() -> Unit)? = null

    /** Whether the platform's listener has been let go (the lift ran [release]). */
    var released = false
        private set

    /**
     * Before the window's first frame (MainActivity.onCreate): take the splash view when the
     * platform hands it over, and let the listener go at the lift through [release] – the app
     * passes [platformRelease]. Below API 33 the platform's listener cannot be cleared, so the copy
     * still comes on a relaunch and [SplashHold.HandOver.LATE] sends it away at once.
     */
    fun attach(splashScreen: SplashScreen, release: (() -> Unit)? = null) {
        this.release = release
        splashScreen.setOnExitAnimationListener { view -> handOver(PlatformSplashSurface(view)) }
    }

    /** The platform handed a splash view over (the exit listener: at the window's first frame, and again for a starting window transferred here later). */
    internal fun handOver(view: SplashSurface) {
        val answer = hold.handOver()
        when (answer) {
            SplashHold.HandOver.LATE -> {
                departLate(view)
                return
            }
            SplashHold.HandOver.SURPLUS -> {
                note("splash: a second hand-over while the first is held; the surplus view removed")
                view.remove()
                return
            }
            SplashHold.HandOver.HOLD, SplashHold.HandOver.LIFT -> Unit
        }
        surface = view
        handedOverAt = clock.uptimeMillis()
        // The library applied the post theme's bar tone as it handed the view over; the splash is
        // still up, so the splash's tone stays until it lifts – and the theme's is what the lift
        // restores when the chrome has asked for none by then.
        if (barsLight == null) barsLight = bars.light
        skinned = skin?.let { dress -> runCatching { view.dress(dress) }.onFailure { warn("splash: the skin failed; the platform's view stays", it) }.getOrNull() }
        bars.light = skinned?.lightBars ?: false
        if (answer == SplashHold.HandOver.LIFT) {
            lift("ready")
            return
        }
        clock.postDelayed(watchdog, WATCHDOG_MS)
    }

    /**
     * A view handed over after the lift ([SplashHold.HandOver.LATE]): the icon trampoline's
     * starting window, transferred to this window over the running chrome. Nothing is booting
     * under it, so it departs now on the same motion as the lift's – the splash's tone on the bars
     * for its 180 ms (the library wrote the theme's as it handed the view over), the chrome's
     * ask restored at the end – and the hold, the watchdog and the lift's numbers stay as they are.
     */
    private fun departLate(view: SplashSurface) {
        note("splash: a hand-over after the lift (the icon trampoline's starting window transferred over the running chrome); departing at once")
        // The view is the platform's as drawn, not dressed: with no skin it is the browser's splash
        // theme, light icons over the indigo until it is gone. A skinned window keeps the tone the
        // theme gave its undressed view.
        if (skin == null) {
            if (barsLight == null) barsLight = bars.light
            bars.light = false
        }
        depart(view, icon = null)
    }

    /** The chrome's first real frame is on screen: lift the splash if the platform has handed it over, else as soon as it does. */
    fun ready() {
        if (hold.ready()) lift("ready")
    }

    /**
     * The tone the chrome asks the bars' icons for (dark icons for a light chrome): applied now
     * when nothing of the splash is on screen, kept for the exit's end while it is.
     */
    fun systemBarsLight(light: Boolean) {
        barsLight = light
        if (!held && !exiting) bars.light = light
    }

    /** The splash is up over this window (handed over, not lifted). */
    val held: Boolean get() = hold.handedOver && !hold.lifted

    /** Milliseconds from the hand-over to the lift, for the log; null before the lift. */
    var heldForMs: Long? = null
        private set

    private fun lift(by: String) {
        val view = surface ?: return
        surface = null
        clock.removeCallbacks(watchdog)
        hold.lift(by)
        heldForMs = clock.uptimeMillis() - handedOverAt
        releaseListener()
        depart(view, skinned?.iconView)
    }

    /** The lift's release of the platform's listener: once, before the exit motion starts; a failure is logged and the view still departs. */
    private fun releaseListener() {
        val release = this.release ?: return
        this.release = null
        try {
            release()
            released = true
            note("splash: the platform's exit listener released at the lift; a starting window transferred here later is the platform's to end")
        } catch (error: RuntimeException) {
            warn("splash: the platform's exit listener could not be released; a later hand-over departs at once", error)
        }
    }

    /** The view leaves on the exit motion – or the reduced-motion fade – and the bars take the chrome's tone as the last one is gone. */
    private fun depart(view: SplashSurface, icon: View?) {
        departing++
        var done = false
        val gone: () -> Unit = {
            if (!done) {
                done = true
                if (departing > 0) departing--
                if (departing == 0) barsLight?.let { bars.light = it }
            }
        }
        if (animatorsEnabled()) view.exit(icon, gone) else view.fadeInPlace(gone)
    }

    /** The activity is going: nothing left to lift, no watchdog to fire into a dead window. */
    fun cancel() {
        clock.removeCallbacks(watchdog)
        surface?.remove()
        surface = null
        departing = 0
    }

    companion object {
        const val TAG = "ZenStartup"
        /**
         * The safety net after the hand-over. Derived, not asserted: the longest hold the
         * harness has read is 4205 ms (the status bar driver's first boot in its process on the
         * API 35 image, a 14 MB seeded history; the startup scene's cold starts hold 1.2–3.5 s,
         * the pair's 1.7–2.1 s) – twice that, rounded up, so a slower runner's boot still ends
         * in the chrome under a splash lifted by READY, and a boot that has not painted its
         * chrome 10 s after the platform's first frame is one whose window is shown as it is.
         */
        const val WATCHDOG_MS = 10_000L
        /** The longest hold read on the recipe's emulator (ms), the watchdog's derivation; pinned by the test. */
        const val LONGEST_HELD_SEEN_MS = 4_205L

        /**
         * The release for [attach]: API 33+ clears the platform's exit listener
         * (`android.window.SplashScreen.clearOnExitAnimationListener`); below it, nothing can, and
         * the release is a no-op – a relaunch's copy still comes and departs at once.
         */
        fun platformRelease(activity: Activity): () -> Unit = {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) activity.splashScreen.clearOnExitAnimationListener()
        }
    }
}

/** The library's provider as a [SplashSurface]: the departure and the reduced-motion fade on the platform's view. */
class PlatformSplashSurface(private val provider: SplashScreenViewProvider) : SplashSurface {
    override fun dress(skin: (SplashScreenViewProvider) -> SplashSkin): SplashSkin = skin(provider)

    override fun exit(icon: View?, onEnd: () -> Unit) {
        val mark = icon ?: runCatching { provider.iconView }.getOrNull()
        val view = provider.view
        // A skin's dress still blending the mark in (a page whose first frame beat the 150 ms)
        // yields to the departure; the ground's blend ends on its own inside the departure's time.
        mark?.animate()?.cancel()
        // One animator, one clock: the mark's scale and the view's opacity from the same progress
        // on the standard curve. The mark's opacity is the view's – the view fades as one object
        // with its mark inside it – so nothing is set on the mark's alpha and nothing compounds.
        ValueAnimator.ofFloat(0f, 1f).apply {
            duration = SplashExit.DURATION_MS
            interpolator = SplashExit.curve
            addUpdateListener { animator ->
                val t = animator.animatedValue as Float
                mark?.let {
                    val s = SplashExit.scale(t)
                    it.scaleX = s
                    it.scaleY = s
                }
                view.alpha = SplashExit.groundAlpha(t)
            }
            addListener(object : AnimatorListenerAdapter() {
                override fun onAnimationEnd(animation: Animator) {
                    provider.remove()
                    onEnd()
                }
            })
            start()
        }
    }

    override fun fadeInPlace(onEnd: () -> Unit) {
        // Not an animator: the setting that brings the lift here scales every animator's duration
        // to zero (a ValueAnimator would end on its first frame – the cut §11.3 rules out), so the
        // fade is stepped on the frame clock from the uptime itself, on the departure's curve.
        val view = provider.view
        val started = SystemClock.uptimeMillis()
        view.postOnAnimation(object : Runnable {
            override fun run() {
                val t = ((SystemClock.uptimeMillis() - started).toFloat() / SplashExit.REDUCED_FADE_MS).coerceIn(0f, 1f)
                view.alpha = SplashExit.groundAlpha(SplashExit.curve.getInterpolation(t))
                if (t < 1f) {
                    view.postOnAnimation(this)
                } else {
                    provider.remove()
                    onEnd()
                }
            }
        })
    }

    override fun remove() = provider.remove()
}

/**
 * The window's bars through androidx core's `WindowInsetsControllerCompat`: the status bar's tone
 * read, both bars' written in one tone. On API 30+ the compat's `Impl30.setAppearanceLight*`
 * writes the decor's legacy flag AND the platform controller's `setSystemBarsAppearance` – the bit
 * becomes controlled, and neither the theme's seeding nor another view's legacy flag moves it
 * afterwards (core 1.15.0, read with `javap`; `Impl35` inherits the setters). Round 4 of #454
 * doubled the write on a premise the bytecode refutes (a `SystemBarInk` object, dropped in round 5);
 * the round-3 still's dark navigation glyphs were the launcher's taskbar, not this window's ask.
 */
class WindowSplashBars(private val window: Window) : SplashBars {
    override var light: Boolean
        get() = WindowInsetsControllerCompat(window, window.decorView).isAppearanceLightStatusBars
        set(value) {
            val controller = WindowInsetsControllerCompat(window, window.decorView)
            controller.isAppearanceLightStatusBars = value
            controller.isAppearanceLightNavigationBars = value
        }
}

class HandlerSplashClock(private val handler: Handler) : SplashClock {
    override fun uptimeMillis(): Long = SystemClock.uptimeMillis()
    override fun postDelayed(work: Runnable, delayMs: Long) {
        handler.postDelayed(work, delayMs)
    }
    override fun removeCallbacks(work: Runnable) = handler.removeCallbacks(work)
}
