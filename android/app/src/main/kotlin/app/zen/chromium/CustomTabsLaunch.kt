package app.zen.chromium

import android.content.Intent
import androidx.browser.customtabs.CustomTabsIntent

/** Small, testable boundary between ordinary VIEW intents and Custom Tabs launches. */
object CustomTabsLaunch {
    const val EXTRA_REPLAY_FROM_CUSTOM_TAB = "app.zen.chromium.extra.REPLAY_FROM_CUSTOM_TAB"

    fun isCustomTabsLaunch(intent: Intent): Boolean =
        !intent.getBooleanExtra(EXTRA_REPLAY_FROM_CUSTOM_TAB, false) &&
            intent.action == Intent.ACTION_VIEW &&
            isCustomTabsExtras(intent.extras?.keySet() ?: emptySet())

    fun isCustomTabsExtras(keys: Set<String>): Boolean = keys.any { key ->
        key.startsWith("android.support.customtabs.") ||
            key.startsWith("androidx.browser.customtabs.")
    }
}

data class CustomTabColors(
    val toolbar: Int,
    val navigationBar: Int,
    val dark: Boolean
)

/** Resolves Custom Tabs' system/light/dark request without consulting activity state. */
object CustomTabColorSchemeResolver {
    const val LIGHT_PAGE = 0xfffbfbfe.toInt()
    const val DARK_PAGE = 0xff1c1b22.toInt()

    fun resolve(toolbarColor: Int?, colorScheme: Int, systemDark: Boolean): CustomTabColors {
        val dark = when (colorScheme) {
            CustomTabsIntent.COLOR_SCHEME_DARK -> true
            CustomTabsIntent.COLOR_SCHEME_LIGHT -> false
            else -> systemDark
        }
        val toolbar = toolbarColor ?: if (dark) DARK_PAGE else LIGHT_PAGE
        return CustomTabColors(
            toolbar = toolbar,
            navigationBar = darken(toolbar, if (dark) 0.82f else 0.92f),
            dark = dark
        )
    }

    private fun darken(color: Int, factor: Float): Int {
        val alpha = color ushr 24 and 0xff
        val red = ((color ushr 16 and 0xff) * factor).toInt()
        val green = ((color ushr 8 and 0xff) * factor).toInt()
        val blue = ((color and 0xff) * factor).toInt()
        return alpha shl 24 or (red shl 16) or (green shl 8) or blue
    }
}
