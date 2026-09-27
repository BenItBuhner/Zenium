package app.zen.chromium.ext

/**
 * The decision behind the compat sweep's `onScreen` and its prompt taps (CompatSweep.kt), kept
 * free of Android so it runs on the JVM (`SweepScreenGuardTest`) and compiled into the unit
 * tests and the instrumentation alike (`src/sharedTest`), never into the app.
 *
 * The lifecycle stage alone does not say whether a finger reaches the browser. Round 22's AFTER
 * on the AOSP image (the 156 sweep's second boot, Adblock Ad Blocker Pro's row) lost 37 rows to
 * one tap: the finger meant for an install prompt's button, 29 px above the navigation bar and
 * the same finger that had answered the boot's 22 prompts before it, was taken by SystemUI's
 * Recents button. Android launches Overview as a *transient* task – the browser's activity
 * stays RESUMED under the launcher's window – so the driver's stage check let the second finger
 * through to the launcher's Recents view, which went Home; the browser was stopped, and the
 * system destroyed the stopped activity fourteen seconds later. The BEFORE's 156 second boot
 * had the same first three steps on Joko's row and came back only because nothing destroyed
 * the stopped activity within the minute.
 *
 * So the screen's window list is read beside the stage: an application window of the launcher
 * or of SystemUI drawn over the browser's own means Overview (or Home over a still-resumed
 * browser) and is left with BACK – Launcher3's Overview hands BACK to the running task, the
 * browser –, never with another finger where the last one went; any other app's window over
 * the browser's is left by bringing the browser's task back with its own intent, as a paused or
 * stopped activity always was.
 */
object SweepScreenGuard {
    /** `AccessibilityWindowInfo.TYPE_APPLICATION`, spelled out so this file needs no Android. */
    const val TYPE_APPLICATION = 1

    /** One window of the screen's accessibility window list, as the driver reads it. */
    data class Window(
        /** `AccessibilityWindowInfo.getType()`: application, input method, system (the bars), overlays. */
        val type: Int,
        /** The package of the window's root node; null when the window hands out no root. */
        val packageName: String?,
        /** `AccessibilityWindowInfo.getLayer()`: a greater layer is drawn on top. */
        val layer: Int
    )

    /** What the window list says about the browser's place on the screen. */
    sealed class Reading {
        /** The browser's own window is the topmost application window: a finger reaches it. */
        object BrowserOnTop : Reading() {
            override fun toString() = "BrowserOnTop"
        }

        /** The launcher or SystemUI draws an application window over the browser's: Overview, or Home over a resumed browser. */
        data class OverviewOver(val packageName: String) : Reading()

        /** Another app's window over the browser's. */
        data class OtherAppOver(val packageName: String) : Reading()

        /** No window of the browser's in the list: the lifecycle stage alone decides. */
        object BrowserAbsent : Reading() {
            override fun toString() = "BrowserAbsent"
        }
    }

    /** How the browser is brought back under a finger. */
    sealed class Exit {
        /** Press BACK once and read the windows again. */
        object PressBack : Exit() {
            override fun toString() = "PressBack"
        }

        /** Start the browser's activity with its own intent (`REORDER_TO_FRONT`) and read again. */
        object Relaunch : Exit() {
            override fun toString() = "Relaunch"
        }

        /** The browser is on top; nothing to do. */
        object Done : Exit() {
            override fun toString() = "Done"
        }

        /** No more presses: the screen is left as it is, for the reason given. */
        data class GiveUp(val reason: String) : Exit()
    }

    /** The launchers of the images the sweep runs on, and SystemUI (Recents lived there before Quickstep). */
    val LAUNCHER_PACKAGES = setOf(
        "com.android.launcher3",
        "com.google.android.apps.nexuslauncher",
        "com.android.launcher",
        "com.android.systemui"
    )

    /** BACK presses at most before the exit gives up: one for Overview, one for a launcher that kept it. */
    const val MAX_BACKS = 2

    /**
     * The browser's place among the application windows on screen. System windows (the bars,
     * toasts), the input method and the overlays are never in the way of a finger; the browser's
     * own other windows (its sheets, its dialogs) are its own.
     */
    fun read(windows: List<Window>, browserPackage: String): Reading {
        val apps = windows.filter { it.type == TYPE_APPLICATION && it.packageName != null }
        val own = apps.filter { it.packageName == browserPackage }
        if (own.isEmpty()) return Reading.BrowserAbsent
        val ownTop = own.maxOf { it.layer }
        val over = apps.filter { it.packageName != browserPackage && it.layer > ownTop }.maxByOrNull { it.layer }
            ?: return Reading.BrowserOnTop
        val pkg = over.packageName!!
        return if (isLauncher(pkg)) Reading.OverviewOver(pkg) else Reading.OtherAppOver(pkg)
    }

    /** Whether a package is a launcher's or SystemUI's: the known names, or any package naming itself a launcher. */
    fun isLauncher(packageName: String): Boolean =
        packageName in LAUNCHER_PACKAGES || packageName.endsWith(".launcher") || packageName.contains(".launcher.")

    /**
     * The next move to bring the browser back under a finger, from the latest reading and the
     * BACK presses made so far. Overview is left with BACK; a launcher that still stands after
     * [MAX_BACKS] is given up on (the browser's stage decides what happens next); another app is
     * left by relaunching the browser's task, once.
     */
    fun exit(reading: Reading, backsPressed: Int, relaunched: Boolean): Exit = when (reading) {
        Reading.BrowserOnTop, Reading.BrowserAbsent -> Exit.Done
        is Reading.OverviewOver ->
            if (backsPressed < MAX_BACKS) Exit.PressBack
            else Exit.GiveUp("${reading.packageName} still over the browser after $backsPressed BACK press(es)")
        is Reading.OtherAppOver ->
            if (!relaunched) Exit.Relaunch
            else Exit.GiveUp("${reading.packageName} still over the browser after its relaunch")
    }

    /**
     * Whether a prompt's button may be tapped again after a finger that did not answer it: never
     * when that finger opened Overview (the reading after it says the launcher is over the
     * browser) – the second finger there goes to the launcher, and the command answers the
     * prompt instead once Overview is left.
     */
    fun mayTapAgain(tapsSoFar: Int, readingAfterTap: Reading): Boolean =
        tapsSoFar == 0 || readingAfterTap == Reading.BrowserOnTop || readingAfterTap == Reading.BrowserAbsent
}
