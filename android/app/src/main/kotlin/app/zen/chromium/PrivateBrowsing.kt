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
 * the private surface, so a regular tab captures as before. The lock cover of "Lock private tabs
 * when you leave Zenium" (`PrivateLock`) is drawn on that same surface – over a private page or
 * the Private pane, in the private theme – so the chrome's word keeps the guard up under it; the
 * host adds the frames the word cannot cover: while it holds private page views hidden under the
 * lock ahead of the chrome's next report ([guardWanted]'s `lockedContent`), the private content
 * behind the cover is still in the window, and the guard stays.
 *
 * The launcher shortcut is the static one in `src/main/shortcuts/shortcuts.xml` (written into
 * each variant's res/xml by the build), declared through the `android.app.shortcuts` meta-data on
 * the launcher aliases (`scripts/app-icons/lib.ts`): its intent carries [ACTION_NEW_TAB] to
 * `LauncherIconActivity`, the trampoline outside the browser's task, which relays it to
 * `MainActivity` as the private landing ([Landing.forwarded], [Landing.PRIVATE]); the activity
 * asks the chrome for a private tab in the running window. An intent carrying the action straight
 * to the activity (a pinned copy of the shortcut from before the landing extra) lands the same.
 */
object PrivateBrowsing {
    /** The launcher shortcut's intent action: a new private tab in the browser window. */
    const val ACTION_NEW_TAB = "app.zen.chromium.NEW_PRIVATE_TAB"

    /** The static shortcut's id (`src/main/shortcuts/shortcuts.xml`). */
    const val SHORTCUT_ID = "new-private-tab"

    /**
     * Debug builds only: a recorded demo (`PrivateTabsDemo`) lets the screen recorder see the
     * private surface it demonstrates, its step on the guard itself excepted. A release build
     * never reads it ([guard] folds it in behind `BuildConfig.DEBUG`).
     */
    @Volatile
    var captureForRecording = false

    /**
     * Whether the guard goes up: the chrome says the surface is private (the lock cover over
     * private content included: the surface stays private under it), or the host holds private
     * page views hidden under the lock while the chrome's word is still on its way
     * (`lockedContent`, [Host.onStop] to the chrome's next layout report); and no recording is
     * let in. Not while private tabs merely exist, locked or not: a regular page or the Tabs pane
     * captures as before, the way Chrome's regular tabs do with Incognito locked.
     */
    fun guardWanted(privateSurface: Boolean, recording: Boolean, lockedContent: Boolean = false): Boolean =
        (privateSurface || lockedContent) && !recording

    /** Put the guard on `window` or take it off, as [guardWanted] says for the surface now. */
    fun guard(window: Window, privateSurface: Boolean, lockedContent: Boolean = false) {
        val flag = WindowManager.LayoutParams.FLAG_SECURE
        if (guardWanted(privateSurface, BuildConfig.DEBUG && captureForRecording, lockedContent)) window.addFlags(flag)
        else window.clearFlags(flag)
    }

    /** Whether the guard is on `window` now (Recents and a recorder then see nothing of it). */
    fun guarded(window: Window): Boolean =
        window.attributes.flags and WindowManager.LayoutParams.FLAG_SECURE != 0
}
