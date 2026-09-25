package app.zen.chromium

import android.accessibilityservice.AccessibilityService
import android.graphics.Rect
import android.os.Build
import android.os.SystemClock
import android.view.View
import android.view.ViewGroup
import android.view.accessibility.AccessibilityNodeInfo
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.json.JSONObject
import org.json.JSONTokener
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import kotlin.math.abs

/**
 * Records the picture-in-picture window's life on the phone (MOT-30, MED-06), Chrome Android's
 * `FullscreenVideoPictureInPictureController` being the bar, in both schemes:
 *
 *  1. the clip playing fullscreen and Home: the window by itself (the auto-enter), the entry's
 *     frames traced (ruling 5: the chrome's long tasks across its hide), the window's bounds and
 *     ratio read, the tab's own view alone filling it over the chrome, and the chrome under it
 *     out of a screen reader's tree (the framework's word on its node); the window's menu under a
 *     finger – Pause (read back from the page), Play, Next track (the page's own handler) – then
 *     the expand, traced too: the page back inline in the chrome with the clip playing in its
 *     place and the chrome a reader's again. The WebView engine ends the element's fullscreen as the
 *     window shrinks, where Chrome keeps its tab fullscreen with a persistent video
 *     ([PictureInPictureRule]);
 *  2. the window on request (`media.pictureInPicture`, the in-app button's path) and its X: the
 *     clip pauses, the app stands behind the launcher, and comes back inline with the clip paused;
 *  3. the endings by the host's hand (Chrome's dismissals, `moveTaskToBack`): a new document in
 *     the window's tab, another tab shown under the window, the window's tab closed – each takes
 *     the window down with its task, and the tab the user comes back to is the page;
 *  4. Home with no fullscreen video – a page without one, and the clip playing inline – does
 *     nothing new: no window (Chrome's auto-enter is the fullscreen video's alone).
 *
 * The page is the media demos' (`media-demo-page.html`'s `/video`), read through its title.
 * Every check goes to `android-pip-notes.txt`; one that did not hold fails the run at its end.
 * Every touch injected has an assertion on what it did (the rule in [DemoHarness]).
 */
@RunWith(AndroidJUnit4::class)
class PipDemo : MediaDemoBase("android-pip") {
    override val tag = "PipDemo"
    private var failures = 0

    @Test
    fun record() {
        recordWithServer()
        assertEquals("checks that did not hold (see android-pip-notes.txt)", 0, failures)
    }

    /** The media demos' profile with its tab on the clip's page; the fullscreen exit hint counts as shown (its toast would stand in the fullscreen frames). */
    override fun patchState(json: String): String {
        val state = JSONObject(json)
        val tabs = state.getJSONArray("tabs")
        for (i in 0 until tabs.length()) {
            val tab = tabs.getJSONObject(i)
            if (tab.optString("id") == TAB) {
                tab.put("url", "http://127.0.0.1:$PORT/video")
                tab.put("title", "Zenium picture-in-picture demo")
            }
        }
        state.getJSONObject("settings").put("gestureHintDone", true)
        return state.toString()
    }

    override fun warmUp() {
        super.warmUp()
        // The system's one-time "Viewing full screen" notice would stand over the clip's first fullscreen.
        shell("settings put secure immersive_mode_confirmations confirmed")
        shell("cmd uimode night no")
        note("night mode off; the system's one-time immersive notice counted as seen; API ${Build.VERSION.SDK_INT}, ${width}x$height")
        poll(10_000) { pageJs("document.getElementById('media').videoWidth") != "0" }
        note("clip: ${pageJs("document.getElementById('media').videoWidth")}x${pageJs("document.getElementById('media').videoHeight")}; page ${title()}")
    }

