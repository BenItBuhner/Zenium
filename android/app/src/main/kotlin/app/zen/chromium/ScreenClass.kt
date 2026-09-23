package app.zen.chromium

/**
 * The screen's class on Android's own tablet line: 600 dp or more on the short side
 * (`Configuration.smallestScreenWidthDp`, the `sw600dp` the system lays resources out by) is a
 * large screen. The chrome lays itself out as a tablet from the same number (`PHONE_MAX_WIDTH` in
 * `shared/formFactor.ts`, design language v2 §9.36; `ScreenClassTest` pins the two to one), read
 * off its own window's CSS px; here the class decides the page controls' desktop default
 * (`MainActivity.environment`) and whether rotate-to-fullscreen runs at all – the phone's alone,
 * as Chrome gates it ([PageHost.rotateToFullscreen], MED-02). What the class follows is what
 * Chrome's own gate follows (the `sw600dp` bucket of its application context, "not affected by
 * multi-window"): the display through split screen – from Android 11 a split task inherits the
 * display's `smallestScreenWidthDp` rather than computing its own, so a tablet narrowed in a split
 * stays a tablet here while the chrome, classifying its window, may lay out as a phone – and the
 * window through a fold (the display itself changes) or a floating window (freeform, desktop
 * windowing): those move the class, a split does not.
 */
object ScreenClass {
    /** From this many dp on the short side the window is a large screen (Android's `sw600dp`; the chrome's `PHONE_MAX_WIDTH`). */
    const val LARGE_MIN_DP = 600

    /** Whether a screen of this smallest width is large: the page controls' desktop default (`MainActivity.largeScreen`). */
    fun large(smallestScreenWidthDp: Int): Boolean = smallestScreenWidthDp >= LARGE_MIN_DP

    /**
     * Whether the turn of the device takes a playing video fullscreen and back on a screen of this
     * smallest width: the phone's alone (§9.36) – the other face of [large], the one spelling of the
     * rule the host reads (`Host.rotateToFullscreen`). A tablet keeps its layout through the turn
     * and its video goes fullscreen by the player's own control.
     */
    fun rotateToFullscreen(smallestScreenWidthDp: Int): Boolean = !large(smallestScreenWidthDp)
}
