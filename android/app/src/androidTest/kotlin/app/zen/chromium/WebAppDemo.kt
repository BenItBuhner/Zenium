package app.zen.chromium

import android.accessibilityservice.AccessibilityService
import android.app.ActivityManager
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.PointF
import android.graphics.Rect
import android.os.Build
import android.os.SystemClock
import android.util.Log
import android.view.View
import android.view.accessibility.AccessibilityNodeInfo
import androidx.core.content.pm.ShortcutManagerCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.runner.lifecycle.ActivityLifecycleMonitorRegistry
import androidx.test.runner.lifecycle.Stage
import org.json.JSONArray
import org.json.JSONObject
import org.json.JSONTokener
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlin.math.abs

/**
 * Drives an installed web app's own window (PWA-07) and its overflow (PWA-08) so the
 * `android-webapp-demo` workflow can record it, in the colour scheme the `theme` argument names
 * (`DEMO_THEME`: the workflow runs light and dark; the dark act puts the device itself in night
 * mode, which is what [WebAppActivity] follows – an app's window has no browser chrome to take a
 * scheme from).
 *
 * The fixture is the Add-to-Home-screen demo's Sketch Studio ([PwaDemo]'s pages on the same
 * loopback port: a `standalone` manifest scoped to `/app/`), joined by two more apps of the same
 * origin – `/mini/` declaring `minimal-ui` and `/full/` declaring `fullscreen` – and by pages on
 * either side of Sketch Studio's scope (`/app/gallery.html` inside it, `/notes.html` outside).
 *
 * The sequence: Sketch Studio is installed through the install sheet (Add under a real finger,
 * the launcher's pin dialog, the confirmation toast); the pinned shortcut is read back through
 * `ShortcutManagerCompat` and its intent asserted to aim at [WebAppLauncherActivity] with the
 * manifest's record; the tile on the Home screen is tapped and the app comes up in its own window
 * – no toolbar, the status bar in the manifest's `theme_color` (a pixel read), the task in Recents
 * labelled with the app's name, `matchMedia('(display-mode: standalone)')` true inside; a link
 * inside the scope stays toolbar-less; a link out of the scope brings #423's toolbar up with the
 * X and the page's origin (frames measured), the X walking the history back to the last in-scope
 * page (frames measured); the overflow (Share, Copy Link, Reload, Open in Zenium) with Copy Link
 * under a finger and Open in Zenium handing the live page to the browser window; the shortcut's
 * intent launched again through `am start -W` (the launch's frames and its `TotalTime`); then the
 * `minimal-ui` fixture (no toolbar strip on a phone – Chrome's `WebappDisplayModeTest`, an open
 * question for the design lead) and the `fullscreen` fixture (both bars hidden), each launched
 * with the intent PWA-02's install would write for it.
 *
 * What it measures goes to `webapp-findings.txt` (`PASS` / `FAIL` per check; the run fails on a
 * FAIL at the end so every still is taken first), the frames to `frames.jsonl`. The stills are
 * the design record's (`android-pwa-display-design-*`, `android-pwa-display-frames-launch-*`).
 * See [DemoHarness] for the plumbing.
 */
@RunWith(AndroidJUnit4::class)
class WebAppDemo : DemoHarness("pwa-demo-state.json", "android-pwa-display", "webapp-demo") {
    override val tag = "WebAppDemo"
    private lateinit var server: DemoServer
    private lateinit var findings: File
    private var failures = 0
    /** The pinned shortcut's own intent, once the install wrote it (the launch scene fires it again). */
    private var shortcutIntent: Intent? = null

    /** The seeded profile's colour scheme, from the `theme` argument (the browser window Open in Zenium lands in). */
    override fun patchState(json: String): String =
        json.replace("\"colorScheme\": \"light\"", "\"colorScheme\": \"$THEME\"")

    /** The device's own scheme: the app's window follows the system, not the browser's profile. */
    override fun beforeLaunch() {
        shellCommand("cmd uimode night ${if (THEME == "dark") "yes" else "no"}")
        SystemClock.sleep(1_500)
    }

    @Test
    fun record() {
        server = DemoServer(PORT, routes()).also { it.start() }
        try {
            runDemo()
        } finally {
            server.close()
            // The nightly runs the next driver on this boot: the device's scheme back as it was.
            if (THEME == "dark") shellCommand("cmd uimode night no")
        }
        if (failures > 0) throw AssertionError("$failures check(s) FAILED; see webapp-findings.txt")
    }

    override fun warmUp() {
        findings = File(out, "webapp-findings.txt")
        findings.writeText(
            "Zenium Android web app window checks ($THEME; API ${Build.VERSION.SDK_INT}, ${width}x$height, density $density)\n\n"
        )
        finding("demo server: ${server.selfCheck()}")
        finding("launcher takes pinned shortcuts: ${ShortcutManagerCompat.isRequestPinShortcutSupported(app)}")
        // The profile opens on the plain page; the app's tab is the one to install from.
        coreInvoke("tab.activate", "{\"tabId\":\"tab_app\"}")
        awaitActiveUrl(APP_URL)
        // The first menu pays for layout and compilation: open it once off camera.
        tapMenuButton()
        if (waitFor(MENU_HANDLE_LABEL, 6_000) != null) {
            SystemClock.sleep(800)
            back()
        }
        SystemClock.sleep(1_500)
        finding("start: active ${activeCoreTab()?.optString("url")}")
    }

