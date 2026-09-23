package app.zen.chromium

import android.content.Context
import android.content.pm.ActivityInfo
import android.hardware.SensorManager
import android.view.OrientationEventListener
import kotlin.math.abs

/**
 * The screen's hold for a fullscreen video, and its release to the device (MED-02; the second
 * half of Chrome's orientation-lock rule, its `MediaControlsOrientationLockDelegate`). A landscape
 * video's fullscreen turns the screen to landscape and holds it there (`SENSOR_LANDSCAPE`,
 * [FullscreenOrientation]), rotation lock or not – so far MED-01. Held that way the screen could
 * never turn back, and the turn back is how a fullscreen video is left (the page's rotate rule,
 * `shared/rotateToFullscreen.ts`, hears the screen turn away from the video's orientation). So
 * once the device has itself turned to the held orientation – the hand followed the screen – and
 * stayed there for [LOCK_TO_ANY_DELAY_MS], the hold becomes [FOLLOW_DEVICE] (`FULL_SENSOR`: the
 * screen follows the device every way, the user's rotation lock notwithstanding, as Chrome's
 * "any" lock does), and a turn back to portrait turns the screen, which exits the fullscreen.
 * A device that stays portrait while its user watches sideways keeps the hold: released at once,
 * the screen would turn back under the video and end the fullscreen just begun.
 *
 * The hand-over is the phone's alone, as the page's rule is (§9.36, Chrome's `device_is_phone`):
 * [handsOver] is the host's one word for both halves ([PageHost.rotateToFullscreen]), read at
 * each word from the device, so a tablet's held screen stays held until the exit releases it –
 * the hold itself (MED-01) is not gated here.
 *
 * Pure: the device's word comes in as degrees ([deviceLandscape] reads them), the delay runs on
 * an injected scheduler, the activity's `requestedOrientation` is written through [apply]; the
 * JVM tests run the whole of it.
 */
class FullscreenRotation(
    /** Run the block after the delay; returns what cancels it. */
    private val schedule: (delayMs: Long, block: () -> Unit) -> (() -> Unit),
    /** Write the activity's requested orientation. */
    private val apply: (orientation: Int) -> Unit,
    /** Whether the held screen is handed to the device at all: a phone's window ([PageHost.rotateToFullscreen]). */
    private val handsOver: () -> Boolean = { true }
) {
    enum class Phase {
        /** No fullscreen video holds the screen. */
        OFF,
        /** The screen is held in the video's orientation. */
        HELD,
        /** The device turned to match: the screen follows the device again. */
        FOLLOWING
    }

    var phase = Phase.OFF
        private set

    private var cancel: (() -> Unit)? = null

    /** A fullscreen video's orientation: hold the screen there (and forget any release under way). */
    fun hold(orientation: Int) {
        cancel?.invoke()
        cancel = null
        phase = Phase.HELD
        apply(orientation)
    }

    /** The fullscreen ended: the system's word again. Nothing when nothing was held. */
    fun release() {
        cancel?.invoke()
        cancel = null
        if (phase == Phase.OFF) return
        phase = Phase.OFF
        apply(FullscreenOrientation.RELEASED)
    }

    /**
     * The device's orientation as the sensor reads it: landscape, portrait, or null for a device
     * flat or on a diagonal ([deviceLandscape]). While the screen is held, a device that has
     * turned to landscape starts the release's delay; one that turns away before it runs out
     * cancels it. Nothing in a window that is not a phone's ([handsOver]): the word is dropped, a
     * delay under way with it – the window may have grown past the line since.
     */
    fun onDevice(landscape: Boolean?) {
        if (phase != Phase.HELD) return
        if (!handsOver()) {
            cancel?.invoke()
            cancel = null
            return
        }
        if (landscape != true) {
            cancel?.invoke()
            cancel = null
            return
        }
        if (cancel != null) return
        cancel = schedule(LOCK_TO_ANY_DELAY_MS) {
            cancel = null
            if (phase != Phase.HELD) return@schedule
            phase = Phase.FOLLOWING
            apply(FOLLOW_DEVICE)
        }
    }

    companion object {
        /**
         * How long the device has to stand in the held orientation before the screen follows it
         * again: the turn's own settling, so a device swung past landscape on its way somewhere
         * does not release the hold.
         */
        const val LOCK_TO_ANY_DELAY_MS = 400L

        /** The screen following the device every way, the user's rotation lock notwithstanding. */
        const val FOLLOW_DEVICE = ActivityInfo.SCREEN_ORIENTATION_FULL_SENSOR

        /** How far from square-on a device may stand and still count as that way up (degrees). */
        const val TOLERANCE_DEGREES = 23

        /**
         * Whether the device stands in landscape by the sensor's `angle` (the degrees an
         * `OrientationEventListener` reports: 0 upright in the device's natural orientation, 90
         * with its left side up, 180 upside down, 270 with its right side up; -1 for a device
         * flat), on a device whose natural orientation is `naturalLandscape` (a tablet's, say).
         * Null for a device flat or between two ways up: neither word, so nothing changes.
         */
        fun deviceLandscape(angle: Int, naturalLandscape: Boolean): Boolean? {
            if (angle < 0) return null
            val a = ((angle % 360) + 360) % 360
            val sideways = near(a, 90) || near(a, 270)
            val upright = near(a, 0) || near(a, 180) || near(a, 360)
            return when {
                sideways -> !naturalLandscape
                upright -> naturalLandscape
                else -> null
            }
        }

        private fun near(angle: Int, target: Int): Boolean = abs(angle - target) <= TOLERANCE_DEGREES
    }
}

/**
 * The device's way up as the accelerometer reads it, in the degrees [FullscreenRotation.deviceLandscape]
 * takes: an [OrientationEventListener] that listens only while asked ([follow]) – a fullscreen video
 * holds the screen for seconds, not the sensor for the app's life. Nothing on a device without the
 * sensor (`canDetectOrientation` false): the hold then simply stays, as before MED-02.
 */
class DeviceOrientationSensor(context: Context, private val onAngle: (angle: Int) -> Unit) {
    private val listener = object : OrientationEventListener(context, SensorManager.SENSOR_DELAY_NORMAL) {
        override fun onOrientationChanged(orientation: Int) = onAngle(orientation)
    }
    private var following = false

    /** Start or stop listening; idempotent. */
    fun follow(on: Boolean) {
        if (on == following) return
        if (on) {
            if (!listener.canDetectOrientation()) return
            listener.enable()
        } else {
            listener.disable()
        }
        following = on
    }
}