    override fun demo() {
        for (scheme in listOf("light", "dark")) {
            scheme(scheme)
            fullscreenHomeIntoTheWindow(scheme)
            requestedWindowAndItsX(scheme)
        }
        newDocumentEndsIt()
        anotherTabEndsIt()
        closingTheTabEndsIt()
        noFullscreenVideoNoWindow()
        note("\nend: pip=${inPip()} pip tab=${host.media.pictureInPictureTab} filling=${host.tabs.filling} fullscreenTab=${host.fullscreenTab?.tabId}; ${describeTab(TAB)}")
    }

    // --- 1. fullscreen, Home: the window by itself, its actions, the expand ---------------------

    private fun fullscreenHomeIntoTheWindow(scheme: String) {
        note("\n1 ($scheme). the clip playing fullscreen, Home: the window by itself (MOT-30), its actions (MED-06), the expand")
        frontApp()
        onTheClip()
        tapPageButton("fullscreen", "Play fullscreen", "the clip goes fullscreen", 15_000) {
            field("fs") == "1" || host.fullscreenTab?.tabId == TAB
        }
        SystemClock.sleep(2_500)
        if (field("state") != "playing") ensurePlaying()
        note("  fullscreen: page fs=${field("fs")} state=${field("state")} host fullscreenTab=${host.fullscreenTab?.tabId}")
        check("$scheme: the clip plays fullscreen before Home", field("state") == "playing" && host.fullscreenTab?.tabId == TAB)
        shot("01-fullscreen-$scheme")
        beat()
        val enter = traceFrames("pip-enter-$scheme", JankBudget.Kind.OPEN) {
            ui.performGlobalAction(AccessibilityService.GLOBAL_ACTION_HOME)
            poll(10_000) { inPip() }
            poll(8_000) { host.tabs.filling == TAB }
            SystemClock.sleep(SETTLE_MS)
        }
        val win = appWindowBounds()
        val view = tabViewOnScreen(TAB)
        note(
            "  Home -> the window: pip=${inPip()} bounds $win (${ratio(win)}; the clip is ${field("size")}); the tab's view $view, z ${tabViewZ(TAB)}; " +
                "filling=${host.tabs.filling} fullscreenTab=${host.fullscreenTab?.tabId} pip tab=${host.media.pictureInPictureTab}; page fs=${field("fs")} state=${field("state")}; " +
                "core pictureInPicture=${mediaState(TAB)?.optBoolean("pictureInPicture")} fill attribute=${pageJs("document.getElementById('media').hasAttribute('data-zenium-pip')")}"
        )
        check("$scheme: Home with the clip playing fullscreen enters picture-in-picture by itself", inPip())
        check("$scheme: the tab's view alone fills the small window, over the chrome", host.tabs.filling == TAB && covers(view, win))
        check("$scheme: the engine ended the element's fullscreen with the entry (the fill stands in for Chrome's persistent video)", host.fullscreenTab == null && field("fs") == "0")
        check("$scheme: the window's ratio is the clip's", ratioMatches(win, field("size")))
        check("$scheme: the clip keeps playing in the window", field("state") == "playing")
        val chrome = chromeNode()
        note("  the chrome under the window: ${describeChrome(chrome)}; the page's view important=${pageNode()?.isImportantForAccessibility}")
        check("$scheme: the chrome under the small window is out of a reader's tree (NO_HIDE_DESCENDANTS: TalkBack is handed the page alone)", chromeMode() == "no-hide-descendants" && chrome != null && !chrome.isImportantForAccessibility && pageNode()?.isImportantForAccessibility == true)
        shot("02-window-$scheme")
        beat()
        if (win != null) {
            val trackBefore = field("track")
            check("$scheme: the window's Pause pauses the clip (the page reports it)", touchPipMenu(win, "Pause", "the window's Pause pauses the clip", shotAfter = "03-actions-$scheme") { field("state") == "paused" })
            SystemClock.sleep(1_000)
            shot("04-paused-$scheme")
            check("$scheme: the window's Play plays it again", touchPipMenu(win, "Play", "the window's Play plays the clip again") { field("state") == "playing" })
            check("$scheme: the window's Next track reaches the page's own handler", touchPipMenu(win, "Next track", "the page's nexttrack handler runs") { field("last") == "nexttrack" && field("track") != trackBefore })
            note("  after the actions: ${title()}; session ${describeSession()}")
        } else {
            dumpWindows("no app window in picture-in-picture")
        }
        val expand = traceFrames("pip-expand-$scheme", JankBudget.Kind.OPEN) {
            bringToFront()
            poll(8_000) { !inPip() }
            poll(8_000) { host.tabs.filling == null }
            SystemClock.sleep(SETTLE_MS)
        }
        note("  expanded: pip=${inPip()} filling=${host.tabs.filling} fullscreenTab=${host.fullscreenTab?.tabId} pip tab=${host.media.pictureInPictureTab}; page fs=${field("fs")} state=${field("state")}; ${describeTab(TAB)}")
        check("$scheme: the expand brings the page back inline in the chrome, the clip playing in its place", !inPip() && host.tabs.filling == null && host.fullscreenTab == null && field("fs") == "0" && field("state") == "playing")
        val chromeBack = chromeNode()
        note("  expanded, the chrome: ${describeChrome(chromeBack)}")
        check("$scheme: expanded, the chrome is a reader's again", chromeMode() == "auto" && chromeBack?.isImportantForAccessibility == true)
        note("  ruling 5: enter ${longTasks(enter)}; expand ${longTasks(expand)} (the tables in frames.txt)")
        shot("05-expanded-$scheme")
        beat()
    }

