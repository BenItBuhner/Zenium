package app.zen.chromium

import android.app.Activity
import android.content.Intent
import android.os.Bundle

/**
 * What the launcher icon aliases and the launcher's static shortcut point at. It starts
 * `MainActivity` in a task of its own and is gone before it ever draws (`Theme.NoDisplay`, no
 * history, no Recents entry).
 *
 * The indirection is what lets the icon change without closing the app: a task whose root
 * intent names an alias is removed by the system the moment that alias is disabled
 * (`RecentTasks.cleanupDisabledPackageTasks`, API 34), taking the running activity with it. This
 * activity's task is the one rooted at the alias, and it is finished by the time the switch
 * happens; the browser's task is rooted at `MainActivity` itself, which no alias switch touches.
 * The affinity is empty so the browser never joins this task.
 *
 * The shortcut needs the same indirection for another reason: the system stamps every manifest
 * shortcut's intent with `FLAG_ACTIVITY_CLEAR_TASK` (`ShortcutParser`, "same flag as what
 * TaskStackBuilder adds"), so a shortcut aimed at `MainActivity` would clear the browser's task
 * and start the activity over. Aimed here, the flag clears this activity's own task, and the
 * browser's gets the shortcut's action through `onNewIntent` – a new private tab in the running
 * window ([PrivateBrowsing.ACTION_NEW_TAB]), the way Chrome's `LauncherShortcutActivity` relays
 * "New Incognito tab".
 */
class LauncherIconActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val forward = Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        val action = PrivateBrowsing.forwardedAction(intent?.action)
        if (action != null) forward.action = action
        else forward.setAction(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER)
        startActivity(forward)
        finish()
    }
}
