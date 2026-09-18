package app.zen.chromium

import android.content.Context
import android.os.Build
import android.view.View
import android.view.autofill.AutofillManager
import org.json.JSONObject

/**
 * Zenium and the Android Autofill Framework. Every WebView is a client of the framework: the
 * user's autofill service (Google, Bitwarden, 1Password, …) sees a page's fields and offers to
 * save and fill them. Zenium's own password manager works in the page instead, through the forms
 * script, and the two would fight over one field. So the core picks one provider (Settings →
 * Passwords → Zenium as the autofill provider): under `zenium` the page WebViews step out of the
 * framework; under `system` the service keeps the pages and Zenium keeps its prompts out of them.
 */
object SystemAutofill {
    const val PROVIDER_SYSTEM = "system"
    const val PROVIDER_ZENIUM = "zenium"

    /** What the core asks for (`autofill.status`): whether the user has a service set, and which. */
    fun status(context: Context): JSONObject {
        val manager = context.getSystemService(AutofillManager::class.java)
        val enabled = manager != null && manager.isAutofillSupported && manager.isEnabled
        val service = if (enabled && Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            manager.autofillServiceComponentName?.flattenToShortString()
        } else {
            null
        }
        return json("enabled" to enabled, "service" to service)
    }

    /**
     * The `importantForAutofill` mode a page WebView takes under `provider`: out of the framework
     * (the view and every field the page renders in it) when Zenium fills, the default when the
     * system service does. Pure, for the unit tests.
     */
    fun importance(provider: String): Int =
        if (provider == PROVIDER_ZENIUM) View.IMPORTANT_FOR_AUTOFILL_NO_EXCLUDE_DESCENDANTS else View.IMPORTANT_FOR_AUTOFILL_AUTO

    /** A provider name from the bridge, normalised: anything but `zenium` is the system. */
    fun provider(raw: String?): String = if (raw == PROVIDER_ZENIUM) PROVIDER_ZENIUM else PROVIDER_SYSTEM
}
