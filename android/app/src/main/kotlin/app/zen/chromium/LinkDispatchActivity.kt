package app.zen.chromium

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import androidx.browser.customtabs.CustomTabsSessionToken

/**
 * Where every web link aimed at Zenium arrives (the manifest's `VIEW http/https` filter is on
 * this activity, as Chrome's is on its launcher activity). It tells a plain link, which goes to
 * the browser window in the browser's own task, from another app's `CustomTabsIntent`, which
 * becomes a [CustomTabActivity] in *this* task – the caller's, since the trampoline itself was
 * started there – so closing the custom tab lands back in the app that opened it. Gone before it
 * draws (`Theme.NoDisplay`, no history, no Recents entry, empty affinity).
 */
class LinkDispatchActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val incoming = intent
        when (CustomTabIntents.classify(incoming)) {
            CustomTabIntents.Kind.CUSTOM_TAB -> startActivity(CustomTabIntents.toCustomTabActivity(this, incoming, callerPackage(incoming)))
            CustomTabIntents.Kind.LINK, CustomTabIntents.Kind.NONE -> {
                val forwarded = Intent(incoming).setClass(this, MainActivity::class.java)
                forwarded.flags = (incoming.flags and (Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION)) or
                    Intent.FLAG_ACTIVITY_NEW_TASK
                startActivity(forwarded)
            }
        }
        finish()
    }

    /** The app behind the intent: what the system says sent it, else the app that owns the session. */
    private fun callerPackage(intent: Intent): String? =
        CustomTabIntents.packageOfReferrer(referrer?.toString())
            ?: CustomTabSessions.packageOf(CustomTabsSessionToken.getSessionTokenFromIntent(intent))
}