    // --- 2. the window on request and its X ------------------------------------------------------

    private fun requestedWindowAndItsX(scheme: String) {
        note("\n2 ($scheme). the window on request (media.pictureInPicture) and its X: the clip pauses, the app behind the launcher")
        frontApp()
        onTheClip()
        if (field("state") != "playing") tapPageButton("play", "Play video", "the clip plays inline", 15_000) { field("state") == "playing" }
        val enter = traceFrames("pip-request-$scheme", JankBudget.Kind.OPEN) {
            // The command fired and not waited for: the harness's reply poll would be chrome work of its own in the trace.
            chromeJs("window.zen.invoke('media.pictureInPicture',{tabId:${JSONObject.quote(TAB)}})")
            poll(10_000) { inPip() }
            poll(8_000) { host.tabs.filling == TAB }
            SystemClock.sleep(SETTLE_MS)
        }
        val win = appWindowBounds()
        note("  media.pictureInPicture: pip=${inPip()} bounds $win (${ratio(win)}) filling=${host.tabs.filling} pip tab=${host.media.pictureInPictureTab} state=${field("state")}")
        check("$scheme: media.pictureInPicture puts the inline clip into the window", inPip() && host.tabs.filling == TAB)
        shot("06-requested-window-$scheme")
        beat()
        val closed = if (win != null) {
            touchPipMenu(win, "Close", "the window closes and the clip pauses", timeoutMs = 10_000) { !inPip() && field("state") == "paused" }
        } else {
            dumpWindows("no app window in picture-in-picture")
            false
        }
        SystemClock.sleep(1_500)
        val front = ui.rootInActiveWindow?.packageName?.toString()
        note("  after the X: pip=${inPip()} state=${field("state")} pip tab=${host.media.pictureInPictureTab} filling=${host.tabs.filling} fullscreenTab=${host.fullscreenTab?.tabId}; in front: $front")
        check("$scheme: the X closes the window and pauses the clip (Chrome's onStop suspends the session)", closed)
        check("$scheme: the X leaves the app behind the launcher, not expanded", front != app.packageName && !inPip())
        shot("07-after-close-$scheme")
        note("  ruling 5: request ${longTasks(enter)}")
        bringToFront()
        awaitPip(false, 5_000)
        frontApp()
        SystemClock.sleep(1_000)
        note("  back in the app: pip=${inPip()} state=${field("state")} fs=${field("fs")} filling=${host.tabs.filling}; ${describeTab(TAB)}")
        check("$scheme: the tab the user comes back to is the page inline, the clip paused", !inPip() && host.tabs.filling == null && field("fs") == "0" && field("state") == "paused")
        shot("08-back-after-close-$scheme")
        beat()
    }

