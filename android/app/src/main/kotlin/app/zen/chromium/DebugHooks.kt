package app.zen.chromium

/**
 * The host's hooks for the demo harness that a product build must not have: today
 * [Host.debugEndRenderer] (the plan's `zen.debug.endRenderer`), which ends the shared renderer
 * process the way a crash would so the `OfflineHungDemo` run can show the crash page – a WebView
 * has no `chrome://crash`, and `WebViewRenderProcess.terminate()` alone reads as the system's
 * kill (the memory page), so the hook records the exit's word first; and [Host.debugHoldLoadHtml],
 * which holds a tab's next `view.loadHtml` back so the run can force the order in which a load
 * set up ahead of the crash page commits before it.
 *
 * Reach: a hook is a Kotlin method on [Host], called in-process by the instrumentation (the
 * harness shares the app's process); none is a bridge method, none is on `window`, and the
 * bridge object is the chrome document's alone, so no page and no chrome script can reach one.
 * Gate: debuggable builds alone answer, as [BackgroundWorkHold] honours its extra – the decision
 * is `BuildConfig.DEBUG`, made where the boot payload is built; a release build's hook logs and
 * does nothing.
 */
object DebugHooks {
    /** Whether the hooks answer: the build's debuggable flag, nothing else. */
    fun enabled(debuggable: Boolean): Boolean = debuggable
}