    override fun demo() {
        val f = Finger()
        val pinned = installThroughTheSheet(f)
        readTheShortcut()
        val opened = openFromTheTile(f, pinned)
        if (opened) {
            inScopeLink()
            outOfScopeLink()
            closeBackIntoScope()
            overflow()
        }
        launchAgain()
        minimalUi()
        fullscreen()
        finding("\nend: web app windows ${webApps(Stage.RESUMED, Stage.PAUSED, Stage.STOPPED).size}, ${failures} FAIL")
    }

    // --- 1. the install: sheet -> Add -> the launcher's pin dialog -> toast -------------------------

    /** True once the launcher confirmed the pin (the toast is up). [PwaDemo] records this path in full; here it is the way in. */
    private fun installThroughTheSheet(f: Finger): Boolean {
        finding("\n1. Install: sheet -> Add -> system pin dialog -> confirmation toast")
        if (!openMenuItem(ADD_ITEM)) {
            fail("the app menu has no '$ADD_ITEM' on the app page")
            back()
            return false
        }
        val sheet = awaitSheet(8_000)
        SystemClock.sleep(1_500)
        val name = json("(document.querySelector('.zen-install-name')||{}).textContent||''")
        check("the install sheet opened for '$name'", sheet && name == "Sketch Studio")
        if (!tapLabel(f, "Add")) {
            fail("no Add button in the sheet")
            back()
            return false
        }
        val system = awaitSystemWindow(12_000)
        SystemClock.sleep(1_500)
        check("the system's pin dialog came up (${ui.rootInActiveWindow?.packageName})", system)
        // The install sheet's injected touch (the rule in DemoHarness): Add under a finger hands
        // the request to the launcher – a check, and a fault of the run when it did not.
        if (!system) {
            touchFault("the touch on the install sheet's Add brought no system pin dialog in 12 s")
            return false
        }
        val accepted = PIN_ACCEPT_LABELS.any { tapInWindows(f, it) }
        check("accepted the pin dialog", accepted)
        val toast = awaitToast(15_000)
        check("confirmation toast: ${toast ?: "none"}", toast != null)
        SystemClock.sleep(1_500)
        return toast != null
    }

    // --- 2. the shortcut the install wrote ---------------------------------------------------------

    /** PWA-02's shortcut for an app with `display: standalone` aims at the launcher trampoline, carrying the record. */
    private fun readTheShortcut() {
        finding("\n2. The pinned shortcut (ShortcutManagerCompat.getShortcuts)")
        val id = Shortcuts.shortcutId(APP_ID)
        val shortcut = ShortcutManagerCompat.getShortcuts(app, ShortcutManagerCompat.FLAG_MATCH_PINNED).firstOrNull { it.id == id }
        if (shortcut == null) {
            fail("no pinned shortcut with id $id (pinned: ${ShortcutManagerCompat.getShortcuts(app, ShortcutManagerCompat.FLAG_MATCH_PINNED).map { it.id }})")
            return
        }
        val intent = shortcut.intent
        shortcutIntent = intent
        val record = WebAppRecord.fromIntent(intent)
        finding("shortcut '${shortcut.shortLabel}' -> ${intent.component?.className} ${intent.action} ${intent.data}; record ${record?.toJson()}")
        check("the shortcut's intent aims at WebAppLauncherActivity", intent.component?.className == WebAppLauncherActivity::class.java.name)
        check("the intent carries the manifest's record: standalone, scope $SCOPE", record != null && record.display == WebAppRules.Display.STANDALONE && record.scope == SCOPE)
        check("the record carries theme_color #2f6f8f and background_color #e8f1f5", record?.themeColor == THEME_COLOR && record?.backgroundColor == BACKGROUND_COLOR)
        check("the record's name is the tile's label ('${record?.name}')", record?.name == TILE_LABEL)
    }

    // --- 3. the tile opens the app's own window ----------------------------------------------------

