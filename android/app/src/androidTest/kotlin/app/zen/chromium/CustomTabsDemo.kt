package app.zen.chromium

import android.app.ActivityManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Path
import android.graphics.PointF
import android.graphics.Rect
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.SystemClock
import android.util.Log
import android.view.View
import android.view.accessibility.AccessibilityNodeInfo
import android.view.accessibility.AccessibilityWindowInfo
import android.widget.RemoteViews
import android.widget.Toast
import androidx.browser.customtabs.CustomTabColorSchemeParams
import androidx.browser.customtabs.CustomTabsCallback
import androidx.browser.customtabs.CustomTabsClient
import androidx.browser.customtabs.CustomTabsIntent
import androidx.browser.customtabs.CustomTabsServiceConnection
import androidx.browser.customtabs.CustomTabsSession
import androidx.core.content.ContextCompat
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.runner.lifecycle.ActivityLifecycleMonitorRegistry
import androidx.test.runner.lifecycle.Stage
import org.json.JSONObject
import org.json.JSONTokener
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.util.Collections
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * Drives Zenium as a Custom Tabs provider so the `android-customtabs-demo` workflow can record it:
 * another app ("Nimbus News", [CustomTabCallerActivity] in the instrumentation APK, its own
 * package and process) opens a story in a custom tab whose intent this driver built the way a
 * real client does – `CustomTabsClient.bindCustomTabsService` against the debug application id,
 * `warmup`, `newSession` with a callback, `mayLaunchUrl`, then a `CustomTabsIntent` with the
 * session, a toolbar colour, the title, toolbar hiding, an action button, two menu items and exit
 * animations. The recording shows the tab arriving over the caller in the caller's colour, a link
 * followed and back stepping within the tab's history, the toolbar hiding on scroll, the menu,
 * one of the caller's items firing (its PendingIntent lands back in the "app" as a toast), Open
 * in Zenium landing in the browser window with the live page, a second, dark-scheme tab, and X
 * closing back to the caller with the caller's exit animation.
 *
 * Then the depth (CCT-07, CCT-11): a third tab with the caller's BOTTOM TOOLBAR – its own
 * `RemoteViews` (a layout of this APK's, inflated by the provider) with two buttons, one under a
 * real finger and its id back in the caller's `PendingIntent`; a swipe up on the bar reaching the
 * caller, which answers with `setSecondaryToolbarViews` (a taller bar, the secondary toolbar
 * revealed); the bars hiding together on scroll – and MINIMIZE: the toolbar's button under a
 * finger shrinking the tab into a picture-in-picture card, the caller's callback hearing
 * `onMinimized`, the platform's Expand bringing the tab back and `onUnminimized` following. A
 * fourth, dark tab does the same with `EXTRA_TOOLBAR_ITEMS` buttons instead of RemoteViews.
 *
 * The session callback's navigation events and the return to the caller are asserted, as are
 * the bottom toolbar's clicks and swipe reaching the caller, the secondary toolbar's update
 * taking, the picture-in-picture entry and exit and their callbacks; the screenshots
 * (`customtabs-*.png`) and the recording are the rest of the evidence.
 */
@RunWith(AndroidJUnit4::class)
class CustomTabsDemo : DemoHarness("customtabs-demo-state.json", "customtabs", "customtabs-demo") {
    override val tag = "CustomTabsDemo"

    private val callerPackage: String = instrumentation.context.packageName
    private var client: CustomTabsClient? = null
    private var session: CustomTabsSession? = null
    private val events: MutableList<String> = Collections.synchronizedList(ArrayList())
    /** What the caller's bottom toolbar intents carried back: `BOTTOM:<id>`, `ITEM:<id>`, `SWIPE_UP`. */
    private val callerHits: MutableList<String> = Collections.synchronizedList(ArrayList())
    /** `setSecondaryToolbarViews`' answer after the swipe up, null until the caller has sent it. */
    @Volatile private var secondaryApplied: Boolean? = null
    private var receiver: BroadcastReceiver? = null

    @Test
    fun record() = runDemo()

    override fun warmUp() {
        connect()
        listenForCallerActions()
        showCaller(customTabIntent(dark = false))
    }

    override fun demo() {
        // 1. The other app.
        shot("01-caller")
        beat()

        // 2. Its button opens the story as a custom tab: the caller's blue toolbar, title over host,
        //    lock, the action button and the menu button, sliding up over the caller.
        openCustomTab()
        shot("02-toolbar-light")
        beat()

        // 3. A link followed inside the tab: the toolbar follows the page (host, title, lock).
        val page = customTab()?.page
        if (page != null) {
            plantLink(page)?.let { p ->
                Finger().tap(p.x, p.y)
                waitForPage("example.com")
                SystemClock.sleep(1_500)
                shot("03-navigated")
                beat()
            }
        } else {
            Log.w(tag, "no custom tab page to plant a link in")
        }

        // 4. Back steps within the tab's history, not out of the tab.
        back()
        waitForPage("wikipedia.org")
        SystemClock.sleep(2_000)
        shot("04-back-in-history")
        assertTrue("back stayed within the custom tab", waitForWindow(app.packageName, 3_000) && findByLabel(CLOSE_LABEL) != null)
        beat()

        // 5. EXTRA_ENABLE_URLBAR_HIDING: the toolbar leaves as the page scrolls down and returns
        //    as it scrolls up.
        scroll(-0.45f)
        SystemClock.sleep(1_500)
        shot("05-toolbar-hidden")
        scroll(0.45f)
        SystemClock.sleep(1_500)

        // 6. The menu: the caller's items, Zenium's page actions, Open in Zenium.
        openMenu()
        shot("06-menu-light")
        beat()

        // 7. One of the caller's items: its PendingIntent fires with the page's URL (the toast is
        //    the caller's receiver answering).
        if (clickByLabel(SAVE_LABEL)) {
            SystemClock.sleep(1_800)
            shot("07-caller-item")
        } else {
            Log.w(tag, "no $SAVE_LABEL in the menu")
            dismissSheet()
        }
        beat()

        // 7b. Find in page: the bar takes the toolbar's row and counts matches as the query goes in.
        openMenu()
        findInPage("07b-find-light")

        // 8. Open in Zenium: the live page moves into the browser window.
        openMenu()
        // A finger on the row (the menu sheet's injected touch, the rule in DemoHarness): the
        // browser's own window, with its address pill, must come up on it (the custom tab shares
        // the package, so the window in front does not tell). The other rows go through the tree.
        if (touchTapLabelExpecting(OPEN_IN_ZENIUM_LABEL, "the browser's window with its address pill is up", timeoutMs = 12_000) {
                findByLabelPrefix(PILL_LABEL) != null
            }
        ) {
            SystemClock.sleep(6_000)
            shot("08-open-in-zenium")
            Log.i(tag, "browser window shows ${findByLabelPrefix(PILL_LABEL)}")
        } else {
            Log.w(tag, "$OPEN_IN_ZENIUM_LABEL did not hand the page over under a finger")
            dismissSheet()
        }
        beat()

        // 9. A second tab from the caller, in the dark scheme with Zenium's own toolbar colour.
        showCaller(customTabIntent(dark = true))
        openCustomTab()
        shot("09-toolbar-dark")
        beat()
        openMenu()
        shot("10-menu-dark")
        beat()
        findInPage("10b-find-dark")

        // 10. X closes the tab, with the caller's exit animation, back into the caller.
        clickByLabel(CLOSE_LABEL)
        val returned = waitForWindow(callerPackage, 8_000)
        SystemClock.sleep(1_500)
        shot("11-closed-to-caller")

        Log.i(tag, "session events: $events")
        assertTrue("the session callback heard the tab show (TAB_SHOWN)", events.contains("TAB_SHOWN"))
        assertTrue("the session callback heard a navigation start", events.contains("NAVIGATION_STARTED"))
        assertTrue("the session callback heard the tab hide (TAB_HIDDEN)", events.contains("TAB_HIDDEN"))
        assertTrue("closing the custom tab returned to the caller", returned)

        // --- the depth: the caller's bottom toolbar and Minimize (CCT-07, CCT-11) ---------------

        // 12. A third tab, light, with the caller's RemoteViews along the bottom: two buttons on
        //     the bar in the secondary toolbar colour, the page's viewport ending above it.
        showCaller(customTabIntent(dark = false, depth = true))
        openCustomTab()
        assertTrue("the caller's bottom toolbar is up with its buttons", waitFor(BOTTOM_SHARE_LABEL, 8_000) != null)
        val restingBar = barRect()
        Log.i(tag, "bottom toolbar (RemoteViews) at $restingBar, page ends at ${pageBottom()}")
        assertTrue("the page's viewport ends above the bottom toolbar", pageEndsAboveBar())
        shot("12-bottom-toolbar-light")
        beat()

        // 13. One of its buttons under a real finger: the caller's PendingIntent fires with the
        //     clicked id and the page's URL (the toast is the caller's receiver answering).
        callerHits.clear()
        assertTrue("the bottom toolbar's Share story took a finger", touchTapLabel(BOTTOM_SHARE_LABEL))
        assertTrue(
            "the caller heard the click with the clicked id (EXTRA_REMOTEVIEWS_CLICKED_ID)",
            awaitTrue(6_000) { callerHits.contains("BOTTOM:${demoId("cct_demo_share")}") }
        )
        SystemClock.sleep(1_200)
        shot("13-bottom-toolbar-tapped-light")
        beat()

        // 14. A swipe up on the bar: the caller's swipe-up PendingIntent fires; the caller answers
        //     with setSecondaryToolbarViews (through updateVisuals) and the taller bar slides in.
        swipeUpAndReveal("14-secondary-toolbar-light")

        // 15. The bars hide together as the page scrolls down (§11.5: the bottom toolbar slides
        //     off past the navigation bar with the top toolbar, the page taking its strip), and
        //     return together as it scrolls up.
        if (customTab() != null) {
            scroll(-0.45f)
            assertTrue("the bottom toolbar slid away with the top toolbar on the scroll down", awaitTrue(4_000) { barTranslation() > 0f })
            SystemClock.sleep(1_200)
            Log.i(tag, "after the scroll down: bar translation ${barTranslation()}, page ends at ${pageBottom()}")
            shot("15-bars-hidden-light")
            scroll(0.45f)
            assertTrue("the bottom toolbar came back with the top toolbar on the scroll up", awaitTrue(4_000) { barTranslation() == 0f })
            SystemClock.sleep(1_200)
            assertTrue("the page's viewport ends above the returned bar", awaitTrue(3_000) { pageEndsAboveBar() })
        }

        // 16. Minimize under a finger: the tab into its floating card; the caller hears onMinimized.
        minimizeAndRestore("16-minimized-light", "17-restored-light")

        // 17. Close back to the caller.
        clickByLabel(CLOSE_LABEL)
        assertTrue("closing the third custom tab returned to the caller", waitForWindow(callerPackage, 8_000))
        SystemClock.sleep(1_500)

        // 18. The dark tab: EXTRA_TOOLBAR_ITEMS buttons (icons, equally weighted) instead of
        //     RemoteViews, on Zenium's dark toolbar colour.
        showCaller(customTabIntent(dark = true, depth = true))
        openCustomTab()
        assertTrue("the dark tab's bottom toolbar is up with its buttons", waitFor(ITEM_COMMENTS_LABEL, 8_000) != null)
        assertTrue("the dark page's viewport ends above the bottom toolbar", pageEndsAboveBar())
        shot("18-bottom-toolbar-dark")
        beat()
        callerHits.clear()
        assertTrue("the dark bar's Comments button took a finger", touchTapLabel(ITEM_COMMENTS_LABEL))
        assertTrue("the caller heard the toolbar item's intent", awaitTrue(6_000) { callerHits.contains("ITEM:$ITEM_COMMENTS_ID") })
        SystemClock.sleep(1_200)
        swipeUpAndReveal("19-secondary-toolbar-dark")
        minimizeAndRestore("20-minimized-dark", "21-restored-dark")
        clickByLabel(CLOSE_LABEL)
        assertTrue("closing the dark custom tab returned to the caller", waitForWindow(callerPackage, 8_000))
        SystemClock.sleep(1_200)
        shot("22-closed-to-caller")
        Log.i(tag, "caller hits: $callerHits; session events: $events")
    }

    // --- the depth's moves -----------------------------------------------------------------------

    /**
     * A real upward drag on the bottom toolbar: the swipe reaches the caller (its receiver here
     * answers with the taller secondary views); the bar's height grows and the page's viewport
     * follows. Asserted; a still of the revealed bar.
     */
    private fun swipeUpAndReveal(name: String) {
        val bar = barRect() ?: run {
            Log.w(tag, "no bottom toolbar to swipe")
            return
        }
        val before = barHeight()
        callerHits.clear()
        secondaryApplied = null
        val f = Finger()
        f.down(bar.exactCenterX(), bar.top + bar.height() * 0.6f)
        f.moveBy(0f, -140 * density, 320)
        f.hold(120)
        f.up()
        assertTrue("the swipe up reached the caller", awaitTrue(6_000) { callerHits.contains("SWIPE_UP") })
        assertTrue("setSecondaryToolbarViews took (updateVisuals answered true)", awaitTrue(6_000) { secondaryApplied == true })
        assertTrue("the secondary toolbar grew the bar", awaitTrue(6_000) { barHeight() > before })
        SystemClock.sleep(1_200)
        Log.i(tag, "secondary toolbar: bar $before -> ${barHeight()} px, page ends at ${pageBottom()}, bar at ${barRect()}")
        assertTrue("the page's viewport ends above the taller bar", pageEndsAboveBar())
        shot(name)
        beat()
    }

    /**
     * Minimize under a finger: the tab into picture-in-picture (the card with its title and
     * favicon), the caller's callback hearing onMinimized; then the platform's own restore (the
     * Expand control of the floating window's menu), the tab back at full size and onUnminimized.
     */
    private fun minimizeAndRestore(minimizedShot: String, restoredShot: String) {
        events.remove("MINIMIZED")
        events.remove("UNMINIMIZED")
        assertTrue("Minimize took a finger", touchTapLabel(MINIMIZE_LABEL))
        assertTrue("the custom tab entered picture-in-picture (isInPictureInPictureMode)", awaitTrue(8_000) { minimized() })
        assertTrue("the caller's callback heard onMinimized", awaitTrue(4_000) { events.contains("MINIMIZED") })
        SystemClock.sleep(2_000)
        Log.i(tag, "minimized: pip window at ${pipWindow()}")
        shot(minimizedShot)
        beat()
        assertTrue("the tab came back from its card", restoreFromPip())
        assertTrue("the caller's callback heard onUnminimized", awaitTrue(4_000) { events.contains("UNMINIMIZED") })
        SystemClock.sleep(1_500)
        assertTrue("the restored tab's toolbar is up", waitFor(CLOSE_LABEL, 5_000) != null)
        shot(restoredShot)
        beat()
    }

    /**
     * The platform's way out of picture-in-picture, the one a user has (the activity's own views
     * get no touches in the small window): a tap on the floating window brings SystemUI's menu,
     * whose Expand control returns the tab. Failing that (a system UI without the control), the
     * tab's own task – the app's, so `AppTask.moveToFront` is allowed it – is brought forward,
     * which the system answers by expanding the window.
     */
    private fun restoreFromPip(): Boolean {
        val pip = pipWindow()
        if (pip == null) {
            Log.w(tag, "no picture-in-picture window among ${ui.windows.size} windows")
        } else {
            val expand = openPipMenu(pip, PIP_EXPAND_LABEL)
            if (expand != null) {
                Log.i(tag, "restoring through the PiP menu's ${describeNode(expand)}")
                if (!touchTap(expand)) expand.performAction(AccessibilityNodeInfo.ACTION_CLICK)
                if (awaitTrue(6_000) { !minimized() }) return true
                Log.w(tag, "'$PIP_EXPAND_LABEL' did not bring the tab back")
            } else {
                Log.w(tag, "the PiP menu never showed '$PIP_EXPAND_LABEL'")
            }
        }
        Log.w(tag, "still minimized; bringing the tab's own task forward")
        val tab = customTab(Stage.PAUSED, Stage.RESUMED) ?: return false
        val taskId = tab.taskId
        val manager = app.getSystemService(ActivityManager::class.java)
        val task = manager.appTasks.firstOrNull { it.taskInfo.taskId == taskId }
        if (task == null) {
            Log.w(tag, "the tab's task $taskId is not among the app's ${manager.appTasks.size} tasks")
            return false
        }
        runCatching { task.moveToFront() }.onFailure { Log.w(tag, "moveToFront failed: $it") }
        return awaitTrue(8_000) { !minimized() }
    }

    /**
     * The small window's menu (SystemUI's, over the window) under a tap, and the node reading
     * `label` in it: the menu hides itself a few seconds after it shows, so the look is at
     * SystemUI's windows alone, every 100 ms, and the tap is tried twice (the media demos' rule).
     */
    private fun openPipMenu(win: Rect, label: String): AccessibilityNodeInfo? {
        for (attempt in 1..2) {
            Finger().tap(win.exactCenterX(), win.exactCenterY())
            val deadline = SystemClock.uptimeMillis() + 3_000
            while (SystemClock.uptimeMillis() < deadline) {
                findInWindows(SYSTEM_UI) { it == label }?.let { return it }
                SystemClock.sleep(100)
            }
            if (attempt == 1) {
                Log.w(tag, "pip menu after tap $attempt showed no '$label'; windows: ${windowLabels()}")
                SystemClock.sleep(4_000)
            }
        }
        return null
    }

    /** What the windows on screen say (a few labels each), for the log when a look fails. */
    private fun windowLabels(): String = ui.windows.mapNotNull { window ->
        val root = window.root ?: return@mapNotNull null
        val labels = ArrayList<String>()
        val queue = ArrayDeque<AccessibilityNodeInfo>()
        queue.add(root)
        var visited = 0
        while (queue.isNotEmpty() && visited < 400 && labels.size < 12) {
            val node = queue.removeFirst()
            visited++
            val text = (node.contentDescription ?: node.text)?.toString()?.trim()
            if (!text.isNullOrEmpty()) labels += text.take(40)
            for (i in 0 until node.childCount) node.getChild(i)?.let(queue::add)
        }
        "${root.packageName}${if (window.isInPictureInPictureMode) " (pip)" else ""}=$labels"
    }.joinToString("; ")

    /** The custom tab is in picture-in-picture (its own flag and the platform's, read on the main thread). */
    private fun minimized(): Boolean {
        var result = false
        instrumentation.runOnMainSync {
            val tab = customTabOnMain(Stage.RESUMED, Stage.PAUSED)
            result = tab != null && tab.isMinimized && tab.isInPictureInPictureMode
        }
        return result
    }

    /** The floating picture-in-picture window's bounds, if one is up. */
    private fun pipWindow(): Rect? {
        for (window in ui.windows) {
            if (window.type != AccessibilityWindowInfo.TYPE_APPLICATION || !window.isInPictureInPictureMode) continue
            return Rect().also { window.getBoundsInScreen(it) }
        }
        return null
    }

    /** The bottom toolbar's own row on screen (without the navigation bar it pads under), when shown. */
    private fun barRect(): Rect? {
        val bar = customTab()?.bottomBar ?: return null
        var rect: Rect? = null
        instrumentation.runOnMainSync {
            if (bar.visibility != View.VISIBLE || bar.width == 0) return@runOnMainSync
            val origin = IntArray(2)
            bar.getLocationOnScreen(origin)
            rect = Rect(origin[0], origin[1], origin[0] + bar.width, origin[1] + bar.barHeight)
        }
        return rect
    }

    private fun barHeight(): Int {
        val bar = customTab()?.bottomBar ?: return 0
        var h = 0
        instrumentation.runOnMainSync { h = bar.barHeight }
        return h
    }

    /** How far the bar stands from its place (positive: slid down, hidden with the top toolbar). */
    private fun barTranslation(): Float {
        val bar = customTab()?.bottomBar ?: return 0f
        var t = 0f
        instrumentation.runOnMainSync { t = bar.translationY }
        return t
    }

    /** Where the page's view ends on screen. */
    private fun pageBottom(): Int {
        val page = customTab()?.page ?: return -1
        var bottom = -1
        instrumentation.runOnMainSync {
            val origin = IntArray(2)
            page.getLocationOnScreen(origin)
            bottom = origin[1] + page.height
        }
        return bottom
    }

    /** The viewport rule: the page ends at (or above) the bar's top edge, never under it. */
    private fun pageEndsAboveBar(): Boolean {
        val bar = barRect() ?: return false
        val bottom = pageBottom()
        return bottom in 1..bar.top
    }

    /** An id of the caller's RemoteViews layout (this APK's resources). */
    private fun demoId(name: String): Int = instrumentation.context.resources.getIdentifier(name, "id", callerPackage)

    /** The name behind a clicked id, for the caller's toast. */
    private fun demoIdName(id: Int): String = when (id) {
        demoId("cct_demo_share") -> BOTTOM_SHARE_LABEL
        demoId("cct_demo_comments") -> "Comments"
        demoId("cct_demo_related") -> "Up next"
        else -> "view $id"
    }

    /** The caller's RemoteViews: its bottom toolbar, or the taller secondary toolbar. */
    private fun callerViews(secondary: Boolean): RemoteViews {
        val layout = instrumentation.context.resources.getIdentifier(
            if (secondary) "cct_demo_secondary_bar" else "cct_demo_bottom_bar", "layout", callerPackage
        )
        check(layout != 0) { "the demo's bottom toolbar layout is missing from the instrumentation APK" }
        return RemoteViews(callerPackage, layout)
    }

    private fun clickableIds(): IntArray = intArrayOf(demoId("cct_demo_share"), demoId("cct_demo_comments"), demoId("cct_demo_related"))

    // --- the client side -------------------------------------------------------------------------

    /** Bind the provider service as a client app does, and prepare a session with a callback. */
    private fun connect() {
        val latch = CountDownLatch(1)
        val bound = CustomTabsClient.bindCustomTabsService(app, app.packageName, object : CustomTabsServiceConnection() {
            override fun onCustomTabsServiceConnected(name: ComponentName, connected: CustomTabsClient) {
                client = connected
                latch.countDown()
            }

            override fun onServiceDisconnected(name: ComponentName?) {
                client = null
            }
        })
        assertTrue("bindCustomTabsService(${app.packageName})", bound)
        assertTrue("the Custom Tabs service connected", latch.await(15, TimeUnit.SECONDS))
        val c = client ?: error("no client after connecting")
        Log.i(tag, "warmup: ${c.warmup(0)}")
        val s = c.newSession(object : CustomTabsCallback() {
            override fun onNavigationEvent(navigationEvent: Int, extras: Bundle?) {
                val name = when (navigationEvent) {
                    NAVIGATION_STARTED -> "NAVIGATION_STARTED"
                    NAVIGATION_FINISHED -> "NAVIGATION_FINISHED"
                    NAVIGATION_FAILED -> "NAVIGATION_FAILED"
                    NAVIGATION_ABORTED -> "NAVIGATION_ABORTED"
                    TAB_SHOWN -> "TAB_SHOWN"
                    TAB_HIDDEN -> "TAB_HIDDEN"
                    else -> "event $navigationEvent"
                }
                events.add(name)
                Log.i(tag, "session: $name")
            }

            // The androidx.browser minimization contract: the session hears the tab shrink
            // into its card and come back (CustomTabsCallback.onMinimized / onUnminimized).
            override fun onMinimized(extras: Bundle) {
                events.add("MINIMIZED")
                Log.i(tag, "session: onMinimized")
            }

            override fun onUnminimized(extras: Bundle) {
                events.add("UNMINIMIZED")
                Log.i(tag, "session: onUnminimized")
            }
        }) ?: error("newSession returned null")
        session = s
        Log.i(tag, "mayLaunchUrl: ${s.mayLaunchUrl(Uri.parse(STORY_URL), null, null)}")
    }

    /**
     * The caller's side of its action button, menu items and bottom toolbar: the PendingIntents
     * are broadcasts, received here (the driver stands in for the app) and shown as a toast
     * naming the page. A bottom toolbar click arrives with the clicked view's id
     * (`EXTRA_REMOTEVIEWS_CLICKED_ID`), a toolbar item with the id the caller put in its own
     * intent, and the swipe up is what a real client answers with `setSecondaryToolbarViews`:
     * the taller secondary toolbar, sent through the session (off the main thread, as a client
     * in its own process would reach the provider's `updateVisuals`), its answer kept for the
     * assertion.
     */
    private fun listenForCallerActions() {
        val r = object : BroadcastReceiver() {
            override fun onReceive(context: Context, intent: Intent) {
                val where = intent.data?.host ?: "no URL"
                val what = when (intent.action) {
                    ACTION_OPEN_IN_APP -> "Opened in the app"
                    ACTION_BOTTOM -> {
                        val id = intent.getIntExtra(CustomTabsIntent.EXTRA_REMOTEVIEWS_CLICKED_ID, -1)
                        callerHits.add("BOTTOM:$id")
                        "Bottom toolbar · ${demoIdName(id)}"
                    }
                    ACTION_ITEM -> {
                        val id = intent.getIntExtra(EXTRA_ITEM, -1)
                        callerHits.add("ITEM:$id")
                        "Toolbar item $id"
                    }
                    ACTION_SWIPE_UP -> {
                        callerHits.add("SWIPE_UP")
                        answerSwipeUp()
                        "Swipe up · more coming"
                    }
                    else -> "Saved for later"
                }
                Log.i(tag, "caller received ${intent.action} for ${intent.dataString} ($what)")
                Toast.makeText(context, "Nimbus News · $what · $where", Toast.LENGTH_LONG).show()
            }
        }
        val filter = IntentFilter().apply {
            addAction(ACTION_SAVE)
            addAction(ACTION_OPEN_IN_APP)
            addAction(ACTION_BOTTOM)
            addAction(ACTION_ITEM)
            addAction(ACTION_SWIPE_UP)
            addDataScheme("http")
            addDataScheme("https")
        }
        ContextCompat.registerReceiver(app, r, filter, ContextCompat.RECEIVER_NOT_EXPORTED)
        receiver = r
    }

    /** The caller's answer to the swipe up: the secondary toolbar's views into the live tab. */
    private fun answerSwipeUp() {
        val s = session ?: return
        Thread {
            val applied = runCatching { s.setSecondaryToolbarViews(callerViews(secondary = true), clickableIds(), callerAction(ACTION_BOTTOM, 3)) }
                .onFailure { Log.w(tag, "setSecondaryToolbarViews failed: $it") }
                .getOrDefault(false)
            Log.i(tag, "setSecondaryToolbarViews (the secondary toolbar) -> $applied")
            secondaryApplied = applied
        }.start()
    }

    /**
     * A mutable broadcast PendingIntent, so the provider can fill the page's URL in as data;
     * `itemId` (a toolbar item's) rides in the caller's own extra, as a client tells its buttons
     * apart.
     */
    private fun callerAction(action: String, requestCode: Int, itemId: Int = -1): PendingIntent {
        val flags = PendingIntent.FLAG_UPDATE_CURRENT or
            (if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) PendingIntent.FLAG_MUTABLE else 0)
        val intent = Intent(action).setPackage(app.packageName)
        if (itemId >= 0) intent.putExtra(EXTRA_ITEM, itemId)
        return PendingIntent.getBroadcast(app, requestCode, intent, flags)
    }

    /**
     * What a client builds: light scheme with its brand colour on the toolbar (and a dark-scheme
     * variant of it in EXTRA_COLOR_SCHEME_PARAMS), or the dark scheme with only the bar under
     * the page named, leaving the toolbar to Zenium.
     *
     * With `depth`, the caller's bottom toolbar too (CCT-07): the light tab carries its
     * `RemoteViews` (`setSecondaryToolbarViews`: this APK's layout, the clickable ids, one
     * PendingIntent that hears them all with the clicked id), the dark tab two custom toolbar
     * items instead (`addToolbarItem`: an icon, a description and an intent each, ids other than
     * the top bar's), and both the swipe-up gesture's intent (`setSecondaryToolbarSwipeUpGesture`).
     */
    private fun customTabIntent(dark: Boolean, depth: Boolean = false): Intent {
        val s = session ?: error("no session")
        val save = callerAction(ACTION_SAVE, 1)
        val builder = CustomTabsIntent.Builder(s)
            .setShowTitle(true)
            .setUrlBarHidingEnabled(true)
            .setShareState(CustomTabsIntent.SHARE_STATE_ON)
            .setActionButton(bookmarkIcon(), SAVE_LABEL, save, true)
            .addMenuItem(SAVE_LABEL, save)
            .addMenuItem("Open in Nimbus News", callerAction(ACTION_OPEN_IN_APP, 2))
            .setExitAnimations(app, android.R.anim.fade_in, android.R.anim.slide_out_right)
        if (depth) {
            if (dark) {
                @Suppress("DEPRECATION")
                builder.addToolbarItem(ITEM_SHARE_ID, shareIcon(), BOTTOM_SHARE_LABEL, callerAction(ACTION_ITEM, 10 + ITEM_SHARE_ID, ITEM_SHARE_ID))
                @Suppress("DEPRECATION")
                builder.addToolbarItem(ITEM_COMMENTS_ID, commentsIcon(), ITEM_COMMENTS_LABEL, callerAction(ACTION_ITEM, 10 + ITEM_COMMENTS_ID, ITEM_COMMENTS_ID))
            } else {
                builder.setSecondaryToolbarViews(callerViews(secondary = false), clickableIds(), callerAction(ACTION_BOTTOM, 3))
            }
            builder.setSecondaryToolbarSwipeUpGesture(callerAction(ACTION_SWIPE_UP, 4))
        }
        if (dark) {
            builder.setColorScheme(CustomTabsIntent.COLOR_SCHEME_DARK)
                .setColorSchemeParams(
                    CustomTabsIntent.COLOR_SCHEME_DARK,
                    CustomTabColorSchemeParams.Builder().setNavigationBarColor(0xFF131313.toInt()).build()
                )
        } else {
            builder.setColorScheme(CustomTabsIntent.COLOR_SCHEME_LIGHT)
                .setDefaultColorSchemeParams(CustomTabColorSchemeParams.Builder().setToolbarColor(BRAND).build())
                .setColorSchemeParams(
                    CustomTabsIntent.COLOR_SCHEME_DARK,
                    CustomTabColorSchemeParams.Builder().setToolbarColor(BRAND_DARK).build()
                )
        }
        val intent = builder.build().intent
        intent.data = Uri.parse(STORY_URL)
        // Clients aim the intent at the provider they bound (CustomTabsClient.getPackageName).
        intent.setPackage(app.packageName)
        return intent
    }

    /** A 24 dp bookmark glyph, white so the provider's tint applies (`setActionButton(…, tint = true)`). */
    private fun bookmarkIcon(): Bitmap = glyph { u ->
        moveTo(6 * u, 3 * u)
        lineTo(18 * u, 3 * u)
        lineTo(18 * u, 21 * u)
        lineTo(12 * u, 17 * u)
        lineTo(6 * u, 21 * u)
        close()
    }

    /** A 24 dp share glyph (a tray with an arrow up out of it) for the dark tab's bottom toolbar item. */
    private fun shareIcon(): Bitmap = glyph { u ->
        moveTo(4 * u, 12 * u)
        lineTo(4 * u, 20 * u)
        lineTo(20 * u, 20 * u)
        lineTo(20 * u, 12 * u)
        moveTo(12 * u, 15 * u)
        lineTo(12 * u, 3 * u)
        moveTo(8 * u, 7 * u)
        lineTo(12 * u, 3 * u)
        lineTo(16 * u, 7 * u)
    }

    /** A 24 dp speech-bubble glyph for the dark tab's Comments item. */
    private fun commentsIcon(): Bitmap = glyph { u ->
        moveTo(21 * u, 15 * u)
        lineTo(21 * u, 4 * u)
        lineTo(3 * u, 4 * u)
        lineTo(3 * u, 21 * u)
        lineTo(7 * u, 17 * u)
        lineTo(19 * u, 17 * u)
        lineTo(21 * u, 15 * u)
    }

    /** A white 24 dp stroke glyph on a transparent square, the provider tinting it to its ink. */
    private fun glyph(draw: Path.(Float) -> Unit): Bitmap {
        val size = (24 * density).toInt()
        val bitmap = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(bitmap)
        val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            color = Color.WHITE
            style = Paint.Style.STROKE
            strokeWidth = 2 * density
            strokeJoin = Paint.Join.ROUND
            strokeCap = Paint.Cap.ROUND
        }
        val path = Path().apply { draw(size / 24f) }
        canvas.drawPath(path, paint)
        return bitmap
    }

    // --- the caller ------------------------------------------------------------------------------

    /** Bring Nimbus News up (or forward) holding `launch` for its button. */
    private fun showCaller(launch: Intent) {
        val intent = Intent()
            .setClassName(callerPackage, CALLER_ACTIVITY)
            .putExtra(CustomTabCallerActivity.EXTRA_LAUNCH, launch)
            .putExtra(CustomTabCallerActivity.EXTRA_BROWSER, app.packageName)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        app.startActivity(intent)
        assertTrue("the caller app came up", waitForWindow(callerPackage, 15_000))
        SystemClock.sleep(2_000)
    }

    /** Press the caller's button and wait for the custom tab and its page. */
    private fun openCustomTab() {
        assertTrue("the caller's button is on screen", clickByLabel(READ_LABEL))
        assertTrue("the custom tab came up", waitForWindow(app.packageName, 15_000))
        assertTrue("the custom tab's toolbar is up", waitFor(CLOSE_LABEL, 10_000) != null)
        waitForPage("wikipedia.org")
        SystemClock.sleep(2_500)
    }

    // --- moves -----------------------------------------------------------------------------------

    private fun openMenu() {
        ensureForeground()
        assertTrue("the menu button is on screen", clickByLabel(MENU_LABEL))
        waitFor(OPEN_IN_ZENIUM_LABEL, 5_000)
        SystemClock.sleep(1_500)
    }

    private fun dismissSheet() {
        if (findByLabel(OPEN_IN_ZENIUM_LABEL) != null) {
            back()
            SystemClock.sleep(1_200)
        }
    }

    /**
     * From the open menu: Find in Page, a query into the bar's field (set through the focused
     * node, the way an IME would; keys if there is none), a shot of the counted matches, then
     * the bar's own close.
     */
    private fun findInPage(name: String) {
        if (!clickByLabel(FIND_LABEL)) {
            Log.w(tag, "no $FIND_LABEL in the menu")
            dismissSheet()
            return
        }
        assertTrue("the find bar came up", waitFor(FIND_CLOSE_LABEL, 5_000) != null)
        SystemClock.sleep(800)
        val field = ui.rootInActiveWindow?.findFocus(AccessibilityNodeInfo.FOCUS_INPUT)
        val typed = field?.performAction(
            AccessibilityNodeInfo.ACTION_SET_TEXT,
            Bundle().apply { putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, FIND_QUERY) }
        ) ?: false
        if (!typed) instrumentation.sendStringSync(FIND_QUERY)
        SystemClock.sleep(1_800)
        shot(name)
        beat()
        clickByLabel(FIND_CLOSE_LABEL)
        SystemClock.sleep(1_000)
    }

    /** Drag the page by `fraction` of the window height (negative: content moves up). */
    private fun scroll(fraction: Float) {
        val f = Finger()
        val startY = if (fraction < 0) height * 0.75f else height * 0.35f
        f.down(width / 2f, startY)
        f.moveBy(0f, fraction * height, 350)
        f.hold(100)
        f.up()
    }

    private fun topPackage(): String? = ui.rootInActiveWindow?.packageName?.toString()

    private fun waitForWindow(packageName: String, timeoutMs: Long): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            if (topPackage() == packageName) return true
            SystemClock.sleep(200)
        }
        Log.w(tag, "window of $packageName never came up; top is ${topPackage()}")
        return false
    }

    // --- the page --------------------------------------------------------------------------------

    /** The custom tab that is resumed, if one is (the driver shares Zenium's process). */
    private fun customTab(): CustomTabActivity? = customTab(Stage.RESUMED)

    /** The first custom tab in any of `stages`, tried in that order (paused is where picture-in-picture keeps it). */
    private fun customTab(vararg stages: Stage): CustomTabActivity? {
        var found: CustomTabActivity? = null
        instrumentation.runOnMainSync { found = customTabOnMain(*stages) }
        return found
    }

    /** [customTab] for code already on the main thread (`runOnMainSync` does not nest). */
    private fun customTabOnMain(vararg stages: Stage): CustomTabActivity? {
        val registry = ActivityLifecycleMonitorRegistry.getInstance()
        for (stage in stages) {
            registry.getActivitiesInStage(stage).filterIsInstance<CustomTabActivity>().firstOrNull()?.let { return it }
        }
        return null
    }

    /**
     * Wait until the custom tab's page is on a host ending in `host` (Wikipedia sends phones to
     * `en.m.wikipedia.org`) and has finished loading.
     */
    private fun waitForPage(host: String) {
        val deadline = SystemClock.uptimeMillis() + 20_000
        while (SystemClock.uptimeMillis() < deadline) {
            val page = customTab()?.page
            val state = if (page != null) evalJs(page, PAGE_STATE_JS) else null
            if (state != null && state.endsWith(":complete") && state.substringBefore(':').endsWith(host)) return
            SystemClock.sleep(500)
        }
        Log.w(tag, "the page never reported $host complete")
    }

    /** Add a big link to example.com over the page and return where it is on screen. */
    private fun plantLink(page: TabWebView): PointF? {
        val text = evalJs(page, PLANT_LINK_JS) ?: run {
            Log.w(tag, "planting the link returned nothing")
            return null
        }
        val origin = IntArray(2)
        instrumentation.runOnMainSync { page.getLocationOnScreen(origin) }
        val point = JSONObject(text)
        return PointF(origin[0] + point.getDouble("x").toFloat(), origin[1] + point.getDouble("y").toFloat())
    }

    private fun evalJs(page: TabWebView, script: String): String? {
        val latch = CountDownLatch(1)
        var result: String? = null
        instrumentation.runOnMainSync {
            page.evaluateJavascript(script) {
                result = it
                latch.countDown()
            }
        }
        latch.await(10, TimeUnit.SECONDS)
        return runCatching { JSONTokener(result ?: "null").nextValue() as? String }.getOrNull()
    }

    companion object {
        private const val CALLER_ACTIVITY = "app.zen.chromium.CustomTabCallerActivity"
        private const val STORY_URL = "https://en.wikipedia.org/wiki/Damping"
        private const val BRAND = 0xFF2E5BFF.toInt()
        private const val BRAND_DARK = 0xFF1B2A6B.toInt()
        private const val ACTION_SAVE = "app.zen.chromium.demo.SAVE"
        private const val ACTION_OPEN_IN_APP = "app.zen.chromium.demo.OPEN_IN_APP"
        /** The bottom toolbar's one click intent (the clicked id rides in EXTRA_REMOTEVIEWS_CLICKED_ID). */
        private const val ACTION_BOTTOM = "app.zen.chromium.demo.BOTTOM"
        /** A custom toolbar item's intent; the caller's own extra says which. */
        private const val ACTION_ITEM = "app.zen.chromium.demo.ITEM"
        private const val ACTION_SWIPE_UP = "app.zen.chromium.demo.SWIPE_UP"
        private const val EXTRA_ITEM = "app.zen.chromium.demo.extra.ITEM"
        /** The dark tab's toolbar items: ids other than 0, which is the top bar's action button. */
        private const val ITEM_SHARE_ID = 11
        private const val ITEM_COMMENTS_ID = 12

        private const val READ_LABEL = "Read the story"
        private const val SAVE_LABEL = "Save for later"
        private const val CLOSE_LABEL = "Close"
        private const val MENU_LABEL = "Menu"
        /** The toolbar's Minimize (strings.xml cct_minimize). */
        private const val MINIMIZE_LABEL = "Minimize"
        /** The RemoteViews bar's first button (cct_demo_bottom_bar.xml) and the dark tab's share item. */
        private const val BOTTOM_SHARE_LABEL = "Share story"
        /** The dark tab's second toolbar item's description. */
        private const val ITEM_COMMENTS_LABEL = "Comments"
        private const val SYSTEM_UI = "com.android.systemui"
        /** SystemUI's picture-in-picture menu control that returns the window to full size. */
        private const val PIP_EXPAND_LABEL = "Expand"
        private const val OPEN_IN_ZENIUM_LABEL = "Open in Zenium"
        private const val FIND_LABEL = "Find in Page"
        private const val FIND_CLOSE_LABEL = "Close find bar"
        private const val FIND_QUERY = "damping"

        private const val PAGE_STATE_JS = "location.host + ':' + document.readyState"

        /** One tall link over the page; its centre in device pixels relative to the WebView. */
        private val PLANT_LINK_JS = """
            (function () {
              var a = document.createElement('a');
              a.href = 'https://example.com/';
              a.textContent = 'Continue to example.com →';
              a.style.cssText = 'position:fixed;left:16px;right:16px;top:40%;display:block;padding:22px 18px;' +
                'border-radius:14px;background:#fff;color:#1d1d2c;text-decoration:none;z-index:2147483647;' +
                'font:600 18px/1.3 system-ui,sans-serif;box-shadow:0 2px 10px rgba(0,0,0,.14)';
              document.body.appendChild(a);
              var vv = window.visualViewport;
              var scale = (vv ? vv.scale : 1) * (window.devicePixelRatio || 1);
              var r = a.getBoundingClientRect();
              return JSON.stringify({
                x: (r.left + r.width / 2 - (vv ? vv.offsetLeft : 0)) * scale,
                y: (r.top + r.height / 2 - (vv ? vv.offsetTop : 0)) * scale
              });
            })()
        """.trimIndent()
    }
}
