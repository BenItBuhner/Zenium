package app.zen.chromium

import android.content.pm.ActivityInfo

/**
 * Chrome's rule for the screen while a video is fullscreen (MED-01): a landscape video – wider
 * than tall by its natural size – turns the activity to landscape, `SENSOR_LANDSCAPE`, either
 * way up and whether or not the user locked rotation, as Chrome's orientation-lock delegate does
 * for a video in fullscreen; a portrait or square video, a fullscreen element without a video, or
 * one whose size is not known yet leaves the screen as it is. Leaving fullscreen hands the
 * orientation back to the system ([RELEASED]). Pure, so the decision is tested on the JVM; the
 * size comes from the page script's `fullscreen` message ([PageMessageRoute.Fullscreen]).
 */
object FullscreenOrientation {
    /** Out of fullscreen (and for a video that does not turn the screen): the system's word. */
    const val RELEASED = ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED

    /** What the activity asks for while a video of this natural size is fullscreen. */
    fun forVideo(videoWidth: Int, videoHeight: Int): Int =
        if (isLandscape(videoWidth, videoHeight)) ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE else RELEASED

    /** A video known to be wider than tall; an unknown size (0 × 0, no video) is not one. */
    fun isLandscape(videoWidth: Int, videoHeight: Int): Boolean =
        videoWidth > 0 && videoHeight > 0 && videoWidth > videoHeight
}