    // --- 3. the endings by the host's hand -------------------------------------------------------

    /** 3a. A new document in the window's tab: the window ends with its task (a navigation away, MED-06). */
    private fun newDocumentEndsIt() {
        note("\n3a. a navigation in the window's tab ends the window (MED-06; the host's ending, Chrome's moveTaskToBack)")
        val entered = intoTheWindow()
        val left = entered && run {
            coreInvoke("tab.navigate", """{"tabId":"$TAB","input":"${server.origin}/notify"}""")
            awaitPip(false, 10_000)
        }
        SystemClock.sleep(1_500)
        val front = ui.rootInActiveWindow?.packageName?.toString()
        note("  tab.navigate -> /notify: the window left=$left; pip tab=${host.media.pictureInPictureTab} filling=${host.tabs.filling}; in front: $front; ${describeTab(TAB)}")
        check("a new document in the window's tab ends the window", entered && left)
        check("the ended window's task goes to the back (Chrome's dismissal), the new page not left in the small window", front != app.packageName && host.media.pictureInPictureTab == null)
        shot("09-navigated-ends")
        bringToFront()
        frontApp()
        waitTitle(TAB, 15_000) { it.startsWith("NT|") }
        note("  back: pip=${inPip()} filling=${host.tabs.filling}; ${describeTab(TAB)}")
        check("back in the app the tab shows the new page inline", !inPip() && host.tabs.filling == null && title().startsWith("NT|"))
    }

    /** 3b. Another tab shown under the window: the window ends (Chrome's NEW_TAB). */
    private fun anotherTabEndsIt() {
        note("\n3b. another tab made active under the window ends it (Chrome's NEW_TAB)")
        frontApp()
        val other = createTab("${server.origin}/notify", active = false)
        note("  a second tab behind: ${other?.let(::describeTab) ?: "none (tab.create answered nothing)"}")
        val entered = intoTheWindow()
        val left = entered && other != null && run {
            coreInvoke("tab.activate", """{"tabId":"$other"}""")
            awaitPip(false, 10_000)
        }
        SystemClock.sleep(1_500)
        val front = ui.rootInActiveWindow?.packageName?.toString()
        note("  tab.activate $other: the window left=$left; pip tab=${host.media.pictureInPictureTab} filling=${host.tabs.filling}; in front: $front; clip state=${field("state")}")
        check("another tab made active under the window ends it, the task to the back", entered && left && front != app.packageName)
        shot("10-tab-change-ends")
        bringToFront()
        frontApp()
        note("  back: active=${activeCoreTab()?.optString("id")} pip=${inPip()} filling=${host.tabs.filling}")
        if (other != null) coreInvoke("tab.close", """{"tabId":"$other"}""")
        coreInvoke("tab.activate", """{"tabId":"$TAB"}""")
        SystemClock.sleep(1_000)
    }

