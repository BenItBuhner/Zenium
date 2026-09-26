package app.zen.chromium

import android.accessibilityservice.AccessibilityService
import android.app.ActivityManager
import android.app.Notification
import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.graphics.PointF
import android.graphics.Rect
import android.os.Build
import android.os.SystemClock
import android.provider.Settings
import android.service.notification.StatusBarNotification
import android.util.Log
import android.view.accessibility.AccessibilityNodeInfo
import androidx.core.content.pm.ShortcutManagerCompat
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
 * Drives an installed web app's identity on the phone (matrix PWA-02, W6-9) so the
 * `android-pwa-identity-demo` workflow can record it, in the colour scheme the `theme` argument
 * names (`DEMO_THEME`: light and dark acts; the dark act puts the device in night mode, which
 * Recents, the shade and the app's window follow).
 *
 * The fixture is the web app window demo's Sketch Studio ([WebAppDemo]: a `standalone` manifest
 * scoped to `/app/` on the loopback port), its page given a "Notify me" button that asks for the
 * permission and posts one notification.
 *
 * The sequence: Sketch Studio installed through the install sheet under a real finger (Add, the
 * launcher's pin dialog, the toast) and the core's `webapps.json` read back as the installed list
 * the channels are built from; the tile tapped, the app's window up, its task in Recents read
 * through the API and `dumpsys activity recents` – the app's name as the label, the manifest's
 * `theme_color` as the card's colour, the browser's task another one – and Recents itself on a
 * still; the tile tapped again with the app up: the same window forward, one task; the page's
 * button under a finger, the window's own prompt on the native sheet ("Allow Sketch to show
 * notifications?", Block | Allow) on a still, dismissed by a touch on the scrim and then by the
 * system back – nothing written, the page reading `default` each time – and answered Allow under
 * a finger, the card posted under the app's channel GROUP named for the app (the
 * system's channel list, `dumpsys notification`, the card's sub text and large icon), the shade
 * on a still reading the app's name, the card's tap bringing the app's task forward and the page
 * hearing `click`; the app's notification settings in the system's Settings listing the app as a
 * group of its own; then the same page as a tab of the browser posting as the app too (the
 * browser's own prompt, the card under the app's channel with the browser's tag).
 *
 * What it measures goes to `pwa-identity-findings.txt` (`PASS` / `FAIL` per check; the run fails
 * on a FAIL at the end so every still is taken first). The stills are the design record's
 * (`android-pwa-identity-recents-*`, `android-pwa-identity-shade-*`). See [DemoHarness].
 */
@RunWith(AndroidJUnit4::class)
class PwaIdentityDemo : DemoHarness("pwa-demo-state.json", "android-pwa-identity", "pwa-identity-demo") {
    override val tag = "PwaIdentityDemo"
    private lateinit var server: DemoServer
    private lateinit var findings: File
    private var failures = 0
    /** The pinned shortcut's own intent, once the install wrote it. */
    private var shortcutIntent: Intent? = null
    private val notificationManager: NotificationManager get() = app.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager

    /** The seeded profile's colour scheme, from the `theme` argument (the browser window the last scene lands in). */
    override fun patchState(json: String): String =
        json.replace("\"colorScheme\": \"light\"", "\"colorScheme\": \"$THEME\"")

    /** The device's own scheme: Recents, the shade and the app's window follow the system, not the browser's profile. */
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
        if (failures > 0) throw AssertionError("$failures check(s) FAILED; see pwa-identity-findings.txt")
    }

    override fun warmUp() {
        findings = File(out, "pwa-identity-findings.txt")
        findings.writeText(
            "Zenium Android installed web app identity checks – PWA-02 ($THEME; API ${Build.VERSION.SDK_INT}, ${width}x$height, density $density)\n\n"
        )
        finding("demo server: ${server.selfCheck()}")
        finding("launcher takes pinned shortcuts: ${ShortcutManagerCompat.isRequestPinShortcutSupported(app)}")
        finding("POST_NOTIFICATIONS held: ${notificationManager.areNotificationsEnabled()}")
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
        // Recents once off camera: the launcher's first-visit tip ("Select text and images…", over the
        // cards in the first run's still) is spent here, and the scene's still shows the cards alone.
        shellCommand("input keyevent KEYCODE_APP_SWITCH")
        SystemClock.sleep(3_000)
        back()
        if (!awaitTrue(5_000) { ui.rootInActiveWindow?.packageName?.toString() == app.packageName }) {
            shellCommand("am start -a android.intent.action.MAIN -n ${app.packageName}/${MainActivity::class.java.name}")
            awaitTrue(8_000) { ui.rootInActiveWindow?.packageName?.toString() == app.packageName }
        }
        SystemClock.sleep(1_500)
        awaitActiveUrl(APP_URL)
        finding("start: active ${activeCoreTab()?.optString("url")}; front ${ui.rootInActiveWindow?.packageName}")
    }

    override fun demo() {
        val f = Finger()
        val pinned = installThroughTheSheet(f)
        readTheShortcut()
        theInstalledList()
        val opened = openFromTheTile(f, pinned)
        if (opened != null) {
            theTaskInRecents(opened)
            launchedAgainFromTheTile(f, opened)
            val posted = notifyFromTheAppWindow(f, opened)
            if (posted) theShade(f, opened)
            theSystemsNotificationSettings()
        }
        notifyFromTheBrowser(f)
        finding("\nend: web app windows ${webApps(Stage.RESUMED, Stage.PAUSED, Stage.STOPPED).size}, $failures FAIL")
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
        if (!tapSettled(f, "Add")) {
            fail("no Add button in the sheet")
            back()
            return false
        }
        var system = awaitSystemWindow(12_000)
        if (!system && json("String(!!document.querySelector('.zen-sheet.zen-install-sheet'))") == "true") {
            // The sheet still up and no dialog: the first finger touched nothing (the window
            // demo's run 36002509774). A second real touch, on the record, before the claim is judged.
            finding("the first touch on Add brought no pin dialog in 12 s with the sheet still up; a second finger goes in")
            if (tapSettled(f, "Add")) system = awaitSystemWindow(8_000)
        }
        SystemClock.sleep(1_500)
        check("the system's pin dialog came up (${ui.rootInActiveWindow?.packageName})", system)
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

    // --- 2. the shortcut and the installed list -----------------------------------------------------

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
        // The tile's intent carries the start URL; the launcher activity mints the task URI (zen-webapp://<id>) for the app's own task.
        check("the shortcut's intent aims at WebAppLauncherActivity with the app's start URL (${intent.data})", intent.component?.className == WebAppLauncherActivity::class.java.name && intent.data?.toString() == APP_URL)
        check("the record's name is the tile's label ('${record?.name}')", record?.name == TILE_LABEL)
    }

    /** The core's `webapps.json`, the list the app's channels are built from ([WebAppChannels]): the pin's confirmation writes the entry. */
    private fun theInstalledList() {
        finding("\n3. The core's installed list (files/zen/webapps.json), what the channels read")
        val file = File(app.filesDir, WebAppChannels.INSTALLED_FILE)
        var apps: List<InstalledWebApp> = emptyList()
        awaitTrue(10_000) {
            apps = InstalledWebApps.parse(runCatching { if (file.isFile) file.readText() else null }.getOrNull())
            apps.isNotEmpty()
        }
        finding("webapps.json pinned: ${apps.map { "'${it.name}' ${it.scope} (${it.shortcutId})" }}")
        val installed = InstalledWebApps.appFor(APP_URL, apps)
        check("the list holds the app for $APP_URL as '$TILE_LABEL' ('${installed?.name}')", installed?.name == TILE_LABEL)
        check("its shortcut id is the tile's (${installed?.shortcutId})", installed?.shortcutId == SHORTCUT_ID)
        check("its origin is the site's as the core writes it (${installed?.origin})", installed?.origin == ORIGIN)
    }

    // --- 4. the tile opens the app's own window; its task in Recents ---------------------------------

    /** The app's window, up from the tile under a finger (or, without a tile, from the intent the tile would have fired). */
    private fun openFromTheTile(f: Finger, pinned: Boolean): WebAppActivity? {
        finding("\n4. The Home screen tile -> the app's own window; the task in Recents")
        ui.performGlobalAction(AccessibilityService.GLOBAL_ACTION_HOME)
        SystemClock.sleep(3_000)
        val tile = if (pinned) findTile() else null
        check("the '$TILE_LABEL' tile is on the Home screen", tile != null)
        if (tile != null) {
            f.tap(tile.exactCenterX(), tile.exactCenterY())
        } else {
            val intent = shortcutIntent ?: Shortcuts.launchIntent(app, APP_URL, SKETCH)
            app.startActivity(Intent(intent).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        }
        val webApp = awaitWebApp(15_000) ?: run {
            fail("no WebAppActivity came up (top: ${ui.rootInActiveWindow?.packageName})")
            return null
        }
        waitForPage(webApp, "/app/")
        SystemClock.sleep(2_500)
        return webApp
    }

    /** The task's description as the platform holds it – the API's word and `dumpsys activity recents`' – and Recents on a still. */
    private fun theTaskInRecents(webApp: WebAppActivity) {
        val task = ownTask(webApp)
        val label = task?.taskDescription?.label
        val colour = task?.taskDescription?.primaryColor
        finding("app tasks: ${appTasks().map { "${it.baseIntent.component?.shortClassName}='${it.taskDescription?.label}' ${it.baseIntent.data ?: ""}" }}")
        check("Recents holds the app's own task, labelled '$TILE_LABEL' ('$label')", task != null && label == TILE_LABEL)
        check("the task's colour is the manifest's theme_color ${hex(THEME_COLOR)} (${colour?.let(::hex)})", colour != null && close(colour, THEME_COLOR))
        check("the task's base intent is the app's own (${task?.baseIntent?.data})", task?.baseIntent?.data?.scheme == WebAppRules.TASK_SCHEME)
        check("the browser's task is another one", appTasks().any { it.baseIntent.component?.className == MainActivity::class.java.name })
        val recents = readRecents()
        finding("dumpsys activity recents, the app's task (${recents.count} WebAppActivity task(s)): ${recents.lines.joinToString(" | ")}")
        check("dumpsys activity recents lists the app's task once, on the tile's task URI", recents.count == 1 && recents.block.contains("${WebAppRules.TASK_SCHEME}://"))
        // The description as the platform holds it: `dumpsys activity activities` prints each record's
        // taskDescription (label, primaryColor); the recents dump on API 34 prints the task without it.
        finding("dumpsys activity activities, the task descriptions: ${recents.descriptions.joinToString(" | ").ifEmpty { "none printed" }}")
        if (recents.descriptions.isNotEmpty()) {
            check("the platform holds the label '$TILE_LABEL' on the app's record (label ${recents.label ?: "?"})", recents.label == TILE_LABEL)
            check("the platform holds the theme_color ${hex(THEME_COLOR)} as the record's primaryColor (${recents.color ?: "?"})", recents.color == hex(THEME_COLOR))
        }
        // Recents as the user sees it (the still): the app's card apart from the browser's.
        shellCommand("input keyevent KEYCODE_APP_SWITCH")
        SystemClock.sleep(3_500)
        finding("Recents on screen (${ui.rootInActiveWindow?.packageName}): ${labelsInWindows()}")
        shot("recents-$THEME")
        beat()
    }

    /** The tile tapped while the app runs: `singleTop` in the `intoExisting` document task brings the window that is up forward, no second task. */
    private fun launchedAgainFromTheTile(f: Finger, opened: WebAppActivity) {
        finding("\n5. The tile tapped again while the app is up: its task forward, one task")
        ui.performGlobalAction(AccessibilityService.GLOBAL_ACTION_HOME)
        SystemClock.sleep(2_500)
        val tasksBefore = appTasks().count { it.baseIntent.component?.className == WebAppActivity::class.java.name }
        val urlBefore = pageUrl(opened)
        val tile = findTile()
        if (tile != null) {
            f.tap(tile.exactCenterX(), tile.exactCenterY())
        } else {
            finding("no tile to tap the second time; the shortcut's intent fired from the app's own uid instead")
            val intent = shortcutIntent ?: Shortcuts.launchIntent(app, APP_URL, SKETCH)
            app.startActivity(Intent(intent).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        }
        val resumed = awaitTrue(10_000) { webApp() === opened }
        SystemClock.sleep(1_500)
        val tasksAfter = appTasks().count { it.baseIntent.component?.className == WebAppActivity::class.java.name }
        val recents = readRecents()
        finding("relaunched from the tile: the same instance in front $resumed; WebAppActivity tasks $tasksBefore -> $tasksAfter (dumpsys: ${recents.count}); page ${pageUrl(opened)}")
        check(
            "the second launch brought the window that was up forward: the same instance, one task, the page kept ($urlBefore)",
            resumed && tasksBefore == 1 && tasksAfter == 1 && recents.count == 1 && pageUrl(opened) == urlBefore
        )
        check("the browser's task is still its own", appTasks().any { it.baseIntent.component?.className == MainActivity::class.java.name })
    }

    // --- 6. a notification from the app's own window ---------------------------------------------------

    /** True when the page's card reached the shade. */
    private fun notifyFromTheAppWindow(f: Finger, opened: WebAppActivity): Boolean {
        finding("\n6. A notification from the app's own window: the page's ask -> the window's prompt -> Allow under a finger -> the card under the app's channel group")
        val page = onMain { opened.page } ?: run {
            fail("the web app window has no page")
            return false
        }
        val before = pageStatus(page)
        finding("page before: '$before'")
        check("the app's page has Notification (the window's own script) and reads 'default' before the ask", before == "permission: default")
        val point = elementCentre(page, NOTIFY_BUTTON) ?: run {
            fail("no '$NOTIFY_BUTTON' button on the page")
            return false
        }
        f.tap(point.x, point.y)
        val title = waitFor(PROMPT_TITLE, 8_000)
        SystemClock.sleep(1_200)
        val block = findByLabel(BLOCK)
        val allow = findByLabel(ALLOW)
        val grip = findByLabel(GRIP_LABEL)
        finding("the window's prompt: title '$PROMPT_TITLE' ${if (title != null) "up at $title" else "not up"}; grip $grip; Block $block; Allow $allow; page '${pageStatus(page)}'")
        check("the window's own prompt is the native sheet asking '$PROMPT_TITLE' with the grip strip over it (§9.23)", title != null && grip != null)
        check("§9.11's pair under the question, Block leading and Allow trailing on one row", block != null && allow != null && block.left < allow.left && abs(block.centerY() - allow.centerY()) < 4 * density)
        if (title == null) {
            touchFault("the touch on the page's '$NOTIFY_LABEL' brought no prompt in 8 s (page: ${pageStatus(page)})")
            return false
        }
        shot("prompt-$THEME")
        beat()
        // A dismissal writes nothing and leaves the question open: the scrim first, then the system back,
        // each answering the page's promise 'default' with the app's memory still empty, the page asking again.
        touchScrim("the scrim over the page")
        val scrimGone = awaitTrue(6_000) { findByLabel(PROMPT_TITLE) == null }
        val afterScrim = awaitTrue(6_000) { pageAnswers(page) == listOf("default") }
        finding("after the scrim: sheet ${if (scrimGone) "gone" else "still up"}; the page's answers ${pageAnswers(page)}; memory ${appMemory()}")
        check("a touch on the scrim dismisses the sheet; the page reads 'default' and nothing is written", scrimGone && afterScrim && appMemory() == null)
        if (!scrimGone) touchFault("the touch on the scrim did not send the sheet away in 6 s")
        f.tap(point.x, point.y)
        val again = waitFor(PROMPT_TITLE, 8_000) != null
        SystemClock.sleep(600)
        back()
        val backGone = awaitTrue(6_000) { findByLabel(PROMPT_TITLE) == null }
        val afterBack = awaitTrue(6_000) { pageAnswers(page) == listOf("default", "default") }
        finding("after the back: asked again $again; sheet ${if (backGone) "gone" else "still up"}; the page's answers ${pageAnswers(page)}; memory ${appMemory()}")
        check("the page may ask again after a dismissal; the system back dismisses the sheet the same way – 'default', nothing written", again && backGone && afterBack && appMemory() == null)
        if (again && !backGone) touchFault("the system back did not send the sheet away in 6 s")
        f.tap(point.x, point.y)
        val third = waitFor(PROMPT_TITLE, 8_000) != null
        SystemClock.sleep(600)
        check("the sheet is up a third time for the answer", third)
        // Allow under a finger: the page reads granted and posts; Android 13's own prompt should the run lack POST_NOTIFICATIONS.
        touchTapLabelExpecting(ALLOW, "the page reads granted", timeoutMs = 10_000) {
            pageStatus(page).startsWith("permission: granted")
        }
        if (awaitSystemWindow(2_000)) {
            finding("Android 13's prompt after the grant: up (${ui.rootInActiveWindow?.packageName})")
            if (!tapInWindows(f, "Allow")) shellCommand("pm grant ${app.packageName} android.permission.POST_NOTIFICATIONS")
        }
        val shown = awaitTrue(12_000) { pageStatus(page).contains("shown") }
        val memory = appMemory()
        finding("page after: '${pageStatus(page)}', its answers ${pageAnswers(page)}; the window's own memory for the app: $memory; the browser's site decisions: ${siteDecisions()}")
        check("the page's notification was shown (its 'show' event fired)", shown)
        check("the window kept the answer as the app's own memory (allow) – the one write of the three asks", memory == WebAppNotifications.ALLOW && pageAnswers(page) == listOf("default", "default", "granted"))
        // The channel group, from the system's list.
        val group = notificationManager.notificationChannelGroups.firstOrNull { it.id == GROUP_ID }
        val channel = notificationManager.notificationChannels.firstOrNull { it.id.startsWith(Notifications.webAppPrefix(SHORTCUT_ID)) }
        finding("channel group: ${group?.id} '${group?.name}'; channel: ${channel?.id} '${channel?.name}' importance ${channel?.importance} group ${channel?.group} description '${channel?.description}'")
        check("the app's channel group is named for the app ('${group?.name}')", group?.name?.toString() == TILE_LABEL)
        check("the channel under it is the app's, named for the app", channel != null && channel.group == GROUP_ID && channel.name?.toString() == TILE_LABEL)
        // The card, from the notification manager and from dumpsys.
        val cards = notificationManager.activeNotifications.filter { it.tag?.startsWith("zenium.webapp/") == true }
        finding("active cards of the app window: ${cards.map(::describe)}")
        val card = cards.firstOrNull()
        check("one card up, under the app's channel (${card?.notification?.channelId})", cards.size == 1 && card != null && card.notification.channelId == channel?.id)
        check("the card's sub text is the app's name ('${card?.notification?.extras?.getCharSequence(Notification.EXTRA_SUB_TEXT)}')", card?.notification?.extras?.getCharSequence(Notification.EXTRA_SUB_TEXT)?.toString() == TILE_LABEL)
        check("the card carries the app's tile as its large icon and the theme colour as its accent (${card?.notification?.color?.let(::hex)})", card != null && card.notification.getLargeIcon() != null && card.notification.color == THEME_COLOR)
        val dump = shellCommand("dumpsys notification --noredact")
        val record = dump.lines().firstOrNull { it.contains("pkg=${app.packageName}") && it.contains("tag=zenium.webapp/") }?.trim()
        finding("dumpsys notification, the card: ${record?.take(500) ?: "no record with tag=zenium.webapp/"}")
        check("dumpsys notification lists the card under the app's channel (${Notifications.webAppPrefix(SHORTCUT_ID)}…)", record != null && record.contains("channel=${Notifications.webAppPrefix(SHORTCUT_ID)}"))
        val groupLine = dump.lines().firstOrNull { it.contains(GROUP_ID) && it.contains("mName=") }?.trim()
        finding("dumpsys notification, the group: ${groupLine?.take(400) ?: "no NotificationChannelGroup line for $GROUP_ID"}")
        check("dumpsys notification names the app's group '$TILE_LABEL'", groupLine != null && groupLine.contains("mName=$TILE_LABEL"))
        return shown && card != null
    }

    // --- 7. the shade -------------------------------------------------------------------------------------

    /** The card as the shade shows it (the still), and its tap: the app's task forward, the page's `click`. */
    private fun theShade(f: Finger, opened: WebAppActivity) {
        finding("\n7. The shade: the card reads the app's name; its tap brings the app's task forward and the page hears click")
        shellCommand("cmd statusbar expand-notifications")
        val card = awaitInWindows(10_000) { it == NOTIFY_TITLE }
        SystemClock.sleep(1_500)
        val labels = labelsInWindows()
        finding("shade (${ui.rootInActiveWindow?.packageName}): $labels")
        check("the shade shows the card '$NOTIFY_TITLE'", card != null)
        // The header reads "Zenium • Sketch" – the app's name as the sub text beside the browser's (the platform's ceiling without a WebAPK).
        check("the shade's card reads the app's name '$TILE_LABEL'", findInWindows { it == TILE_LABEL || it.endsWith(" $TILE_LABEL") || it.contains("• $TILE_LABEL") } != null)
        if (card == null) {
            closeShade()
            return
        }
        shot("shade-$THEME")
        beat()
        val bounds = Rect().also { card.getBoundsInScreen(it) }
        f.tap(bounds.exactCenterX(), bounds.exactCenterY())
        val forward = awaitTrue(10_000) { webApp() === opened }
        val clicked = awaitTrue(6_000) { onMain { opened.page }?.let(::pageStatus)?.contains("click") == true }
        SystemClock.sleep(1_000)
        val tasks = appTasks().count { it.baseIntent.component?.className == WebAppActivity::class.java.name }
        val left = notificationManager.activeNotifications.count { it.tag?.startsWith("zenium.webapp/") == true }
        finding("after the tap: web app in front $forward, page '${onMain { opened.page }?.let(::pageStatus)}', WebAppActivity tasks $tasks, cards left $left, front ${ui.rootInActiveWindow?.packageName}")
        check("the card's tap brought the app's own task forward (the same window, one task) and the page heard click; the card went", forward && clicked && tasks == 1 && left == 0)
        if (!forward) {
            touchFault("the touch on the shade's card did not bring the app's window forward in 10 s")
            closeShade()
        }
    }

    /** The system's notification settings for Zenium: the app listed as a group of its own to silence or block. */
    private fun theSystemsNotificationSettings() {
        finding("\n8. The system's notification settings: the app as a group of its own")
        runCatching {
            app.startActivity(
                Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
                    .putExtra(Settings.EXTRA_APP_PACKAGE, app.packageName)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            )
        }.onFailure { finding("notification settings refused: $it") }
        if (awaitSystemWindow(8_000)) {
            SystemClock.sleep(3_000)
            val listed = awaitInWindows(6_000) { it == TILE_LABEL } != null
            finding("system notification settings: the app's group '$TILE_LABEL' ${if (listed) "listed" else "not in the tree (may be below the fold)"}; Sites ${if (findInWindows { it == Notifications.SITES.name } != null) "listed" else "not in the tree"}; labels ${labelsInWindows()}")
            check("the system's notification settings list the app's group '$TILE_LABEL' by name (the group named for the app, its one switch)", listed)
            if (listed) {
                shot("settings-$THEME")
                beat()
            }
            back()
            SystemClock.sleep(2_000)
        } else {
            finding("the system's notification settings did not come up in 8 s")
        }
    }

    // --- 9. the browser half --------------------------------------------------------------------------------

    /** The app's page as a tab of the browser: the browser's own prompt, then the card under the app's channel with the browser's tag. */
    private fun notifyFromTheBrowser(f: Finger) {
        finding("\n9. The browser half: the app's page as a tab posts as the app too")
        finishWebApps()
        shellCommand("am start -a android.intent.action.MAIN -n ${app.packageName}/${MainActivity::class.java.name}")
        awaitTrue(10_000) { ui.rootInActiveWindow?.packageName?.toString() == app.packageName && webApp() == null }
        SystemClock.sleep(1_500)
        coreInvoke("tab.activate", "{\"tabId\":\"tab_app\"}")
        awaitActiveUrl(APP_URL)
        // The tab's document as the warm-up loaded it (the browser's own page script, the core behind it); its status line read from it.
        val page = onMain { (activity as? MainActivity)?.host?.tabs?.get("tab_app") } ?: run {
            fail("no page view for tab_app")
            return
        }
        awaitTrue(15_000) { pageStatus(page).startsWith("permission: ") }
        SystemClock.sleep(1_000)
        val before = pageStatus(page)
        finding("the tab before: '$before' (the site's own standing in the browser; the app window's answer was the app's memory, not the site's)")
        val point = elementCentre(page, NOTIFY_BUTTON) ?: run {
            fail("no '$NOTIFY_BUTTON' button on the tab's page")
            return
        }
        f.tap(point.x, point.y)
        if (before == "permission: default") {
            val allowUp = waitFor("Allow", 8_000) != null
            finding("the browser's prompt: ${if (allowUp) "up" else "not up"}")
            if (allowUp) {
                SystemClock.sleep(1_000)
                touchTapLabelExpecting("Allow", "the tab reads granted", timeoutMs = 12_000) {
                    pageStatus(page).startsWith("permission: granted")
                }
            } else {
                touchFault("the touch on the tab's '$NOTIFY_LABEL' brought no prompt in 8 s (page: ${pageStatus(page)})")
            }
        }
        val shown = awaitTrue(12_000) { pageStatus(page).contains("shown") }
        finding("the tab after: '${pageStatus(page)}'; the browser's site decisions: ${siteDecisions()}")
        check("the tab's notification was shown", shown)
        val cards = notificationManager.activeNotifications.filter { it.tag?.startsWith("zenium.web/") == true }
        finding("active cards of the browser: ${cards.map(::describe)}")
        val card = cards.firstOrNull()
        check("the browser posted the card under the app's channel (${card?.notification?.channelId}), with the app's name as its sub text", card != null && card.notification.channelId.startsWith(Notifications.webAppPrefix(SHORTCUT_ID)) && card.notification.extras.getCharSequence(Notification.EXTRA_SUB_TEXT)?.toString() == TILE_LABEL)
        val dump = shellCommand("dumpsys notification --noredact")
        val record = dump.lines().firstOrNull { it.contains("pkg=${app.packageName}") && it.contains("tag=zenium.web/") }?.trim()
        finding("dumpsys notification, the browser's card: ${record?.take(500) ?: "no record with tag=zenium.web/"}")
        check("dumpsys notification lists the browser's card under the app's channel", record != null && record.contains("channel=${Notifications.webAppPrefix(SHORTCUT_ID)}"))
        SystemClock.sleep(1_000)
        for (sbn in notificationManager.activeNotifications) notificationManager.cancel(sbn.tag, sbn.id)
    }

    // --- Recents, read ----------------------------------------------------------------------------------------

    private class RecentsRead(
        val count: Int,
        val block: String,
        val lines: List<String>,
        val descriptions: List<String>,
        val label: String?,
        val color: String?
    )

    /**
     * The app's task as the platform prints it: `dumpsys activity recents` for the task list (its raw
     * list only – the "Visible recent tasks" echo below it names every task's base intent again),
     * `dumpsys activity activities` for the record's `taskDescription: label="…" … primaryColor=…`
     * line (the recents dump on API 34 prints the task without its description).
     */
    private fun readRecents(): RecentsRead {
        val dump = shellCommand("dumpsys activity recents").substringBefore("Visible recent tasks")
        val blocks = dump.split(Regex("(?m)^\\s*\\* Recent #")).drop(1)
        val ours = blocks.filter { it.contains(WebAppActivity::class.java.simpleName) }
        val block = ours.firstOrNull() ?: ""
        val lines = block.lines().map(String::trim).filter { it.isNotEmpty() }.take(8).map { it.take(220) }
        val activities = shellCommand("dumpsys activity activities")
        val descriptions = activities.lines().map(String::trim).filter { it.startsWith("taskDescription:") }.map { it.take(300) }
        // The app window's own record ("* Hist #n: ActivityRecord{… WebAppActivity …}" and its indented detail).
        val records = activities.split(Regex("(?m)^\\s*\\* Hist\\s+#\\d+: ActivityRecord\\{")).drop(1)
        val own = records.firstOrNull { it.substringBefore('\n').contains(WebAppActivity::class.java.simpleName) }
        val ownDescription = own?.lines()?.map(String::trim)?.firstOrNull { it.startsWith("taskDescription:") }
            // Without the record's block in that shape: the one description that carries the app's label (no other activity sets it).
            ?: descriptions.firstOrNull { it.contains("label=\"$TILE_LABEL\"") }
        val label = ownDescription?.let { Regex("label=\"(.*?)\"").find(it)?.groupValues?.get(1) }
        val color = ownDescription?.let { Regex("primaryColor=([0-9a-fA-F]+)").find(it)?.groupValues?.get(1) }?.let { "#${it.lowercase().takeLast(6)}" }
        return RecentsRead(ours.size, block, lines, descriptions, label, color)
    }

    private fun appTasks(): List<ActivityManager.RecentTaskInfo> {
        val manager = app.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
        return manager.appTasks.mapNotNull { runCatching { it.taskInfo }.getOrNull() }
    }

    private fun ownTask(webApp: WebAppActivity): ActivityManager.RecentTaskInfo? =
        appTasks().firstOrNull { it.baseIntent.component?.className == WebAppActivity::class.java.name && it.baseIntent.data == webApp.intent.data }

    // --- the web app window -----------------------------------------------------------------------------------

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

    private fun finishWebApps() {
        onMain { webApps(Stage.RESUMED, Stage.PAUSED, Stage.STOPPED).forEach { it.finishAndRemoveTask() } }
        awaitTrue(6_000) { webApps(Stage.RESUMED, Stage.PAUSED, Stage.STOPPED).isEmpty() }
        SystemClock.sleep(1_000)
    }

    private fun pageUrl(webApp: WebAppActivity): String? = onMain { webApp.page?.url }

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

    /** The page's status line (`#status`: "permission: default", then "permission: granted > shown > click > close" as the events come). */
    private fun pageStatus(page: TabWebView): String =
        evalJs(page, "String((document.getElementById('status')||{}).textContent||'')") ?: ""

    /** What every `requestPermission()` of the page has resolved to so far, in order (`window.zenAnswers`); a pending promise adds nothing. */
    private fun pageAnswers(page: TabWebView): List<String> {
        val text = evalJs(page, "JSON.stringify(window.zenAnswers || [])") ?: return emptyList()
        val array = runCatching { JSONArray(text) }.getOrNull() ?: return emptyList()
        return List(array.length()) { array.getString(it) }
    }

    /** The window's own memory of the app's answer (`WebAppNotifications.PREFS`), null while the question is open. */
    private fun appMemory(): String? = app.getSharedPreferences(WebAppNotifications.PREFS, Context.MODE_PRIVATE).getString(SHORTCUT_ID, null)

    /** A real touch on the page area above the sheet: the scrim's, a dismissal. */
    private fun touchScrim(what: String) {
        val point = PointF(width / 2f, touchable.top + 48 * density)
        finding("touch at ${point.x.toInt()},${point.y.toInt()} on $what")
        Finger().tap(point.x, point.y)
    }

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

    private fun close(a: Int, b: Int, tolerance: Int = 8): Boolean =
        abs(Color.red(a) - Color.red(b)) <= tolerance && abs(Color.green(a) - Color.green(b)) <= tolerance && abs(Color.blue(a) - Color.blue(b)) <= tolerance

    private fun hex(color: Int): String = "#%06x".format(color and 0xffffff)

    /** The browser's `permissions.json` decisions for notifications, as the app window reads them. */
    private fun siteDecisions(): String {
        val decisions = SiteDecisions.parse(runCatching { File(app.filesDir, SiteDecisions.FILE).readText() }.getOrNull())
        return decisions.keys().asSequence().filter { it.endsWith("|notifications") }.map { "$it=${decisions.optString(it)}" }.joinToString(", ").ifEmpty { "none" }
    }

    private fun describe(sbn: StatusBarNotification): String {
        val n = sbn.notification
        val extras = n.extras
        return "tag=${sbn.tag} channel=${n.channelId} title=\"${extras.getCharSequence(Notification.EXTRA_TITLE)}\" text=\"${extras.getCharSequence(Notification.EXTRA_TEXT)}\" " +
            "subText=\"${extras.getCharSequence(Notification.EXTRA_SUB_TEXT)}\" color=${hex(n.color)} largeIcon=${n.getLargeIcon() != null}"
    }

    // --- the shade and the windows ---------------------------------------------------------------------------

    private fun awaitInWindows(timeoutMs: Long, matches: (String) -> Boolean): AccessibilityNodeInfo? {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            findInWindows(matches)?.let { return it }
            SystemClock.sleep(250)
        }
        return null
    }

    private fun closeShade() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            ui.performGlobalAction(AccessibilityService.GLOBAL_ACTION_DISMISS_NOTIFICATION_SHADE)
        } else {
            back()
        }
        SystemClock.sleep(1_500)
    }

    /** The labels on screen, window by window (what the tree really says: the record of Recents, the shade, the settings). */
    private fun labelsInWindows(): String {
        val lines = ArrayList<String>()
        for (window in ui.windows) {
            val root = window.root ?: continue
            val labels = ArrayList<String>()
            val queue = ArrayDeque<AccessibilityNodeInfo>()
            queue.add(root)
            var visited = 0
            while (queue.isNotEmpty() && visited < 1_500 && labels.size < 40) {
                val node = queue.removeFirst()
                visited++
                val text = (node.contentDescription ?: node.text)?.toString()?.trim()
                if (!text.isNullOrEmpty()) labels += text.take(60)
                for (i in 0 until node.childCount) node.getChild(i)?.let(queue::add)
            }
            lines += "[${root.packageName}: ${labels.joinToString(" / ")}]"
        }
        return lines.joinToString(" ")
    }

    // --- the install flow's helpers (as WebAppDemo has them) ---------------------------------------------

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

    /** A real touch on the node labelled `label` once two reads of its bounds 350 ms apart agree. False when the label never comes. */
    private fun tapSettled(f: Finger, label: String, timeoutMs: Long = 8_000): Boolean {
        var last: Rect? = null
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            val now = waitFor(label, 2_000)
            if (now != null && now == last) {
                Log.i(tag, "touch at ${now.exactCenterX()},${now.exactCenterY()} on '$label' (bounds $now, two reads agree)")
                f.tap(now.exactCenterX(), now.exactCenterY())
                return true
            }
            last = now
            SystemClock.sleep(350)
        }
        return false
    }

    /** A real tap on the clickable node labelled `label` in any window on screen (a system dialog is a window of its own). */
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

    // --- findings ------------------------------------------------------------------------------------------------

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

    // --- the pages -----------------------------------------------------------------------------------------------

    private fun asset(name: String): ByteArray = instrumentation.context.assets.open(name).use { it.readBytes() }

    private fun routes(): Map<String, Pair<String, ByteArray>> = mapOf(
        "/app/" to ("text/html; charset=utf-8" to appPage().toByteArray()),
        "/app/manifest.webmanifest" to ("application/manifest+json" to manifest().toByteArray()),
        "/webapp/icon.svg" to ("image/svg+xml" to asset("webapp/icon.svg")),
        "/webapp/icon-192.png" to ("image/png" to asset("webapp/icon-192.png")),
        "/webapp/shot-canvas.svg" to ("image/svg+xml" to asset("webapp/shot-canvas.svg")),
        "/webapp/shot-colours.svg" to ("image/svg+xml" to asset("webapp/shot-colours.svg")),
        "/webapp/shot-gallery.svg" to ("image/svg+xml" to asset("webapp/shot-gallery.svg"))
    )

    companion object {
        private const val PORT = 18131
        private const val ORIGIN = "http://127.0.0.1:$PORT"
        private const val APP_URL = "$ORIGIN/app/"
        private const val SCOPE = "$ORIGIN/app/"
        /** The manifest's `id` (`/app/`) resolved against the origin. */
        private const val APP_ID = APP_URL
        private const val THEME_COLOR = 0xff2f6f8f.toInt()
        private const val BACKGROUND_COLOR = 0xffe8f1f5.toInt()

        private const val ADD_ITEM = "Add to Home Screen"
        private const val TILE_LABEL = "Sketch"
        /** The page's button and its label, the notification's title as the shade shows it. */
        private const val NOTIFY_BUTTON = "notify"
        private const val NOTIFY_LABEL = "Notify me"
        private const val NOTIFY_TITLE = "New sketch shared"
        private const val NOTIFY_BODY = "Ada shared “Harbour at dusk” with you"
        /** The window's own prompt on the native sheet (`PermissionPromptSheet`): `webapp_notifications_question` with the app's name. */
        private const val PROMPT_TITLE = "Allow $TILE_LABEL to show notifications?"
        /** §9.11's pair under it (`cct_block`, `cct_allow`), and the chassis's grip (`prompt_sheet_dismiss`). */
        private const val BLOCK = "Block"
        private const val ALLOW = "Allow"
        private const val GRIP_LABEL = "Dismiss"
        /** The launcher's pin dialog accepts on one of these (Launcher3 says "Add automatically"). */
        private val PIN_ACCEPT_LABELS = listOf("Add automatically", "Add to Home screen", "Add to home screen", "Add")

        private val SHORTCUT_ID = Shortcuts.shortcutId(APP_ID)
        private val GROUP_ID = Notifications.webAppGroupId(SHORTCUT_ID)

        /** The `theme` argument: `dark`, else light (the shared script's `DEMO_THEME`). */
        private val THEME = InstrumentationRegistry.getArguments().getString("theme").let { if (it == "dark") "dark" else "light" }

        /** The record the install writes for Sketch Studio (WebAppRecordTest pins it against the request). */
        private val SKETCH = WebAppRecord(APP_ID, TILE_LABEL, APP_URL, SCOPE, WebAppRules.Display.STANDALONE, THEME_COLOR, BACKGROUND_COLOR)

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

        /**
         * The app's page: the manifest link, a heading, the Notify me button and a status line the
         * driver reads (`#status`: the permission before the ask, then the notification's events).
         * No icon on the notification: the card's large icon is then the app's tile, the claim.
         */
        private fun appPage() = """
            <!doctype html><html><head><meta charset=utf-8>
            <meta name=viewport content="width=device-width,initial-scale=1">
            <title>Sketch Studio</title>
            <link rel=manifest href="/app/manifest.webmanifest">
            <style>body{margin:0;font-family:sans-serif;color:#15141a;background:#e8f1f5}
            h1{font-size:28px;padding:40px 24px 8px}p{padding:0 24px;font-size:20px;line-height:1.4}
            button{display:block;margin:24px;padding:22px 18px;width:calc(100% - 48px);border:0;border-radius:14px;background:#2f6f8f;color:#fff;font:600 20px/1.3 system-ui,sans-serif}
            .status{padding:0 24px;font-size:18px;opacity:.75}</style></head>
            <body><h1>Sketch Studio</h1><p>Draw, ink and colour on an endless canvas. This page is the app's start URL.</p>
            <button id=notify>$NOTIFY_LABEL</button>
            <p class=status id=status></p>
            <script>
              // Not `status`: window.status is a string-typed built-in, and an element assigned to it at the top level coerces.
              var line = document.getElementById('status');
              var events = [];
              // Every answer the asks resolved to, in order: a dismissed prompt resolves 'default' – the same
              // words the line showed before the ask – so the driver reads this list to tell the two apart.
              window.zenAnswers = [];
              function say(t) { events = [t]; line.textContent = t; }
              // The notification's events accumulate (a tap fires click and then close at once).
              function note(t) { events.push(t); line.textContent = events.join(' > '); }
              say(window.Notification ? 'permission: ' + Notification.permission : 'no Notification API');
              document.getElementById('notify').addEventListener('click', function () {
                if (!window.Notification) { say('no Notification API'); return; }
                Notification.requestPermission().then(function (p) {
                  window.zenAnswers.push(p);
                  say('permission: ' + p);
                  if (p !== 'granted') return;
                  var n = new Notification('$NOTIFY_TITLE', { body: '$NOTIFY_BODY', tag: 'share' });
                  n.onshow = function () { note('shown'); };
                  n.onclick = function () { note('click'); };
                  n.onclose = function () { note('close'); };
                  n.onerror = function () { note('error'); };
                }, function (e) { say('error: ' + e); });
              });
            </script></body></html>
        """.trimIndent()

        private fun manifest() = """
            {
              "id": "/app/",
              "name": "Sketch Studio",
              "short_name": "$TILE_LABEL",
              "description": "Sketch Studio: a fixture of the installed web app identity demo.",
              "start_url": "/app/",
              "scope": "/app/",
              "display": "standalone",
              "theme_color": "#2f6f8f",
              "background_color": "#e8f1f5",
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
