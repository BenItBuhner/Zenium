package app.zen.chromium

import kotlin.math.abs
import kotlin.math.roundToInt

/**
 * Rotate-to-fullscreen's host side (MED-02). The turn itself is the engine's: Chrome's
 * `MediaControlsRotateToFullscreenDelegate` runs in WebView as it does in Chrome (content's
 * web preference for the phone form factor), taking a `<video>` with the browser's controls
 * that is playing in view fullscreen when the screen turns to the video's orientation and out
 * again when the screen turns away. What the host adds is the way back under its own lock, and
 * the exit on the turn for the video it locked for; pure, so the decisions run under plain
 * JUnit ([RotateToFullscreenTest]); [Host] wires them to the activity's configuration, an
 * `OrientationEventListener` and the system's auto-rotate setting.
 *
 * Chrome's orientation lock holds a fullscreen landscape video in landscape (MED-01,
 * [FullscreenOrientation]) and, so that turning the device back can exit, gives the lock up –
 * to "any", the sensor's word either way up – once the device itself has been turned to match
 * the video ([RotateUnlock]); never while the user has rotation locked at the system level,
 * whose fullscreen stays as it is until they leave it (watching in bed).
 */
object RotateToFullscreen {
    /** A video smaller than this either way is not one to turn the screen for (Chrome's `kMinVideoSize`). */
    const val MIN_VIDEO_SIZE = 200
    /** How far off straight the device may be held and still count as portrait or landscape (Chrome's 23°). */
    const val TOLERANCE_DEG = 23
    /** From the device matching the video to the lock giving way (Chrome's `kLockToAnyDelay`): time for Android's own slower reading of the turn. */
    const val UNLOCK_DELAY_MS = 1_000L

    /**
     * The video's orientation by its natural size: landscape when at least as wide as tall (a
     * square one included, as Chrome has it), portrait otherwise; null for one too small or
     * with no size known, which rotate-to-fullscreen leaves alone.
     */
    fun videoLandscape(videoWidth: Int, videoHeight: Int): Boolean? {
        if (videoWidth < MIN_VIDEO_SIZE || videoHeight < MIN_VIDEO_SIZE) return null
        return videoWidth >= videoHeight
    }

    /** A fullscreen video of this orientation leaves fullscreen when the screen turns to the other. */
    fun exitsOnTurn(videoLandscape: Boolean, screenLandscape: Boolean): Boolean = videoLandscape != screenLandscape

    /**
     * How the device is held, from `OrientationEventListener`'s angle (degrees clockwise from
     * the device's natural orientation, or -1 for a device too flat to tell): landscape, portrait,
     * or null for flat and for the diagonal zones between (more than [TOLERANCE_DEG] off a
     * quarter turn), where nothing is decided so the answer cannot flicker. `naturalPortrait`
     * says which quarter turns are which: a phone's natural orientation is portrait, some
     * tablets' landscape.
     */
    fun deviceLandscape(angle: Int, naturalPortrait: Boolean): Boolean? {
        if (angle < 0) return null
        val a = angle % 360
        val quarter = ((a / 90.0).roundToInt() * 90) % 360
        val off = abs(a - quarter).let { if (it > 180) 360 - it else it }
        if (off > TOLERANCE_DEG) return null
        val turned = quarter % 180 != 0
        return turned == naturalPortrait
    }
}

/**
 * The lock's way to "any" (MED-02): while a fullscreen video holds the screen in its
 * orientation, the first reading of the device turned to match it – with the system's
 * auto-rotate on – sets the time the lock gives way, [RotateToFullscreen.UNLOCK_DELAY_MS] on;
 * later readings change nothing (Chrome stops listening at the match). With auto-rotate off
 * the lock is never given up. Pure; [Host] holds one, feeds it the readings and asks for the
 * orientation change when the time comes.
 */
class RotateUnlock {
    /** A lock is held in `landscape` (true) or portrait, and the device is watched. */
    private var lockedLandscape: Boolean? = null
    /** When the lock gives way (uptime ms), or -1 while it holds. */
    var unlockAt = -1L
        private set

    val watching: Boolean get() = lockedLandscape != null && unlockAt < 0

    fun lock(landscape: Boolean) {
        lockedLandscape = landscape
        unlockAt = -1
    }

    fun release() {
        lockedLandscape = null
        unlockAt = -1
    }

    /**
     * The device stands at `angle` at `now`: the time the lock gives way, or -1 while nothing
     * is decided. The first match decides; auto-rotate off decides nothing.
     */
    fun onDeviceAngle(angle: Int, naturalPortrait: Boolean, autoRotate: Boolean, now: Long): Long {
        val locked = lockedLandscape ?: return -1
        if (unlockAt >= 0) return unlockAt
        if (!autoRotate) return -1
        if (RotateToFullscreen.deviceLandscape(angle, naturalPortrait) != locked) return -1
        unlockAt = now + RotateToFullscreen.UNLOCK_DELAY_MS
        return unlockAt
    }
}
