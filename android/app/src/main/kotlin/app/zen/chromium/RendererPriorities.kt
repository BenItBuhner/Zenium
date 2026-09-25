package app.zen.chromium

/**
 * The renderer priority policy of every WebView the browser window holds (OS-37; Chrome's
 * `BindingManager`, whose background renderers hold only a moderate or waived binding so the
 * system takes them ahead of the browser). Free of Android types so it runs under plain JUnit
 * ([RendererPrioritiesTest]); [TabHost.show] and [Host.applyRendererPriority] act on it.
 *
 * Every WebView of the process – the chrome's and the pages' – shares one sandboxed renderer,
 * and the platform gives that renderer the highest priority any attached WebView asks for, each
 * read against its own visibility: a view that asked `waivedWhenNotVisible` counts as [WAIVED]
 * while the platform does not see it (`View.GONE`, detached, or its window off the screen). So
 * while the window shows, the chrome (visible) and the page in front (visible, [IMPORTANT]) keep
 * the renderer at the app's own priority whatever the hidden pages ask, and a hidden page's
 * [WAIVED] changes nothing on its own: the policy's weight is in the background. With the window
 * off the screen no view is visible, every one of them reads waived, and the renderer – the
 * pages' memory, the bulk of the app's – becomes the system's cheapest kill, ahead of this
 * process, which is small without it, holds the session on disk and rebuilds the chrome once
 * the window is back (`Host.rebuildChrome` defers the load to `onStart`); the pages come back
 * with their pictures over them (`RestoredPictures`), as Chrome's do after a background kill.
 * The exit reads as a background one ([RendererExits.classify]: WAIVED at exit).
 *
 * The exception is what the renderer carries that must outlive the screen: a media session
 * playing (the foreground service keeps the process for it) or a capture running. Then the chrome
 * asks [IMPORTANT] unwaived ([forChrome] `held`), and the renderer stays at the process's
 * priority in the background as under the platform's default policy.
 */
object RendererPriorities {
    /** `WebView.RENDERER_PRIORITY_WAIVED`: the renderer may go whenever the system wants the memory. */
    const val WAIVED = 0
    /** `WebView.RENDERER_PRIORITY_BOUND`: kept while the app is in the foreground, expendable behind it. */
    const val BOUND = 1
    /** `WebView.RENDERER_PRIORITY_IMPORTANT`: the app's own priority – the platform's default. */
    const val IMPORTANT = 2

    /** One WebView's `setRendererPriorityPolicy(priority, waivedWhenNotVisible)` pair. */
    data class Policy(val priority: Int, val waivedWhenNotVisible: Boolean) {
        /** What this view asks of the renderer while the platform sees it (`visible`) or not. */
        fun effective(visible: Boolean): Int = if (!visible && waivedWhenNotVisible) WAIVED else priority
    }

    /**
     * A page view's policy as it is shown or hidden: [IMPORTANT] in front, [WAIVED] hidden, and
     * waived whichever it is once the window leaves the screen.
     */
    fun forPage(visible: Boolean): Policy = Policy(if (visible) IMPORTANT else WAIVED, waivedWhenNotVisible = true)

    /**
     * The chrome's policy: [IMPORTANT], waived with the window – unless the renderer is `held`
     * ([held]), when it is the platform's default, unwaived, and the renderer lives on behind
     * other apps.
     */
    fun forChrome(held: Boolean): Policy = Policy(IMPORTANT, waivedWhenNotVisible = !held)

    /** Whether the renderer carries something the screen's leaving must not end. */
    fun held(mediaPlaying: Boolean, capturing: Boolean): Boolean = mediaPlaying || capturing

    /**
     * The renderer's priority as the platform computes it: the highest any attached view asks,
     * each read against its own visibility, none of them visible while the window is off the
     * screen (`windowVisible` false). No view at all is waived.
     */
    fun effective(views: List<Pair<Policy, Boolean>>, windowVisible: Boolean): Int =
        views.maxOfOrNull { (policy, viewVisible) -> policy.effective(windowVisible && viewVisible) } ?: WAIVED
}
