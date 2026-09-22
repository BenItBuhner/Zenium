package app.zen.chromium

import android.content.res.Configuration
import androidx.appcompat.app.AppCompatDelegate

/**
 * The pages' share of the chrome's theme switch (`Host.applyTheme`). Zenium's own Light / Dark
 * choice sets the app's night mode, and the app's theme is what WebView reads the pages'
 * `prefers-color-scheme` and the algorithmic darkening from (`AwDarkMode.isAppUsingDarkTheme`
 * resolves the activity theme's `isLightTheme` each time it populates the web preferences).
 * Plain ints, so the decisions run under JUnit (`PageThemeTest`).
 */
object PageTheme {
    /** The app's night mode for the chrome's colour scheme; `system` (or anything else) follows the OS. */
    fun nightMode(scheme: String): Int = when (scheme) {
        "dark" -> AppCompatDelegate.MODE_NIGHT_YES
        "light" -> AppCompatDelegate.MODE_NIGHT_NO
        else -> AppCompatDelegate.MODE_NIGHT_FOLLOW_SYSTEM
    }

    /**
     * Whether the activity's configuration crossed between day and night over a switch: its
     * `uiMode` before and after `AppCompatDelegate.setDefaultNightMode`. The manifest handles
     * `uiMode`, so AppCompat rewrites the activity's resources in place and calls the activity
     * (`MainActivity.onConfigurationChanged`) – but no view hears of it: the system dispatches
     * a configuration change down the view tree for a real `uiMode` change alone, and WebView
     * re-derives the pages' colour scheme only in its own `onConfigurationChanged`
     * (`AwContents` -> `notifyRendererPreferenceUpdate` -> the web preferences populated again).
     * So the host dispatches the change to every WebView itself when this is true, and every
     * open page flips with the chrome, instead of at the next system flip – or never, in the
     * production app-only switch (the bug behind PC-13's note; #266's review). A switch that
     * leaves the night bit alone (Light -> System on a light system) has nothing to tell them;
     * the type bits of `uiMode` (a car dock, a TV) are not a flip.
     */
    fun nightFlipped(uiModeBefore: Int, uiModeAfter: Int): Boolean =
        (uiModeBefore and Configuration.UI_MODE_NIGHT_MASK) != (uiModeAfter and Configuration.UI_MODE_NIGHT_MASK)
}
