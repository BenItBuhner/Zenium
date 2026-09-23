package app.zen.chromium

import android.app.role.RoleManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.verify.domain.DomainVerificationManager
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

    /**
     * What Android's "Open by default" screen is set to for this app (DEF-06; the About row's
     * state): on Android 12+ the screen's link-handling switch, `DomainVerificationUserState
     * .isLinkHandlingAllowed` – off, the system hands no web link to this app however the role
     * stands; before it the screen is the app's details page, and the state is which app a plain
     * `http://` link resolves to. `allowed`, `disallowed` or `unknown`, the words the chrome's
     * `AppLinkState` reads.
     */
    fun appLinkState(context: Context): String {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            val manager = context.getSystemService(DomainVerificationManager::class.java) ?: return legacyLinkState(context)
            val state = try {
                manager.getDomainVerificationUserState(context.packageName)
            } catch (e: PackageManager.NameNotFoundException) {
                null
            } ?: return UNKNOWN
            return if (state.isLinkHandlingAllowed) ALLOWED else DISALLOWED
        }
        return legacyLinkState(context)
    }

    /**
     * The pre-12 reading, decided from the package a plain web link resolves to with
     * `MATCH_DEFAULT_ONLY`: this app – the links are ours; another – they go there; none –
     * the system asks each time, or nothing takes them, and the screen cannot be read.
     */
    fun linkStateOf(resolvedPackage: String?, self: String): String = when (resolvedPackage) {
        null -> UNKNOWN
        self -> ALLOWED
        else -> DISALLOWED
    }

    const val ALLOWED = "allowed"
    const val DISALLOWED = "disallowed"
    const val UNKNOWN = "unknown"

    private fun legacyIsDefault(context: Context): Boolean {
        return legacyHandler(context) == context.packageName
    }

    private fun legacyLinkState(context: Context): String = linkStateOf(legacyHandler(context), context.packageName)

    /** The package a plain `http://` link goes to without asking, or null when the system would ask. */
    private fun legacyHandler(context: Context): String? {
        val probe = Intent(Intent.ACTION_VIEW, Uri.parse("http://example.com"))
        val handler = context.packageManager.resolveActivity(probe, PackageManager.MATCH_DEFAULT_ONLY)
        // The resolver's own activity answers a link with no default: not a browser's package.
        val pkg = handler?.activityInfo?.packageName ?: return null
        return if (pkg == "android") null else pkg
    }
}
