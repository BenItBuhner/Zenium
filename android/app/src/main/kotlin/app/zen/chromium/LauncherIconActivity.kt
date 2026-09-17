package app.zen.chromium

import android.app.Activity
import android.content.Intent
import android.os.Bundle

/**
 * What the launcher icon aliases point at. It starts `MainActivity` in a task of its own and is
 * gone before it ever draws (`Theme.NoDisplay`, no history, no Recents entry).
 *
 * The indirection is what lets the icon change without closing the app: a task whose root
 * intent names an alias is removed by the system the moment that alias is disabled
 * (`RecentTasks.cleanupDisabledPackageTasks`, API 34), taking the running activity with it. This
 * activity's task is the one rooted at the alias, and it is finished by the time the switch
 * happens; the browser's task is rooted at `MainActivity` itself, which no alias switch touches.
 * The affinity is empty so the browser never joins this task.
 */
class LauncherIconActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        startActivity(
            Intent(this, MainActivity::class.java)
                .setAction(Intent.ACTION_MAIN)
                .addCategory(Intent.CATEGORY_LAUNCHER)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        )
        finish()
    }
}
