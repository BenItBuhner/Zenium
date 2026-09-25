package app.zen.chromium

/**
 * What the launcher icon's aliases point at: the tap's own splash, carried into the browser.
 *
 * The forward to `MainActivity` is [LauncherIconActivity]'s (inherited); the manifest shape is
 * another – `Theme.Zen.Splash`, the package's task affinity, `relinquishTaskIdentity`, no
 * `excludeFromRecents` – so that the platform draws the splash starting window FROM THE TAP and
 * hands it to the browser's window. The platform's rules, at the API 35 sources:
 *
 *  - The starting window is drawn from the theme of the activity the launcher starts, before the
 *    process exists. `Theme.NoDisplay` (translucent) draws none
 *    (`ActivityRecord.validateStartingWindowTheme`, `:2503-2546`): behind the old target the
 *    launcher stood still for the process start and the forward, and the splash came only when
 *    `MainActivity` started. Under this theme the splash is up at the tap.
 *  - The hand-over is the platform's intra-task transfer. `Task.startActivityLocked`
 *    (`:5377-5381`) looks for an activity holding starting data in the started activity's OWN
 *    task, and `ActivityRecord.addStartingWindow` (`:2611`) moves that window over
 *    (`transferStartingWindow`, `:4657-4768`) before it asks whether the new activity would have
 *    earned one of its own (`getStartingWindowType`, `:2665-2708`: not for an activity added to
 *    a running task). So the browser must land in THIS activity's task: no `taskAffinity=""`
 *    here, and `MainActivity` (singleTask, no task of its own yet on a cold start) is added to
 *    it by `ActivityStarter.complyActivityFlags`' singleTask branch (`performClearTop` finds no
 *    `MainActivity` in the task → `mAddingToTask`). The transferred window then lifts as the
 *    browser's own would have: `MainActivity`'s exit listener is registered on its record, and
 *    `transferSplashScreenIfNeeded` (`:2791-2807`) declines only a window resized in transit.
 *  - The identity. A task whose intent names an alias dies with the alias
 *    (`RecentTasks.cleanupDisabledPackageTasksLocked`, `:756-771` – the icon switch, which is
 *    why the aliases never named `MainActivity` itself, Chrome's shape). This activity
 *    relinquishes: the moment `MainActivity` is added, the task's root filter
 *    (`Task.java:547-572`) passes the identity to it (`onChildAdded` → `updateEffectiveIntent`),
 *    and from then on the task keeps it – `Task.setIntent(ActivityRecord…)` (`:938-953`) updates
 *    an identity only while the root relinquishes, so a later tap's `setIntent` of this activity
 *    (`ActivityStarter:2391`, the `!rootWasReset` branch) cannot hand it back to the alias.
 *    Chrome's own trampoline, `ChromeLauncherActivity`, carries the same attribute.
 *  - The cost on the boot path: one `Activity` of the platform's with no content and no window
 *    (`finish()` in `onCreate`: `ActivityThread.performResumeActivity` returns early for a
 *    finished activity, `:5266`), measured against the direct start by the pair tool's alias way.
 *
 * The hot tap from the launcher (`FLAG_ACTIVITY_NEW_TASK | FLAG_ACTIVITY_RESET_TASK_IF_NEEDED`,
 * what launchers and `LauncherApps.startMainActivity` send) takes `complyActivityFlags`'
 * `resetTask` branch: the browser's task comes forward, nothing is added, no splash. A warm
 * launch through the alias with `FLAG_ACTIVITY_NEW_TASK` alone – `adb shell am start`, callers of
 * `PackageManager.getLaunchIntentForPackage` such as Settings' Open – adds this activity on top
 * of the running browser (`:2385-2390`), and the platform, seeing a task switch to an activity
 * not yet created, draws its splash for it; the forward's `performClearTop` finishes this
 * activity and the starting window is TRANSFERRED to the browser's window, whose exit listener is
 * handed the copy a second time – after the lift, the chrome READY long since. The platform does
 * not end that copy (`TRANSFER_SPLASH_SCREEN_TIMEOUT`, 2000 ms, removes the SHELL's window when
 * the copy is not attached in time; the attached copy is the app's to end), so the app must:
 * [StartupSplash] sends a hand-over after the lift away at once on the exit motion
 * (`SplashHold.HandOver.LATE`), so the warm launch shows the splash for the forward's length plus
 * the departure's 180 ms. Before round 5 of #454 nothing lifted it and the copy stayed over the
 * page (runs 7 and 8's `alias_open` recordings); android-startup-demo.sh's `alias_open` act judges
 * the flash's end on every scheme. The launcher's own path never shows it.
 *
 * The other trampolines keep `Theme.NoDisplay`. [LinkDispatchActivity] runs in the CALLER's task,
 * where a splash would be one window in the mail app's task and then a second in the browser's
 * (the transfer never crosses tasks); [WebAppLauncherActivity]'s window lives in the app's own
 * document task, found by its URI, never the trampoline's. Chrome's `ChromeLauncherActivity`
 * (the link path) and `WebappLauncherActivity` are `NoDisplay` for the same reason.
 */
class IconTapActivity : LauncherIconActivity()
