package app.zen.chromium

import android.app.Activity
import android.content.Intent
import android.os.Bundle

/**
 * What the launcher's static shortcuts (shortcuts.xml) and the private-browsing shortcut point
 * at. It starts `MainActivity` in a task of its own and is gone before it ever draws
 * (`Theme.NoDisplay`, no history, no Recents entry, an empty affinity so the browser never joins
 * its task).
 *
 * The shortcuts need the indirection because the system stamps every manifest shortcut's intent
 * with `FLAG_ACTIVITY_CLEAR_TASK` (`ShortcutParser`, "same flag as what TaskStackBuilder adds"),
 * so a shortcut aimed at `MainActivity` would clear the browser's task and start the activity
 * over. Aimed here, the flag clears this activity's own task, and the browser's gets the state
 * the shortcut asks for through `onNewIntent` – the [Landing] extra carried over as it came (a
 * new tab, the omnibox, the QR scanner), the private shortcut's action read as the private
 * landing ([Landing.forwarded]) – the way Chrome's `LauncherShortcutActivity` relays "New
 * Incognito tab".
 *
 * The launcher icon's aliases point at [IconTapActivity] instead: the same forward (inherited),
 * under the splash theme and in the browser's own task, so the tap's starting window is the
 * browser's. It cannot serve the shortcuts – `FLAG_ACTIVITY_CLEAR_TASK` there would clear the
 * browser – and this one cannot serve the icon: a task of its own means a starting window the
 * platform never transfers to the browser's task, which is why the icon's tap used to show the
 * launcher standing still until `MainActivity` started.
 */
open class LauncherIconActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val forward = Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        val landing = Landing.forwarded(intent?.action, intent?.getStringExtra(Landing.EXTRA))
        if (landing != null) forward.setAction(Intent.ACTION_MAIN).putExtra(Landing.EXTRA, landing)
        else forward.setAction(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER)
        // The forward before the finish: the browser's task is found by root affinity only while
        // this activity, its top, is not finishing (RootWindowContainer.FindTaskResult).
        startActivity(forward)
        finish()
    }
}
