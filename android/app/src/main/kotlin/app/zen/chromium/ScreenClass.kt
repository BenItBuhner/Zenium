package app.zen.chromium

/**
 * The window's class on Android's own tablet line: a window 600 dp or more on its short side
 * (`Configuration.smallestScreenWidthDp`, the `sw600dp` the system lays resources out by) is a
 * large screen. The chrome lays itself out as a tablet from the same line (`PHONE_MAX_WIDTH` in
 * `shared/formFactor.ts`, design language v2 §9.36), so the host and the chrome agree on what a
 * window is; here the class decides the page controls' desktop default (`MainActivity.environment`)
 * and whether rotate-to-fullscreen runs at all – the phone's alone, as Chrome gates it
 * ([PageHost.rotateToFullscreen], MED-02). The class follows the window, not the device: a
 * tablet's window narrowed in split screen is a phone's while it stays so.
 */
object ScreenClass {
    /** From this many dp on the short side the window is a large screen (Android's `sw600dp`; the chrome's `PHONE_MAX_WIDTH`). */
    const val LARGE_MIN_DP = 600

    /** Whether a window of this smallest width is a large screen: the tablet layout's class. */
    fun large(smallestScreenWidthDp: Int): Boolean = smallestScreenWidthDp >= LARGE_MIN_DP

    /**
     * Whether the turn of the device takes a playing video fullscreen and back in a window of this
     * smallest width: the phone's alone (§9.36). A tablet keeps its layout through the turn and its
     * video goes fullscreen by the player's own control.
     */
    fun rotateToFullscreen(smallestScreenWidthDp: Int): Boolean = !large(smallestScreenWidthDp)
}
