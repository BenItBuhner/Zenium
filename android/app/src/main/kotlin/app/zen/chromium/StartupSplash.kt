package app.zen.chromium

import android.animation.ValueAnimator
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import android.view.View
import android.view.Window
import android.view.animation.LinearInterpolator
import android.view.animation.PathInterpolator
import androidx.core.splashscreen.SplashScreen
import androidx.core.splashscreen.SplashScreenViewProvider
import androidx.core.view.WindowInsetsControllerCompat

/**
 * The hold's bookkeeping, pure so the JVM test can run it (StartupSplashTest): the splash lifts
 * once, on the first of the chrome's READY after the hand-over and the watchdog. READY before
 * the hand-over (the chrome faster than the platform's first frame) waits for it; a second READY,
 * a second hand-over or a watchdog after the lift do nothing.
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

    /** The platform handed the splash view over: true when it should lift right away (READY came first). */
    fun handOver(): Boolean {
        if (handedOver) return false
        handedOver = true
        return chromeReady && !lifted
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
 * The exit motion's numbers, in one place for the lead's ruling (the PR's open question: §11's
 * GENTLE against the system's own). Until ruled, the system default: the platform's app-reveal
 * sequence (WM Shell's SplashScreenExitAnimation) – the icon fades first, then the splash over the
 * app, the app's frame under it the whole way – with its durations
 * (`starting_window_app_reveal_icon_fade_out_duration`, `…_anim_delay`, `…_anim_duration`).
 * Under reduced motion the departure is v2 §11.3's: a 120 ms opacity fade in place, the icon
 * with the view (the chrome's `REDUCED_FADE_MS`), not a cut.
 */
object SplashExit {
    const val ICON_FADE_MS = 133L
    const val REVEAL_DELAY_MS = 83L
    const val REVEAL_MS = 266L
    const val REDUCED_FADE_MS = 120L
    /** Lazily: the interpolators are the platform's classes, and the JVM test reads the numbers alone. */
    val iconCurve by lazy { LinearInterpolator() }
    /** The shell's app reveal is a standard ease (fast out, slow in); the reduced-motion fade takes it too. */
    val revealCurve by lazy { PathInterpolator(0.4f, 0f, 0.2f, 1f) }
}

/**
 * What a window's own skin put on the platform's splash view at the hand-over (PWA-06,
 * [WebAppSplash]): the icon view the exit motion fades first (null: the platform's own), and the
 * tone the system bars' icons keep while the splash is held (light for a light ground).
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
     * The exit motion ([SplashExit]): the icon – `icon` when the skin put one on, else the
     * platform's – fades first, then the whole view over the app; `onEnd` as the view is gone.
     */
    fun exit(icon: View?, onEnd: () -> Unit)
    /** The reduced-motion departure: the view, icon and all, fades in place over [SplashExit.REDUCED_FADE_MS]; `onEnd` as it is gone. */
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
 * The system bars' icon tone during the hold is the splash theme's (light icons over the indigo);
 * what the chrome asks for meanwhile (Host.applyTheme → [systemBarsLight]) is kept and applied
 * at the exit's END – the splash's colour is on screen until the last frame of the motion, and
 * dark icons over the indigo for its 350 ms would be the flip the hold exists to avoid.
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
    private val warn: (String, Throwable?) -> Unit
) {
    /** The app's: the window's bars, the main thread's Handler and clock, the platform's animator switch, logcat. */
    constructor(window: Window, skin: ((SplashScreenViewProvider) -> SplashSkin)? = null) : this(
        HandlerSplashClock(Handler(Looper.getMainLooper())),
        WindowSplashBars(window),
        { ValueAnimator.areAnimatorsEnabled() },
        skin,
        { message, error -> Log.w(TAG, message, error) }
    )

    val hold = SplashHold()
    private var surface: SplashSurface? = null
    private var skinned: SplashSkin? = null
    private var barsLight: Boolean? = null
    private var handedOverAt = 0L
    /** The exit motion is running: the splash's colour is still on screen, the bars keep its tone. */
    private var exiting = false
    private val watchdog = Runnable {
        if (!hold.watchdog()) return@Runnable
        warn("splash: the chrome did not report ready within $WATCHDOG_MS ms of the hand-over; lifting", null)
        lift("watchdog")
    }

    /** Before the window's first frame (MainActivity.onCreate): take the splash view when the platform hands it over. */
    fun attach(splashScreen: SplashScreen) {
        splashScreen.setOnExitAnimationListener { view -> handOver(PlatformSplashSurface(view)) }
    }

    /** The platform handed its splash view over (the exit listener, at the window's first frame). */
    internal fun handOver(view: SplashSurface) {
        surface = view
        handedOverAt = clock.uptimeMillis()
        // The library applied the post theme's bar tone as it handed the view over; the splash is
        // still up, so the splash's tone stays until it lifts – and the theme's is what the lift
        // restores when the chrome has asked for none by then.
        if (barsLight == null) barsLight = bars.light
        skinned = skin?.let { dress -> runCatching { view.dress(dress) }.onFailure { warn("splash: the skin failed; the platform's view stays", it) }.getOrNull() }
        bars.light = skinned?.lightBars ?: false
        if (hold.handOver()) {
            lift("ready")
            return
        }
        clock.postDelayed(watchdog, WATCHDOG_MS)
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
        exiting = true
        val gone: () -> Unit = {
            exiting = false
            barsLight?.let { bars.light = it }
        }
        if (animatorsEnabled()) view.exit(skinned?.iconView, gone) else view.fadeInPlace(gone)
    }

    /** The activity is going: nothing left to lift, no watchdog to fire into a dead window. */
    fun cancel() {
        clock.removeCallbacks(watchdog)
        surface?.remove()
        surface = null
        exiting = false
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
    }
}

/** The library's provider as a [SplashSurface]: the exit motion and the reduced-motion fade on the platform's view. */
class PlatformSplashSurface(private val provider: SplashScreenViewProvider) : SplashSurface {
    override fun dress(skin: (SplashScreenViewProvider) -> SplashSkin): SplashSkin = skin(provider)

    override fun exit(icon: View?, onEnd: () -> Unit) {
        val fading = icon ?: runCatching { provider.iconView }.getOrNull()
        fading?.animate()?.alpha(0f)?.setDuration(SplashExit.ICON_FADE_MS)?.setInterpolator(SplashExit.iconCurve)?.start()
        provider.view.animate()
            .alpha(0f)
            .setStartDelay(SplashExit.REVEAL_DELAY_MS)
            .setDuration(SplashExit.REVEAL_MS)
            .setInterpolator(SplashExit.revealCurve)
            .withEndAction {
                provider.remove()
                onEnd()
            }
            .start()
    }

    override fun fadeInPlace(onEnd: () -> Unit) {
        // Not an animator: the setting that brings the lift here scales every animator's duration
        // to zero (a ViewPropertyAnimator would end on its first frame – the cut §11.3 rules out),
        // so the fade is stepped on the frame clock from the uptime itself.
        val view = provider.view
        val started = SystemClock.uptimeMillis()
        view.postOnAnimation(object : Runnable {
            override fun run() {
                val t = ((SystemClock.uptimeMillis() - started).toFloat() / SplashExit.REDUCED_FADE_MS).coerceIn(0f, 1f)
                view.alpha = 1f - SplashExit.revealCurve.getInterpolation(t)
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

/** The window's bars through the insets controller: the status bar's tone read, both bars' written. */
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
