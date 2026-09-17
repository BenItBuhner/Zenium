package app.zen.chromium

import kotlin.math.pow

/**
 * Which colours a custom tab paints its toolbar and system bars with, from what the caller asked
 * for: `EXTRA_COLOR_SCHEME` picks light, dark or the system's scheme, and the per-scheme
 * `EXTRA_COLOR_SCHEME_PARAMS` (already merged with the intent's default params by
 * `CustomTabsIntent.getColorSchemeParams`) may name a toolbar and a navigation bar colour. Pure,
 * so the fallbacks and the icon-contrast rule have a JVM test.
 */
object CustomTabScheme {
    /** `CustomTabsIntent.COLOR_SCHEME_SYSTEM / _LIGHT / _DARK`. */
    const val SYSTEM = 0
    const val LIGHT = 1
    const val DARK = 2

    /** What the caller supplied for one scheme, each colour optional (ARGB, alpha ignored). */
    data class Params(
        val toolbar: Int? = null,
        val secondaryToolbar: Int? = null,
        val navigationBar: Int? = null,
        val navigationBarDivider: Int? = null
    )

    /** Zenium's own colours for a scheme, used where the caller named none. */
    data class Defaults(val toolbar: Int, val navigationBar: Int)

    data class Resolved(
        /** The custom tab's own scheme: its menu, text and fallback surfaces. */
        val dark: Boolean,
        val toolbar: Int,
        /** True when the toolbar colour is the caller's rather than Zenium's default. */
        val toolbarIsCallers: Boolean,
        val navigationBar: Int,
        /** Null: no divider line above the navigation bar. */
        val navigationBarDivider: Int?,
        /** Whether the toolbar's glyphs, text and status bar icons are light (on a dark toolbar). */
        val lightToolbarForeground: Boolean,
        val lightNavigationForeground: Boolean
    )

    /** The effective scheme: `scheme` is [SYSTEM], [LIGHT] or [DARK] (anything else counts as [SYSTEM]). */
    fun isDark(scheme: Int, systemDark: Boolean): Boolean = when (scheme) {
        LIGHT -> false
        DARK -> true
        else -> systemDark
    }

    /**
     * `params` are the caller's colours for the effective scheme (see [isDark]); `light` and
     * `dark` are Zenium's.
     */
    fun resolve(scheme: Int, systemDark: Boolean, params: Params, light: Defaults, dark: Defaults): Resolved {
        val isDark = isDark(scheme, systemDark)
        val defaults = if (isDark) dark else light
        val toolbar = opaque(params.toolbar ?: defaults.toolbar)
        // A caller that colours the toolbar but not the navigation bar gets a matching bar, as in
        // Chrome; with no colours at all the bar takes Zenium's page colour.
        val navigationBar = opaque(params.navigationBar ?: params.toolbar ?: defaults.navigationBar)
        return Resolved(
            dark = isDark,
            toolbar = toolbar,
            toolbarIsCallers = params.toolbar != null,
            navigationBar = navigationBar,
            navigationBarDivider = params.navigationBarDivider?.let(::opaque),
            lightToolbarForeground = needsLightForeground(toolbar),
            lightNavigationForeground = needsLightForeground(navigationBar)
        )
    }

    /** Chrome's rule: light glyphs once the colour contrasts at least 3:1 with white. */
    fun needsLightForeground(argb: Int): Boolean = contrastWithWhite(argb) >= 3.0

    /** WCAG contrast ratio between white and an opaque colour, 1…21. */
    fun contrastWithWhite(argb: Int): Double = 1.05 / (luminance(argb) + 0.05)

    /** WCAG relative luminance of an opaque colour, 0 (black) … 1 (white). */
    fun luminance(argb: Int): Double {
        fun channel(shift: Int): Double {
            val c = ((argb shr shift) and 0xff) / 255.0
            return if (c <= 0.03928) c / 12.92 else ((c + 0.055) / 1.055).pow(2.4)
        }
        return 0.2126 * channel(16) + 0.7152 * channel(8) + 0.0722 * channel(0)
    }

    fun opaque(argb: Int): Int = argb or 0xff000000.toInt()
}