    /** 3c. The window's tab closed: the window ends (Chrome's CLOSE). A second clip tab, so the demo tab stays. */
    private fun closingTheTabEndsIt() {
        note("\n3c. the window's tab closed ends it (Chrome's CLOSE)")
        frontApp()
        val clip = createTab("${server.origin}/video", active = true)
        if (clip == null) {
            check("a second clip tab opens for the close", false)
            return
        }
        waitTitle(clip, 20_000) { it.startsWith("MD|kind:video") }
        SystemClock.sleep(1_000)
        // A finger on its Play (the clip's play needs a gesture), then the window on request.
        val played = tapIn(clip, "play", "Play video", "the second tab's clip plays") { field("state", clip) == "playing" }
        val asked = if (played) coreInvoke("media.pictureInPicture", """{"tabId":"$clip"}""") else "not asked"
        val entered = played && awaitPip(true, 10_000)
        poll(5_000) { host.tabs.filling == clip }
        SystemClock.sleep(SETTLE_MS)
        note("  the second clip tab $clip in the window: $entered (media.pictureInPicture -> $asked); pip tab=${host.media.pictureInPictureTab} filling=${host.tabs.filling}")
        val left = entered && run {
            coreInvoke("tab.close", """{"tabId":"$clip"}""")
            awaitPip(false, 10_000)
        }
        SystemClock.sleep(1_500)
        val front = ui.rootInActiveWindow?.packageName?.toString()
        note("  tab.close $clip: the window left=$left; pip tab=${host.media.pictureInPictureTab} filling=${host.tabs.filling}; in front: $front; tabs ${coreState().getJSONObject("tabs").length()}")
        check("closing the window's tab ends the window, the task to the back", entered && left && front != app.packageName)
        shot("11-tab-close-ends")
        bringToFront()
        frontApp()
        coreInvoke("tab.activate", """{"tabId":"$TAB"}""")
        SystemClock.sleep(1_000)
        note("  back: active=${activeCoreTab()?.optString("id")} pip=${inPip()} filling=${host.tabs.filling}; ${describeTab(TAB)}")
        check("the demo tab is the one the user comes back to, inline", !inPip() && host.tabs.filling == null && activeCoreTab()?.optString("id") == TAB)
    }

    // --- 4. no fullscreen video, no window --------------------------------------------------------

    private fun noFullscreenVideoNoWindow() {
        note("\n4. Home without a fullscreen video does nothing new: a page without one, then the clip playing inline")
        frontApp()
        coreInvoke("tab.navigate", """{"tabId":"$TAB","input":"${server.origin}/notify"}""")
        waitTitle(TAB, 15_000) { it.startsWith("NT|") }
        SystemClock.sleep(1_000)
        ui.performGlobalAction(AccessibilityService.GLOBAL_ACTION_HOME)
        val windowed = awaitPip(true, 4_000)
        val front = ui.rootInActiveWindow?.packageName?.toString()
        note("  a page without a video, Home: pip=$windowed pip tab=${host.media.pictureInPictureTab} filling=${host.tabs.filling}; in front: $front")
        check("Home on a page without a video opens no window", !windowed && host.media.pictureInPictureTab == null && front != app.packageName)
        shot("12-no-video-home")
        bringToFront()
        frontApp()
        onTheClip()
        if (field("state") != "playing") tapPageButton("play", "Play video", "the clip plays inline", 15_000) { field("state") == "playing" }
        SystemClock.sleep(1_000)
        ui.performGlobalAction(AccessibilityService.GLOBAL_ACTION_HOME)
        val inlineWindowed = awaitPip(true, 4_000)
        note("  the clip playing inline (not fullscreen), Home: pip=$inlineWindowed pip tab=${host.media.pictureInPictureTab} state=${field("state")}; in front: ${ui.rootInActiveWindow?.packageName}")
        check("Home with the clip playing inline opens no window (Chrome's auto-enter is the fullscreen video's alone)", !inlineWindowed && host.media.pictureInPictureTab == null)
        shot("13-inline-home")
        bringToFront()
        frontApp()
        note("  back: pip=${inPip()} state=${field("state")} filling=${host.tabs.filling}; ${describeTab(TAB)}")
    }

    // --- helpers ----------------------------------------------------------------------------------

    private fun scheme(scheme: String) {
        shell("cmd uimode night ${if (scheme == "dark") "yes" else "no"}")
        coreInvoke("settings.update", """{"colorScheme":"$scheme"}""")
        // The theme blends over 240 ms (v2 §11.6); the launcher and SystemUI follow the night mode.
        SystemClock.sleep(2_500)
        ensureForeground()
        note("\n== the $scheme scheme (night mode ${if (scheme == "dark") "on" else "off"}) ==")
    }

