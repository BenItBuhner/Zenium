package app.zen.chromium

import android.content.Context
import android.content.Intent

/**
 * Tells another app's `CustomTabsIntent` apart from a plain link and forwards it to
 * [CustomTabActivity]. The decision itself is pure ([classify]) so it has a JVM test.
 */
object CustomTabIntents {
    enum class Kind { NONE, LINK, CUSTOM_TAB }

    /** `CustomTabsIntent.EXTRA_SESSION`: present (even as a null binder) on every custom tab intent. */
    const val EXTRA_SESSION = "android.support.customtabs.extra.SESSION"
    /** The prefixes every other custom tab extra carries, old (support) and new (androidx) names. */
    private const val EXTRA_PREFIX_SUPPORT = "android.support.customtabs.extra."
    private const val EXTRA_PREFIX_ANDROIDX = "androidx.browser.customtabs.extra."

    /** The app that sent the intent, as LinkDispatchActivity saw it (`android-app://` referrer). */
    const val EXTRA_CALLER_PACKAGE = "app.zen.chromium.extra.CALLER_PACKAGE"

    private val WEB_SCHEMES = setOf("http", "https")

    /**
     * A VIEW of a web URL is a [Kind.LINK]; when it carries the session extra it is a
     * [Kind.CUSTOM_TAB] (Chrome's own rule), and so is one that only carries other custom tab
     * extras, which a hand-built intent may do. Anything else is [Kind.NONE].
     */
    fun classify(action: String?, scheme: String?, extraKeys: Collection<String>): Kind {
        if (action != Intent.ACTION_VIEW || scheme?.lowercase() !in WEB_SCHEMES) return Kind.NONE
        val custom = extraKeys.any {
            it == EXTRA_SESSION || it.startsWith(EXTRA_PREFIX_SUPPORT) || it.startsWith(EXTRA_PREFIX_ANDROIDX)
        }
        return if (custom) Kind.CUSTOM_TAB else Kind.LINK
    }

    fun classify(intent: Intent): Kind =
        classify(intent.action, intent.data?.scheme, intent.extras?.keySet() ?: emptySet())

    fun isCustomTab(intent: Intent): Boolean = classify(intent) == Kind.CUSTOM_TAB

    /**
     * The same intent aimed at [CustomTabActivity]. Launch flags are dropped: started without
     * `NEW_TASK` from an activity in the caller's task the custom tab joins that task, as Chrome's
     * does, so closing it lands back in the caller.
     */
    fun toCustomTabActivity(context: Context, intent: Intent, callerPackage: String? = null): Intent {
        val forwarded = Intent(intent).setClass(context, CustomTabActivity::class.java)
        forwarded.flags = intent.flags and (Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
        if (callerPackage != null) forwarded.putExtra(EXTRA_CALLER_PACKAGE, callerPackage)
        return forwarded
    }

    /** The package behind an `android-app://` referrer (`Activity.getReferrer`), null for anything else. */
    fun packageOfReferrer(referrer: String?): String? {
        val rest = referrer?.removePrefix("android-app://")?.takeIf { it !== referrer } ?: return null
        return rest.substringBefore('/').substringBefore('?').substringBefore('#').takeIf { it.isNotEmpty() }
    }
}