    /** True when the app's window came up on the tile. */
    private fun openFromTheTile(f: Finger, pinned: Boolean): Boolean {
        finding("\n3. The Home screen tile -> the app's own window (standalone)")
        ui.performGlobalAction(AccessibilityService.GLOBAL_ACTION_HOME)
        SystemClock.sleep(3_000)
        val tile = if (pinned) findTile() else null
        check("the '$TILE_LABEL' tile is on the Home screen", tile != null)
        if (tile != null) {
            f.tap(tile.exactCenterX(), tile.exactCenterY())
        } else {
            // Nothing to tap: the intent the tile would have fired, so the rest can still run.
            val intent = shortcutIntent ?: Shortcuts.launchIntent(app, APP_URL, SKETCH)
            app.startActivity(Intent(intent).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        }
        val webApp = awaitWebApp(15_000) ?: run {
            fail("no WebAppActivity came up (top: ${ui.rootInActiveWindow?.packageName})")
            return false
        }
        waitForPage(webApp, "/app/")
        SystemClock.sleep(2_500)
        shot("design-standalone-$THEME")
        beat()
        describeWindow(webApp, "standalone", THEME_COLOR, expectToolbar = false, expectBarsHidden = false, expectMode = "standalone")
        recents(webApp)
        return true
    }

    // --- 4. links inside and outside the scope -----------------------------------------------------

    private fun inScopeLink() {
        finding("\n4. A link inside the scope: still no toolbar")
        val webApp = webApp() ?: return fail("no web app window in front")
        val page = webApp.page ?: return fail("the web app window has no page")
        val point = elementCentre(page, GALLERY_LINK) ?: return fail("no '$GALLERY_LINK' link on the page")
        Finger().tap(point.x, point.y)
        waitForPage(webApp, "/app/gallery.html")
        SystemClock.sleep(1_500)
        check("the page moved to /app/gallery.html (${pageUrl(webApp)})", pageUrl(webApp)?.endsWith("/app/gallery.html") == true)
        check("the toolbar stayed hidden inside the scope", !toolbarShown(webApp) && onMain { webApp.inScope })
        check("matchMedia still reports standalone (${displayModes(page)})", displayModes(page) == "standalone")
    }

    private fun outOfScopeLink() {
        finding("\n5. A link out of the scope: the toolbar with the X and the origin (frames measured)")
        val webApp = webApp() ?: return fail("no web app window in front")
        val page = webApp.page ?: return fail("the web app window has no page")
        val point = elementCentre(page, NOTES_LINK) ?: return fail("no '$NOTES_LINK' link on the page")
        var shown = false
        measureFrames("webapp-toolbar-show", JankBudget.Kind.OPEN) {
            Finger().tap(point.x, point.y)
            shown = awaitTrue(10_000) { toolbarShown(webApp) }
            SystemClock.sleep(1_200)
        }
        waitForPage(webApp, "/notes.html")
        SystemClock.sleep(1_500)
        shot("design-out-of-scope-x-$THEME")
        beat()
        check("the page moved to /notes.html, outside the scope (${pageUrl(webApp)})", pageUrl(webApp)?.endsWith("/notes.html") == true)
        check("the toolbar came up on the out-of-scope page", shown && onMain { !webApp.inScope })
        check("the toolbar carries the X (Close) and the Menu, no Minimize", findByLabel(CLOSE_LABEL) != null && findByLabel(MENU_LABEL) != null && findByLabel(MINIMIZE_LABEL) == null)
        check("the toolbar names the page's origin ($ORIGIN_HOST)", findByLabel(ORIGIN_HOST) != null || findNodeWhere { it.text?.toString() == ORIGIN_HOST } != null)
        check("matchMedia reports browser outside the scope (${displayModes(page)})", displayModes(page) == "browser")
        val bars = barsOf(webApp)
        val bar = onMain { Rect(0, bars.top, width, bars.top + webApp.toolbar.barHeight) }
        finding("toolbar at $bar (${webApp.toolbar.barHeight / density} dp) under the ${bars.top} px status bar; status bar pixel ${hex(statusBarPixel())}")
    }

    private fun closeBackIntoScope() {
        finding("\n6. X: the history walked back to the last in-scope page (frames measured)")
        val webApp = webApp() ?: return fail("no web app window in front")
        var hidden = false
        measureFrames("webapp-toolbar-hide", JankBudget.Kind.OPEN) {
            if (!touchTapLabel(CLOSE_LABEL)) {
                fail("the X took no finger")
                return@measureFrames
            }
            hidden = awaitTrue(10_000) { !toolbarShown(webApp) }
            SystemClock.sleep(1_200)
        }
        waitForPage(webApp, "/app/gallery.html")
        SystemClock.sleep(1_200)
        val url = pageUrl(webApp)
        check("the X returned to the last in-scope page, /app/gallery.html ($url)", url?.endsWith("/app/gallery.html") == true)
        check("the toolbar left with the scope regained", hidden && onMain { webApp.inScope })
        check("the window is still the app's (not finished)", onMain { !webApp.isFinishing })
        webApp.page?.let { check("matchMedia reports standalone again (${displayModes(it)})", displayModes(it) == "standalone") }
    }

    // --- 7. the overflow -------------------------------------------------------------------------

    private fun overflow() {
        finding("\n7. The overflow: Share, Copy Link, Reload, Open in Zenium")
        val webApp = webApp() ?: return fail("no web app window in front")
        // The menu opens from the toolbar, so the page is taken out of the scope again first.
        val page = webApp.page ?: return fail("the web app window has no page")
        val point = elementCentre(page, NOTES_LINK) ?: return fail("no '$NOTES_LINK' link on the page")
        Finger().tap(point.x, point.y)
        awaitTrue(10_000) { toolbarShown(webApp) }
        waitForPage(webApp, "/notes.html")
        SystemClock.sleep(1_200)
        if (!touchTapLabel(MENU_LABEL)) return fail("the Menu button took no finger")
        val rows = listOf(SHARE_LABEL, COPY_LABEL, RELOAD_LABEL, OPEN_IN_ZENIUM_LABEL)
        check("the menu sheet is up with its rows", waitFor(OPEN_IN_ZENIUM_LABEL, 6_000) != null && rows.all { findByLabel(it) != null })
        SystemClock.sleep(1_200)
        shot("design-menu-$THEME")
        beat()
        // Copy Link under a real finger (the sheet's injected touch): the clipboard holds the page's URL.
        val copied = touchTapLabelExpecting(COPY_LABEL, "the clipboard holds the page's URL", timeoutMs = 6_000) {
            clipboardText()?.startsWith(ORIGIN) == true
        }
        val clip = clipboardText()
        check("Copy Link put the page's URL on the clipboard ($clip)", copied && clip == "$ORIGIN/notes.html")
        finding("SH-04: the system's own Copied overlay on API ${Build.VERSION.SDK_INT} (the toast is shown below 33)")
        SystemClock.sleep(1_500)
        // Open in Zenium: the live page moves into the browser window as a tab.
        if (!touchTapLabel(MENU_LABEL)) return fail("the Menu button took no second finger")
        waitFor(OPEN_IN_ZENIUM_LABEL, 6_000)
        SystemClock.sleep(800)
        val handed = touchTapLabelExpecting(OPEN_IN_ZENIUM_LABEL, "the browser window is up with its address pill", timeoutMs = 12_000) {
            findByLabelPrefix(PILL_LABEL) != null
        }
        SystemClock.sleep(4_000)
        val active = activeCoreTab()?.optString("url")
        check("Open in Zenium landed the page in a browser tab ($active)", handed && active == "$ORIGIN/notes.html")
        check("the app's window finished on the hand-over", awaitTrue(6_000) { webApps(Stage.RESUMED).isEmpty() && onMain { webApp.isFinishing || webApp.isDestroyed } })
        shot("10-open-in-zenium-$THEME")
        beat()
    }

    // --- 8. the launch, again, through am start -------------------------------------------------

    private fun launchAgain() {
        finding("\n8. The shortcut's intent through am start -W (the launch's frames)")
        val intent = shortcutIntent ?: Shortcuts.launchIntent(app, APP_URL, SKETCH)
        var started = ""
        var webApp: WebAppActivity? = null
        measureFrames("webapp-launch", JankBudget.Kind.OPEN) {
            started = amStart(intent)
            webApp = awaitWebApp(15_000)
            webApp?.let { waitForPage(it, "/app/") }
            SystemClock.sleep(1_500)
        }
        finding("am start -W: ${started.lines().filter { it.contains("Time") || it.contains("LaunchState") || it.contains("Status") }.joinToString(" | ")}")
        val opened = webApp ?: return fail("no WebAppActivity came up on am start (${started.trim()})")
        shot("frames-launch-$THEME")
        beat()
        describeWindow(opened, "standalone (relaunched)", THEME_COLOR, expectToolbar = false, expectBarsHidden = false, expectMode = "standalone")
        val task = ownTask(opened)
        check("the relaunch reused the app's task (${task?.taskDescription?.label})", task != null && task.taskDescription?.label == TILE_LABEL)
        finishWebApps()
    }

    // --- 9. minimal-ui and fullscreen -------------------------------------------------------------

    private fun minimalUi() {
        finding("\n9. minimal-ui: no strip on a phone (Chrome's pose; the design lead's question)")
        val intent = Shortcuts.launchIntent(app, MINI_URL, MINI)
        var webApp: WebAppActivity? = null
        measureFrames("webapp-launch-minimal-ui", JankBudget.Kind.OPEN) {
            amStart(intent)
            webApp = awaitWebApp(15_000)
            webApp?.let { waitForPage(it, "/mini/") }
            SystemClock.sleep(1_500)
        }
        val opened = webApp ?: return fail("no WebAppActivity came up for the minimal-ui fixture")
        SystemClock.sleep(1_000)
        shot("design-minimal-ui-$THEME")
        beat()
        describeWindow(opened, "minimal-ui", MINI_THEME, expectToolbar = false, expectBarsHidden = false, expectMode = "standalone")
        finishWebApps()
    }

    private fun fullscreen() {
        finding("\n10. fullscreen: both bars hidden (immersive)")
        val intent = Shortcuts.launchIntent(app, FULL_URL, FULL)
        var webApp: WebAppActivity? = null
        measureFrames("webapp-launch-fullscreen", JankBudget.Kind.OPEN) {
            amStart(intent)
            webApp = awaitWebApp(15_000)
            webApp?.let { waitForPage(it, "/full/") }
            SystemClock.sleep(1_500)
        }
        val opened = webApp ?: return fail("no WebAppActivity came up for the fullscreen fixture")
        SystemClock.sleep(1_500)
        shot("design-fullscreen-$THEME")
        beat()
        describeWindow(opened, "fullscreen", FULL_THEME, expectToolbar = false, expectBarsHidden = true, expectMode = "fullscreen")
        val page = opened.page
        if (page != null) {
            val viewport = evalJs(page, "String(Math.round(window.innerHeight * (window.devicePixelRatio || 1)))")?.toIntOrNull() ?: 0
            check("the page's viewport spans the screen ($viewport of $height px)", viewport >= height - 4)
        }
        // The recording ends on the browser: the fullscreen window away, the browser's task forward.
        finishWebApps()
        shellCommand("am start -a android.intent.action.MAIN -n ${app.packageName}/${MainActivity::class.java.name}")
        SystemClock.sleep(2_000)
    }

    // --- the window's claims ---------------------------------------------------------------------

    /**
     * The claims every window makes: the toolbar's absence (or presence), the status bar's pixel
     * against the manifest's `theme_color` (or the bars hidden), the navigation bar's pixel on
     * record, the display mode the page reads, the reported mode the window holds.
     */
    private fun describeWindow(webApp: WebAppActivity, what: String, themeColor: Int, expectToolbar: Boolean, expectBarsHidden: Boolean, expectMode: String) {
        val bars = barsOf(webApp)
        val shown = toolbarShown(webApp)
        check("$what: toolbar ${if (expectToolbar) "shown" else "hidden"} (${if (shown) "shown" else "hidden"})", shown == expectToolbar)
        val statusVisible = onMain { ViewCompat.getRootWindowInsets(webApp.window.decorView)?.isVisible(WindowInsetsCompat.Type.statusBars()) ?: true }
        val navVisible = onMain { ViewCompat.getRootWindowInsets(webApp.window.decorView)?.isVisible(WindowInsetsCompat.Type.navigationBars()) ?: true }
        finding("$what: bars status ${if (statusVisible) "visible" else "hidden"} / navigation ${if (navVisible) "visible" else "hidden"}, insets top ${bars.top} bottom ${bars.bottom}; barsHidden ${onMain { webApp.barsHidden }}")
        if (expectBarsHidden) {
            check("$what: the status bar and the navigation bar are hidden", !statusVisible && !navVisible && onMain { webApp.barsHidden })
        } else {
            val status = statusBarPixel()
            check("$what: the status bar reads theme_color ${hex(themeColor)} (${hex(status)})", close(status, themeColor))
            val nav = navigationBarPixel()
            finding("$what: the navigation bar pixel ${hex(nav)} against theme_color ${hex(themeColor)} (${if (close(nav, themeColor)) "the colour" else "the system's contrast scrim over it"})")
        }
        val page = webApp.page
        if (page != null) {
            val modes = displayModes(page)
            check("$what: window.matchMedia reports '$expectMode' ($modes)", modes == expectMode)
        }
        finding("$what: reportedDisplay ${onMain { webApp.reportedDisplay }}, task ${ownTask(webApp)?.let { "'${it.taskDescription?.label}' ${it.baseIntent.data}" }}")
    }

    /** The app's task in Recents: its own, labelled with the app's name, apart from the browser's. */
    private fun recents(webApp: WebAppActivity) {
        val task = ownTask(webApp)
        val tasks = appTasks().map { "${it.baseIntent.component?.shortClassName}='${it.taskDescription?.label}'" }
        finding("app tasks: $tasks")
        check("the app has a task of its own in Recents labelled '$TILE_LABEL' (${task?.taskDescription?.label})", task != null && task.taskDescription?.label == TILE_LABEL)
        check("the task's base intent is the app's own (${task?.baseIntent?.data})", task?.baseIntent?.data?.scheme == WebAppRules.TASK_SCHEME)
        check("the browser's task is another one", appTasks().any { it.baseIntent.component?.className == MainActivity::class.java.name })
    }

    private fun appTasks(): List<ActivityManager.RecentTaskInfo> {
        val manager = app.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
        return manager.appTasks.mapNotNull { runCatching { it.taskInfo }.getOrNull() }
    }

    private fun ownTask(webApp: WebAppActivity): ActivityManager.RecentTaskInfo? =
        appTasks().firstOrNull { it.baseIntent.component?.className == WebAppActivity::class.java.name && it.baseIntent.data == webApp.intent.data }

    // --- launching -----------------------------------------------------------------------------------

    /**
     * `am start -W` of `intent` through the shell, the way a launcher's start reaches the app
     * (the shortcut's own component, action, data, flags and extras rendered as the command's
     * words; the extras are URLs, single words and ints, which need no quoting). The command's
     * output, with its `TotalTime`.
     */
    private fun amStart(intent: Intent): String {
        val words = ArrayList<String>()
        words += "am start -W"
        intent.action?.let { words += "-a $it" }
        intent.data?.let { words += "-d $it" }
        intent.component?.let { words += "-n ${it.flattenToString()}" }
        if (intent.flags != 0) words += "-f ${intent.flags}"
        val extras = intent.extras
        if (extras != null) {
            for (key in extras.keySet()) {
                @Suppress("DEPRECATION")
                when (val value = extras.get(key)) {
                    is String -> words += "--es $key $value"
                    is Int -> words += "--ei $key $value"
                    is Boolean -> words += "--ez $key $value"
                    else -> Log.w(tag, "extra $key of ${value?.javaClass?.simpleName} not rendered")
                }
            }
        }
        val command = words.joinToString(" ")
        Log.i(tag, command)
        val output = shellCommand(command)
        Log.i(tag, output.trim())
        return output
    }

    private fun finishWebApps() {
        onMain { webApps(Stage.RESUMED, Stage.PAUSED, Stage.STOPPED).forEach { it.finishAndRemoveTask() } }
        awaitTrue(6_000) { webApps(Stage.RESUMED, Stage.PAUSED, Stage.STOPPED).isEmpty() }
        SystemClock.sleep(1_000)
    }

    // --- the web app window -------------------------------------------------------------------------

    /** The web app window that is resumed, if one is (the driver shares Zenium's process). */
    private fun webApp(): WebAppActivity? = webApps(Stage.RESUMED).firstOrNull()

    private fun webApps(vararg stages: Stage): List<WebAppActivity> {
        var found: List<WebAppActivity> = emptyList()
        val read = {
            val registry = ActivityLifecycleMonitorRegistry.getInstance()
            found = stages.flatMap { registry.getActivitiesInStage(it).filterIsInstance<WebAppActivity>() }.distinct()
        }
        if (Thread.currentThread() === instrumentation.targetContext.mainLooper.thread) read() else instrumentation.runOnMainSync(read)
        return found
    }

    private fun awaitWebApp(timeoutMs: Long): WebAppActivity? {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            webApp()?.let { return it }
            SystemClock.sleep(200)
        }
        Log.w(tag, "no WebAppActivity resumed within $timeoutMs ms; top is ${ui.rootInActiveWindow?.packageName}")
        return null
    }

    private fun toolbarShown(webApp: WebAppActivity): Boolean = onMain { webApp.toolbar.visibility == View.VISIBLE }

    private fun pageUrl(webApp: WebAppActivity): String? = onMain { webApp.page?.url }

    /** The window's system bar insets (the app's own decor, not the browser's). */
    private fun barsOf(webApp: WebAppActivity): Rect = onMain {
        val insets = ViewCompat.getRootWindowInsets(webApp.window.decorView)?.getInsets(WindowInsetsCompat.Type.systemBars())
        Rect(insets?.left ?: 0, insets?.top ?: 0, insets?.right ?: 0, insets?.bottom ?: 0)
    }

    /** Wait until the page is on a path ending in `path` and has finished loading. */
    private fun waitForPage(webApp: WebAppActivity, path: String) {
        val deadline = SystemClock.uptimeMillis() + 20_000
        while (SystemClock.uptimeMillis() < deadline) {
            val page = onMain { webApp.page }
            val state = if (page != null) evalJs(page, PAGE_STATE_JS) else null
            if (state != null && state.endsWith(":complete") && state.substringBefore(':').endsWith(path)) return
            SystemClock.sleep(400)
        }
        Log.w(tag, "the page never reported $path complete (${onMain { webApp.page?.url }})")
    }

    /** The display modes the page's `matchMedia` answers for, comma-joined ("standalone"). */
    private fun displayModes(page: TabWebView): String =
        evalJs(page, "['fullscreen','standalone','minimal-ui','browser'].filter(function (m) { return window.matchMedia('(display-mode: ' + m + ')').matches; }).join(',')") ?: "?"

    /** Where the element `id` is on screen (device px). */
    private fun elementCentre(page: TabWebView, id: String): PointF? {
        val text = evalJs(page, centreJs(id)) ?: return null
        if (text.isEmpty()) return null
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

    private fun <T> onMain(block: () -> T): T {
        var result: T? = null
        instrumentation.runOnMainSync { result = block() }
        @Suppress("UNCHECKED_CAST")
        return result as T
    }

    // --- pixels --------------------------------------------------------------------------------------

    /** The status bar's colour: the most common of three pixels along its middle, clear of the clock and the icons. */
    private fun statusBarPixel(): Int {
        val top = (windowInsets().top).coerceAtLeast((24 * density).toInt())
        return samplePixels(top / 2)
    }

    /** The navigation bar's colour: pixels along its middle, left of the buttons. */
    private fun navigationBarPixel(): Int {
        val bottom = windowInsets().bottom.coerceAtLeast((48 * density).toInt())
        return samplePixels(height - bottom / 2, fractions = listOf(0.06f, 0.1f, 0.94f))
    }

    private fun samplePixels(y: Int, fractions: List<Float> = listOf(0.3f, 0.5f, 0.7f)): Int {
        val shotBitmap: Bitmap = ui.takeScreenshot() ?: return 0
        try {
            val yy = y.coerceIn(0, shotBitmap.height - 1)
            val pixels = fractions.map { shotBitmap.getPixel((it * shotBitmap.width).toInt().coerceIn(0, shotBitmap.width - 1), yy) }
            return pixels.groupingBy { it }.eachCount().maxByOrNull { it.value }?.key ?: pixels.first()
        } finally {
            shotBitmap.recycle()
        }
    }

    private fun close(a: Int, b: Int, tolerance: Int = 8): Boolean =
        abs(Color.red(a) - Color.red(b)) <= tolerance && abs(Color.green(a) - Color.green(b)) <= tolerance && abs(Color.blue(a) - Color.blue(b)) <= tolerance

    private fun hex(color: Int): String = "#%06x".format(color and 0xffffff)

    private fun clipboardText(): String? = onMain {
        (app.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager).primaryClip?.getItemAt(0)?.coerceToText(app)?.toString()
    }

    // --- the install flow's helpers (as PwaDemo has them) -------------------------------------------

    /** The shortcut's icon on the launcher's workspace, looking one page to each side when needed. */
    private fun findTile(): Rect? {
        waitFor(TILE_LABEL, 4_000)?.let { return it }
        for (direction in listOf(-1f, 1f, 1f)) {
            Finger().apply {
                down(width / 2f, height * 0.45f)
                moveBy(direction * 0.6f * width, 0f, 220)
                up()
            }
            SystemClock.sleep(1_800)
            waitFor(TILE_LABEL, 2_000)?.let { return it }
        }
        return null
    }

    /** A real tap on the clickable node labelled `label` in any window on screen (the launcher's pin dialog is a window of its own). */
    private fun tapInWindows(f: Finger, label: String): Boolean {
        for (window in ui.windows) {
            val root = window.root ?: continue
            val queue = ArrayDeque<AccessibilityNodeInfo>().apply { add(root) }
            var visited = 0
            while (queue.isNotEmpty() && visited < 4_000) {
                val node = queue.removeFirst()
                visited++
                val text = node.text?.toString()
                val description = node.contentDescription?.toString()
                if ((text == label || description == label) && node.isClickable) {
                    val bounds = Rect().also { node.getBoundsInScreen(it) }
                    Log.i(tag, "tapping '$label' (${node.className}) at $bounds")
                    f.tap(bounds.exactCenterX(), bounds.exactCenterY())
                    SystemClock.sleep(1_500)
                    return true
                }
                for (i in 0 until node.childCount) node.getChild(i)?.let(queue::add)
            }
        }
        return false
    }

    private fun awaitSheet(timeoutMs: Long): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            if (json("String(!!document.querySelector('.zen-sheet.zen-install-sheet'))") == "true") return true
            SystemClock.sleep(200)
        }
        return false
    }