    /** The demo tab on the clip's page (it navigates away in 3a and 4). */
    private fun onTheClip() {
        if (field("kind") == "video") return
        coreInvoke("tab.navigate", """{"tabId":"$TAB","input":"${server.origin}/video"}""")
        waitTitle(TAB, 20_000) { it.startsWith("MD|kind:video") }
        poll(10_000) { pageJs("document.getElementById('media').videoWidth") != "0" }
        SystemClock.sleep(1_000)
    }

    /** The clip playing inline and the window asked for it (`media.pictureInPicture`); whether the window came. */
    private fun intoTheWindow(): Boolean {
        frontApp()
        onTheClip()
        if (field("state") != "playing") tapPageButton("play", "Play video", "the clip plays inline", 15_000) { field("state") == "playing" }
        val asked = coreInvoke("media.pictureInPicture", """{"tabId":"$TAB"}""")
        val entered = awaitPip(true, 10_000)
        poll(5_000) { host.tabs.filling == TAB }
        SystemClock.sleep(SETTLE_MS)
        note("  media.pictureInPicture -> $asked; in the window: $entered (pip tab=${host.media.pictureInPictureTab} filling=${host.tabs.filling} state=${field("state")})")
        return entered
    }

    private fun createTab(url: String, active: Boolean): String? =
        JSONTokener(coreInvoke("tab.create", """{"url":"$url","active":$active}""")).nextValue() as? String

    /** A real finger on the page button `id` of `tabId` (the demo tab's helper reads [TAB] alone). */
    private fun tapIn(tabId: String, id: String, label: String, effect: String, took: () -> Boolean): Boolean {
        val point = pageElementRect(id, tabId)?.let { touchPoint(it) } ?: run {
            note("  no '$label' on $tabId to touch")
            return false
        }
        Finger().tap(point.x, point.y)
        if (poll(15_000, took)) {
            note("  finger on $tabId's '$label' at ${point.x.toInt()},${point.y.toInt()}: $effect")
            return true
        }
        touchFault("a touch on $tabId's '$label' did not take: not $effect (page: ${title(tabId)})")
        note("  TOUCH FAULT: $tabId's '$label' did not $effect (page: ${title(tabId)})")
        return false
    }

    /** Where `tabId`'s view is on screen, or null. */
    private fun tabViewOnScreen(tabId: String): Rect? {
        var rect: Rect? = null
        instrumentation.runOnMainSync {
            val view = host.tabs.get(tabId) ?: return@runOnMainSync
            val at = IntArray(2).also { view.getLocationOnScreen(it) }
            rect = Rect(at[0], at[1], at[0] + view.width, at[1] + view.height)
        }
        return rect
    }

    /** `tabId`'s view's place among its parent's children, `index/count` (the last is on top). */
    private fun tabViewZ(tabId: String): String {
        var z = "no view"
        instrumentation.runOnMainSync {
            val view = host.tabs.get(tabId) ?: return@runOnMainSync
            val parent = view.parent as? ViewGroup ?: return@runOnMainSync
            z = "${parent.indexOfChild(view) + 1}/${parent.childCount}"
        }
        return z
    }

    /**
     * The chrome WebView's node (`R.id.zen_chrome`) in the app's window, as the tree reports it
     * with the harness's flags on (every view included, ids reported). Its
     * `isImportantForAccessibility` is the framework's own word on whether a reader without the
     * not-important flag – TalkBack – is handed the view: `View.isImportantForAccessibility` is
     * false for a view in `NO_HIDE_DESCENDANTS` (and for everything under one), and a WebView
     * left out takes its whole document with it. The service's flags are not changed for the
     * read: UiAutomation's window list goes stale on a change, and the small window's menu is
     * read through that list (run 36157165808 lost the menu three taps running after one).
     */
    private fun chromeNode(): AccessibilityNodeInfo? = viewNode("zen_chrome")

