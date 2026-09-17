package app.zen.chromium

import android.app.role.RoleManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.provider.Settings

/**
 * The system's browser role. Android 10 (API 29) introduced `RoleManager`, whose dialog lets the
 * user hand the role to an app on the spot; Android 8 and 9 only have the default-apps screen in
 * Settings, so there the answer is read from which activity handles a plain web link.
 */
object DefaultBrowser {
    /** Whether this app is the default browser right now. */
    fun isDefault(context: Context): Boolean {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            val roles = context.getSystemService(RoleManager::class.java) ?: return legacyIsDefault(context)
            return roles.isRoleAvailable(RoleManager.ROLE_BROWSER) && roles.isRoleHeld(RoleManager.ROLE_BROWSER)
        }
        return legacyIsDefault(context)
    }

    /**
     * The intent that lets the user make this app the default: the role request dialog on
     * Android 10+, the default-apps settings screen before that. `null` when the device offers
     * neither (the role is unavailable, e.g. on some TV / automotive builds).
     */
    fun requestIntent(context: Context): Intent? {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            val roles = context.getSystemService(RoleManager::class.java)
            if (roles != null && roles.isRoleAvailable(RoleManager.ROLE_BROWSER)) {
                return roles.createRequestRoleIntent(RoleManager.ROLE_BROWSER)
            }
        }
        val settings = Intent(Settings.ACTION_MANAGE_DEFAULT_APPS_SETTINGS)
        return if (settings.resolveActivity(context.packageManager) != null) settings else null
    }

    private fun legacyIsDefault(context: Context): Boolean {
        val probe = Intent(Intent.ACTION_VIEW, Uri.parse("http://example.com"))
        val handler = context.packageManager.resolveActivity(probe, PackageManager.MATCH_DEFAULT_ONLY)
        return handler?.activityInfo?.packageName == context.packageName
    }
}