    private fun awaitActiveUrl(url: String, timeoutMs: Long = 20_000) {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            val tab = activeCoreTab()
            if (tab?.optString("url") == url && !tab.optBoolean("loading", true)) return
            SystemClock.sleep(250)
        }
        Log.w(tag, "gave up waiting for $url")
    }

    /** The text of the pin confirmation toast, once the launcher's confirmation reached the chrome. */
    private fun awaitToast(timeoutMs: Long): String? {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            val messages = JSONArray(json("JSON.stringify(window.__zenStores.ui.get().toasts.filter(t => !t.leaving).map(t => t.message))"))
            for (i in 0 until messages.length()) {
                val message = messages.getString(i)
                if (message.contains("Home screen")) return message
            }
            SystemClock.sleep(250)
        }
        return null
    }

    /** A JS expression that evaluates to a string in the chrome, decoded. */
    private fun json(code: String): String = (JSONTokener(chromeJs(code)).nextValue() as? String).orEmpty()

    // --- findings ----------------------------------------------------------------------------------------

    private fun check(claim: String, ok: Boolean) {
        if (!ok) failures++
        finding("${if (ok) "PASS" else "FAIL"} $claim")
    }

    private fun fail(claim: String) {
        failures++
        finding("FAIL $claim")
    }

    private fun finding(line: String) {
        Log.i(tag, line.trim())
        findings.appendText(line + "\n")
    }

    // --- the pages -------------------------------------------------------------------------------------------

    private fun asset(name: String): ByteArray = instrumentation.context.assets.open(name).use { it.readBytes() }

    private fun routes(): Map<String, Pair<String, ByteArray>> = mapOf(
        "/notes.html" to DemoServer.page(
            "Notes on damping",
            "<p>A page of the same origin outside the app's scope: the app's window shows it under the toolbar with the X.</p>"
        ),
        "/app/" to ("text/html; charset=utf-8" to appPage("Sketch Studio", "#e8f1f5", "Draw, ink and colour on an endless canvas. This page is the app's start URL.").toByteArray()),
        "/app/gallery.html" to ("text/html; charset=utf-8" to appPage("Gallery", "#e8f1f5", "The sketch gallery: a page inside the app's scope.").toByteArray()),
        "/app/manifest.webmanifest" to ("application/manifest+json" to manifest("/app/", "Sketch Studio", "Sketch", "standalone", "#2f6f8f", "#e8f1f5").toByteArray()),
        "/mini/" to ("text/html; charset=utf-8" to appPage("Notebook", "#f3efe4", "A notebook declaring minimal-ui: on a phone it opens like a standalone app.", "/mini/manifest.webmanifest").toByteArray()),
        "/mini/manifest.webmanifest" to ("application/manifest+json" to manifest("/mini/", "Notebook", "Notebook", "minimal-ui", "#5b3fa3", "#f3efe4").toByteArray()),
        "/full/" to ("text/html; charset=utf-8" to appPage("Canvas", "#101820", "A canvas declaring fullscreen: both bars hide.", "/full/manifest.webmanifest", ink = "#fbfbfe").toByteArray()),
        "/full/manifest.webmanifest" to ("application/manifest+json" to manifest("/full/", "Canvas", "Canvas", "fullscreen", "#101820", "#101820").toByteArray()),
        "/webapp/icon.svg" to ("image/svg+xml" to asset("webapp/icon.svg")),
        "/webapp/icon-192.png" to ("image/png" to asset("webapp/icon-192.png")),
        "/webapp/shot-canvas.svg" to ("image/svg+xml" to asset("webapp/shot-canvas.svg")),
        "/webapp/shot-colours.svg" to ("image/svg+xml" to asset("webapp/shot-colours.svg")),
        "/webapp/shot-gallery.svg" to ("image/svg+xml" to asset("webapp/shot-gallery.svg"))
    )

    companion object {
        private const val PORT = 18131
        private const val ORIGIN = "http://127.0.0.1:$PORT"
        private const val ORIGIN_HOST = "127.0.0.1"
        private const val APP_URL = "$ORIGIN/app/"
        private const val SCOPE = "$ORIGIN/app/"
        /** The manifest's `id` (`/app/`) resolved against the origin. */
        private const val APP_ID = APP_URL
        private const val MINI_URL = "$ORIGIN/mini/"
        private const val FULL_URL = "$ORIGIN/full/"
        private const val THEME_COLOR = 0xff2f6f8f.toInt()
        private const val BACKGROUND_COLOR = 0xffe8f1f5.toInt()
        private const val MINI_THEME = 0xff5b3fa3.toInt()
        private const val FULL_THEME = 0xff101820.toInt()

        private const val ADD_ITEM = "Add to Home Screen"
        private const val TILE_LABEL = "Sketch"
        private const val GALLERY_LINK = "gallery"
        private const val NOTES_LINK = "notes"
        private const val CLOSE_LABEL = "Close"
        private const val MENU_LABEL = "Menu"
        private const val MINIMIZE_LABEL = "Minimize"
        private const val SHARE_LABEL = "Share…"
        private const val COPY_LABEL = "Copy Link"
        private const val RELOAD_LABEL = "Reload"
        private const val OPEN_IN_ZENIUM_LABEL = "Open in Zenium"
        /** The launcher's pin dialog accepts on one of these (Launcher3 says "Add automatically"). */
        private val PIN_ACCEPT_LABELS = listOf("Add automatically", "Add to Home screen", "Add to home screen", "Add")

        /** The `theme` argument: `dark`, else light (the shared script's `DEMO_THEME`). */
        private val THEME = InstrumentationRegistry.getArguments().getString("theme").let { if (it == "dark") "dark" else "light" }

        /** The records the installs write (WebAppRecordTest pins them against the request); the fixtures launch with them. */
        private val SKETCH = WebAppRecord(APP_ID, TILE_LABEL, APP_URL, SCOPE, WebAppRules.Display.STANDALONE, THEME_COLOR, BACKGROUND_COLOR)
        private val MINI = WebAppRecord(MINI_URL, "Notebook", MINI_URL, MINI_URL, WebAppRules.Display.MINIMAL_UI, MINI_THEME, 0xfff3efe4.toInt())
        private val FULL = WebAppRecord(FULL_URL, "Canvas", FULL_URL, FULL_URL, WebAppRules.Display.FULLSCREEN, FULL_THEME, FULL_THEME)

        private const val PAGE_STATE_JS = "location.pathname + ':' + document.readyState"

        /** The centre of the element `id` in device pixels relative to the WebView, or '' without one. */
        private fun centreJs(id: String) = """
            (function () {
              var el = document.getElementById('$id');
              if (!el) return '';
              var vv = window.visualViewport;
              var scale = (vv ? vv.scale : 1) * (window.devicePixelRatio || 1);
              var r = el.getBoundingClientRect();
              return JSON.stringify({
                x: (r.left + r.width / 2 - (vv ? vv.offsetLeft : 0)) * scale,
                y: (r.top + r.height / 2 - (vv ? vv.offsetTop : 0)) * scale
              });
            })()
        """.trimIndent()

        /** An app page: the manifest link, a heading, and two tall links – one inside the scope, one outside. */
        private fun appPage(title: String, background: String, blurb: String, manifest: String = "/app/manifest.webmanifest", ink: String = "#15141a") = """
            <!doctype html><html><head><meta charset=utf-8>
            <meta name=viewport content="width=device-width,initial-scale=1">
            <title>$title</title>
            <link rel=manifest href="$manifest">
            <style>body{margin:0;font-family:sans-serif;color:$ink;background:$background}
            h1{font-size:28px;padding:40px 24px 8px}p{padding:0 24px;font-size:20px;line-height:1.4}
            a.row{display:block;margin:16px 24px;padding:22px 18px;border-radius:14px;background:rgba(127,127,127,.18);color:inherit;text-decoration:none;font:600 18px/1.3 system-ui,sans-serif}
            .mode{padding:0 24px;font-size:16px;opacity:.7}</style></head>
            <body><h1>$title</h1><p>$blurb</p>
            <a class=row id=gallery href="/app/gallery.html">Open the gallery (inside the scope)</a>
            <a class=row id=notes href="/notes.html">Read the notes (outside the scope)</a>
            <p class=mode id=mode></p>
            <script>
              function mode() { return ['fullscreen','standalone','minimal-ui','browser'].filter(function (m) { return matchMedia('(display-mode: ' + m + ')').matches; }).join(',') || 'none'; }
              function show() { document.getElementById('mode').textContent = 'display-mode: ' + mode(); }
              show();
              ['fullscreen','standalone','minimal-ui','browser'].forEach(function (m) { matchMedia('(display-mode: ' + m + ')').addEventListener('change', show); });
            </script></body></html>
        """.trimIndent()

        private fun manifest(scope: String, name: String, shortName: String, display: String, theme: String, background: String) = """
            {
              "id": "$scope",
              "name": "$name",
              "short_name": "$shortName",
              "description": "$name: a fixture of the web app window demo.",
              "start_url": "$scope",
              "scope": "$scope",
              "display": "$display",
              "theme_color": "$theme",
              "background_color": "$background",
              "icons": [
                { "src": "/webapp/icon.svg", "sizes": "any", "type": "image/svg+xml", "purpose": "any" },
                { "src": "/webapp/icon-192.png", "sizes": "192x192", "type": "image/png", "purpose": "maskable" }
              ],
              "screenshots": [
                { "src": "/webapp/shot-canvas.svg", "sizes": "540x1080", "type": "image/svg+xml", "form_factor": "narrow", "label": "An ink sketch on the canvas" },
                { "src": "/webapp/shot-colours.svg", "sizes": "540x1080", "type": "image/svg+xml", "form_factor": "narrow", "label": "The colour palette" },
                { "src": "/webapp/shot-gallery.svg", "sizes": "540x1080", "type": "image/svg+xml", "form_factor": "narrow", "label": "The sketch gallery" }
              ]
            }
        """.trimIndent()
    }
}