    /**
     * The demo tab's page WebView node (the view's own, not the document's root under it, which
     * carries the same class name), found up from the page's own button (`Pause video` / `Play video`).
     */
    private fun pageNode(): AccessibilityNodeInfo? {
        var node = findInWindows(app.packageName) { it == "Pause video" || it == "Play video" }
        while (node != null && node.className?.toString() != WEB_VIEW) node = node.parent
        while (node?.parent?.className?.toString() == WEB_VIEW) node = node.parent
        return node
    }

    private fun viewNode(id: String): AccessibilityNodeInfo? {
        val root = ui.windows.firstNotNullOfOrNull { w -> w.root?.takeIf { it.packageName?.toString() == app.packageName } } ?: return null
        return root.findAccessibilityNodeInfosByViewId("${app.packageName}:id/$id").firstOrNull()
    }

    private fun describeChrome(node: AccessibilityNodeInfo?): String =
        "mode ${chromeMode()}; node ${if (node == null) "not found" else "important=${node.isImportantForAccessibility} visible=${node.isVisibleToUser} children=${node.childCount}"}"

    /** The chrome view's importance for accessibility as the host holds it ([Host.readChrome]). */
    private fun chromeMode(): String {
        var mode = "no chrome"
        instrumentation.runOnMainSync {
            val chrome = host.underlay ?: return@runOnMainSync
            mode = when (chrome.importantForAccessibility) {
                View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS -> "no-hide-descendants"
                View.IMPORTANT_FOR_ACCESSIBILITY_AUTO -> "auto"
                View.IMPORTANT_FOR_ACCESSIBILITY_YES -> "yes"
                View.IMPORTANT_FOR_ACCESSIBILITY_NO -> "no"
                else -> chrome.importantForAccessibility.toString()
            }
        }
        return mode
    }

    /** Whether `view` is the size of `win` (within a few px: the window's own rounding). */
    private fun covers(view: Rect?, win: Rect?): Boolean =
        view != null && win != null && abs(view.width() - win.width()) <= 8 && abs(view.height() - win.height()) <= 8

    /** Whether `win`'s ratio is the clip's (`size` as `WxH`), within the window's own rounding. */
    private fun ratioMatches(win: Rect?, size: String?): Boolean {
        if (win == null || win.height() <= 0 || size == null) return false
        val parts = size.split('x')
        val w = parts.getOrNull(0)?.toDoubleOrNull() ?: return false
        val h = parts.getOrNull(1)?.toDoubleOrNull() ?: return false
        if (w <= 0 || h <= 0) return false
        return abs(win.width().toDouble() / win.height() - w / h) < 0.05
    }

    /** Ruling 5's reading of a traced scene: the chrome WebView's renderer main thread across it. */
    private fun longTasks(scene: FrameStats.Scene): String {
        val t = scene.trace ?: return "no trace (${scene.traceMissing}); ${scene.summary?.frames ?: 0} frames in ${scene.durationMs} ms"
        return "%d long task(s) by thread time (%d by wall; the longest %.0f ms), main thread busy %.0f ms, layouts %d (%.0f ms), paints %d, style recalcs %d; %d frames in %d ms".format(
            t.longTasks, t.longTasksWall, t.longestTaskMs, t.busyMs, t.layoutCount, t.layoutMs, t.paintCount, t.styleRecalcCount, scene.summary?.frames ?: 0, scene.durationMs
        )
    }

    private fun check(what: String, ok: Boolean) {
        if (!ok) failures++
        note("  ${if (ok) "PASS" else "FAIL"}  $what")
    }

    companion object {
        /** The rest after a window's change of state before it is read: the system's animation and the chrome's relayout. */
        private const val SETTLE_MS = 2_500L
        private const val WEB_VIEW = "android.webkit.WebView"
    }
}
