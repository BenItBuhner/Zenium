package app.zen.chromium

import org.json.JSONObject

/**
 * What the chrome's accessibility variants read off the device (A11Y-04): whether a service
 * explores the screen by touch (TalkBack, `AccessibilityManager.isTouchExplorationEnabled`) and
 * the system font scale (`Configuration.fontScale`). Both travel in the boot payload
 * (`accessibility`) and again as an `accessibility` host event on each change – the touch
 * exploration listener's, the configuration's – so the phone menu turns its icon row into a
 * labelled list the moment TalkBack comes on or the text grows, and back when they go.
 */
object AccessibilityState {
    /**
     * The payload the chrome hears. A font scale the configuration does not carry (zero, negative,
     * NaN – a stub configuration in a test, a broken OEM value) reads as the default size rather
     * than as large text, so the list variant never comes on for a number that means nothing.
     */
    fun payload(touchExploration: Boolean, fontScale: Float): JSONObject =
        json("touchExploration" to touchExploration, "fontScale" to fontScaleOf(fontScale))

    /** The font scale as a finite positive factor; 1 for anything else. */
    fun fontScaleOf(fontScale: Float): Double =
        if (fontScale.isFinite() && fontScale > 0f) fontScale.toDouble() else 1.0
}
