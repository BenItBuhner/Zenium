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
 */
object SplashExit {
    const val ICON_FADE_MS = 133L
    const val REVEAL_DELAY_MS = 83L
    const val REVEAL_MS = 266L
    val iconCurve = LinearInterpolator()
    /** The shell's app reveal is a standard ease (fast out, slow in). */
    val revealCurve = PathInterpolator(0.4f, 0f, 0.2f, 1f)
}

/**
 * What a window's own skin put on the platform's splash view at the hand-over (PWA-06,
 * [WebAppSplash]): the icon view the exit motion fades first (null: the platform's own), and the
 * tone the system bars' icons keep while the splash is held (light for a light ground).
 */
class SplashSkin(val iconView: View?, val lightBars: Boolean)

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
 * as the splash lifts, so the icons do not go dark over the indigo for the hold and the bars do
 * not flip twice.
 *
 * Reduced motion (the animator duration scale at zero – Settings' "Remove animations") lifts the
 * splash on the plain cut, no motion.
 */
class StartupSplash(
    private val window: Window,
    private val main: Handler = Handler(Looper.getMainLooper()),
    private val animatorsEnabled: () -> Boolean = { ValueAnimator.areAnimatorsEnabled() },
    /** A window's own dress for the platform's splash view, applied once at the hand-over (PWA-06); null for the browser's. */
    private val skin: ((SplashScreenViewProvider) -> SplashSkin)? = null
) {
    val hold = SplashHold()
    private var provider: SplashScreenViewProvider? = null
    private var skinned: SplashSkin? = null
    private var barsLight: Boolean? = null
    private var handedOverAt = 0L
    private val watchdog = Runnable {
        if (!hold.watchdog()) return@Runnable
        Log.w(TAG, "splash: the chrome did not report ready within $WATCHDOG_MS ms of the hand-over; lifting")
        lift("watchdog")
    }

    /** Before the window's first frame (MainActivity.onCreate): take the splash view when the platform hands it over. */
    fun attach(splashScreen: SplashScreen) {
        splashScreen.setOnExitAnimationListener { view -> handOver(view) }
    }

    private fun handOver(view: SplashScreenViewProvider) {
        provider = view
        handedOverAt = SystemClock.uptimeMillis()
        // The library applied the post theme's bar tone as it handed the view over; the splash is
        // still up, so the splash's tone stays until it lifts – and the theme's is what the lift
        // restores when the chrome has asked for none by then.
        if (barsLight == null) barsLight = WindowInsetsControllerCompat(window, window.decorView).isAppearanceLightStatusBars
        skinned = skin?.let { dress -> runCatching { dress(view) }.onFailure { Log.w(TAG, "splash: the skin failed; the platform's view stays", it) }.getOrNull() }
        applyBars(light = skinned?.lightBars ?: false)
        if (hold.handOver()) {
            lift("ready")
            return
        }
        main.postDelayed(watchdog, WATCHDOG_MS)
    }

    /** The chrome's first real frame is on screen: lift the splash if the platform has handed it over, else as soon as it does. */
    fun ready() {
        if (hold.ready()) lift("ready")
    }

    /**
     * The tone the chrome asks the bars' icons for (dark icons for a light chrome): applied now
     * when the splash is not up, kept for the lift when it is.
     */
    fun systemBarsLight(light: Boolean) {
        barsLight = light
        if (!held) applyBars(light)
    }

    /** The splash is up over this window (handed over, not lifted). */
    val held: Boolean get() = hold.handedOver && !hold.lifted

    /** Milliseconds from the hand-over to the lift, for the log; null before the lift. */
    var heldForMs: Long? = null
        private set

    private fun lift(by: String) {
        val view = provider ?: return
        provider = null
        main.removeCallbacks(watchdog)
        hold.lift(by)
        heldForMs = SystemClock.uptimeMillis() - handedOverAt
        barsLight?.let { applyBars(it) }
        if (!animatorsEnabled()) {
            view.remove()
            return
        }
        val icon = skinned?.iconView ?: runCatching { view.iconView }.getOrNull()
        icon?.animate()?.alpha(0f)?.setDuration(SplashExit.ICON_FADE_MS)?.setInterpolator(SplashExit.iconCurve)?.start()
        view.view.animate()
            .alpha(0f)
            .setStartDelay(SplashExit.REVEAL_DELAY_MS)
            .setDuration(SplashExit.REVEAL_MS)
            .setInterpolator(SplashExit.revealCurve)
            .withEndAction { view.remove() }
            .start()
    }

    /** The activity is going: nothing left to lift, no watchdog to fire into a dead window. */
    fun cancel() {
        main.removeCallbacks(watchdog)
        provider?.remove()
        provider = null
    }

    private fun applyBars(light: Boolean) {
        val controller = WindowInsetsControllerCompat(window, window.decorView)
        controller.isAppearanceLightStatusBars = light
        controller.isAppearanceLightNavigationBars = light
    }

    companion object {
        const val TAG = "ZenStartup"
        /** The safety net after the hand-over, well past any boot that ends in a chrome. */
        const val WATCHDOG_MS = 6_000L
    }
}
