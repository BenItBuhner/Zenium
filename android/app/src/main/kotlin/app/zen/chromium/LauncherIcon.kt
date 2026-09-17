package app.zen.chromium

import android.app.Activity
import android.app.ActivityManager
import android.content.ComponentName
import android.content.Context
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.Canvas
import android.os.Build
import android.util.Log

/**
 * The launcher icon colour. Every colour is an `activity-alias` of `MainActivity` carrying the
 * MAIN/LAUNCHER filter (AndroidManifest.xml, generated from src/shared/appIcon.ts); exactly one
 * is enabled at a time and that is the icon the launcher shows.
 *
 * Switching enables the new alias before the old one goes, both with DONT_KILL_APP: the app
 * keeps running, and the launcher – which reacts to each component change – never sees a
 * package without a launcher entry. Intents that name the activity itself (links, share,
 * search, notifications) are untouched by the aliases. Known launcher behaviour that no app can
 * avoid: Launcher3-based home screens drop a home-screen icon whose alias went away (the app
 * drawer entry is updated in place), and the running task leaves Recents until the app is
 * brought forward again.
 */
class LauncherIcon(private val context: Context) {
    private val pm: PackageManager = context.packageManager
    private val variants = LauncherIconVariants.ALIASES.keys.toList()

    /** The colour whose alias is currently enabled. */
    fun current(): String = LauncherIconPlan.current(variants, LauncherIconVariants.DEFAULT, ::isEnabled)

    /** Make `id` the launcher icon (a no-op when it already is) and show it on the Recents card. */
    fun apply(id: String, activity: Activity?) {
        val changes = LauncherIconPlan.changes(variants, LauncherIconVariants.DEFAULT, id, ::isEnabled)
        for (change in changes) {
            val state = if (change.enabled) PackageManager.COMPONENT_ENABLED_STATE_ENABLED
            else PackageManager.COMPONENT_ENABLED_STATE_DISABLED
            try {
                pm.setComponentEnabledSetting(component(change.id), state, PackageManager.DONT_KILL_APP)
            } catch (e: Exception) {
                Log.w(TAG, "could not ${if (change.enabled) "enable" else "disable"} the ${change.id} icon", e)
            }
        }
        if (changes.isNotEmpty()) Log.i(TAG, "launcher icon → $id (${changes.size} component changes)")
        activity?.let { describeTask(it, current()) }
    }

    private fun component(id: String) = ComponentName(context, LauncherIconVariants.ALIASES.getValue(id))

    /** Whether an alias is on, reading the manifest default when the state was never set. */
    fun isEnabled(id: String): Boolean = when (pm.getComponentEnabledSetting(component(id))) {
        PackageManager.COMPONENT_ENABLED_STATE_ENABLED -> true
        PackageManager.COMPONENT_ENABLED_STATE_DISABLED,
        PackageManager.COMPONENT_ENABLED_STATE_DISABLED_USER,
        PackageManager.COMPONENT_ENABLED_STATE_DISABLED_UNTIL_USED -> false
        else -> id == LauncherIconVariants.DEFAULT
    }

    /** Recents shows the task under the icon it was launched with; hand it the current one. */
    private fun describeTask(activity: Activity, id: String) {
        val label = context.getString(R.string.app_name)
        val iconRes = context.resources.getIdentifier("ic_launcher_$id", "mipmap", context.packageName)
        if (iconRes == 0) return
        val description = when {
            Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU ->
                ActivityManager.TaskDescription.Builder().setLabel(label).setIcon(iconRes).build()
            Build.VERSION.SDK_INT >= Build.VERSION_CODES.P ->
                @Suppress("DEPRECATION") ActivityManager.TaskDescription(label, iconRes)
            else -> {
                val drawable = pm.getActivityIcon(component(id))
                val size = (48 * context.resources.displayMetrics.density).toInt().coerceAtLeast(1)
                val bitmap = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888)
                drawable.setBounds(0, 0, size, size)
                drawable.draw(Canvas(bitmap))
                @Suppress("DEPRECATION") ActivityManager.TaskDescription(label, bitmap)
            }
        }
        activity.setTaskDescription(description)
    }

    companion object {
        private const val TAG = "ZenLauncherIcon"
    }
}
