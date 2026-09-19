package app.zen.chromium

import android.view.Window
import android.view.WindowManager

/**
 * The host's side of private browsing beyond the profile (`Profiles.kt`): the window's screenshot
 * guard while a private tab is in view, and the launcher shortcut that opens one.
 *
 * The guard is `FLAG_SECURE` on the browser window, sent by the chrome as the private surface
 * comes and goes (`window.setSecure`: a private tab active, or the overview on its private pane):
 * Recents shows no private page, and none reaches a screenshot or a screen recording, the way
 * Chrome keeps Incognito out of the app switcher. It is released the moment the chrome leaves
 * the private surface, so a regular tab captures as before.
 *
 * The launcher shortcut is the static one in `res/xml/shortcuts.xml`, declared through the
 * `android.app.shortcuts` meta-data on the launcher aliases (`scripts/app-icons/lib.ts`): its
 * intent carries [ACTION_NEW_TAB] to `MainActivity`, which asks the chrome for a private tab.
 */
object PrivateBrowsing {
    /** The launcher shortcut's intent action: a new private tab in the browser window. */
    const val ACTION_NEW_TAB = "app.zen.chromium.NEW_PRIVATE_TAB"

    /** The static shortcut's id (`res/xml/shortcuts.xml`). */
    const val SHORTCUT_ID = "new-private-tab"

    /**
     * Debug builds only: a recorded demo (`PrivateTabsDemo`) lets the screen recorder see the
     * private surface it demonstrates, its step on the guard itself excepted. A release build
     * never reads it ([guard] folds it in behind `BuildConfig.DEBUG`).
     */
    @Volatile
    var captureForRecording = false

    /** Whether the guard goes up: the chrome says the surface is private, and no recording is let in. */
    fun guardWanted(privateSurface: Boolean, recording: Boolean): Boolean = privateSurface && !recording

    /** Put the guard on `window` or take it off, as [guardWanted] says for the surface now. */
    fun guard(window: Window, privateSurface: Boolean) {
        val flag = WindowManager.LayoutParams.FLAG_SECURE
        if (guardWanted(privateSurface, BuildConfig.DEBUG && captureForRecording)) window.addFlags(flag)
        else window.clearFlags(flag)
    }

    /** Whether the guard is on `window` now (Recents and a recorder then see nothing of it). */
    fun guarded(window: Window): Boolean =
        window.attributes.flags and WindowManager.LayoutParams.FLAG_SECURE != 0
}
