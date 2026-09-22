package app.zen.chromium

/**
 * The demo harness's hold on the core's startup sweeps: the filter lists and the Safe Browsing
 * feeds refresh 20 s and 35 s after boot, and their parsing – in the chrome's background worker,
 * but the downloads and the file writes still on the chrome's thread – would land inside an
 * emulator demo's measured scenes. The harness asks for the sweeps to wait with the launch
 * intent's [EXTRA_HOLD] (the boot payload's `holdBackgroundWork`, `Platform.performance`), and
 * ends the hold with [Host.releaseBackgroundWork] once its scenes are over (the [RELEASE_EVENT]
 * host event, the core's `performance.releaseBackgroundWork`). A held sweep looks again every
 * 5 s and runs at once on the release.
 *
 * Debuggable builds alone honour the extra: any app may start the browser's activity with any
 * extra, and a release build must not let another app put its protection lists off.
 */
object BackgroundWorkHold {
    /** The launch intent's boolean extra (`DemoHarness`: `-e holdBackgroundWork true`). */
    const val EXTRA_HOLD = "app.zen.chromium.extra.HOLD_BACKGROUND_WORK"

    /** The host event that ends the hold (`HostEventPayloads['background.release']`). */
    const val RELEASE_EVENT = "background.release"

    /** Whether the boot payload says to hold: the extra, on a debuggable build. */
    fun requested(extraSet: Boolean, debuggable: Boolean): Boolean = debuggable && extraSet
}
